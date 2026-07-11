#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  matchReservationReviewCandidatesToSameDateConfirmedVisits,
  prepareReservationReviewPrefilter,
  readReservationReviewPrefilterSnapshotRows,
  type ReservationReviewPrefilterCandidate,
  type ReservationReviewPrefilterSnapshot,
} from "../utils/db/reservation-review-prefilter-core.ts";
import {
  emptyPrefilterHarnessMetrics,
  initializePrefilterDatabase,
  localTimestamp,
  runLiteralLegacyPrefilter,
  snapshotHash,
  type PrefilterHarnessMetrics,
} from "./test-reservation-review-prefilter.ts";

process.env.TZ = "America/Los_Angeles";

type Strategy = "legacy-autocommit-batches" | "snapshot-json-day-index";

interface Configuration {
  readonly scales: number[];
  readonly samples: number;
  readonly warmupPairs: number;
  readonly outputPath: string;
}

interface Execution {
  readonly elapsedMilliseconds: number;
  readonly outputHash: string;
  readonly snapshot: ReservationReviewPrefilterSnapshot;
  readonly metrics: PrefilterHarnessMetrics;
}

const DEFAULT_CONFIGURATION: Configuration = {
  scales: [139, 256, 1_000, 5_000],
  samples: 7,
  warmupPairs: 1,
  outputPath: ".build/reservation-review-prefilter-profile.json",
};
const HISTORY_COUNT = 6_511;
const DISTINCT_REQUESTED_DAY_COUNT = 139;
const FIRST_HISTORY_TIME = localTimestamp(2011, 1, 1, 19);
const DAY = 24 * 60 * 60 * 1_000;

function usage(): string {
  return `Usage: benchmark-reservation-review-prefilter.ts [options]

  --scales=LIST    Positive candidate counts (default: ${DEFAULT_CONFIGURATION.scales.join(",")})
  --samples=N      Measured counterbalanced pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup pairs (default: ${DEFAULT_CONFIGURATION.warmupPairs})
  --output=PATH    Aggregate JSON report (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help`;
}

