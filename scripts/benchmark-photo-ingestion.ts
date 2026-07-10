#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  buildPhotoIngestionStatement,
  getPhotoIngestionFlushCount,
  type PhotoIngestionRecord,
} from "../utils/db/photo-ingestion-core.ts";

interface Configuration {
  photos: number;
  pageSize: number;
  preexistingPhotos: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface StoredPhotoRow extends PhotoIngestionRecord {
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly changes: number;
  readonly calls: number;
  readonly checksum: string;
  readonly boundParameters: number;
}

type Strategy = "legacyPageAutocommit" | "bufferedBoundInsert";

const DEFAULT_CONFIGURATION: Configuration = {
  photos: 68_030,
  pageSize: 2_000,
  preexistingPhotos: 257,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/photo-ingestion-profile.json",
};

function usage(): string {
  return `Usage: benchmark-photo-ingestion.ts [options]

  --photos=N       Input metadata rows (default: ${DEFAULT_CONFIGURATION.photos})
  --page-size=N    PhotoKit page size (default: ${DEFAULT_CONFIGURATION.pageSize})
  --preexisting=N  Existing rows that INSERT OR IGNORE must retain (default: ${DEFAULT_CONFIGURATION.preexistingPhotos})
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
      case "--photos":
        configuration.photos = parseInteger(value, option);
        break;
      case "--page-size":
        configuration.pageSize = parseInteger(value, option);
        break;
      case "--preexisting":
        configuration.preexistingPhotos = parseInteger(value, option, true);
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
  if (configuration.preexistingPhotos > configuration.photos) {
    throw new RangeError("--preexisting cannot exceed --photos.");
  }
  return configuration;
}

function makePhoto(index: number): PhotoIngestionRecord {
  return {
    id: index === 0 ? "photo-O'Brien-雪" : `photo-${index.toString().padStart(6, "0")}`,
    uri: index === 1 ? 'ph://雪/"quoted"/line\nbreak' : `ph://asset-${index}/L0/001`,
    creationTime: 1_700_000_000_000 + Math.floor(index / 3),
    latitude: index % 9 === 0 ? null : index % 19 === 0 ? 0 : 34 + (index % 500) / 10_000,
    longitude: index % 9 === 0 ? null : index % 23 === 0 ? 0 : -118 - (index % 500) / 10_000,
    mediaType: index % 13 === 0 ? "video" : "photo",
    duration: index % 13 === 0 ? (index % 26 === 0 ? 0 : (index % 300) / 10) : null,
  };
}

