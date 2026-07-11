#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  resolveReservationAwardsInBatches,
  type ReservationAwardLookupInput,
} from "../utils/reservation-award-batch-core.ts";

process.env.TZ = "America/Los_Angeles";

type Strategy = "legacy-per-match" | "batched-per-local-year";

interface Configuration {
  readonly scales: number[];
  readonly samples: number;
  readonly warmupPairs: number;
  readonly outputPath: string;
}

interface LookupMetrics {
  apiCalls: number;
  sqliteQueries: number;
  returnedRows: number;
  boundRestaurantIds: number;
}

interface Execution {
  readonly elapsedMilliseconds: number;
  readonly awards: Array<string | null>;
  readonly awardsSha256: string;
  readonly metrics: LookupMetrics;
}

const DEFAULT_CONFIGURATION: Configuration = {
  scales: [139, 256, 1_000, 5_000],
  samples: 7,
  warmupPairs: 2,
  outputPath: ".build/reservation-award-batching-profile.json",
};
const FIRST_YEAR = 2012;
const YEAR_COUNT = 15;
const RESTAURANT_COUNT = 128;

function usage(): string {
  return `Usage: benchmark-reservation-award-batching.ts [options]

  --scales=LIST    Comma-separated positive reservation counts (default: ${DEFAULT_CONFIGURATION.scales.join(",")})
  --samples=N      Measured pairs per scale (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup pairs per scale (default: ${DEFAULT_CONFIGURATION.warmupPairs})
  --output=PATH    Aggregate JSON report (default: ${DEFAULT_CONFIGURATION.outputPath})
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
  let scales = [...DEFAULT_CONFIGURATION.scales];
  let samples = DEFAULT_CONFIGURATION.samples;
  let warmupPairs = DEFAULT_CONFIGURATION.warmupPairs;
  let outputPath = DEFAULT_CONFIGURATION.outputPath;
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
      samples = parseInteger(value, option);
    } else if (option === "--warmup") {
      warmupPairs = parseInteger(value, option, true);
    } else if (option === "--scales") {
      scales = value.split(",").map((entry) => parseInteger(entry.trim(), option));
      if (new Set(scales).size !== scales.length) {
        throw new RangeError("--scales cannot contain duplicates.");
      }
    } else if (option === "--output") {
      if (!value) {
        throw new RangeError("--output cannot be empty.");
      }
      outputPath = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return { scales, samples, warmupPairs, outputPath };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function sourceSha256(relativePath: string): string {
  return sha256(readFileSync(new URL(relativePath, import.meta.url)));
}

function createFixtureDatabase(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE restaurant_awards (
      restaurant_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      distinction TEXT,
      green_star INTEGER,
      PRIMARY KEY (restaurant_id, year)
    );
    BEGIN;
  `);
  const distinctions = ["Three Stars", "Two Stars", "One Star", "Bib Gourmand", "Selected", ""];
  const insert = database.prepare(
    "INSERT INTO restaurant_awards (restaurant_id, year, distinction, green_star) VALUES (?, ?, ?, ?)",
  );
  for (let restaurantId = 1; restaurantId <= RESTAURANT_COUNT; restaurantId++) {
    for (let year = FIRST_YEAR - 2; year < FIRST_YEAR + YEAR_COUNT; year++) {
      insert.run(
        restaurantId,
        year,
        distinctions[(restaurantId + year) % distinctions.length],
        (restaurantId + year) % 13 === 0 ? 1 : 0,
      );
    }
  }
  database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
  database.close();
}

function createInputs(count: number): ReservationAwardLookupInput[] {
  const inputs: ReservationAwardLookupInput[] = [];
  let matchedOrdinal = 0;
  for (let index = 0; index < count; index++) {
    const localYear = FIRST_YEAR + (index % YEAR_COUNT);
    const startTime = new Date(localYear, index % 12, (index % 27) + 1, index % 24, index % 60, 0, 0).getTime();
    if (index % 4 === 3) {
      inputs.push({ restaurantId: null, startTime });
      continue;
    }
    const restaurantId =
      matchedOrdinal % 31 === 30
        ? `michelin-invalid-${matchedOrdinal % 3}`
        : `michelin-${(matchedOrdinal % RESTAURANT_COUNT) + 1}`;
    inputs.push({ restaurantId, startTime });
    matchedOrdinal += 1;
  }
  return inputs;
}