function parsePositiveInteger(value: string, option: string, allowZero = false): number {
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
  let configuration = { ...DEFAULT_CONFIGURATION, scales: [...DEFAULT_CONFIGURATION.scales] };
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
    if (option === "--scales") {
      const scales = value.split(",").map((entry) => parsePositiveInteger(entry.trim(), option));
      if (new Set(scales).size !== scales.length) {
        throw new RangeError("--scales cannot contain duplicates.");
      }
      configuration = { ...configuration, scales };
    } else if (option === "--samples") {
      configuration = { ...configuration, samples: parsePositiveInteger(value, option) };
    } else if (option === "--warmup") {
      configuration = { ...configuration, warmupPairs: parsePositiveInteger(value, option, true) };
    } else if (option === "--output") {
      if (!value) {
        throw new RangeError("--output cannot be empty.");
      }
      configuration = { ...configuration, outputPath: value };
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function sqlValues(parameters: readonly (string | number | null)[]): SQLInputValue[] {
  return parameters as SQLInputValue[];
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSha256(relativePath: string): string {
  return sha256(readFileSync(new URL(relativePath, import.meta.url)));
}

function percentile(values: readonly number[], fraction: number): number {
  assert(values.length > 0);
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

function makeCandidates(scale: number): ReservationReviewPrefilterCandidate[] {
  return Array.from({ length: scale }, (_, index) => {
    const requestedDayOrdinal = index % DISTINCT_REQUESTED_DAY_COUNT;
    const historyOrdinal = Math.floor((requestedDayOrdinal * (HISTORY_COUNT - 1)) / (DISTINCT_REQUESTED_DAY_COUNT - 1));
    const matchMode = index % 4;
    const baseName = `Restaurant ${historyOrdinal % 512}`;
    return {
      sourceEventId: `benchmark-source-${scale}-${index}`,
      sourceName: index % 2 === 0 ? "resy" : "opentable",
      restaurantName:
        matchMode === 2 ? `${baseName} Dinner via Resy` : matchMode === 3 ? `No Match ${index}` : baseName,
      startTime: FIRST_HISTORY_TIME + historyOrdinal * DAY,
      restaurantId: matchMode === 0 ? `restaurant-${historyOrdinal % 512}` : null,
    };
  });
}

function seedFixture(database: DatabaseSync, candidates: readonly ReservationReviewPrefilterCandidate[]): void {
  initializePrefilterDatabase(database);
  database.exec("BEGIN");
  try {
    const restaurant = database.prepare("INSERT OR IGNORE INTO restaurants (id, name) VALUES (?, ?)");
    const visit = database.prepare(
      `INSERT INTO visits (
         id, restaurantId, status, startTime, endTime, calendarEventTitle
       ) VALUES (?, ?, 'confirmed', ?, ?, ?)`,
    );
    for (let index = 0; index < 512; index++) {
      restaurant.run(`restaurant-${index}`, `Restaurant ${index}`);
    }
    for (let index = 0; index < HISTORY_COUNT; index++) {
      const startTime = FIRST_HISTORY_TIME + index * DAY;
      visit.run(
        `history-${index}`,
        `restaurant-${index % 512}`,
        startTime,
        startTime + 2 * 60 * 60 * 1_000,
        index % 11 === 0 ? `Restaurant ${index % 512} Dinner` : null,
      );
    }

    const dismissed = database.prepare("INSERT INTO dismissed_reservation_import_sources VALUES (?, ?)");
    const source = database.prepare("INSERT INTO reservation_import_sources VALUES (?, ?, ?, ?)");
    const legacy = database.prepare(
      `INSERT INTO visits (
         id, status, startTime, endTime, calendarEventId, calendarEventTitle
       ) VALUES (?, 'confirmed', ?, ?, ?, ?)`,
    );
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      if (index % 17 === 0) {
        dismissed.run(candidate.sourceEventId, index + 1);
      }
      if (index % 23 === 0) {
        source.run(candidate.sourceEventId, candidate.sourceName, `history-${index % HISTORY_COUNT}`, index + 1);
      }
      if (index % 29 === 0) {
        legacy.run(
          `legacy-${index}`,
          candidate.startTime,
          candidate.startTime + 60 * 60 * 1_000,
          candidate.sourceEventId,
          `Legacy ${index}`,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function runOptimized(
  database: DatabaseSync,
  candidates: readonly ReservationReviewPrefilterCandidate[],
): Promise<Execution> {
  const metrics = emptyPrefilterHarnessMetrics();
  const prepared = prepareReservationReviewPrefilter(candidates);
  const started = performance.now();
  database.exec("BEGIN");
  let rows;
  try {
    rows = await readReservationReviewPrefilterSnapshotRows(
      {
        getAllAsync: async <Row>(sql: string, parameters: Array<string | number | null>) => {
          metrics.queryCalls += 1;
          metrics.parameterBytes += bytes(parameters);
          const result = database.prepare(sql).all(...sqlValues(parameters)) as Row[];
          metrics.returnedRows += result.length;
          metrics.returnedBytes += bytes(result);
          return result;
        },
      },
      prepared,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const sameDate = matchReservationReviewCandidatesToSameDateConfirmedVisits(
    rows.sameDateCandidates,
    rows.confirmedVisitRows,
  );
  metrics.nameNormalizations = sameDate.metrics.normalizedNameCount;
  metrics.fuzzyNameComparisons = sameDate.metrics.fuzzyNameComparisonCount;
  const snapshot: ReservationReviewPrefilterSnapshot = {
    dismissedSourceEventIds: rows.dismissedSourceEventIds,
    excludedSourceEventIds: rows.excludedSourceEventIds,
    exactConfirmedSourceEventIds: rows.exactConfirmedSourceEventIds,
    sameDateConfirmedSourceEventIds: sameDate.sourceEventIds,
  };
  return {
    elapsedMilliseconds: performance.now() - started,
    outputHash: snapshotHash(snapshot),
    snapshot,
    metrics,
  };
}

function runLegacy(database: DatabaseSync, candidates: readonly ReservationReviewPrefilterCandidate[]): Execution {
  const started = performance.now();
  const result = runLiteralLegacyPrefilter(database, candidates);
  return {
    elapsedMilliseconds: performance.now() - started,
    outputHash: snapshotHash(result.snapshot),
    snapshot: result.snapshot,
    metrics: result.metrics,
  };
}

async function runStrategy(
  strategy: Strategy,
  database: DatabaseSync,
  candidates: readonly ReservationReviewPrefilterCandidate[],
): Promise<Execution> {
  return strategy === "legacy-autocommit-batches"
    ? runLegacy(database, candidates)
    : runOptimized(database, candidates);
}

function assertOutputsEqual(first: Execution, second: Execution, label: string): void {
  assert.equal(first.outputHash, second.outputHash, `${label}: exact output hashes`);
}

async function benchmarkScale(scale: number, configuration: Configuration): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(tmpdir(), `palate-review-prefilter-${scale}-`));
  const databasePath = join(directory, "fixture.db");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    const candidates = makeCandidates(scale);
    seedFixture(database, candidates);
    const preflightLegacy = runLegacy(database, candidates);
    const preflightOptimized = await runOptimized(database, candidates);
    assertOutputsEqual(preflightLegacy, preflightOptimized, `scale ${scale} preflight`);

    const measured: Record<Strategy, Execution[]> = {
      "legacy-autocommit-batches": [],
      "snapshot-json-day-index": [],
    };
    const pairCount = configuration.warmupPairs + configuration.samples;
    for (let pair = 0; pair < pairCount; pair++) {
      const order: Strategy[] =
        pair % 2 === 0
          ? ["legacy-autocommit-batches", "snapshot-json-day-index"]
          : ["snapshot-json-day-index", "legacy-autocommit-batches"];
      const pairResults: Execution[] = [];
      for (const strategy of order) {
        const execution = await runStrategy(strategy, database, candidates);
        pairResults.push(execution);
        if (pair >= configuration.warmupPairs) {
          measured[strategy].push(execution);
        }
      }
      assertOutputsEqual(pairResults[0]!, pairResults[1]!, `scale ${scale} pair ${pair}`);
    }

    const summarize = (strategy: Strategy) => {
      const runs = measured[strategy];
      const timings = runs.map(({ elapsedMilliseconds }) => elapsedMilliseconds);
      const reference = runs[0]!;
      for (const run of runs) {
        assert.equal(run.outputHash, reference.outputHash);
        assert.deepEqual(run.metrics, reference.metrics);
      }
      return {
        medianMilliseconds: median(timings),
        p95Milliseconds: percentile(timings, 0.95),
        minimumMilliseconds: Math.min(...timings),
        maximumMilliseconds: Math.max(...timings),
        metrics: reference.metrics,
      };
    };
    const legacy = summarize("legacy-autocommit-batches");
    const optimized = summarize("snapshot-json-day-index");
    return {
      candidateCount: scale,
      confirmedHistoryRows: HISTORY_COUNT,
      distinctRequestedDays: Math.min(scale, DISTINCT_REQUESTED_DAY_COUNT),
      exactOutputSha256: preflightOptimized.outputHash,
      legacy,
      optimized,
      structural: {
        queryCallReduction: preflightLegacy.metrics.queryCalls - preflightOptimized.metrics.queryCalls,
        returnedRowReduction: preflightLegacy.metrics.returnedRows - preflightOptimized.metrics.returnedRows,
        returnedByteReduction: preflightLegacy.metrics.returnedBytes - preflightOptimized.metrics.returnedBytes,
        localDateComparisonReduction:
          preflightLegacy.metrics.localDateComparisons - preflightOptimized.metrics.localDateComparisons,
        nameNormalizationReduction:
          preflightLegacy.metrics.nameNormalizations - preflightOptimized.metrics.nameNormalizations,
        fuzzyNameComparisonReduction:
          preflightLegacy.metrics.fuzzyNameComparisons - preflightOptimized.metrics.fuzzyNameComparisons,
        medianSpeedupRatio: legacy.medianMilliseconds / optimized.medianMilliseconds,
      },
    };
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }
  const scaleReports: Record<string, unknown>[] = [];
  for (const scale of configuration.scales) {
    scaleReports.push(await benchmarkScale(scale, configuration));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration,
    fixture: {
      storage: "disposable file-backed node:sqlite WAL database",
      timezone: process.env.TZ,
      confirmedHistoryRows: HISTORY_COUNT,
      firstHistoryLocalDate: new Date(FIRST_HISTORY_TIME).toString(),
      distinctRequestedDayLimit: DISTINCT_REQUESTED_DAY_COUNT,
    },
    sourceSha256: {
      core: sourceSha256("../utils/db/reservation-review-prefilter-core.ts"),
      oracle: sourceSha256("./test-reservation-review-prefilter.ts"),
      benchmark: sourceSha256("./benchmark-reservation-review-prefilter.ts"),
    },
    scales: scaleReports,
    caveats: [
      "Node/V8 node:sqlite is synchronous and does not model Expo SQLite scheduling, its asynchronous bridge, Hermes, React rendering, Places, Photos, Calendar, or live app UI.",
      "Fixtures are synthetic and contain no identifiers, names, events, photos, or database rows from the user's Mac.",
      "Raw elapsed time is descriptive; query-call, row, byte, and comparison reductions are the portable evidence.",
      "The benchmark covers one provider-review snapshot invocation; the service's fresh unresolved-candidate snapshot and intentionally preserved located confirmed/overlap recheck are outside the timed region.",
    ],
  };
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configuration.outputPath, 0o600);
  const reportHash = sha256(readFileSync(configuration.outputPath));
  console.log(`Reservation review prefilter benchmark: ${configuration.outputPath}`);
  console.log(`Report SHA-256: ${reportHash}`);
  for (const scale of scaleReports) {
    const structural = scale.structural as { medianSpeedupRatio: number; queryCallReduction: number };
    console.log(
      `${String(scale.candidateCount)} candidates: ${structural.medianSpeedupRatio.toFixed(2)}x median; ${structural.queryCallReduction} fewer SELECTs`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
