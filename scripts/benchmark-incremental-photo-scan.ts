#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL,
  processPhotoScanAssets,
  type PhotoScanAssetRecord,
  type PhotoScanInsertRecord,
} from "../utils/incremental-photo-scan-core.ts";
import { buildPhotoIngestionStatement, PHOTO_INGESTION_FLUSH_SIZE } from "../utils/db/photo-ingestion-core.ts";

type Strategy = "fullRetainedScan" | "nativeIncrementalScan";

interface Configuration {
  readonly databasePath: string;
  readonly outputPath: string;
  readonly pageSize: number;
  readonly samples: number;
  readonly unknownAssets: number;
  readonly warmupIterations: number;
}

interface SourcePhotoRow {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly mediaType: string | null;
  readonly duration: number | null;
}

interface StoredPhotoScanMetrics {
  readonly hasUsableCreationTime: boolean;
  readonly hasValidLocation: boolean;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly size: number | null;
}

interface SequenceSnapshot {
  readonly rowCount: number;
  readonly sha256: string;
}

interface DigestSnapshot {
  readonly rowCount: number;
  readonly sha256: string;
}

interface TimingSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

interface StrategyMeasurement {
  readonly boundParameters: number;
  readonly changes: number;
  readonly executeMilliseconds: number;
  readonly finalDatabase: DigestSnapshot;
  readonly statementBuildMilliseconds: number;
  readonly statementCalls: number;
  readonly totalMilliseconds: number;
}

const DEFAULT_DATABASE = join(
  homedir(),
  "Library/Containers/3043B5A3-30EC-4EDC-9AB4-3AFC61142C73/Data/Documents/SQLite/photo_foodie.db",
);
const DEFAULT_OUTPUT = ".build/incremental-photo-scan-profile.json";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SYNTHETIC_PREFIX = "codex-incremental-profile-unknown-";
const PHOTO_COLUMNS = `id, uri, creationTime, latitude, longitude, visitId,
  foodDetected, foodLabels, foodConfidence, allLabels, mediaType, duration`;
const SOURCE_ROWS_SQL = `SELECT ${PHOTO_COLUMNS} FROM photos ORDER BY id ASC`;
const DATABASE_BACKED_INDEX_SQL = "SELECT id, creationTime, latitude, longitude FROM photos";

function usage(): string {
  return `Usage: benchmark-incremental-photo-scan.ts [options]

  --database=PATH       Immutable Palate database (default: this Mac's Palate container)
  --unknown-assets=N    Synthetic PhotoKit-only assets (default: 512)
  --page-size=N         Native page size, 1...5000 (default: 2000)
  --samples=N           Counterbalanced measured pairs (default: 5)
  --warmup=N            Counterbalanced warmup pairs (default: 1)
  --output=PATH         Aggregate-only JSON report (default: ${DEFAULT_OUTPUT})
  --help, -h            Show this help

The source is opened mode=ro, immutable=1, and query_only. The benchmark uses
its real photo identifiers and rows, adds deterministic synthetic unknown assets
only to an in-memory clone, and never emits raw identifiers, URIs, or metadata.`;
}

function integerOption(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let databasePath = DEFAULT_DATABASE;
  let outputPath = resolve(DEFAULT_OUTPUT);
  let pageSize = 2_000;
  let samples = 5;
  let unknownAssets = 512;
  let warmupIterations = 1;

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
    if (value.length === 0) {
      throw new RangeError(`${option} cannot be empty`);
    }
    switch (option) {
      case "--database":
        databasePath = resolve(value);
        break;
      case "--unknown-assets":
        unknownAssets = integerOption(value, option, true);
        break;
      case "--page-size":
        pageSize = integerOption(value, option);
        break;
      case "--samples":
        samples = integerOption(value, option);
        break;
      case "--warmup":
        warmupIterations = integerOption(value, option, true);
        break;
      case "--output":
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  if (pageSize > 5_000) {
    throw new RangeError("--page-size cannot exceed the native 5000-asset maximum");
  }
  return { databasePath, outputPath, pageSize, samples, unknownAssets, warmupIterations };
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, sha256: null, size: null };
  }
  const metadata = statSync(path);
  return { exists: true, sha256: sha256File(path), size: metadata.size };
}

