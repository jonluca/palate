#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildVisitPhotoSampleStatement,
  FOOD_DETECTION_VISIT_SAMPLES_SQL,
  parseFoodDetectionVisitSampleRows,
  VISIT_PHOTO_SAMPLE_BATCH_SIZE,
  type FoodDetectionVisitSample,
  type FoodDetectionVisitSamplePlan,
  type FoodDetectionVisitSampleRow,
} from "../utils/db/visit-photo-sampling-core.ts";

interface Configuration {
  readonly visits: number;
  readonly photos: number;
  readonly samplePercentage: number;
  readonly samples: number;
  readonly warmupIterations: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 5_000,
  photos: 68_027,
  samplePercentage: 0.2,
  samples: 15,
  warmupIterations: 2,
};

function usage(): string {
  return `Usage: benchmark-visit-photo-sampling.ts [options]

  --visits=N               Visit rows (default: ${DEFAULT_CONFIGURATION.visits})
  --photos=N               Photo rows; must be at least visits (default: ${DEFAULT_CONFIGURATION.photos})
  --sample-percentage=N    Fraction used for each visit sample (default: ${DEFAULT_CONFIGURATION.samplePercentage})
  --samples=N              Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N               Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --help, -h               Show this help`;
}

function positiveInteger(value: string | undefined, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function finiteNumber(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === "--") {
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  const known = new Set(["visits", "photos", "sample-percentage", "samples", "warmup"]);
  for (const key of values.keys()) {
    if (!known.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  const configuration: Configuration = {
    visits: values.has("visits") ? positiveInteger(values.get("visits"), "--visits") : DEFAULT_CONFIGURATION.visits,
    photos: values.has("photos") ? positiveInteger(values.get("photos"), "--photos") : DEFAULT_CONFIGURATION.photos,
    samplePercentage: values.has("sample-percentage")
      ? finiteNumber(values.get("sample-percentage"), "--sample-percentage")
      : DEFAULT_CONFIGURATION.samplePercentage,
    samples: values.has("samples")
      ? positiveInteger(values.get("samples"), "--samples")
      : DEFAULT_CONFIGURATION.samples,
    warmupIterations: values.has("warmup")
      ? positiveInteger(values.get("warmup"), "--warmup", true)
      : DEFAULT_CONFIGURATION.warmupIterations,
  };
  if (configuration.photos < configuration.visits) {
    throw new Error("--photos must be at least --visits so every fixture visit has an unanalyzed photo.");
  }
  return configuration;
}

function visitId(index: number): string {
  return `visit-${index.toString().padStart(5, "0")}`;
}

function photoId(index: number): string {
  return `photo-${index.toString().padStart(6, "0")}`;
}

function createDatabase(configuration: Configuration): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      startTime INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      creationTime INTEGER NOT NULL,
      foodDetected INTEGER,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_visits_time ON visits(startTime);
    BEGIN;
  `);

  const insertVisit = database.prepare("INSERT INTO visits (id, startTime, payload) VALUES (?, ?, ?)");
  for (let index = 0; index < configuration.visits; index++) {
    insertVisit.run(visitId(index), 2_000_000_000_000 - index * 60_000, `visit-sentinel-${index}`);
  }

  const insertPhoto = database.prepare(
    `INSERT INTO photos (id, visitId, creationTime, foodDetected, payload)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const photoCounts = new Uint32Array(configuration.visits);
  let photoIndex = 0;
  // Guarantee every visit is eligible and exercise the at-least-one rule.
  for (let visitIndex = 0; visitIndex < configuration.visits; visitIndex++) {
    insertPhoto.run(
      photoId(photoIndex),
      visitId(visitIndex),
      1_700_000_000_000 + photoIndex,
      null,
      `photo-sentinel-${photoIndex}`,
    );
    photoCounts[visitIndex] += 1;
    photoIndex += 1;
  }

  // A deterministic bounded skew sends one in five extra photos to the first
  // decile while distributing the rest globally. This keeps a realistic tail
  // without allowing one synthetic visit to dominate the entire dataset.
  let randomState = 0x51f15e;
  while (photoIndex < configuration.photos) {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    const unit = randomState / 0x1_0000_0000;
    const visitRange = photoIndex % 5 === 0 ? Math.max(1, Math.floor(configuration.visits / 10)) : configuration.visits;
    const visitIndex = Math.min(configuration.visits - 1, Math.floor(unit * visitRange));
    const ordinalInVisit = photoCounts[visitIndex];
    insertPhoto.run(
      photoId(photoIndex),
      visitId(visitIndex),
      1_700_000_000_000 + ordinalInVisit * 10_000 + (photoIndex % 7),
      null,
      photoIndex === configuration.visits + 7 ? "photo-sentinel-雪-'quoted'" : `photo-sentinel-${photoIndex}`,
    );
    photoCounts[visitIndex] += 1;
    photoIndex += 1;
  }
  database.exec("COMMIT");
  return database;
}

function legacyPlan(database: DatabaseSync, samplePercentage: number): FoodDetectionVisitSamplePlan {
  const visits = database
    .prepare(
      `SELECT v.id FROM visits AS v
       WHERE EXISTS (
         SELECT 1 FROM photos AS photo
         WHERE photo.visitId = v.id AND photo.foodDetected IS NULL
       )
       ORDER BY v.startTime DESC, v.id ASC`,
    )
    .all() as Array<{ id: string }>;
  const samples: FoodDetectionVisitSample[] = [];
  for (const visit of visits) {
    const rows = database
      .prepare(
        `SELECT id FROM photos
         WHERE visitId = ? AND foodDetected IS NULL
         ORDER BY creationTime ASC, id ASC
         LIMIT MAX(1, CAST((SELECT COUNT(*) FROM photos WHERE visitId = ?) * ? AS INTEGER))`,
      )
      .all(visit.id, visit.id, samplePercentage) as Array<{ id: string }>;
    samples.push(...rows.map(({ id }, index) => ({ visitId: visit.id, photoId: id, sampleRank: index + 1 })));
  }
  return { totalVisits: visits.length, samples };
}

function combinedPlan(database: DatabaseSync, samplePercentage: number): FoodDetectionVisitSamplePlan {
  const rows = database
    .prepare(FOOD_DETECTION_VISIT_SAMPLES_SQL)
    .all(samplePercentage) as unknown as FoodDetectionVisitSampleRow[];
  return parseFoodDetectionVisitSampleRows(rows);
}

function chunkedPlan(database: DatabaseSync, samplePercentage: number): FoodDetectionVisitSamplePlan {
  const visits = database
    .prepare(
      `SELECT v.id FROM visits AS v
       WHERE EXISTS (
         SELECT 1 FROM photos AS photo
         WHERE photo.visitId = v.id AND photo.foodDetected IS NULL
       )
       ORDER BY v.startTime DESC, v.id ASC`,
    )
    .all() as Array<{ id: string }>;
  const samples: FoodDetectionVisitSample[] = [];
  for (let offset = 0; offset < visits.length; offset += VISIT_PHOTO_SAMPLE_BATCH_SIZE) {
    const statement = buildVisitPhotoSampleStatement(
      visits.slice(offset, offset + VISIT_PHOTO_SAMPLE_BATCH_SIZE).map(({ id }) => id),
      samplePercentage,
    );
    const rows = database.prepare(statement.sql).all(...statement.parameters) as unknown as FoodDetectionVisitSample[];
    samples.push(...rows.map(({ visitId, photoId, sampleRank }) => ({ visitId, photoId, sampleRank })));
  }
  return { totalVisits: visits.length, samples };
}

function updateChecksum(checksum: number, value: string): number {
  let updated = checksum;
  for (let index = 0; index < value.length; index++) {
    updated ^= value.charCodeAt(index);
    updated = Math.imul(updated, 16_777_619) >>> 0;
  }
  return updated;
}

function planChecksum(plan: FoodDetectionVisitSamplePlan): string {
  let checksum = updateChecksum(2_166_136_261, `${plan.totalVisits}\0${plan.samples.length}\0`);
  for (const sample of plan.samples) {
    checksum = updateChecksum(checksum, `${sample.visitId}\0${sample.photoId}\0${sample.sampleRank}\0`);
  }
  return checksum.toString(16).padStart(8, "0");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(values: readonly number[]): MeasurementSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMilliseconds: values.map(rounded),
    minimumMilliseconds: rounded(sorted[0]),
    medianMilliseconds: rounded(median(values)),
    p95Milliseconds: rounded(percentile95(values)),
    maximumMilliseconds: rounded(sorted[sorted.length - 1]),
  };
}

function measure(select: () => FoodDetectionVisitSamplePlan, expectedChecksum: string): number {
  const startedAt = performance.now();
  const plan = select();
  const elapsed = performance.now() - startedAt;
  assert.equal(planChecksum(plan), expectedChecksum, "timed sampling result changed");
  return elapsed;
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const database = createDatabase(configuration);
try {
  const expected = legacyPlan(database, configuration.samplePercentage);
  assert.deepEqual(
    chunkedPlan(database, configuration.samplePercentage),
    expected,
    "chunked sampling query differed from the N+1 reference",
  );
  assert.deepEqual(
    combinedPlan(database, configuration.samplePercentage),
    expected,
    "combined sampling query differed from the N+1 reference",
  );
  const expectedChecksum = planChecksum(expected);
  const legacySelect = () => legacyPlan(database, configuration.samplePercentage);
  const chunkedSelect = () => chunkedPlan(database, configuration.samplePercentage);
  const combinedSelect = () => combinedPlan(database, configuration.samplePercentage);

  for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
    const strategies =
      warmup % 2 === 0 ? [legacySelect, chunkedSelect, combinedSelect] : [combinedSelect, chunkedSelect, legacySelect];
    for (const select of strategies) {
      assert.equal(planChecksum(select()), expectedChecksum);
    }
  }

  const legacySamples: number[] = [];
  const chunkedSamples: number[] = [];
  const combinedSamples: number[] = [];
  const measurementOrder: string[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    const strategies = [
      { name: "legacy", select: legacySelect, samples: legacySamples },
      { name: "chunked", select: chunkedSelect, samples: chunkedSamples },
      { name: "combined", select: combinedSelect, samples: combinedSamples },
    ];
    const rotation = sample % strategies.length;
    const ordered = [...strategies.slice(rotation), ...strategies.slice(0, rotation)];
    measurementOrder.push(ordered.map(({ name }) => name).join("-then-"));
    for (const strategy of ordered) {
      strategy.samples.push(measure(strategy.select, expectedChecksum));
    }
  }

  const legacy = summarize(legacySamples);
  const chunked = summarize(chunkedSamples);
  const combined = summarize(combinedSamples);
  const sqliteVersion = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  const visitPhotoCounts = database
    .prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId IS NOT NULL GROUP BY visitId ORDER BY count ASC")
    .all()
    .map(({ count }) => Number(count));
  const percentile = (fraction: number) =>
    visitPhotoCounts[Math.min(visitPhotoCounts.length - 1, Math.floor((visitPhotoCounts.length - 1) * fraction))];
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        status: "ok",
        runtime: { node: process.version, sqlite: sqliteVersion },
        configuration,
        dataset: {
          visitRows: configuration.visits,
          photoRows: configuration.photos,
          unanalyzedPhotoRows: configuration.photos,
          eligibleVisits: expected.totalVisits,
          selectedPhotoRows: expected.samples.length,
          visitPhotoDistribution: {
            shape: "deterministic bounded skew",
            minimum: visitPhotoCounts[0],
            p50: percentile(0.5),
            p95: percentile(0.95),
            maximum: visitPhotoCounts.at(-1),
          },
        },
        correctness: {
          exactOrderedResultParity: true,
          checksum: expectedChecksum,
          resultValidatedAfterEveryRun: true,
        },
        algorithms: {
          legacy: "one eligible-visits query plus one deterministic LIMIT query per eligible visit",
          chunked: `${VISIT_PHOTO_SAMPLE_BATCH_SIZE}-visit CTE batches using per-visit indexes`,
          combined: "one production global CTE query with counts and per-visit ROW_NUMBER ranking",
        },
        timingScope:
          "isolated Node/V8 plus in-memory SQLite; excludes Expo async promise and React Native bridge overhead",
        queryCallsPerRun: {
          legacy: expected.totalVisits + 1,
          chunked: Math.ceil(expected.totalVisits / VISIT_PHOTO_SAMPLE_BATCH_SIZE) + 1,
          combined: 1,
          productionEliminated: expected.totalVisits,
        },
        estimatedExpoAsyncNativeOperationsPerRun: {
          legacyPrepareExecuteReadFinalize: (expected.totalVisits + 1) * 4,
          productionPrepareExecuteReadFinalize: 4,
        },
        measurementOrder,
        legacyNPlusOne: legacy,
        chunkedSetBasedAlternative: chunked,
        combinedGlobalProduction: combined,
        productionNativeSqliteRatio: Number((legacy.medianMilliseconds / combined.medianMilliseconds).toFixed(2)),
        breakEvenPerEliminatedQueryMicroseconds: Number(
          (
            (Math.max(0, combined.medianMilliseconds - legacy.medianMilliseconds) / expected.totalVisits) *
            1_000
          ).toFixed(3),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
