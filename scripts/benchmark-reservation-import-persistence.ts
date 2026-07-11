#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  RESERVATION_IMPORT_FIXED_NOW,
  assertHealthyReservationImportPersistenceDatabase,
  emptyReservationImportPersistenceMetrics,
  executeLiteralReservationImportPersistence,
  executeSetBasedReservationImportPersistence,
  initializeReservationImportPersistenceDatabase,
  insertReservationImportFixtureVisit,
  makeReservationImportFixtureVisit,
  snapshotReservationImportPersistenceTables,
  type ReservationImportPersistenceMetrics,
} from "./test-reservation-import-persistence.ts";
import type { ReservationOnlyVisitImportResult, ReservationOnlyVisitInput } from "../utils/db/types.ts";

type Strategy = "legacy-row-v1" | "set-based-json-v1";

interface Configuration {
  scales: number[];
  samples: number;
  warmupPairs: number;
  outputPath: string;
}

interface ExecutionSample {
  readonly elapsedMilliseconds: number;
  readonly calls: number;
  readonly getAllCalls: number;
  readonly runCalls: number;
  readonly transactionCount: number;
  readonly parameterBytes: number;
  readonly walBytes: number;
  readonly mainDatabaseBytes: number;
  readonly result: ReservationOnlyVisitImportResult;
  readonly snapshotSha256: string;
}

interface TimingSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

const DEFAULTS: Configuration = {
  scales: [1, 16, 139, 256, 1_000, 5_000],
  samples: 5,
  warmupPairs: 1,
  outputPath: ".build/reservation-import-persistence-profile.json",
};
const BASE_TIME = new Date(2025, 0, 15, 18, 0, 0, 0).getTime();
const HOUR = 60 * 60 * 1_000;

function usage(): string {
  return `Usage: benchmark-reservation-import-persistence.ts [options]

  --scales=LIST    Comma-separated positive input counts (default: ${DEFAULTS.scales.join(",")})
  --samples=N      Measured pairs per scale (default: ${DEFAULTS.samples})
  --warmup=N       Warmup pairs per scale (default: ${DEFAULTS.warmupPairs})
  --output=PATH    Aggregate JSON report (default: ${DEFAULTS.outputPath})
  --help, -h       Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} is outside the supported range.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration: Configuration = { ...DEFAULTS, scales: [...DEFAULTS.scales] };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 0) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (option === "--samples") {
      configuration.samples = parseInteger(value, option);
    } else if (option === "--warmup") {
      configuration.warmupPairs = parseInteger(value, option, true);
    } else if (option === "--output") {
      if (!value) {
        throw new RangeError("--output cannot be empty.");
      }
      configuration.outputPath = value;
    } else if (option === "--scales") {
      const scales = value.split(",").map((entry) => parseInteger(entry.trim(), option));
      if (new Set(scales).size !== scales.length) {
        throw new RangeError("--scales cannot contain duplicates.");
      }
      configuration.scales = scales;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSha256(relativePath: string): string {
  return sha256(readFileSync(new URL(relativePath, import.meta.url)));
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function createWorkload(database: DatabaseSync, inputCount: number): ReservationOnlyVisitInput[] {
  const inputs: ReservationOnlyVisitInput[] = [];
  for (let index = 0; index < inputCount; index++) {
    const suffix = index.toString().padStart(5, "0");
    const startTime = BASE_TIME + index * 5 * HOUR;
    const latitude = 30 + (index % 100) * 0.001;
    const longitude = -100 - (index % 100) * 0.001;
    if (index % 4 === 0) {
      insertReservationImportFixtureVisit(database, {
        id: `existing-${suffix}`,
        startTime,
        status: "pending",
        latitude,
        longitude,
        photoCount: index % 8 === 0 ? 4 : 0,
      });
    }
    const restaurant = {
      id: `provider-restaurant-${(index % 64).toString().padStart(2, "0")}`,
      name: `Provider Restaurant ${index % 64}`,
      latitude,
      longitude,
      address: index % 3 === 0 ? `Address ${index}` : null,
      phone: index % 7 === 0 ? `555-${suffix}` : null,
      website: index % 11 === 0 ? `https://fixture.invalid/${index}` : null,
      cuisine: index % 5 === 0 ? `Cuisine ${index % 10}` : null,
    };
    const hasSuggestion = index % 4 !== 3;
    inputs.push(
      makeReservationImportFixtureVisit(`import-${suffix}`, `source-${suffix}`, startTime, restaurant, {
        sourceTitle: index % 9 === 0 ? `Reservation at ${restaurant.name}` : restaurant.name,
        sourceLocation: restaurant.address,
        suggestedRestaurantId: hasSuggestion ? "michelin-a" : null,
        suggestedRestaurantDistance: hasSuggestion ? 5 + (index % 200) : null,
        awardAtVisit: hasSuggestion ? `Historical ${index % 4}` : null,
        notes: index % 6 === 0 ? `Party of ${(index % 8) + 1}` : null,
      }),
    );
  }
  return inputs;
}