function snapshotSource(databasePath: string): Record<string, FileSnapshot> {
  return Object.fromEntries([
    ["main", snapshotFile(databasePath)],
    ...SIDECAR_SUFFIXES.map((suffix) => [suffix.slice(1), snapshotFile(`${databasePath}${suffix}`)] as const),
  ]);
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Output path contains a symbolic-link cycle at ${ancestor}`);
        }
        seenSymlinks.add(ancestor);
        return resolve(
          canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), seenSymlinks),
          ...missing,
        );
      }
      return resolve(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function sourcePathVariants(databasePath: string): string[] {
  return [...new Set([resolve(databasePath), realpathSync(databasePath)])];
}

function protectedSourcePaths(databasePath: string): string[] {
  return sourcePathVariants(databasePath).flatMap((base) => [
    base,
    ...SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const outputCanonical = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    if (outputIdentity !== null && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not hard-link the source database or a SQLite sidecar");
      }
    }
  }
}

function assertSourceCanBeOpenedImmutable(databasePath: string): void {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${databasePath}`);
  }
  for (const base of sourcePathVariants(databasePath)) {
    for (const suffix of ["-wal", "-journal"] as const) {
      const sidecar = `${base}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw new Error(`Source database has a non-empty ${suffix.slice(1)} sidecar: ${sidecar}`);
      }
    }
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const url = pathToFileURL(resolve(databasePath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number") {
    throw new TypeError("SQLite total_changes() did not return a number");
  }
  return row.count;
}

function snapshotSqliteSequence(database: DatabaseSync): SequenceSnapshot {
  const present = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get() as { present?: unknown } | undefined;
  const rows =
    present?.present === 1 ? database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() : [];
  return { rowCount: rows.length, sha256: sha256Bytes(JSON.stringify(rows)) };
}

function digestQuery(database: DatabaseSync, sql: string, ...parameters: Array<string | number>): DigestSnapshot {
  const hash = createHash("sha256");
  let rowCount = 0;
  for (const row of database.prepare(sql).iterate(...parameters)) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    rowCount++;
  }
  return { rowCount, sha256: hash.digest("hex") };
}

function summarize(samples: readonly number[]): TimingSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function loadSourceRows(database: DatabaseSync): SourcePhotoRow[] {
  return database.prepare(SOURCE_ROWS_SQL).all() as unknown as SourcePhotoRow[];
}

function createUnknownAssets(count: number): PhotoScanAssetRecord[] {
  return Array.from({ length: count }, (_, index) => {
    let creationTime: number | null = 1_900_000_000_000 + index;
    if (index === 0) {
      creationTime = null;
    } else if (index === 1) {
      creationTime = Number.NaN;
    }
    let latitude: number | null = index % 5 === 0 ? null : 37.7 + (index % 100) / 10_000;
    let longitude: number | null = index % 5 === 0 ? null : -122.4 - (index % 100) / 10_000;
    if (index === 2) {
      latitude = 91;
    } else if (index === 3) {
      longitude = -181;
    }
    const mediaType = index % 7 === 0 ? "video" : "photo";
    return {
      id: `${SYNTHETIC_PREFIX}${index === 4 ? "O'Brien-食堂-🍜" : index.toString().padStart(6, "0")}`,
      uri: index === 4 ? "ph://synthetic/O'Brien/夕食/🍜" : `ph://synthetic/${index}`,
      creationTime,
      latitude,
      longitude,
      mediaType,
      duration: mediaType === "video" ? index + 0.5 : null,
    };
  });
}

function sourceRowsAsAssets(rows: readonly SourcePhotoRow[]): PhotoScanAssetRecord[] {
  return rows.map((row) => ({
    id: row.id,
    uri: row.uri,
    creationTime: row.creationTime,
    latitude: row.latitude,
    longitude: row.longitude,
    mediaType: row.mediaType === "video" ? "video" : "photo",
    duration: row.mediaType === "video" ? row.duration : null,
  }));
}

function processPages(assets: readonly PhotoScanAssetRecord[], pageSize: number) {
  const photos: PhotoScanInsertRecord[] = [];
  let photosWithLocation = 0;
  let skippedAssets = 0;
  let pageCalls = 0;
  const startedAt = performance.now();
  for (let offset = 0; offset < assets.length; offset += pageSize) {
    pageCalls++;
    const processed = processPhotoScanAssets(assets.slice(offset, offset + pageSize));
    photos.push(...processed.photos);
    photosWithLocation += processed.photosWithLocation;
    skippedAssets += processed.skippedAssets;
  }
  return {
    photos,
    photosWithLocation,
    skippedAssets,
    pageCalls,
    elapsedMilliseconds: performance.now() - startedAt,
  };
}

