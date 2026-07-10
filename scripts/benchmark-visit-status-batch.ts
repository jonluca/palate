#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { buildVisitStatusBatchStatement } from "../utils/db/visit-status-batch-core.ts";

interface Configuration {
  visits: number;
  selectedVisits: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface VisitRow {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly payload: string;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "currentPerVisitAutocommit" | "setBasedJsonUpdate";

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 5_000,
  selectedVisits: 4_000,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/visit-status-batch-profile.json",
};
const UPDATED_AT = 1_789_123_456_789;
const TARGET_STATUS = "rejected" as const;
const UPDATE_SQL = "UPDATE visits SET status = ?, updatedAt = ? WHERE id = ?";

function usage(): string {
  return `Usage: benchmark-visit-status-batch.ts [options]

  --visits=N       Total visit rows (default: ${DEFAULT_CONFIGURATION.visits})
  --selected=N     Rows selected for update (default: ${DEFAULT_CONFIGURATION.selectedVisits})
  --samples=N      Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
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
      case "--visits":
        configuration.visits = parseInteger(value, option);
        break;
      case "--selected":
        configuration.selectedVisits = parseInteger(value, option);
        break;
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
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
  if (configuration.selectedVisits > configuration.visits) {
    throw new RangeError("--selected cannot exceed --visits.");
  }
  return configuration;
}

function visitId(index: number): string {
  switch (index) {
    case 0:
      return "visit-O'Brien";
    case 1:
      return "訪問-東京-🍣";
    case 2:
      return 'visit-"quoted"-\\path';
    default:
      return `visit-${index.toString().padStart(6, "0")}`;
  }
}

function createInitialRows(count: number): VisitRow[] {
  const statuses = ["pending", "confirmed", "rejected"] as const;
  return Array.from({ length: count }, (_, index) => ({
    id: visitId(index),
    status: statuses[index % statuses.length]!,
    updatedAt: 1_700_000_000_000 + index,
    payload: index === 1 ? "sentinel-雪-'quoted'-🙂" : `sentinel-${index.toString(36)}`,
  }));
}

function expectedRows(initialRows: readonly VisitRow[], selectedIds: ReadonlySet<string>): VisitRow[] {
  return initialRows
    .map((row) => (selectedIds.has(row.id) ? { ...row, status: TARGET_STATUS, updatedAt: UPDATED_AT } : row))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function createDatabase(rows: readonly VisitRow[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const insert = database.prepare("INSERT INTO visits VALUES (?, ?, ?, ?)");
  database.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(row.id, row.status, row.updatedAt, row.payload);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return database;
}

function snapshot(database: DatabaseSync): VisitRow[] {
  return database
    .prepare("SELECT id, status, updatedAt, payload FROM visits ORDER BY id")
    .all()
    .map((row) => ({ ...row })) as unknown as VisitRow[];
}

function checksum(rows: readonly VisitRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function measure(
  strategy: Strategy,
  initialRows: readonly VisitRow[],
  selectedIds: readonly string[],
  expectedChecksum: string,
): number {
  const database = createDatabase(initialRows);
  try {
    const startedAt = performance.now();
    if (strategy === "currentPerVisitAutocommit") {
      for (const id of selectedIds) {
        // Expo SQLite's runAsync prepares, executes, and finalizes this statement per call.
        database.prepare(UPDATE_SQL).run(TARGET_STATUS, UPDATED_AT, id);
      }
    } else {
      const statement = buildVisitStatusBatchStatement(selectedIds, TARGET_STATUS, UPDATED_AT);
      assert.ok(statement);
      database.prepare(statement.sql).run(...statement.parameters);
    }
    const elapsedMilliseconds = performance.now() - startedAt;

    assert.equal(checksum(snapshot(database)), expectedChecksum, `${strategy} result diverged from the oracle`);
    return elapsedMilliseconds;
  } finally {
    database.close();
  }
}

function summarize(samples: readonly number[]): MeasurementSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: median,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const initialRows = createInitialRows(configuration.visits);
const selectedIds = initialRows.slice(0, configuration.selectedVisits).map(({ id }) => id);
const selectedIdSet = new Set(selectedIds);
const oracleRows = expectedRows(initialRows, selectedIdSet);
const expectedChecksum = checksum(oracleRows);

// Validate both implementations before warmup or timing.
measure("currentPerVisitAutocommit", initialRows, selectedIds, expectedChecksum);
measure("setBasedJsonUpdate", initialRows, selectedIds, expectedChecksum);

for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
  const order: Strategy[] =
    iteration % 2 === 0
      ? ["currentPerVisitAutocommit", "setBasedJsonUpdate"]
      : ["setBasedJsonUpdate", "currentPerVisitAutocommit"];
  for (const strategy of order) {
    measure(strategy, initialRows, selectedIds, expectedChecksum);
  }
}

const samples: Record<Strategy, number[]> = {
  currentPerVisitAutocommit: [],
  setBasedJsonUpdate: [],
};
for (let iteration = 0; iteration < configuration.samples; iteration++) {
  const order: Strategy[] =
    iteration % 2 === 0
      ? ["currentPerVisitAutocommit", "setBasedJsonUpdate"]
      : ["setBasedJsonUpdate", "currentPerVisitAutocommit"];
  for (const strategy of order) {
    samples[strategy].push(measure(strategy, initialRows, selectedIds, expectedChecksum));
  }
}

const currentSummary = summarize(samples.currentPerVisitAutocommit);
const candidateSummary = summarize(samples.setBasedJsonUpdate);
const candidateStatement = buildVisitStatusBatchStatement(selectedIds, TARGET_STATUS, UPDATED_AT);
assert.ok(candidateStatement);
const report = {
  schemaVersion: 1,
  status: "ok",
  mode: "synthetic-in-memory-sqlite",
  generatedAt: new Date().toISOString(),
  configuration: {
    ...configuration,
    outputPath: undefined,
    targetStatus: TARGET_STATUS,
  },
  correctness: {
    exactFullRowParityWithIndependentOracle: true,
    resultValidatedAfterEveryRun: true,
    checksum: expectedChecksum,
    selectedRows: selectedIds.length,
    untouchedRows: initialRows.length - selectedIds.length,
  },
  operationCounts: {
    currentPerVisitAutocommit: {
      sqliteCalls: selectedIds.length,
      statementPreparations: selectedIds.length,
      implicitTransactions: selectedIds.length,
    },
    setBasedJsonUpdate: {
      sqliteCalls: selectedIds.length === 0 ? 0 : 1,
      statementPreparations: selectedIds.length === 0 ? 0 : 1,
      implicitTransactions: selectedIds.length === 0 ? 0 : 1,
      boundParameters: candidateStatement.parameters.length,
      jsonPayloadBytes: Buffer.byteLength(candidateStatement.parameters[2], "utf8"),
    },
  },
  timings: {
    currentPerVisitAutocommit: currentSummary,
    setBasedJsonUpdate: candidateSummary,
    medianRawSQLiteSpeedup:
      currentSummary.medianMilliseconds / Math.max(candidateSummary.medianMilliseconds, Number.EPSILON),
  },
  measurementScope:
    "Timings include Node/V8 orchestration and in-memory SQLite writes. They exclude Expo's asynchronous bridge overhead; SQLite call reductions are reported separately.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