function formatAward(award: { distinction: string | null; green_star: number | null }): string | null {
  let value = award.distinction ?? "";
  if (award.green_star === 1) {
    value = value ? `${value}, Green Star` : "Green Star";
  }
  return value || null;
}

function queryAwards(
  database: DatabaseSync,
  restaurantIds: readonly string[],
  timestamp: number,
  metrics: LookupMetrics,
): Record<string, string | null> {
  const result: Record<string, string | null> = Object.fromEntries(restaurantIds.map((id) => [id, null]));
  const parsed: Array<{ id: string; databaseId: number }> = [];
  for (const restaurantId of restaurantIds) {
    const match = restaurantId.match(/^michelin-(\d+)$/);
    if (match) {
      parsed.push({ id: restaurantId, databaseId: Number(match[1]) });
    }
  }
  if (parsed.length === 0) {
    return result;
  }

  const databaseIds = [...new Set(parsed.map((entry) => entry.databaseId))];
  const placeholders = databaseIds.map(() => "?").join(", ");
  metrics.sqliteQueries += 1;
  metrics.boundRestaurantIds += databaseIds.length;
  const rows = database
    .prepare(
      `SELECT restaurant_id, year, distinction, green_star
       FROM restaurant_awards
       WHERE restaurant_id IN (${placeholders})
       ORDER BY restaurant_id ASC, year ASC`,
    )
    .all(...databaseIds) as Array<{
    restaurant_id: number;
    year: number;
    distinction: string | null;
    green_star: number | null;
  }>;
  metrics.returnedRows += rows.length;
  const byRestaurant = new Map<number, typeof rows>();
  for (const row of rows) {
    const awards = byRestaurant.get(row.restaurant_id);
    if (awards) {
      awards.push(row);
    } else {
      byRestaurant.set(row.restaurant_id, [row]);
    }
  }

  const visitYear = new Date(timestamp).getFullYear();
  for (const entry of parsed) {
    const awards = byRestaurant.get(entry.databaseId);
    if (!awards?.length) {
      continue;
    }
    let selected = awards[0]!;
    let foundHistorical = false;
    for (const award of awards) {
      if (award.year > visitYear) {
        break;
      }
      selected = award;
      foundHistorical = true;
    }
    result[entry.id] = formatAward(foundHistorical ? selected : awards[0]!);
  }
  return result;
}

async function queryAwardsAfterDatabasePromise(
  database: DatabaseSync,
  restaurantIds: readonly string[],
  timestamp: number,
  metrics: LookupMetrics,
): Promise<Record<string, string | null>> {
  // Production's valid-ID path awaits the cached Michelin database promise before
  // starting its SQLite request. Model that microtask boundary for both strategies;
  // node:sqlite execution itself remains synchronous and is called out in the report.
  if (restaurantIds.some((restaurantId) => /^michelin-\d+$/.test(restaurantId))) {
    const resolvedDatabase = await Promise.resolve(database);
    return queryAwards(resolvedDatabase, restaurantIds, timestamp, metrics);
  }
  return queryAwards(database, restaurantIds, timestamp, metrics);
}