function createExpectedRows(photos: readonly PhotoIngestionRecord[], preexistingCount: number): StoredPhotoRow[] {
  const rows = new Map<string, StoredPhotoRow>();
  for (let index = 0; index < preexistingCount; index++) {
    const photo = photos[index]!;
    rows.set(photo.id, {
      id: photo.id,
      uri: `ph://preexisting-${index}`,
      creationTime: photo.creationTime,
      latitude: photo.latitude,
      longitude: photo.longitude,
      visitId: `existing-visit-${index % 17}`,
      foodDetected: index % 2,
      foodLabels: JSON.stringify([{ label: `sentinel-${index}`, confidence: 0.8 }]),
      foodConfidence: 0.8,
      allLabels: JSON.stringify([{ label: "sentinel", confidence: 0.9 }]),
      mediaType: photo.mediaType,
      duration: photo.duration,
    });
  }
  for (const photo of photos) {
    if (!rows.has(photo.id)) {
      rows.set(photo.id, {
        id: photo.id,
        uri: photo.uri,
        creationTime: photo.creationTime,
        latitude: photo.latitude,
        longitude: photo.longitude,
        visitId: null,
        foodDetected: null,
        foodLabels: null,
        foodConfidence: null,
        allLabels: null,
        mediaType: photo.mediaType,
        duration: photo.duration,
      });
    }
  }
  return [...rows.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function createDatabase(
  photos: readonly PhotoIngestionRecord[],
  preexistingCount: number,
): {
  database: DatabaseSync;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "palate-photo-ingestion-"));
  const database = new DatabaseSync(join(directory, "profile.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;
    PRAGMA wal_autocheckpoint = 10000;
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      mediaType TEXT DEFAULT 'photo',
      duration REAL
    );
  `);
  const insert = database.prepare(
    `INSERT INTO photos (
      id, uri, creationTime, latitude, longitude, visitId, foodDetected,
      foodLabels, foodConfidence, allLabels, mediaType, duration
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < preexistingCount; index++) {
      const photo = photos[index]!;
      insert.run(
        photo.id,
        `ph://preexisting-${index}`,
        photo.creationTime,
        photo.latitude,
        photo.longitude,
        `existing-visit-${index % 17}`,
        index % 2,
        JSON.stringify([{ label: `sentinel-${index}`, confidence: 0.8 }]),
        0.8,
        JSON.stringify([{ label: "sentinel", confidence: 0.9 }]),
        photo.mediaType,
        photo.duration,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { database, directory };
}

function snapshot(database: DatabaseSync): StoredPhotoRow[] {
  return database
    .prepare(
      `SELECT
        id, uri, creationTime, latitude, longitude, visitId, foodDetected,
        foodLabels, foodConfidence, allLabels, mediaType, duration
       FROM photos
       ORDER BY id ASC`,
    )
    .all()
    .map((row) => ({ ...row })) as unknown as StoredPhotoRow[];
}

function checksum(rows: readonly StoredPhotoRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function runLegacy(
  database: DatabaseSync,
  photos: readonly PhotoIngestionRecord[],
  pageSize: number,
): {
  changes: number;
  calls: number;
} {
  let changes = 0;
  let calls = 0;
  for (let pageOffset = 0; pageOffset < photos.length; pageOffset += pageSize) {
    const page = photos.slice(pageOffset, pageOffset + pageSize);
    for (let batchOffset = 0; batchOffset < page.length; batchOffset += 1_000) {
      const batch = page.slice(batchOffset, batchOffset + 1_000);
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
      const values = batch.flatMap((photo) => [
        photo.id,
        photo.uri,
        photo.creationTime,
        photo.latitude,
        photo.longitude,
        photo.mediaType,
        photo.duration,
      ]);
      changes += Number(
        database
          .prepare(
            `INSERT OR IGNORE INTO photos (
              id, uri, creationTime, latitude, longitude, mediaType, duration
            ) VALUES ${placeholders}`,
          )
          .run(...values).changes,
      );
      calls++;
    }
  }
  return { changes, calls };
}

function runCandidate(
  database: DatabaseSync,
  photos: readonly PhotoIngestionRecord[],
  pageSize: number,
): {
  changes: number;
  calls: number;
  boundParameters: number;
} {
  const pending: PhotoIngestionRecord[] = [];
  let changes = 0;
  let calls = 0;
  let boundParameters = 0;

  const flush = (force: boolean) => {
    let flushCount = getPhotoIngestionFlushCount(pending.length, force);
    while (flushCount > 0) {
      const rows = pending.slice(0, flushCount);
      const statement = buildPhotoIngestionStatement(rows);
      assert.ok(statement);
      changes += Number(database.prepare(statement.sql).run(...statement.parameters).changes);
      calls++;
      boundParameters += statement.parameters.length;
      pending.splice(0, flushCount);
      flushCount = getPhotoIngestionFlushCount(pending.length, force);
    }
  };

  for (let pageOffset = 0; pageOffset < photos.length; pageOffset += pageSize) {
    pending.push(...photos.slice(pageOffset, pageOffset + pageSize));
    flush(false);
  }
  flush(true);
  assert.equal(pending.length, 0);
  return { changes, calls, boundParameters };
}

function measure(
  strategy: Strategy,
  configuration: Configuration,
  photos: readonly PhotoIngestionRecord[],
  expectedChecksum: string,
  expectedChanges: number,
): Measurement {
  const { database, directory } = createDatabase(photos, configuration.preexistingPhotos);
  try {
    const startedAt = performance.now();
    const result =
      strategy === "legacyPageAutocommit"
        ? { ...runLegacy(database, photos, configuration.pageSize), boundParameters: configuration.photos * 7 }
        : runCandidate(database, photos, configuration.pageSize);
    const elapsedMilliseconds = performance.now() - startedAt;
    const resultChecksum = checksum(snapshot(database));
    assert.equal(result.changes, expectedChanges, `${strategy} changes diverged`);
    assert.equal(resultChecksum, expectedChecksum, `${strategy} full database checksum diverged`);
    return { elapsedMilliseconds, checksum: resultChecksum, ...result };
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function summarize(samples: readonly number[]): MeasurementSummary {
  const sorted = [...samples].sort((left, right) => left - right);
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

function structuralCounts(totalPhotos: number, pageSize: number): { legacyCalls: number; candidateCalls: number } {
  let legacyCalls = 0;
  for (let offset = 0; offset < totalPhotos; offset += pageSize) {
    legacyCalls += Math.ceil(Math.min(pageSize, totalPhotos - offset) / 1_000);
  }
  return { legacyCalls, candidateCalls: Math.ceil(totalPhotos / 4_000) };
}

function sqliteVersion(): string {
  const database = new DatabaseSync(":memory:");
  try {
    return (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  } finally {
    database.close();
  }
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const photos = Array.from({ length: configuration.photos }, (_, index) => makePhoto(index));
const expectedRows = createExpectedRows(photos, configuration.preexistingPhotos);
const expectedChecksum = checksum(expectedRows);
const expectedChanges = configuration.photos - configuration.preexistingPhotos;

// Exact independent-oracle validation before warmup or timing.
measure("legacyPageAutocommit", configuration, photos, expectedChecksum, expectedChanges);
measure("bufferedBoundInsert", configuration, photos, expectedChecksum, expectedChanges);

for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
  const order: Strategy[] =
    iteration % 2 === 0
      ? ["legacyPageAutocommit", "bufferedBoundInsert"]
      : ["bufferedBoundInsert", "legacyPageAutocommit"];
  for (const strategy of order) {
    measure(strategy, configuration, photos, expectedChecksum, expectedChanges);
  }
}

const samples: Record<Strategy, number[]> = { legacyPageAutocommit: [], bufferedBoundInsert: [] };
let legacyCalls = 0;
let candidateCalls = 0;
let candidateBoundParameters = 0;
for (let iteration = 0; iteration < configuration.samples; iteration++) {
  const order: Strategy[] =
    iteration % 2 === 0
      ? ["legacyPageAutocommit", "bufferedBoundInsert"]
      : ["bufferedBoundInsert", "legacyPageAutocommit"];
  for (const strategy of order) {
    const result = measure(strategy, configuration, photos, expectedChecksum, expectedChanges);
    samples[strategy].push(result.elapsedMilliseconds);
    if (strategy === "legacyPageAutocommit") {
      legacyCalls = result.calls;
    } else {
      candidateCalls = result.calls;
      candidateBoundParameters = result.boundParameters;
    }
  }
}

const legacySummary = summarize(samples.legacyPageAutocommit);
const candidateSummary = summarize(samples.bufferedBoundInsert);
const report = {
  schemaVersion: 1,
  status: "ok",
  mode: "synthetic-file-backed-sqlite",
  generatedAt: new Date().toISOString(),
  configuration,
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    sqlite: sqliteVersion(),
  },
  correctness: {
    independentExpectedRows: expectedRows.length,
    expectedInsertedRows: expectedChanges,
    fullDatabaseChecksumAfterEveryRun: true,
    checksum: expectedChecksum,
    preexistingRowsPreserved: configuration.preexistingPhotos,
  },
  operationCounts: {
    measuredPageSize: configuration.pageSize,
    legacyPageAutocommit: {
      sqliteCalls: legacyCalls,
      statementPreparations: legacyCalls,
      implicitTransactions: legacyCalls,
    },
    bufferedBoundInsert: {
      sqliteCalls: candidateCalls,
      statementPreparations: candidateCalls,
      implicitTransactions: candidateCalls,
      boundParameters: candidateBoundParameters,
    },
    pageSizeModels: Object.fromEntries(
      [25, 100, 250, 500, 2_000, 5_000].map((pageSize) => [pageSize, structuralCounts(configuration.photos, pageSize)]),
    ),
  },
  timings: {
    legacyPageAutocommit: legacySummary,
    bufferedBoundInsert: candidateSummary,
    medianSpeedup: legacySummary.medianMilliseconds / candidateSummary.medianMilliseconds,
  },
  measurementScope:
    "Timings include Node/V8 statement construction and file-backed SQLite WAL writes with synchronous=NORMAL. They exclude PhotoKit extraction and the Expo asynchronous bridge; call reductions are reported separately.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
