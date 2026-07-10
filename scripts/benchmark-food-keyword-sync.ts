#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_FOOD_KEYWORDS,
  syncDefaultFoodKeywords,
  type FoodKeywordSyncConnection,
  type FoodKeywordSyncDatabase,
} from "../utils/db/food-keyword-sync-core.ts";

interface Configuration {
  readonly iterations: number;
  readonly samples: number;
  readonly warmupPairs: number;
  readonly outputPath: string;
}

interface AdapterCounters {
  reads: number;
  writeExecutions: number;
  transactions: number;
}

interface Measurement {
  readonly milliseconds: number;
  readonly reads: number;
  readonly writeExecutions: number;
  readonly transactions: number;
  readonly totalChanges: number;
  readonly sequenceDelta: number;
}

interface FileSnapshot {
  readonly bytes: number;
  readonly sha256: string;
}

interface StorageProbe {
  readonly totalChanges: number;
  readonly sequenceDelta: number;
  readonly walBytesBefore: number;
  readonly walBytesAfter: number;
  readonly walBytesDelta: number;
  readonly walHashChanged: boolean;
}

type Strategy = "legacy" | "optimized";

const DEFAULT_CONFIGURATION: Configuration = {
  iterations: 500,
  samples: 7,
  warmupPairs: 1,
  outputPath: ".build/food-keyword-sync-profile.json",
};
const INITIAL_CREATED_AT = 1_700_000_000_123;
const RERUN_CREATED_AT = 1_800_000_000_456;

function usage(): string {
  return `Usage: benchmark-food-keyword-sync.ts [options]

  --iterations=N  Startup syncs per sample (default: ${DEFAULT_CONFIGURATION.iterations})
  --samples=N     Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N      Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupPairs})
  --output=PATH   JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h      Show this help`;
}

function parsePositiveInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--iterations":
        configuration.iterations = parsePositiveInteger(value, option);
        break;
      case "--samples":
        configuration.samples = parsePositiveInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupPairs = parsePositiveInteger(value, option, true);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE food_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      isBuiltIn INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX idx_food_keywords_enabled ON food_keywords(enabled);
  `);
}

function createAdapter(database: DatabaseSync, counters: AdapterCounters): FoodKeywordSyncDatabase {
  const connection: FoodKeywordSyncConnection = {
    async getAllAsync<T>(source: string, parameters: Array<string | number>) {
      counters.reads += 1;
      return database.prepare(source).all(...parameters) as T[];
    },
    async runAsync(source, parameters) {
      counters.writeExecutions += 1;
      const result = database.prepare(source).run(...parameters);
      return { changes: Number(result.changes) };
    },
  };

  return {
    ...connection,
    async withExclusiveTransactionAsync(task) {
      counters.transactions += 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        await task(connection);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        throw error;
      }
    },
  };
}

async function legacySync(database: FoodKeywordSyncConnection, createdAt: number): Promise<void> {
  const batchSize = 50;
  for (let index = 0; index < DEFAULT_FOOD_KEYWORDS.length; index += batchSize) {
    const batch = DEFAULT_FOOD_KEYWORDS.slice(index, index + batchSize);
    const insertPlaceholders = batch.map(() => "(?, 1, 1, ?)").join(", ");
    await database.runAsync(
      `INSERT OR IGNORE INTO food_keywords (keyword, enabled, isBuiltIn, createdAt)
        VALUES ${insertPlaceholders}`,
      batch.flatMap((keyword) => [keyword, createdAt]),
    );
    await database.runAsync(
      `UPDATE food_keywords SET isBuiltIn = 1 WHERE keyword IN (${batch.map(() => "?").join(", ")})`,
      [...batch],
    );
  }
}

function readSequence(database: DatabaseSync): number {
  const row = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'food_keywords'").get();
  assert(row);
  return Number(row.seq);
}

function readTotalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS totalChanges").get();
  assert(row);
  return Number(row.totalChanges);
}

function rowDigest(database: DatabaseSync): string {
  const rows = database
    .prepare("SELECT id, keyword, enabled, isBuiltIn, createdAt FROM food_keywords ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function measure(strategy: Strategy, iterations: number): Promise<Measurement> {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    const counters: AdapterCounters = { reads: 0, writeExecutions: 0, transactions: 0 };
    const adapter = createAdapter(database, counters);
    await syncDefaultFoodKeywords(adapter, INITIAL_CREATED_AT);
    counters.reads = 0;
    counters.writeExecutions = 0;
    counters.transactions = 0;
    const digestBefore = rowDigest(database);
    const changesBefore = readTotalChanges(database);
    const sequenceBefore = readSequence(database);

    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (strategy === "legacy") {
        await legacySync(adapter, RERUN_CREATED_AT + iteration);
      } else {
        const result = await syncDefaultFoodKeywords(adapter, RERUN_CREATED_AT + iteration);
        assert.equal(result.transactionStarted, false);
      }
    }
    const milliseconds = performance.now() - startedAt;

    assert.equal(rowDigest(database), digestBefore);
    return {
      milliseconds,
      reads: counters.reads,
      writeExecutions: counters.writeExecutions,
      transactions: counters.transactions,
      totalChanges: readTotalChanges(database) - changesBefore,
      sequenceDelta: readSequence(database) - sequenceBefore,
    };
  } finally {
    database.close();
  }
}

function snapshotFile(path: string): FileSnapshot {
  assert(existsSync(path), `Expected file to exist: ${path}`);
  const contents = readFileSync(path);
  return {
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function probeStorage(strategy: Strategy): Promise<StorageProbe> {
  const directory = mkdtempSync(join(tmpdir(), `palate-food-keyword-${strategy}-`));
  const databasePath = join(directory, "keywords.db");
  const database = new DatabaseSync(databasePath);
  try {
    createSchema(database);
    const counters: AdapterCounters = { reads: 0, writeExecutions: 0, transactions: 0 };
    const adapter = createAdapter(database, counters);
    await syncDefaultFoodKeywords(adapter, INITIAL_CREATED_AT);
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    const walPath = `${databasePath}-wal`;
    const before = snapshotFile(walPath);
    const changesBefore = readTotalChanges(database);
    const sequenceBefore = readSequence(database);

    if (strategy === "legacy") {
      await legacySync(adapter, RERUN_CREATED_AT);
    } else {
      await syncDefaultFoodKeywords(adapter, RERUN_CREATED_AT);
    }

    const after = snapshotFile(walPath);
    return {
      totalChanges: readTotalChanges(database) - changesBefore,
      sequenceDelta: readSequence(database) - sequenceBefore,
      walBytesBefore: before.bytes,
      walBytesAfter: after.bytes,
      walBytesDelta: after.bytes - before.bytes,
      walHashChanged: before.sha256 !== after.sha256,
    };
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function summarize(values: readonly number[]): {
  readonly minimum: number;
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maximum: sorted[sorted.length - 1],
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

for (let warmup = 0; warmup < configuration.warmupPairs; warmup += 1) {
  await measure("legacy", configuration.iterations);
  await measure("optimized", configuration.iterations);
}

const legacyMeasurements: Measurement[] = [];
const optimizedMeasurements: Measurement[] = [];
for (let sample = 0; sample < configuration.samples; sample += 1) {
  const order: Strategy[] = sample % 2 === 0 ? ["legacy", "optimized"] : ["optimized", "legacy"];
  for (const strategy of order) {
    const measurement = await measure(strategy, configuration.iterations);
    (strategy === "legacy" ? legacyMeasurements : optimizedMeasurements).push(measurement);
  }
}

const legacyStorage = await probeStorage("legacy");
const optimizedStorage = await probeStorage("optimized");
const expectedLegacyChanges = DEFAULT_FOOD_KEYWORDS.length * configuration.iterations;
assert(legacyMeasurements.every((measurement) => measurement.totalChanges === expectedLegacyChanges));
assert(legacyMeasurements.every((measurement) => measurement.sequenceDelta === expectedLegacyChanges));
assert(optimizedMeasurements.every((measurement) => measurement.totalChanges === 0));
assert(optimizedMeasurements.every((measurement) => measurement.sequenceDelta === 0));
assert.deepEqual(optimizedStorage, {
  totalChanges: 0,
  sequenceDelta: 0,
  walBytesBefore: 0,
  walBytesAfter: 0,
  walBytesDelta: 0,
  walHashChanged: false,
});
assert.equal(legacyStorage.totalChanges, DEFAULT_FOOD_KEYWORDS.length);
assert.equal(legacyStorage.sequenceDelta, DEFAULT_FOOD_KEYWORDS.length);
assert(legacyStorage.walBytesDelta > 0);
assert.equal(legacyStorage.walHashChanged, true);

const legacyTiming = summarize(legacyMeasurements.map((measurement) => measurement.milliseconds));
const optimizedTiming = summarize(optimizedMeasurements.map((measurement) => measurement.milliseconds));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  configuration,
  defaultKeywordCount: DEFAULT_FOOD_KEYWORDS.length,
  timingsMilliseconds: {
    legacy: legacyTiming,
    optimized: optimizedTiming,
    medianSpeedup: legacyTiming.median / optimizedTiming.median,
    medianMillisecondsSaved: legacyTiming.median - optimizedTiming.median,
  },
  operationsPerSample: {
    legacy: {
      reads: legacyMeasurements[0].reads,
      writeExecutions: legacyMeasurements[0].writeExecutions,
      transactions: legacyMeasurements[0].transactions,
      totalChanges: legacyMeasurements[0].totalChanges,
      sequenceDelta: legacyMeasurements[0].sequenceDelta,
    },
    optimized: {
      reads: optimizedMeasurements[0].reads,
      writeExecutions: optimizedMeasurements[0].writeExecutions,
      transactions: optimizedMeasurements[0].transactions,
      totalChanges: optimizedMeasurements[0].totalChanges,
      sequenceDelta: optimizedMeasurements[0].sequenceDelta,
    },
  },
  oneRerunStorageProbe: {
    legacy: legacyStorage,
    optimized: optimizedStorage,
  },
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Food keyword sync benchmark: ${configuration.iterations} reruns/sample, legacy ${legacyTiming.median.toFixed(3)}ms, optimized ${optimizedTiming.median.toFixed(3)}ms, ${(legacyTiming.median / optimizedTiming.median).toFixed(2)}x; optimized steady state 0 writes, 0 sequence changes, 0 WAL bytes.`,
);
console.log(`Report: ${configuration.outputPath}`);