async function executeStrategy(path: string, inputs: readonly ReservationAwardLookupInput[], strategy: Strategy) {
  const database = new DatabaseSync(path, { readOnly: true });
  const metrics: LookupMetrics = { apiCalls: 0, sqliteQueries: 0, returnedRows: 0, boundRestaurantIds: 0 };
  const start = performance.now();
  let awards: Array<string | null>;
  if (strategy === "legacy-per-match") {
    // Recreate the prior reservation-import orchestration: every input creates an
    // async task, while only Michelin-prefix matches call getAwardForDate().
    awards = await Promise.all(
      inputs.map(async (input) => {
        if (!input.restaurantId?.startsWith("michelin-")) {
          return null;
        }
        metrics.apiCalls += 1;
        const result = await queryAwardsAfterDatabasePromise(database, [input.restaurantId], input.startTime, metrics);
        return result[input.restaurantId] ?? null;
      }),
    );
  } else {
    awards = await resolveReservationAwardsInBatches(
      inputs,
      async (restaurantIds, timestamp) => {
        metrics.apiCalls += 1;
        return queryAwardsAfterDatabasePromise(database, restaurantIds, timestamp, metrics);
      },
      async (restaurantId, timestamp) => {
        metrics.apiCalls += 1;
        const result = await queryAwardsAfterDatabasePromise(database, [restaurantId], timestamp, metrics);
        return result[restaurantId] ?? null;
      },
    );
  }
  const elapsedMilliseconds = performance.now() - start;
  database.close();
  return {
    elapsedMilliseconds,
    awards,
    awardsSha256: sha256(JSON.stringify(awards)),
    metrics,
  } satisfies Execution;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summarize(samples: readonly Execution[]) {
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

function invariantMetrics(samples: readonly Execution[]): LookupMetrics {
  const first = samples[0]!.metrics;
  for (const sample of samples) {
    assert.deepEqual(sample.metrics, first);
  }
  return first;
}

async function measureScale(path: string, inputCount: number, scaleIndex: number, configuration: Configuration) {
  const inputs = createInputs(inputCount);
  const expected = await executeStrategy(path, inputs, "legacy-per-match");
  const candidateBeforeTiming = await executeStrategy(path, inputs, "batched-per-local-year");
  assert.deepEqual(candidateBeforeTiming.awards, expected.awards, `pre-timing parity for ${inputCount}`);

  for (let warmup = 0; warmup < configuration.warmupPairs; warmup++) {
    const order: Strategy[] =
      (scaleIndex + warmup) % 2 === 0
        ? ["legacy-per-match", "batched-per-local-year"]
        : ["batched-per-local-year", "legacy-per-match"];
    for (const strategy of order) {
      await executeStrategy(path, inputs, strategy);
    }
  }

  const samples: Record<Strategy, Execution[]> = {
    "legacy-per-match": [],
    "batched-per-local-year": [],
  };
  const pairOrders: Strategy[][] = [];
  for (let pair = 0; pair < configuration.samples; pair++) {
    const order: Strategy[] =
      (scaleIndex + pair) % 2 === 0
        ? ["legacy-per-match", "batched-per-local-year"]
        : ["batched-per-local-year", "legacy-per-match"];
    pairOrders.push(order);
    for (const strategy of order) {
      samples[strategy].push(await executeStrategy(path, inputs, strategy));
    }
  }

  for (let pair = 0; pair < configuration.samples; pair++) {
    assert.deepEqual(
      samples["batched-per-local-year"][pair]!.awards,
      samples["legacy-per-match"][pair]!.awards,
      `timed parity for ${inputCount}, pair ${pair}`,
    );
  }
  const legacyTiming = summarize(samples["legacy-per-match"]);
  const candidateTiming = summarize(samples["batched-per-local-year"]);
  const legacyMetrics = invariantMetrics(samples["legacy-per-match"]);
  const candidateMetrics = invariantMetrics(samples["batched-per-local-year"]);
  return {
    inputCount,
    workload: {
      matchedMichelinPrefixCount: inputs.filter((input) => input.restaurantId?.startsWith("michelin-")).length,
      unmatchedCount: inputs.filter((input) => !input.restaurantId?.startsWith("michelin-")).length,
      localYearCount: new Set(inputs.map((input) => new Date(input.startTime).getFullYear())).size,
      uniqueValidMichelinIds: new Set(
        inputs.flatMap((input) => (input.restaurantId?.match(/^michelin-\d+$/) ? [input.restaurantId] : [])),
      ).size,
    },
    correctness: {
      exactLegacyOutputParityBeforeTiming: true,
      exactLegacyOutputParityEveryPair: true,
      outputLength: expected.awards.length,
      outputSha256: expected.awardsSha256,
    },
    pairOrders,
    strategies: {
      legacyPerMatch: { timing: legacyTiming, ...legacyMetrics },
      batchedPerLocalYear: { timing: candidateTiming, ...candidateMetrics },
    },
    comparison: {
      apiCallReduction: legacyMetrics.apiCalls - candidateMetrics.apiCalls,
      apiCallReductionPercent: ((legacyMetrics.apiCalls - candidateMetrics.apiCalls) / legacyMetrics.apiCalls) * 100,
      sqliteQueryReduction: legacyMetrics.sqliteQueries - candidateMetrics.sqliteQueries,
      sqliteQueryReductionPercent:
        ((legacyMetrics.sqliteQueries - candidateMetrics.sqliteQueries) / legacyMetrics.sqliteQueries) * 100,
      medianSpeedup: legacyTiming.medianMilliseconds / candidateTiming.medianMilliseconds,
      medianMillisecondsSaved: legacyTiming.medianMilliseconds - candidateTiming.medianMilliseconds,
      candidateWonPairs: samples["legacy-per-match"].filter(
        (legacy, index) => samples["batched-per-local-year"][index]!.elapsedMilliseconds < legacy.elapsedMilliseconds,
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
  const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "palate-reservation-awards-"));
  const databasePath = join(directory, "michelin-awards.db");
  try {
    createFixtureDatabase(databasePath);
    const sourceBefore = { sha256: fileSha256(databasePath), bytes: statSync(databasePath).size };
    const scales = [];
    for (let index = 0; index < configuration.scales.length; index++) {
      scales.push(await measureScale(databasePath, configuration.scales[index]!, index, configuration));
    }
    const sourceAfter = { sha256: fileSha256(databasePath), bytes: statSync(databasePath).size };
    assert.deepEqual(sourceAfter, sourceBefore, "read-only fixture identity");
    assert.equal(statSync(databasePath).isFile(), true);
    const report = {
      schemaVersion: 1,
      status: "ok",
      benchmark: "provider-reservation-award-batching",
      generatedAt: new Date().toISOString(),
      configuration,
      source: {
        productionCoreSha256: sourceSha256("../utils/reservation-award-batch-core.ts"),
        productionWiringSha256: sourceSha256("../services/reservation-import.ts"),
        providerBatchReaderSha256: sourceSha256("../services/michelin.ts"),
        correctnessSuiteSha256: sourceSha256("./test-reservation-award-batching.ts"),
        fixtureMainFileByteIdentical: true,
        fixtureWalBytesAfterReads: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
        fixtureJournalBytesAfterReads: existsSync(`${databasePath}-journal`)
          ? statSync(`${databasePath}-journal`).size
          : 0,
      },
      fixture: {
        containsRealReservationOrGuideData: false,
        restaurantCount: RESTAURANT_COUNT,
        awardYearCount: YEAR_COUNT + 2,
        localYearCount: YEAR_COUNT,
        matchedPattern: "three of every four reservations",
        invalidMichelinPattern: "every thirty-first matched reservation",
      },
      measurement: {
        includes: [
          "Node/V8 async orchestration, including the legacy Promise.all(inputs.map(async ...)) fan-out",
          "one resolved cached-database-promise microtask yield before each valid lookup",
          "file-backed read-only node:sqlite statement prepare, execute, and row decoding",
          "award-history hydration and exact production-equivalent historical selection",
          "output assembly",
        ],
        excludes: [
          "Hermes and React Native runtime scheduling",
          "Expo SQLite bridge, asynchronous query execution, and queue scheduling; node:sqlite work remains synchronous after the modeled database-promise yield",
          "Michelin database open/initialization",
          "provider fetch, geocoding, spatial matching, persistence, auto-merge, and UI work",
          "rejected-batch single-lookup fallback, which the isolated correctness suite stress-tests instead",
        ],
        limitations: [
          "The legacy baseline recreates the former JavaScript Promise.all fan-out, but cannot reproduce Expo SQLite concurrency with synchronous node:sqlite.",
          "Synthetic fixture locality and host filesystem caches can differ from a user's Michelin database and macOS app runtime.",
          "Timing results isolate award lookup and output assembly; they are not end-to-end import latency predictions.",
        ],
        interpretation:
          "This isolated Node profile validates semantics, JavaScript orchestration cost, and structural call reduction; a signed macOS app measurement remains necessary for end-to-end latency.",
      },
      scales,
    };
    mkdirSync(dirname(configuration.outputPath), { recursive: true });
    writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configuration.outputPath, 0o600);
    console.log(JSON.stringify(report));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