function prepareDatabase(
  path: string,
  inputCount: number,
): { database: DatabaseSync; inputs: ReservationOnlyVisitInput[] } {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  initializeReservationImportPersistenceDatabase(database);
  const inputs = createWorkload(database, inputCount);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { database, inputs };
}

async function executeOnce(strategy: Strategy, inputCount: number): Promise<ExecutionSample> {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "palate-reservation-profile-"));
  const path = join(directory, `${strategy}.db`);
  try {
    const { database, inputs } = prepareDatabase(path, inputCount);
    const metrics: ReservationImportPersistenceMetrics = emptyReservationImportPersistenceMetrics();
    const start = performance.now();
    const result =
      strategy === "legacy-row-v1"
        ? executeLiteralReservationImportPersistence(database, inputs, RESERVATION_IMPORT_FIXED_NOW, metrics)
        : await executeSetBasedReservationImportPersistence(database, inputs, metrics);
    const elapsedMilliseconds = performance.now() - start;
    const state = snapshotReservationImportPersistenceTables(database);
    const snapshotSha256 = sha256(JSON.stringify(state));
    assertHealthyReservationImportPersistenceDatabase(database);
    const sample = {
      elapsedMilliseconds,
      calls: metrics.calls,
      getAllCalls: metrics.reads,
      runCalls: metrics.writes,
      transactionCount: inputs.length > 0 ? 1 : 0,
      parameterBytes: metrics.parameterBytes,
      walBytes: fileBytes(`${path}-wal`),
      mainDatabaseBytes: fileBytes(path),
      result,
      snapshotSha256,
    };
    database.close();
    return sample;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function timingSummary(samples: readonly ExecutionSample[]): TimingSummary {
  const values = samples.map((sample) => sample.elapsedMilliseconds);
  const sorted = [...values].sort((first, second) => first - second);
  return {
    samplesMilliseconds: values,
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function invariantMetric(samples: readonly ExecutionSample[], key: keyof ExecutionSample): unknown {
  const first = samples[0]![key];
  for (const sample of samples) {
    assert.deepEqual(sample[key], first, `${String(key)} must be invariant`);
  }
  return first;
}

async function measureScale(configuration: Configuration, inputCount: number, scaleIndex: number) {
  for (let warmup = 0; warmup < configuration.warmupPairs; warmup++) {
    const order: Strategy[] =
      (warmup + scaleIndex) % 2 === 0 ? ["legacy-row-v1", "set-based-json-v1"] : ["set-based-json-v1", "legacy-row-v1"];
    for (const strategy of order) {
      await executeOnce(strategy, inputCount);
    }
  }

  const samples: Record<Strategy, ExecutionSample[]> = {
    "legacy-row-v1": [],
    "set-based-json-v1": [],
  };
  const pairOrders: Strategy[][] = [];
  for (let pair = 0; pair < configuration.samples; pair++) {
    const order: Strategy[] =
      (pair + scaleIndex) % 2 === 0 ? ["legacy-row-v1", "set-based-json-v1"] : ["set-based-json-v1", "legacy-row-v1"];
    pairOrders.push(order);
    for (const strategy of order) {
      samples[strategy].push(await executeOnce(strategy, inputCount));
    }
  }

  for (let index = 0; index < configuration.samples; index++) {
    const legacy = samples["legacy-row-v1"][index]!;
    const candidate = samples["set-based-json-v1"][index]!;
    assert.deepEqual(candidate.result, legacy.result, `result parity at scale ${inputCount}, pair ${index}`);
    assert.equal(
      candidate.snapshotSha256,
      legacy.snapshotSha256,
      `snapshot parity at scale ${inputCount}, pair ${index}`,
    );
  }

  const legacyTiming = timingSummary(samples["legacy-row-v1"]);
  const candidateTiming = timingSummary(samples["set-based-json-v1"]);
  const legacyCalls = Number(invariantMetric(samples["legacy-row-v1"], "calls"));
  const candidateCalls = Number(invariantMetric(samples["set-based-json-v1"], "calls"));
  return {
    inputCount,
    workload: {
      existingPendingOverlapCount: Math.ceil(inputCount / 4),
      expectedSuggestionCount: inputCount - Math.floor(inputCount / 4),
      expectedInsertCount: inputCount - Math.ceil(inputCount / 4),
      distinctProviderRestaurantIds: Math.min(inputCount, 64),
    },
    correctness: {
      exactResultParityEveryPair: true,
      exactCompleteTableSnapshotParityEveryPair: true,
      snapshotSha256: invariantMetric(samples["legacy-row-v1"], "snapshotSha256"),
      result: invariantMetric(samples["legacy-row-v1"], "result"),
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
    },
    pairOrders,
    strategies: {
      legacyRowV1: {
        timing: legacyTiming,
        calls: legacyCalls,
        getAllCalls: invariantMetric(samples["legacy-row-v1"], "getAllCalls"),
        runCalls: invariantMetric(samples["legacy-row-v1"], "runCalls"),
        transactions: invariantMetric(samples["legacy-row-v1"], "transactionCount"),
        parameterBytes: invariantMetric(samples["legacy-row-v1"], "parameterBytes"),
        walBytes: invariantMetric(samples["legacy-row-v1"], "walBytes"),
      },
      setBasedJsonV1: {
        timing: candidateTiming,
        calls: candidateCalls,
        getAllCalls: invariantMetric(samples["set-based-json-v1"], "getAllCalls"),
        runCalls: invariantMetric(samples["set-based-json-v1"], "runCalls"),
        transactions: invariantMetric(samples["set-based-json-v1"], "transactionCount"),
        parameterBytes: invariantMetric(samples["set-based-json-v1"], "parameterBytes"),
        walBytes: invariantMetric(samples["set-based-json-v1"], "walBytes"),
      },
    },
    comparison: {
      medianSpeedup: legacyTiming.medianMilliseconds / candidateTiming.medianMilliseconds,
      medianMillisecondsSaved: legacyTiming.medianMilliseconds - candidateTiming.medianMilliseconds,
      callReduction: legacyCalls - candidateCalls,
      callReductionPercent: ((legacyCalls - candidateCalls) / legacyCalls) * 100,
      candidateWonPairs: samples["legacy-row-v1"].filter(
        (legacy, index) => samples["set-based-json-v1"][index]!.elapsedMilliseconds < legacy.elapsedMilliseconds,
      ).length,
      pairCount: configuration.samples,
    },
  };
}

async function main(): Promise<void> {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }
  const scales = [];
  for (let index = 0; index < configuration.scales.length; index++) {
    scales.push(await measureScale(configuration, configuration.scales[index]!, index));
  }
  const report = {
    schemaVersion: 1,
    status: "ok",
    benchmark: "provider-reservation-import-persistence",
    generatedAt: new Date().toISOString(),
    configuration,
    source: {
      productionCoreSha256: sourceSha256("../utils/db/reservation-import-transaction-core.ts"),
      productionWiringSha256: sourceSha256("../utils/db/calendar.ts"),
      independentOracleSha256: sourceSha256("./test-reservation-import-persistence.ts"),
    },
    fixture: {
      deterministic: true,
      containsRealProviderData: false,
      intervalHours: 5,
      overlapPattern: "every fourth input has one pending visit at identical time and coordinates",
      suggestionPattern: "three of every four inputs carry one Michelin suggestion",
      capturesEstablished256Shape: configuration.scales.includes(256),
    },
    measurement: {
      includes: [
        "transaction begin/commit",
        "SQLite prepare, execute, and row decoding",
        "legacy JavaScript matching and row-by-row persistence",
        "candidate JavaScript planning, JSON serialization/parsing, and set persistence",
        "adapter call and bound-parameter instrumentation",
      ],
      excludes: [
        "fixture/database creation",
        "Expo SQLite asynchronous bridge and dedicated-connection setup",
        "React Native and Hermes",
        "provider fetch, geocoding, Michelin spatial matching, award lookup, duplicate auto-merge, and UI work",
      ],
      interpretation:
        "Node/V8 file-backed WAL SQLite timing is isolated evidence. Call reduction is structural; signed macOS app validation is required before promotion.",
    },
    scales,
  };
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configuration.outputPath, 0o600);
  console.log(JSON.stringify(report));
}

await main();