function createFixture(rows: readonly SourcePhotoRow[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE photos (
      id TEXT PRIMARY KEY NOT NULL,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      mediaType TEXT,
      duration REAL
    )`);
  const insert = database.prepare(`INSERT INTO photos (${PHOTO_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  database.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(
        row.id,
        row.uri,
        row.creationTime,
        row.latitude,
        row.longitude,
        row.visitId,
        row.foodDetected,
        row.foodLabels,
        row.foodConfidence,
        row.allLabels,
        row.mediaType,
        row.duration,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return database;
}

function executeStrategy(
  database: DatabaseSync,
  photos: readonly PhotoScanInsertRecord[],
  expectedChanges: number,
  expectedFinalDigest: DigestSnapshot | null,
): StrategyMeasurement {
  const collision = database
    .prepare("SELECT COUNT(*) AS count FROM photos WHERE id LIKE ?")
    .get(`${SYNTHETIC_PREFIX}%`) as { count: number };
  assert.equal(collision.count, 0, "synthetic profile IDs must be absent before each strategy");

  let changes = 0;
  let statementCalls = 0;
  let boundParameters = 0;
  let statementBuildMilliseconds = 0;
  let executeMilliseconds = 0;
  const totalStartedAt = performance.now();
  for (let offset = 0; offset < photos.length; offset += PHOTO_INGESTION_FLUSH_SIZE) {
    const chunk = photos.slice(offset, offset + PHOTO_INGESTION_FLUSH_SIZE);
    const buildStartedAt = performance.now();
    const statement = buildPhotoIngestionStatement(chunk);
    statementBuildMilliseconds += performance.now() - buildStartedAt;
    assert.ok(statement);
    const executeStartedAt = performance.now();
    changes += Number(database.prepare(statement.sql).run(...statement.parameters).changes);
    executeMilliseconds += performance.now() - executeStartedAt;
    statementCalls++;
    boundParameters += statement.parameters.length;
  }
  const totalMilliseconds = performance.now() - totalStartedAt;
  assert.equal(changes, expectedChanges, "strategy inserted an unexpected number of unknown assets");

  const finalDatabase = digestQuery(database, SOURCE_ROWS_SQL);
  if (expectedFinalDigest !== null) {
    assert.deepEqual(finalDatabase, expectedFinalDigest, "full and incremental database snapshots must match exactly");
  }
  database.prepare("DELETE FROM photos WHERE id LIKE ?").run(`${SYNTHETIC_PREFIX}%`);
  return {
    boundParameters,
    changes,
    executeMilliseconds,
    finalDatabase,
    statementBuildMilliseconds,
    statementCalls,
    totalMilliseconds,
  };
}

function readIdentifierBridgeIndex(
  database: DatabaseSync,
  expectedCount: number,
): { readonly elapsedMilliseconds: number; readonly identifiers: string[] } {
  const startedAt = performance.now();
  const rows = database.prepare(INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL).all();
  const identifiers = rows.map((row, index) => {
    const identifier = (row as { id: unknown }).id;
    if (typeof identifier !== "string" || identifier.length === 0) {
      throw new TypeError(`identifier bridge row ${index + 1} must have a nonempty string ID`);
    }
    return identifier;
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.equal(identifiers.length, expectedCount);
  return { elapsedMilliseconds, identifiers };
}

function storedMetricsFromDatabaseRow(row: Record<string, unknown>, rowNumber: number): StoredPhotoScanMetrics {
  const { id, creationTime, latitude, longitude } = row;
  if (typeof id !== "string") {
    throw new TypeError(`database index row ${rowNumber} must have a string ID`);
  }
  assert.ok(id.length > 0, `database index row ${rowNumber} must have a nonempty ID`);
  for (const [column, value] of [
    ["creationTime", creationTime],
    ["latitude", latitude],
    ["longitude", longitude],
  ] as const) {
    assert.ok(
      value === null || typeof value === "number",
      `database index row ${rowNumber} ${column} must be numeric or null`,
    );
  }

  const hasValidLocation =
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180;
  return {
    hasUsableCreationTime: typeof creationTime === "number" && Number.isFinite(creationTime),
    hasValidLocation,
  };
}

function readDatabaseBackedIndex(
  databasePath: string,
  expectedCount: number,
): {
  readonly elapsedMilliseconds: number;
  readonly metricsByIdentifier: ReadonlyMap<string, StoredPhotoScanMetrics>;
} {
  const startedAt = performance.now();
  const database = new DatabaseSync(immutableDatabaseUri(databasePath), { readOnly: true });
  const metricsByIdentifier = new Map<string, StoredPhotoScanMetrics>();
  try {
    database.exec("PRAGMA query_only = ON");
    let rowNumber = 0;
    for (const rawRow of database.prepare(DATABASE_BACKED_INDEX_SQL).iterate()) {
      rowNumber++;
      const row = rawRow as Record<string, unknown>;
      const identifier = row.id;
      if (typeof identifier !== "string") {
        throw new TypeError(`database index row ${rowNumber} must have a string ID`);
      }
      assert.ok(!metricsByIdentifier.has(identifier), `database index row ${rowNumber} duplicated an ID`);
      metricsByIdentifier.set(identifier, storedMetricsFromDatabaseRow(row, rowNumber));
    }
    assert.equal(metricsByIdentifier.size, expectedCount);
    assert.equal(totalChanges(database), 0, "database-backed proxy connection must remain read-only");
  } finally {
    database.close();
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  return { elapsedMilliseconds, metricsByIdentifier };
}

function measureSetupProxies(
  database: DatabaseSync,
  databasePath: string,
  expectedCount: number,
  samples: number,
  warmupIterations: number,
) {
  type SetupProxy = "databaseBacked" | "identifierBridge";
  const identifierSamples: number[] = [];
  const databaseBackedSamples: number[] = [];
  let identifiers: string[] = [];
  let metricsByIdentifier = new Map<string, StoredPhotoScanMetrics>();
  for (let iteration = 0; iteration < warmupIterations + samples; iteration++) {
    const order: readonly SetupProxy[] =
      iteration % 2 === 0 ? ["identifierBridge", "databaseBacked"] : ["databaseBacked", "identifierBridge"];
    for (const proxy of order) {
      if (proxy === "identifierBridge") {
        const measurement = readIdentifierBridgeIndex(database, expectedCount);
        identifiers = measurement.identifiers;
        if (iteration >= warmupIterations) {
          identifierSamples.push(measurement.elapsedMilliseconds);
        }
      } else {
        const measurement = readDatabaseBackedIndex(databasePath, expectedCount);
        metricsByIdentifier = new Map(measurement.metricsByIdentifier);
        if (iteration >= warmupIterations) {
          databaseBackedSamples.push(measurement.elapsedMilliseconds);
        }
      }
    }
  }
  return {
    identifierBridge: {
      identifiers,
      queryMaterializeAndValidateTiming: summarize(identifierSamples),
    },
    databaseBacked: {
      metricsByIdentifier,
      openReadValidateIndexAndCloseTiming: summarize(databaseBackedSamples),
    },
  };
}

interface PlanProxyResult {
  readonly elapsedMilliseconds: number;
  readonly excludedPhotosWithLocation: number;
  readonly excludedSkippedAssets: number;
  readonly excludedVisibleCount: number;
  readonly unknownIdentifiers: string[];
}

function readIdentifierBridgePlan(
  existingIdentifiers: readonly string[],
  libraryAssets: readonly PhotoScanAssetRecord[],
  expectedUnknownCount: number,
) {
  const buildStartedAt = performance.now();
  const existing = new Set(existingIdentifiers);
  const setBuildMilliseconds = performance.now() - buildStartedAt;
  let excludedPhotosWithLocation = 0;
  let excludedSkippedAssets = 0;
  let excludedVisibleCount = 0;
  const unknownIdentifiers: string[] = [];
  const planStartedAt = performance.now();
  for (const asset of libraryAssets) {
    if (!existing.has(asset.id)) {
      unknownIdentifiers.push(asset.id);
      continue;
    }
    excludedVisibleCount++;
    if (asset.creationTime === null || !Number.isFinite(asset.creationTime)) {
      excludedSkippedAssets++;
    } else if (
      asset.latitude !== null &&
      Number.isFinite(asset.latitude) &&
      asset.latitude >= -90 &&
      asset.latitude <= 90 &&
      asset.longitude !== null &&
      Number.isFinite(asset.longitude) &&
      asset.longitude >= -180 &&
      asset.longitude <= 180
    ) {
      excludedPhotosWithLocation++;
    }
  }
  const elapsedMilliseconds = performance.now() - planStartedAt;
  assert.equal(unknownIdentifiers.length, expectedUnknownCount);
  return {
    elapsedMilliseconds,
    excludedPhotosWithLocation,
    excludedSkippedAssets,
    excludedVisibleCount,
    setBuildMilliseconds,
    unknownIdentifiers,
  };
}

function readDatabaseBackedPlan(
  metricsByIdentifier: ReadonlyMap<string, StoredPhotoScanMetrics>,
  libraryAssets: readonly PhotoScanAssetRecord[],
  expectedUnknownCount: number,
): PlanProxyResult {
  let excludedPhotosWithLocation = 0;
  let excludedSkippedAssets = 0;
  let excludedVisibleCount = 0;
  const unknownIdentifiers: string[] = [];
  const startedAt = performance.now();
  for (const asset of libraryAssets) {
    const metrics = metricsByIdentifier.get(asset.id);
    if (metrics === undefined) {
      unknownIdentifiers.push(asset.id);
      continue;
    }
    excludedVisibleCount++;
    if (!metrics.hasUsableCreationTime) {
      excludedSkippedAssets++;
    } else if (metrics.hasValidLocation) {
      excludedPhotosWithLocation++;
    }
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.equal(unknownIdentifiers.length, expectedUnknownCount);
  return {
    elapsedMilliseconds,
    excludedPhotosWithLocation,
    excludedSkippedAssets,
    excludedVisibleCount,
    unknownIdentifiers,
  };
}

function measurePlanProxies(
  existingIdentifiers: readonly string[],
  metricsByIdentifier: ReadonlyMap<string, StoredPhotoScanMetrics>,
  libraryAssets: readonly PhotoScanAssetRecord[],
  expectedUnknownCount: number,
  samples: number,
  warmupIterations: number,
) {
  type PlanProxy = "databaseBacked" | "identifierBridge";
  const setBuildSamples: number[] = [];
  const identifierPlanSamples: number[] = [];
  const databaseBackedPlanSamples: number[] = [];
  let identifierResult: ReturnType<typeof readIdentifierBridgePlan> | null = null;
  let databaseBackedResult: PlanProxyResult | null = null;
  for (let iteration = 0; iteration < warmupIterations + samples; iteration++) {
    const order: readonly PlanProxy[] =
      iteration % 2 === 0 ? ["identifierBridge", "databaseBacked"] : ["databaseBacked", "identifierBridge"];
    for (const proxy of order) {
      if (proxy === "identifierBridge") {
        identifierResult = readIdentifierBridgePlan(existingIdentifiers, libraryAssets, expectedUnknownCount);
        if (iteration >= warmupIterations) {
          setBuildSamples.push(identifierResult.setBuildMilliseconds);
          identifierPlanSamples.push(identifierResult.elapsedMilliseconds);
        }
      } else {
        databaseBackedResult = readDatabaseBackedPlan(metricsByIdentifier, libraryAssets, expectedUnknownCount);
        if (iteration >= warmupIterations) {
          databaseBackedPlanSamples.push(databaseBackedResult.elapsedMilliseconds);
        }
      }
    }
  }
  assert.ok(identifierResult);
  assert.ok(databaseBackedResult);
  return {
    identifierBridge: {
      ...identifierResult,
      setBuild: summarize(setBuildSamples),
      libraryPlan: summarize(identifierPlanSamples),
    },
    databaseBacked: {
      ...databaseBackedResult,
      libraryLookupTiming: summarize(databaseBackedPlanSamples),
    },
  };
}

function run(configuration: Configuration): void {
  assertSourceCanBeOpenedImmutable(configuration.databasePath);
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  const sourceBefore = snapshotSource(configuration.databasePath);
  const source = new DatabaseSync(immutableDatabaseUri(configuration.databasePath), { readOnly: true });
  let report: Record<string, unknown>;
  let changesBefore = 0;
  let changesAfter = 0;
  let sequenceBefore: SequenceSnapshot = { rowCount: 0, sha256: "" };
  let sequenceAfter: SequenceSnapshot = { rowCount: 0, sha256: "" };

  try {
    source.exec("PRAGMA query_only = ON");
    changesBefore = totalChanges(source);
    sequenceBefore = snapshotSqliteSequence(source);
    const integrity = source.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    assert.equal(integrity?.integrity_check, "ok", "source integrity_check must pass");
    const sourceDigest = digestQuery(source, SOURCE_ROWS_SQL);
    const sourceRows = loadSourceRows(source);
    assert.equal(sourceRows.length, sourceDigest.rowCount);
    for (const [index, row] of sourceRows.entries()) {
      assert.equal(typeof row.id, "string", `source photo ${index} must have a string ID`);
      assert.ok(row.id.length > 0, `source photo ${index} must have a nonempty ID`);
    }

    const setupProxies = measureSetupProxies(
      source,
      configuration.databasePath,
      sourceRows.length,
      configuration.samples,
      configuration.warmupIterations,
    );
    const queryMeasurement = {
      identifiers: setupProxies.identifierBridge.identifiers,
      timing: setupProxies.identifierBridge.queryMaterializeAndValidateTiming,
    };
    const databaseBackedIndex = {
      metricsByIdentifier: setupProxies.databaseBacked.metricsByIdentifier,
      openReadIndexAndCloseTiming: setupProxies.databaseBacked.openReadValidateIndexAndCloseTiming,
    };
    assert.equal(new Set(queryMeasurement.identifiers).size, queryMeasurement.identifiers.length);
    assert.equal(databaseBackedIndex.metricsByIdentifier.size, queryMeasurement.identifiers.length);
    for (const identifier of queryMeasurement.identifiers) {
      assert.ok(databaseBackedIndex.metricsByIdentifier.has(identifier));
    }
    const unknownAssets = createUnknownAssets(configuration.unknownAssets);
    const unknownCollisionCount = source
      .prepare("SELECT COUNT(*) AS count FROM photos WHERE id LIKE ?")
      .get(`${SYNTHETIC_PREFIX}%`) as { count: number };
    assert.equal(unknownCollisionCount.count, 0, "source database collides with synthetic benchmark IDs");
    const libraryAssets = [...sourceRowsAsAssets(sourceRows), ...unknownAssets];
    const planProxies = measurePlanProxies(
      queryMeasurement.identifiers,
      databaseBackedIndex.metricsByIdentifier,
      libraryAssets,
      unknownAssets.length,
      configuration.samples,
      configuration.warmupIterations,
    );
    const setFiltering = planProxies.identifierBridge;
    const databaseBackedLookup = planProxies.databaseBacked;
    for (const [index, row] of sourceRows.entries()) {
      assert.deepEqual(
        databaseBackedIndex.metricsByIdentifier.get(row.id),
        storedMetricsFromDatabaseRow(
          {
            id: row.id,
            creationTime: row.creationTime,
            latitude: row.latitude,
            longitude: row.longitude,
          },
          index + 1,
        ),
        `database-backed index metrics differ for source row ${index + 1}`,
      );
    }
    const expectedUnknownIdentifiers = unknownAssets.map((asset) => asset.id);
    assert.deepEqual(setFiltering.unknownIdentifiers, expectedUnknownIdentifiers);
    assert.deepEqual(databaseBackedLookup.unknownIdentifiers, expectedUnknownIdentifiers);
    assert.equal(databaseBackedLookup.excludedVisibleCount, setFiltering.excludedVisibleCount);
    assert.equal(databaseBackedLookup.excludedPhotosWithLocation, setFiltering.excludedPhotosWithLocation);
    assert.equal(databaseBackedLookup.excludedSkippedAssets, setFiltering.excludedSkippedAssets);

    const fullProcessing = processPages(libraryAssets, configuration.pageSize);
    const incrementalProcessing = processPages(unknownAssets, configuration.pageSize);
    const expectedChanges = incrementalProcessing.photos.length;
    const fixture = createFixture(sourceRows);
    try {
      const initialFixtureDigest = digestQuery(fixture, SOURCE_ROWS_SQL);
      assert.deepEqual(
        initialFixtureDigest,
        sourceDigest,
        "in-memory clone must exactly match the immutable source rows",
      );

      const fullOracle = executeStrategy(fixture, fullProcessing.photos, expectedChanges, null);
      const sourceAfterFull = digestQuery(fixture, SOURCE_ROWS_SQL);
      assert.deepEqual(sourceAfterFull, sourceDigest, "cleanup after full scan must restore every source sentinel row");
      const incrementalOracle = executeStrategy(
        fixture,
        incrementalProcessing.photos,
        expectedChanges,
        fullOracle.finalDatabase,
      );
      assert.deepEqual(
        digestQuery(fixture, SOURCE_ROWS_SQL),
        sourceDigest,
        "cleanup after incremental scan must restore every source sentinel row",
      );
      assert.equal(incrementalOracle.statementCalls, Math.ceil(expectedChanges / PHOTO_INGESTION_FLUSH_SIZE));
      if (configuration.unknownAssets === 0) {
        assert.equal(incrementalOracle.statementCalls, 0);
      }

      const timingSamples: Record<Strategy, { build: number[]; execute: number[]; total: number[] }> = {
        fullRetainedScan: { build: [], execute: [], total: [] },
        nativeIncrementalScan: { build: [], execute: [], total: [] },
      };
      const measuredIterations = configuration.warmupIterations + configuration.samples;
      for (let iteration = 0; iteration < measuredIterations; iteration++) {
        const order: readonly Strategy[] =
          iteration % 2 === 0
            ? ["fullRetainedScan", "nativeIncrementalScan"]
            : ["nativeIncrementalScan", "fullRetainedScan"];
        for (const strategy of order) {
          const measurement = executeStrategy(
            fixture,
            strategy === "fullRetainedScan" ? fullProcessing.photos : incrementalProcessing.photos,
            expectedChanges,
            fullOracle.finalDatabase,
          );
          assert.deepEqual(
            digestQuery(fixture, SOURCE_ROWS_SQL),
            sourceDigest,
            "fixture cleanup must retain source rows",
          );
          if (iteration >= configuration.warmupIterations) {
            timingSamples[strategy].build.push(measurement.statementBuildMilliseconds);
            timingSamples[strategy].execute.push(measurement.executeMilliseconds);
            timingSamples[strategy].total.push(measurement.totalMilliseconds);
          }
        }
      }

      const fullTimings = {
        statementBuild: summarize(timingSamples.fullRetainedScan.build),
        statementExecute: summarize(timingSamples.fullRetainedScan.execute),
        buildAndExecute: summarize(timingSamples.fullRetainedScan.total),
      };
      const incrementalTimings = {
        statementBuild: summarize(timingSamples.nativeIncrementalScan.build),
        statementExecute: summarize(timingSamples.nativeIncrementalScan.execute),
        buildAndExecute: summarize(timingSamples.nativeIncrementalScan.total),
      };
      const fullAssetPayloadBytes = serializedBytes(libraryAssets);
      const incrementalAssetPayloadBytes = serializedBytes(unknownAssets);
      const identifierPayloadBytes = serializedBytes(queryMeasurement.identifiers);
      const databaseIndexRecordPayloadBytes = serializedBytes(
        sourceRows.map(({ id, creationTime, latitude, longitude }) => ({
          id,
          creationTime,
          latitude,
          longitude,
        })),
      );
      const databaseStoredMetricPayloadBytes = serializedBytes(
        [...databaseBackedIndex.metricsByIdentifier].map(([identifier, metrics]) => [
          identifier,
          metrics.hasUsableCreationTime,
          metrics.hasValidLocation,
        ]),
      );
      const identifierBridgeRetainedPayloadBytes = serializedBytes([
        queryMeasurement.identifiers,
        queryMeasurement.identifiers,
      ]);
      const fullPageCalls = fullProcessing.pageCalls;
      const incrementalPageCalls = incrementalProcessing.pageCalls;
      const incrementalPayloadBytes = identifierPayloadBytes + incrementalAssetPayloadBytes;
      const fullModeledMedianMilliseconds =
        fullProcessing.elapsedMilliseconds + fullTimings.buildAndExecute.medianMilliseconds;
      const incrementalModeledMedianMilliseconds =
        queryMeasurement.timing.medianMilliseconds +
        setFiltering.setBuild.medianMilliseconds +
        setFiltering.libraryPlan.medianMilliseconds +
        incrementalProcessing.elapsedMilliseconds +
        incrementalTimings.buildAndExecute.medianMilliseconds;
      const databaseBackedModeledMedianMilliseconds =
        databaseBackedIndex.openReadIndexAndCloseTiming.medianMilliseconds +
        databaseBackedLookup.libraryLookupTiming.medianMilliseconds +
        incrementalProcessing.elapsedMilliseconds +
        incrementalTimings.buildAndExecute.medianMilliseconds;
      const identifierBridgeSetupMedianMilliseconds =
        queryMeasurement.timing.medianMilliseconds +
        setFiltering.setBuild.medianMilliseconds +
        setFiltering.libraryPlan.medianMilliseconds;
      const databaseBackedSetupMedianMilliseconds =
        databaseBackedIndex.openReadIndexAndCloseTiming.medianMilliseconds +
        databaseBackedLookup.libraryLookupTiming.medianMilliseconds;

      report = {
        schemaVersion: 2,
        status: "ok",
        generatedAt: new Date().toISOString(),
        configuration: {
          pageSize: configuration.pageSize,
          samples: configuration.samples,
          unknownAssets: configuration.unknownAssets,
          warmupIterations: configuration.warmupIterations,
        },
        measurementModel: {
          scope: "isolated incremental PhotoKit/Expo SQLite integration model using this Mac's immutable Palate rows",
          realInputs: ["all persisted photo IDs", "all persisted photo rows", "database byte and sequence state"],
          modeledInputs: [
            "deterministic PhotoKit-only unknown assets",
            "native Set construction and fetch-result filtering",
            "native read-only database index construction and fetch-result lookup",
          ],
          excludes: [
            "PhotoKit fetch latency",
            "Expo JSI serialization latency",
            "Swift/ExpoSQLite versus Node/system-SQLite runtime differences",
            "React Native scheduling",
            "macOS UI work",
          ],
          timingExcludes: ["payload proxy serialization", "database digest validation", "fixture cleanup"],
          caveats: [
            "Node SQLite and V8 collections are timing proxies, not Swift/ExpoSQLite measurements",
            "serialized byte counts model payload shape and are not RSS estimates",
            "the immutable fixture does not model live-WAL contention or second-connection locking",
            "the modeled library pairs persisted IDs and metadata with fixture assets; native tests cover stale IDs and metadata edge cases",
            "the signed macOS app A/B is authoritative for production latency and maximum RSS",
          ],
        },
        source: {
          databaseBytes: statSync(configuration.databasePath).size,
          databaseSha256: sha256File(configuration.databasePath),
          integrityCheck: "ok",
          persistedPhotoRows: sourceRows.length,
          persistedPhotoRowsSha256: sourceDigest.sha256,
        },
        workload: {
          visibleLibraryAssets: libraryAssets.length,
          existingVisibleAssets: sourceRows.length,
          unknownVisibleAssets: unknownAssets.length,
          unknownAssetsWithUsableMetadata: incrementalProcessing.photos.length,
          unknownSkippedAssets: incrementalProcessing.skippedAssets,
        },
        correctness: {
          exactFullVsIncrementalDatabaseParity: true,
          fullDatabaseRowCount: fullOracle.finalDatabase.rowCount,
          fullDatabaseSha256: fullOracle.finalDatabase.sha256,
          immutableRowsClonedExactly: true,
          existingMetadataAndClassificationSentinelsPreserved: true,
          sourceRowsRestoredAfterEveryFixtureRun: true,
          identifierAndDatabaseIndexKeySetsMatchExactly: true,
          databaseBackedIndexMatchesEveryPersistedRow: true,
          databaseBackedUnknownOrderingMatchesIdentifierBridge: true,
          excludedVisibleCountersMatchExactly: true,
          excludedLocationCountersMatchExactly: true,
          excludedSkippedCountersMatchExactly: true,
          productionIdentifierSqlImportedDirectly: true,
          productionPageProcessorImportedDirectly: true,
          productionInsertBuilderImportedDirectly: true,
        },
        identifierQuery: {
          sqliteCallsPerScan: 1,
          rowsReturned: queryMeasurement.identifiers.length,
          serializedPayloadBytesProxy: identifierPayloadBytes,
          timing: queryMeasurement.timing,
        },
        nativeFilteringProxy: {
          implementationNote:
            "JavaScript Set timing is an isolated proxy for the equivalent native Swift Set/filter plan",
          identifiersRetained: queryMeasurement.identifiers.length,
          visibleAssetsExamined: libraryAssets.length,
          setBuildTiming: setFiltering.setBuild,
          libraryPlanTiming: setFiltering.libraryPlan,
          excludedVisibleCount: setFiltering.excludedVisibleCount,
          excludedPhotosWithLocation: setFiltering.excludedPhotosWithLocation,
          excludedSkippedAssets: setFiltering.excludedSkippedAssets,
          productionStructuralWork: {
            photoKitObjectAtCalls: libraryAssets.length,
            existingAssetsWhosePhotoKitCreationAndLocationAreRead: setFiltering.excludedVisibleCount,
          },
        },
        databaseBackedNativeProxy: {
          implementationNote:
            "Node/system-SQLite timing proxies the native Swift/ExpoSQLite read-only index; the signed-app A/B measures production directly",
          sqliteReadConnectionsPerScan: 1,
          rowsRead: databaseBackedIndex.metricsByIdentifier.size,
          columnsReadPerRow: 4,
          sqliteStatementsPerScan: 3,
          retainedStoredMetricEntries: databaseBackedIndex.metricsByIdentifier.size,
          databaseRowsReadPayloadBytesProxy: databaseIndexRecordPayloadBytes,
          retainedStoredMetricPayloadBytesProxy: databaseStoredMetricPayloadBytes,
          serializedExistingRowsAcrossNativeBoundary: 0,
          openReadIndexAndCloseTiming: databaseBackedIndex.openReadIndexAndCloseTiming,
          visibleAssetsExamined: libraryAssets.length,
          libraryLookupTiming: databaseBackedLookup.libraryLookupTiming,
          excludedVisibleCount: databaseBackedLookup.excludedVisibleCount,
          excludedPhotosWithLocation: databaseBackedLookup.excludedPhotosWithLocation,
          excludedSkippedAssets: databaseBackedLookup.excludedSkippedAssets,
          productionStructuralWork: {
            photoKitObjectAtCalls: libraryAssets.length,
            existingAssetsWhosePhotoKitCreationAndLocationAreRead: 0,
          },
        },
        strategies: {
          fullRetainedScan: {
            nativeCalls: { begin: 1, pages: fullPageCalls, end: 1 },
            existingIdQueryCalls: 0,
            assetRecordsCrossingNativeBoundaryProxy: libraryAssets.length,
            serializedAssetPayloadBytesProxy: fullAssetPayloadBytes,
            insertStatementCalls: fullOracle.statementCalls,
            boundParameters: fullOracle.boundParameters,
            retainedObjectProxies: {
              retainedFetchAssets: libraryAssets.length,
              retainedExistingIdentifiersInJs: 0,
              maximumJsPageAssets: Math.min(configuration.pageSize, libraryAssets.length),
            },
            pageProcessingMilliseconds: fullProcessing.elapsedMilliseconds,
            timings: fullTimings,
          },
          nativeIncrementalScan: {
            selectedImplementation: "identifier-list",
            nativeCalls: { begin: 1, pages: incrementalPageCalls, end: 1 },
            existingIdQueryCalls: 1,
            assetRecordsCrossingNativeBoundaryProxy: unknownAssets.length,
            serializedAssetPayloadBytesProxy: incrementalAssetPayloadBytes,
            existingIdentifierPayloadBytesProxy: identifierPayloadBytes,
            insertStatementCalls: incrementalOracle.statementCalls,
            boundParameters: incrementalOracle.boundParameters,
            retainedObjectProxies: {
              retainedFetchAssets: libraryAssets.length,
              retainedExistingIdentifiersInJs: queryMeasurement.identifiers.length,
              nativeExistingIdentifierSetEntries: queryMeasurement.identifiers.length,
              duplicatedIdentifierPayloadBytesProxy: identifierBridgeRetainedPayloadBytes,
              retainedUnknownAssetIndexes: unknownAssets.length,
              maximumJsPageAssets: Math.min(configuration.pageSize, unknownAssets.length),
            },
            pageProcessingMilliseconds: incrementalProcessing.elapsedMilliseconds,
            timings: incrementalTimings,
          },
          databaseBackedNativeIncrementalScan: {
            selectedImplementation: "database-backed",
            nativeCalls: { begin: 1, pages: incrementalPageCalls, end: 1 },
            existingIdQueryCallsInJavaScript: 0,
            nativeDatabaseReadConnections: 1,
            assetRecordsCrossingNativeBoundaryProxy: unknownAssets.length,
            serializedAssetPayloadBytesProxy: incrementalAssetPayloadBytes,
            existingIdentifierPayloadBytesCrossingNativeBoundary: 0,
            insertStatementCalls: incrementalOracle.statementCalls,
            boundParameters: incrementalOracle.boundParameters,
            retainedObjectProxies: {
              retainedFetchAssets: libraryAssets.length,
              retainedExistingIdentifiersInJs: 0,
              nativeStoredMetricEntries: databaseBackedIndex.metricsByIdentifier.size,
              storedMetricPayloadBytesProxy: databaseStoredMetricPayloadBytes,
              retainedUnknownAssetIndexes: unknownAssets.length,
              maximumJsPageAssets: Math.min(configuration.pageSize, unknownAssets.length),
            },
            pageProcessingMilliseconds: incrementalProcessing.elapsedMilliseconds,
            timings: incrementalTimings,
          },
        },
        comparison: {
          pageCallsSaved: fullPageCalls - incrementalPageCalls,
          assetRecordsAvoidedAcrossNativeBoundary: libraryAssets.length - unknownAssets.length,
          serializedAssetPayloadBytesAvoided: fullAssetPayloadBytes - incrementalAssetPayloadBytes,
          netSerializedPayloadBytesProxy: {
            fullMetadataRecords: fullAssetPayloadBytes,
            incrementalExistingIdsAndUnknownMetadata: incrementalPayloadBytes,
            bytesSaved: fullAssetPayloadBytes - incrementalPayloadBytes,
            reductionPercent:
              fullAssetPayloadBytes === 0
                ? 0
                : ((fullAssetPayloadBytes - incrementalPayloadBytes) / fullAssetPayloadBytes) * 100,
          },
          boundParametersAvoided: fullOracle.boundParameters - incrementalOracle.boundParameters,
          insertStatementsAvoided: fullOracle.statementCalls - incrementalOracle.statementCalls,
          medianStatementBuildAndExecuteSpeedup:
            fullTimings.buildAndExecute.medianMilliseconds /
            Math.max(Number.EPSILON, incrementalTimings.buildAndExecute.medianMilliseconds),
          identifierBridgeVsDatabaseBackedProxy: {
            existingIdentifierPayloadBytesEliminated: identifierPayloadBytes,
            existingIdentifiersRetainedInJavaScriptEliminated: queryMeasurement.identifiers.length,
            identifierBridgeSetupMedianMilliseconds,
            databaseBackedSetupMedianMilliseconds,
            setupSpeedup:
              identifierBridgeSetupMedianMilliseconds / Math.max(Number.EPSILON, databaseBackedSetupMedianMilliseconds),
            retainedPayloadShapeProxy: {
              identifierBridgeDuplicatedAcrossJsAndNativeSet: identifierBridgeRetainedPayloadBytes,
              databaseBackedNativeStoredMetrics: databaseStoredMetricPayloadBytes,
              bytesAvoided: identifierBridgeRetainedPayloadBytes - databaseStoredMetricPayloadBytes,
            },
            productionStructuralWorkAvoided: {
              photoKitObjectAtCalls: 0,
              existingAssetsWithPhotoKitCreationAndLocationReads: setFiltering.excludedVisibleCount,
            },
            modeledEndToEndMedianMilliseconds: {
              identifierBridge: incrementalModeledMedianMilliseconds,
              databaseBacked: databaseBackedModeledMedianMilliseconds,
              speedup:
                incrementalModeledMedianMilliseconds /
                Math.max(Number.EPSILON, databaseBackedModeledMedianMilliseconds),
            },
          },
          modeledMedianMilliseconds: {
            fullScanPageProcessingAndPersistence: fullModeledMedianMilliseconds,
            incrementalIdQuerySetFilterPageProcessingAndPersistence: incrementalModeledMedianMilliseconds,
            databaseBackedReadLookupPageProcessingAndPersistence: databaseBackedModeledMedianMilliseconds,
            speedup: fullModeledMedianMilliseconds / Math.max(Number.EPSILON, incrementalModeledMedianMilliseconds),
            databaseBackedSpeedup:
              fullModeledMedianMilliseconds / Math.max(Number.EPSILON, databaseBackedModeledMedianMilliseconds),
          },
        },
        privacy: {
          aggregateOnly: true,
          rawIdentifiersRetainedInReport: false,
          rawUrisRetainedInReport: false,
          rawMetadataRetainedInReport: false,
          photosLibraryAccessedByThisScript: false,
        },
      };
    } finally {
      fixture.close();
    }

    changesAfter = totalChanges(source);
    sequenceAfter = snapshotSqliteSequence(source);
    assert.equal(changesAfter, changesBefore, "read-only benchmark must not increment source total_changes()");
    assert.deepEqual(sequenceAfter, sequenceBefore, "read-only benchmark must not alter source sqlite_sequence");
  } finally {
    source.close();
  }

  const sourceAfter = snapshotSource(configuration.databasePath);
  assert.deepEqual(sourceAfter, sourceBefore, "immutable benchmark must not alter the database or a SQLite sidecar");
  report.sourceAttestation = { before: sourceBefore, after: sourceAfter, byteIdentical: true };
  report.writeInvariants = {
    totalChangesBefore: changesBefore,
    totalChangesAfter: changesAfter,
    totalChangesUnchanged: changesBefore === changesAfter,
    sqliteSequenceBefore: sequenceBefore,
    sqliteSequenceAfter: sequenceAfter,
    sqliteSequenceUnchanged: sequenceBefore.sha256 === sequenceAfter.sha256,
    mainAndSidecarsByteIdentical: true,
    sourceOpenMode: "mode=ro, immutable=1, PRAGMA query_only=ON",
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, serialized);
  console.log(serialized.trimEnd());
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
} else {
  run(configuration);
}
