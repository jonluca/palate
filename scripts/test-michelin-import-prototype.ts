#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  assertMutableDatabaseDoesNotAliasSource,
  CURRENT_MICHELIN_IMPORT_BATCH_SIZE,
  CURRENT_MICHELIN_SOURCE_ROWS_SQL,
  destinationDigest,
  IMPORT_FAILURE_MESSAGE,
  immutableSqliteUri,
  MICHELIN_DATASET_VERSION_KEY,
  NO_VALID_MICHELIN_ROWS_MESSAGE,
  openDestinationDatabase,
  readDestinationRows,
  resolveProtectedSourcePath,
  runAttachInsertSelectImport,
  runCurrentJsOracleImport,
  snapshotSqliteSource,
  type DestinationDigest,
  type DestinationRows,
} from "./michelin-import-prototype-core.ts";
import {
  ATTACHED_MICHELIN_INSERT_SELECT_SQL as PRODUCTION_ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  MICHELIN_DATASET_VERSION_KEY as PRODUCTION_MICHELIN_DATASET_VERSION_KEY,
  MICHELIN_IMPORT_METADATA_UPSERT_SQL,
  NO_VALID_MICHELIN_ROWS_MESSAGE as PRODUCTION_NO_VALID_MICHELIN_ROWS_MESSAGE,
} from "../utils/db/michelin-import-core.ts";
import {
  MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL,
  MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL,
} from "../utils/db/michelin-provider-spatial-core.ts";

interface SyntheticRestaurant {
  readonly id: number;
  readonly name: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly address?: string;
  readonly location?: string;
  readonly cuisine?: string;
}

interface SyntheticAward {
  readonly distinction: string;
  readonly greenStar: number | string | Uint8Array | null;
  readonly restaurantId: number;
  readonly year: number;
}

interface TextRow {
  readonly value: string;
}

interface CountRow {
  readonly count: number;
}

interface HealthRow {
  readonly issueCount: number;
}

interface GreenStarStorageRow {
  readonly blobBytes: number | null;
  readonly numericValue: number | null;
  readonly restaurantId: number;
  readonly storageClass: string;
  readonly textValue: string | null;
  readonly year: number;
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const benchmarkPath = join(repositoryRoot, "scripts/benchmark-michelin-import-prototype.ts");
const realSourcePath = join(repositoryRoot, "assets/michelin.db");
const DATASET_VERSION = "synthetic-current-v9";
const SECRET_SENTINEL = "PRIVATE_IMPORT_SENTINEL_雪_6dd139b3";
const HISTORICAL_ID = "michelin-synthetic-historical-only";

const SYNTHETIC_RESTAURANTS: readonly SyntheticRestaurant[] = [
  {
    id: 1,
    name: `${SECRET_SENTINEL} Café e\u0301`,
    latitude: "\uFEFF+37.5north",
    longitude: " -122.25west",
    address: `${SECRET_SENTINEL} address`,
    location: "Zürich 東京",
    cuisine: "Crème brûlée 🍮",
  },
  { id: 2, name: null, latitude: ".5tail", longitude: "-.25tail" },
  { id: 3, name: "No award 雪", latitude: "12", longitude: "34" },
  { id: 4, name: "Null latitude", latitude: null, longitude: "10" },
  { id: 5, name: "Empty longitude", latitude: "10", longitude: "" },
  { id: 6, name: "Alphabetic", latitude: "not-a-number", longitude: "10" },
  { id: 7, name: "NaN", latitude: "NaN", longitude: "10" },
  { id: 8, name: "Infinity", latitude: "Infinity", longitude: "10" },
  { id: 9, name: "Latitude out", latitude: "91", longitude: "10" },
  { id: 10, name: "Longitude out", latitude: "10", longitude: "-181" },
  { id: 11, name: "Origin", latitude: "0", longitude: "0" },
  { id: 12, name: "Zero latitude valid", latitude: "0", longitude: "10" },
  { id: 13, name: "Exponent out", latitude: "1e2", longitude: "10" },
  { id: 14, name: "Negative origin", latitude: "-0", longitude: "+0" },
  { id: 15, name: "Unicode whitespace", latitude: "\u00A0+.125rest", longitude: "\u3000-.5rest" },
  { id: 16, name: "Incomplete exponent", latitude: "1e", longitude: "2e+" },
  { id: 17, name: "Signed fractions", latitude: "+.5hello", longitude: "-.5hello" },
  { id: 18, name: "Bare sign", latitude: "+", longitude: "10" },
  { id: 19, name: "Bare dot", latitude: ".", longitude: "10" },
  { id: 20, name: "Overflow", latitude: "1e309", longitude: "10" },
  { id: 21, name: "Nonnumeric green star", latitude: "21", longitude: "42" },
  { id: 22, name: "Blob green star", latitude: "22", longitude: "44" },
];

const SYNTHETIC_AWARDS: readonly SyntheticAward[] = [
  { restaurantId: 1, year: 2024, distinction: "Bib Gourmand", greenStar: 0 },
  { restaurantId: 1, year: 2026, distinction: "2 Stars", greenStar: 1 },
  { restaurantId: 2, year: 2025, distinction: "", greenStar: 1 },
  { restaurantId: 12, year: 2023, distinction: "Selected", greenStar: 0 },
  { restaurantId: 15, year: 2022, distinction: "Green distinction", greenStar: null },
  { restaurantId: 16, year: 2021, distinction: "Empty text", greenStar: "" },
  { restaurantId: 17, year: 2020, distinction: "Text zero", greenStar: "0" },
  { restaurantId: 21, year: 2019, distinction: "Nonnumeric text", greenStar: "yes" },
  { restaurantId: 22, year: 2018, distinction: "Blob", greenStar: Buffer.alloc(0) },
];

function createSyntheticSource(path: string, includeSentinelSidecars = false): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE restaurants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        description TEXT NOT NULL,
        address TEXT NOT NULL,
        location TEXT NOT NULL,
        latitude TEXT,
        longitude TEXT,
        cuisine TEXT NOT NULL,
        phone_number TEXT,
        facilities_and_services TEXT,
        website_url TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE restaurant_awards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        year INTEGER NOT NULL,
        distinction TEXT NOT NULL,
        price TEXT NOT NULL,
        green_star BLOB,
        created_at TEXT,
        updated_at TEXT,
        wayback_url TEXT,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );
      CREATE UNIQUE INDEX idx_restaurant_year_unique ON restaurant_awards(restaurant_id, year);
    `);
    const insertRestaurant = database.prepare(`INSERT INTO restaurants
      (id, url, name, description, address, location, latitude, longitude, cuisine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const restaurant of SYNTHETIC_RESTAURANTS) {
      insertRestaurant.run(
        restaurant.id,
        `https://fixture.invalid/${restaurant.id}`,
        restaurant.name,
        `${SECRET_SENTINEL} description ${restaurant.id}`,
        restaurant.address ?? `Address ${restaurant.id}`,
        restaurant.location ?? `Location ${restaurant.id}`,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.cuisine ?? `Cuisine ${restaurant.id}`,
      );
    }
    const insertAward = database.prepare(`INSERT INTO restaurant_awards
      (restaurant_id, year, distinction, price, green_star)
      VALUES (?, ?, ?, ?, ?)`);
    for (const award of SYNTHETIC_AWARDS) {
      insertAward.run(award.restaurantId, award.year, award.distinction, "€€", award.greenStar);
    }
    const storageRows = database
      .prepare(`SELECT
        restaurant_id AS restaurantId,
        year,
        typeof(green_star) AS storageClass,
        CASE WHEN typeof(green_star) IN ('integer', 'real') THEN green_star ELSE NULL END AS numericValue,
        CASE WHEN typeof(green_star) = 'text' THEN green_star ELSE NULL END AS textValue,
        CASE WHEN typeof(green_star) = 'blob' THEN length(green_star) ELSE NULL END AS blobBytes
      FROM restaurant_awards
      WHERE restaurant_id IN (1, 12, 16, 17, 21, 22)
      ORDER BY restaurant_id, year`)
      .all() as unknown as GreenStarStorageRow[];
    assert.deepEqual(
      storageRows.map((row) => ({ ...row })),
      [
        { restaurantId: 1, year: 2024, storageClass: "real", numericValue: 0, textValue: null, blobBytes: null },
        { restaurantId: 1, year: 2026, storageClass: "real", numericValue: 1, textValue: null, blobBytes: null },
        { restaurantId: 12, year: 2023, storageClass: "real", numericValue: 0, textValue: null, blobBytes: null },
        { restaurantId: 16, year: 2021, storageClass: "text", numericValue: null, textValue: "", blobBytes: null },
        { restaurantId: 17, year: 2020, storageClass: "text", numericValue: null, textValue: "0", blobBytes: null },
        { restaurantId: 21, year: 2019, storageClass: "text", numericValue: null, textValue: "yes", blobBytes: null },
        { restaurantId: 22, year: 2018, storageClass: "blob", numericValue: null, textValue: null, blobBytes: 0 },
      ],
    );
  } finally {
    database.close();
  }

  if (includeSentinelSidecars) {
    writeFileSync(`${path}-wal`, Buffer.from("sentinel-wal-bytes"));
    writeFileSync(`${path}-shm`, Buffer.from("sentinel-shm-bytes"));
    writeFileSync(`${path}-journal`, Buffer.from("sentinel-journal-bytes"));
  }
}

function seedDestination(database: DatabaseSync): void {
  const insert = database.prepare(`INSERT INTO michelin_restaurants
    (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(
    "michelin-1",
    "Stale conflict",
    -10,
    -20,
    "Stale address",
    "Stale location",
    "Stale cuisine",
    1900,
    "Stale award",
    "old-version",
  );
  insert.run(
    HISTORICAL_ID,
    "Preserved historical",
    45,
    90,
    "Historical address",
    "Historical location",
    "Historical cuisine",
    2020,
    "Historical award",
    "historical-version",
  );
  database
    .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?), (?, ?)")
    .run(MICHELIN_DATASET_VERSION_KEY, "old-version", "unrelated-key", "unrelated-value");
}

function openSeededDestination(path: string): DatabaseSync {
  const database = openDestinationDatabase(path);
  seedDestination(database);
  return database;
}

function restaurantById(rows: DestinationRows, id: string): Record<string, unknown> {
  const restaurant = rows.restaurants.find((row) => row.id === id);
  assert.ok(restaurant, `Missing destination restaurant ${id}`);
  return restaurant;
}

function assertSyntheticExpected(rows: DestinationRows): void {
  assert.equal(rows.restaurants.length, 10, "nine valid source rows plus one preserved historical row expected");
  assert.deepEqual(
    rows.restaurants.map(({ id }) => id),
    [
      "michelin-1",
      "michelin-12",
      "michelin-15",
      "michelin-16",
      "michelin-17",
      "michelin-2",
      "michelin-21",
      "michelin-22",
      "michelin-3",
      HISTORICAL_ID,
    ],
  );

  const unicode = restaurantById(rows, "michelin-1");
  assert.equal(unicode.name, `${SECRET_SENTINEL} Café e\u0301`);
  assert.equal(unicode.latitude, 37.5);
  assert.equal(unicode.longitude, -122.25);
  assert.equal(unicode.latestAwardYear, 2026);
  assert.equal(unicode.award, "2 Stars, Green Star");
  assert.equal(unicode.datasetVersion, DATASET_VERSION);

  const nullName = restaurantById(rows, "michelin-2");
  assert.equal(nullName.name, "");
  assert.equal(nullName.award, "Green Star");
  assert.equal(nullName.latestAwardYear, 2025);

  const noAward = restaurantById(rows, "michelin-3");
  assert.equal(noAward.award, "");
  assert.equal(noAward.latestAwardYear, null);

  assert.equal(restaurantById(rows, "michelin-12").award, "Selected");
  assert.equal(restaurantById(rows, "michelin-15").latitude, 0.125);
  assert.equal(restaurantById(rows, "michelin-15").longitude, -0.5);
  assert.equal(restaurantById(rows, "michelin-16").latitude, 1);
  assert.equal(restaurantById(rows, "michelin-16").longitude, 2);
  assert.equal(restaurantById(rows, "michelin-16").award, "Empty text");
  assert.equal(restaurantById(rows, "michelin-17").latitude, 0.5);
  assert.equal(restaurantById(rows, "michelin-17").longitude, -0.5);
  assert.equal(restaurantById(rows, "michelin-17").award, "Text zero, Green Star");
  assert.equal(restaurantById(rows, "michelin-21").award, "Nonnumeric text, Green Star");
  assert.equal(restaurantById(rows, "michelin-22").award, "Blob, Green Star");

  const historical = restaurantById(rows, HISTORICAL_ID);
  assert.equal(historical.name, "Preserved historical");
  assert.equal(historical.datasetVersion, "historical-version");
  assert.deepEqual(
    rows.metadata.map(({ key, value }) => ({ key, value })),
    [
      { key: MICHELIN_DATASET_VERSION_KEY, value: DATASET_VERSION },
      { key: "unrelated-key", value: "unrelated-value" },
    ],
  );
  assert.equal(rows.spatial.length, rows.restaurants.length);
}

function assertHealthy(database: DatabaseSync): void {
  const integrity = database
    .prepare("SELECT integrity_check AS value FROM pragma_integrity_check")
    .get() as unknown as TextRow;
  assert.equal(integrity.value, "ok");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  const health = database.prepare(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL).get() as unknown as HealthRow;
  assert.equal(health.issueCount, 0);
}

function mutateThroughSpatialTriggers(database: DatabaseSync): DestinationRows {
  database.prepare("UPDATE michelin_restaurants SET latitude = 91 WHERE id = ?").run("michelin-1");
  assert.equal(
    (
      database
        .prepare(`SELECT COUNT(*) AS count
          FROM michelin_restaurant_spatial_index spatial
          JOIN michelin_restaurants restaurant ON restaurant.rowid = spatial.restaurantRowId
          WHERE restaurant.id = ?`)
        .get("michelin-1") as unknown as CountRow
    ).count,
    0,
  );
  database.prepare("UPDATE michelin_restaurants SET latitude = 40, longitude = -70 WHERE id = ?").run("michelin-1");
  database.prepare("DELETE FROM michelin_restaurants WHERE id = ?").run("michelin-3");
  database
    .prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, datasetVersion)
      VALUES ('michelin-trigger-insert', 'Trigger insert', 1.5, 2.5, ?)`)
    .run(DATASET_VERSION);
  assertHealthy(database);
  return readDestinationRows(database);
}

function testSyntheticParityAndSpatialSemantics(root: string): void {
  const sourcePath = join(root, "synthetic-with-sidecars.db");
  createSyntheticSource(sourcePath, true);
  const sourceBefore = snapshotSqliteSource(sourcePath);
  assert.ok(
    sourceBefore.main.present && sourceBefore.wal.present && sourceBefore.shm.present && sourceBefore.journal.present,
  );

  const oracle = openSeededDestination(join(root, "synthetic-oracle.db"));
  const candidate = openSeededDestination(join(root, "synthetic-candidate.db"));
  try {
    const oracleMeasurement = runCurrentJsOracleImport(oracle, sourcePath, DATASET_VERSION);
    const candidateMeasurement = runAttachInsertSelectImport(candidate, sourcePath, DATASET_VERSION);
    assert.equal(oracleMeasurement.sourceRestaurantRows, SYNTHETIC_RESTAURANTS.length);
    assert.equal(oracleMeasurement.sourceSelectedRows, 20);
    assert.equal(oracleMeasurement.importedRowChanges, 9);
    assert.equal(candidateMeasurement.importedRowChanges, 9);
    assert.equal(candidateMeasurement.bridge.sourceResultRows, 1);
    assert.equal(candidateMeasurement.bridge.boundValues, 4);
    assert.equal(candidateMeasurement.sqlite.transactions, 1);

    const oracleRows = readDestinationRows(oracle);
    const candidateRows = readDestinationRows(candidate);
    assert.deepEqual(candidateRows, oracleRows);
    assertSyntheticExpected(oracleRows);
    assert.deepEqual(destinationDigest(candidate), destinationDigest(oracle));
    assertHealthy(oracle);
    assertHealthy(candidate);

    const mutatedOracle = mutateThroughSpatialTriggers(oracle);
    const mutatedCandidate = mutateThroughSpatialTriggers(candidate);
    assert.deepEqual(mutatedCandidate, mutatedOracle);
  } finally {
    oracle.close();
    candidate.close();
  }
  assert.deepEqual(
    snapshotSqliteSource(sourcePath),
    sourceBefore,
    "All four synthetic source components must be unchanged",
  );
}

function testRollbackAtomicity(root: string): void {
  const sourcePath = join(root, "rollback-source.db");
  createSyntheticSource(sourcePath, true);
  const sourceBefore = snapshotSqliteSource(sourcePath);

  for (const strategy of ["currentJsOracle", "attachInsertSelect"] as const) {
    const database = openSeededDestination(join(root, `rollback-${strategy}.db`));
    try {
      const before = destinationDigest(database);
      const run = strategy === "currentJsOracle" ? runCurrentJsOracleImport : runAttachInsertSelectImport;
      assert.throws(
        () => run(database, sourcePath, DATASET_VERSION, { failurePoint: "afterRowsBeforeMetadata" }),
        new RegExp(IMPORT_FAILURE_MESSAGE),
      );
      assert.deepEqual(destinationDigest(database), before, `${strategy} must roll back rows, triggers, and metadata`);
      const metadata = database
        .prepare("SELECT value FROM app_metadata WHERE key = ?")
        .get(MICHELIN_DATASET_VERSION_KEY) as unknown as TextRow;
      assert.equal(metadata.value, "old-version");
      const attachedNames = database
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => row.name);
      assert.deepEqual(attachedNames, ["main"]);
      assertHealthy(database);
    } finally {
      database.close();
    }
  }
  assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore);
}

function testNoImportableRowsPreserveMetadata(root: string): void {
  const sourcePath = join(root, "no-importable-source.db");
  createSyntheticSource(sourcePath);
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec(`
      DELETE FROM restaurant_awards;
      DELETE FROM restaurants WHERE id IN (1, 2, 3, 12, 15, 16, 17, 21, 22);
    `);
  } finally {
    writer.close();
  }
  writeFileSync(`${sourcePath}-wal`, "no-importable-wal-sentinel");
  writeFileSync(`${sourcePath}-shm`, "no-importable-shm-sentinel");
  writeFileSync(`${sourcePath}-journal`, "no-importable-journal-sentinel");
  const sourceBefore = snapshotSqliteSource(sourcePath);

  const oracle = openSeededDestination(join(root, "no-importable-oracle.db"));
  const candidate = openSeededDestination(join(root, "no-importable-candidate.db"));
  try {
    const before = destinationDigest(oracle);
    assert.deepEqual(destinationDigest(candidate), before);
    assert.throws(
      () => runCurrentJsOracleImport(oracle, sourcePath, "must-not-commit"),
      new RegExp(NO_VALID_MICHELIN_ROWS_MESSAGE),
    );
    assert.throws(
      () => runAttachInsertSelectImport(candidate, sourcePath, "must-not-commit"),
      new RegExp(NO_VALID_MICHELIN_ROWS_MESSAGE),
    );
    assert.deepEqual(destinationDigest(oracle), before);
    assert.deepEqual(destinationDigest(candidate), before);
    assert.equal(
      (
        candidate
          .prepare("SELECT value FROM app_metadata WHERE key = ?")
          .get(MICHELIN_DATASET_VERSION_KEY) as unknown as TextRow
      ).value,
      "old-version",
    );
  } finally {
    oracle.close();
    candidate.close();
  }
  assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore);
}

function firstRealSourceId(): number | string {
  const database = new DatabaseSync(immutableSqliteUri(realSourcePath), { readOnly: true });
  try {
    const row = database.prepare("SELECT id FROM restaurants ORDER BY id LIMIT 1").get() as
      | Record<string, number | string>
      | undefined;
    assert.ok(row);
    return row.id!;
  } finally {
    database.close();
  }
}

function seedRealDestination(database: DatabaseSync, conflictSourceId: number | string): void {
  database
    .prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
      VALUES (?, 'Stale', -1, -1, '', '', '', 1900, 'Stale', 'old')`)
    .run(`michelin-${String(conflictSourceId)}`);
  database
    .prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
      VALUES (?, 'Historical', 1, 2, '', '', '', 2020, 'Historical', 'historical')`)
    .run(HISTORICAL_ID);
  database
    .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?), ('unrelated', 'preserved')")
    .run(MICHELIN_DATASET_VERSION_KEY, "old");
}

function testRealAssetParity(root: string): DestinationDigest {
  const sourceBefore = snapshotSqliteSource(realSourcePath);
  const conflictSourceId = firstRealSourceId();
  assert.deepEqual(
    snapshotSqliteSource(realSourcePath),
    sourceBefore,
    "Immutable real-source identity lookup changed sidecars",
  );
  const oracle = openDestinationDatabase(join(root, "real-oracle.db"));
  const candidate = openDestinationDatabase(join(root, "real-candidate.db"));
  try {
    seedRealDestination(oracle, conflictSourceId);
    seedRealDestination(candidate, conflictSourceId);
    const oracleMeasurement = runCurrentJsOracleImport(oracle, realSourcePath, "real-asset-test-v1");
    const candidateMeasurement = runAttachInsertSelectImport(candidate, realSourcePath, "real-asset-test-v1");
    assert.equal(oracleMeasurement.sourceRestaurantRows, 28_787);
    assert.equal(oracleMeasurement.importedRowChanges, 28_785);
    assert.equal(candidateMeasurement.importedRowChanges, 28_785);
    const oracleDigest = destinationDigest(oracle);
    assert.deepEqual(destinationDigest(candidate), oracleDigest);
    assert.equal(oracleDigest.restaurantRows, 28_786);
    assertHealthy(oracle);
    assertHealthy(candidate);
    return oracleDigest;
  } finally {
    oracle.close();
    candidate.close();
    assert.deepEqual(snapshotSqliteSource(realSourcePath), sourceBefore, "Real source main/WAL/SHM/journal changed");
  }
}

function benchmarkArguments(sourcePath: string, outputPath: string, extra: readonly string[] = []): string[] {
  return [
    "--no-warnings",
    "--experimental-sqlite",
    "--experimental-strip-types",
    benchmarkPath,
    `--source=${sourcePath}`,
    "--samples=2",
    "--warmup=0",
    `--output=${outputPath}`,
    ...extra,
  ];
}

function runBenchmark(sourcePath: string, outputPath: string, extra: readonly string[] = []): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, benchmarkArguments(sourcePath, outputPath, extra), {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function assertBenchmarkRejected(
  sourcePath: string,
  outputPath: string,
  expected: RegExp,
  extra: readonly string[] = [],
): void {
  const result = runBenchmark(sourcePath, outputPath, extra);
  assert.notEqual(result.status, 0, `Benchmark unexpectedly succeeded:\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function testBenchmarkContractAndPrivacy(root: string): void {
  const sourcePath = join(root, "benchmark-source.db");
  const outputPath = join(root, "aggregate-report.json");
  createSyntheticSource(sourcePath);
  const sourceBefore = snapshotSqliteSource(sourcePath);
  const result = runBenchmark(sourcePath, outputPath);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.ok(existsSync(outputPath));
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore);

  const reportText = readFileSync(outputPath, "utf8");
  const report = JSON.parse(reportText) as Record<string, unknown>;
  assert.equal(report.schemaVersion, 1);
  assert.doesNotMatch(reportText, new RegExp(SECRET_SENTINEL));
  assert.ok(!reportText.includes(sourcePath), "Report must not retain the source path");
  assert.ok(!result.stdout.includes(SECRET_SENTINEL), "stdout must remain aggregate-only");
  const forbiddenKeys = new Set([
    "id",
    "restaurantId",
    "name",
    "latitude",
    "longitude",
    "address",
    "location",
    "cuisine",
    "path",
  ]);
  for (const key of collectKeys(report)) {
    assert.ok(!forbiddenKeys.has(key), `Aggregate report contains forbidden raw-field key: ${key}`);
  }

  const source = report.source as Record<string, unknown>;
  assert.equal(source.restaurantRows, SYNTHETIC_RESTAURANTS.length);
  assert.equal(source.importedRows, 9);
  const correctness = report.correctness as Record<string, unknown>;
  assert.equal(correctness.equalMichelinRestaurantsMetadataAndSpatialTables, true);
  const destinationReportDigest = correctness.destinationDigest as Record<string, unknown>;
  assert.match(String(destinationReportDigest.fullTableSha256), /^[0-9a-f]{64}$/);
  const strategies = report.strategies as Record<string, Record<string, unknown>>;
  const oracleStrategy = strategies.currentJsOracle!;
  const candidateStrategy = strategies.attachInsertSelect!;
  assert.equal((oracleStrategy.bridgeModel as Record<string, unknown>).sourceResultRows, 21);
  assert.equal((candidateStrategy.bridgeModel as Record<string, unknown>).sourceResultRows, 1);
  assert.equal((oracleStrategy.sqliteModel as Record<string, unknown>).transactions, 1);
  assert.equal((candidateStrategy.sqliteModel as Record<string, unknown>).transactions, 1);
  assert.equal(((oracleStrategy.destinationWalGrowthBytes as Record<string, unknown>).samples as unknown[]).length, 2);
  assert.equal(
    (
      ((candidateStrategy.phasesMilliseconds as Record<string, unknown>).total as Record<string, unknown>)
        .samples as unknown[]
    ).length,
    2,
  );
  const comparison = report.comparison as Record<string, unknown>;
  assert.equal(comparison.sourceResultRowsEliminated, 20);
  assert.equal(comparison.boundValuesEliminated, 88);
  const implementation = report.implementation as Record<string, unknown>;
  assert.match(String(implementation.productionImportCoreSha256), /^[0-9a-f]{64}$/);
  const privacy = report.privacy as Record<string, unknown>;
  assert.equal(privacy.aggregateOnly, true);
  assert.equal(privacy.rawDisposableDatabasesRetained, false);

  const rawDatabases = readdirSync(root).filter((name) => name.endsWith(".db") && name !== "benchmark-source.db");
  assert.deepEqual(rawDatabases, [], "Benchmark must not retain disposable destination databases");
  const reportHash = createHash("sha256").update(reportText).digest("hex");
  assert.match(reportHash, /^[0-9a-f]{64}$/);

  assertBenchmarkRejected(sourcePath, outputPath, /already exists/);

  const symlinkOutput = join(root, "source-output-symlink.json");
  symlinkSync(sourcePath, symlinkOutput);
  assertBenchmarkRejected(sourcePath, symlinkOutput, /aliases a protected source/);
  rmSync(symlinkOutput);

  const hardLinkOutput = join(root, "source-output-hardlink.json");
  linkSync(sourcePath, hardLinkOutput);
  assertBenchmarkRejected(sourcePath, hardLinkOutput, /hard-link aliases|aliases a protected source/);
  rmSync(hardLinkOutput);

  const sourceSymlink = join(root, "source-symlink.db");
  symlinkSync(sourcePath, sourceSymlink);
  assertBenchmarkRejected(sourceSymlink, join(root, "symlink-report.json"), /non-symlink/);
  rmSync(sourceSymlink);

  const nonQuiescentSource = join(root, "non-quiescent.db");
  createSyntheticSource(nonQuiescentSource);
  writeFileSync(`${nonQuiescentSource}-wal`, "not-empty");
  const nonQuiescentBefore = snapshotSqliteSource(nonQuiescentSource);
  assertBenchmarkRejected(nonQuiescentSource, join(root, "non-quiescent.json"), /WAL must be absent or empty/);
  assert.deepEqual(snapshotSqliteSource(nonQuiescentSource), nonQuiescentBefore);

  assertBenchmarkRejected(sourcePath, join(root, "odd.json"), /--samples must be even/, ["--samples=1"]);
  const help = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-sqlite", "--experimental-strip-types", benchmarkPath, "--help"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /aggregate-only/);
}

function testAliasGuards(root: string): void {
  const sourcePath = join(root, "alias-source.db");
  createSyntheticSource(sourcePath);
  const hardLinkPath = join(root, "alias-destination.db");
  linkSync(sourcePath, hardLinkPath);
  assert.throws(() => assertMutableDatabaseDoesNotAliasSource(sourcePath, hardLinkPath), /aliases a protected source/);
  assert.throws(() => resolveProtectedSourcePath(sourcePath), /hard-link aliases/);
  rmSync(hardLinkPath);
  assert.equal(resolveProtectedSourcePath(sourcePath), realpathSync(resolve(sourcePath)));

  const symlinkPath = join(root, "alias-source-symlink.db");
  symlinkSync(sourcePath, symlinkPath);
  assert.throws(() => resolveProtectedSourcePath(symlinkPath), /non-symlink/);
}

function testPrototypePinsSharedProductionCore(): void {
  assert.equal(ATTACHED_MICHELIN_INSERT_SELECT_SQL, PRODUCTION_ATTACHED_MICHELIN_INSERT_SELECT_SQL);
  assert.equal(MICHELIN_DATASET_VERSION_KEY, PRODUCTION_MICHELIN_DATASET_VERSION_KEY);
  assert.equal(NO_VALID_MICHELIN_ROWS_MESSAGE, PRODUCTION_NO_VALID_MICHELIN_ROWS_MESSAGE);
  assert.equal(CURRENT_MICHELIN_IMPORT_BATCH_SIZE, 1000);
  assert.match(CURRENT_MICHELIN_SOURCE_ROWS_SQL, /SELECT\s+restaurant_id, MAX\(year\) as max_year/s);
  assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /CASE typeof\(has_green_star\)/);
  assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /WHEN 'text' THEN length\(has_green_star\) != 0/);
  assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /WHEN 'blob' THEN 1/);
  assert.match(MICHELIN_IMPORT_METADATA_UPSERT_SQL, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
  const prototypeCoreSource = readFileSync(join(repositoryRoot, "scripts/michelin-import-prototype-core.ts"), "utf8");
  assert.match(prototypeCoreSource, /from "\.\.\/utils\/db\/michelin-import-core\.ts"/);
  assert.doesNotMatch(prototypeCoreSource, /export const ATTACHED_MICHELIN_INSERT_SELECT_SQL\s*=/);
  assert.match(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL, /AFTER INSERT ON michelin_restaurants/);
  assert.match(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL, /AFTER UPDATE OF latitude, longitude/);
  assert.match(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL, /AFTER DELETE ON michelin_restaurants/);
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "palate-michelin-import-test-"));
  chmodSync(root, 0o700);
  try {
    testPrototypePinsSharedProductionCore();
    testSyntheticParityAndSpatialSemantics(root);
    testRollbackAtomicity(root);
    testNoImportableRowsPreserveMetadata(root);
    testAliasGuards(root);
    const realDigest = testRealAssetParity(root);
    const benchmarkRoot = join(root, "benchmark-contract");
    mkdirSync(benchmarkRoot, { mode: 0o700 });
    testBenchmarkContractAndPrivacy(benchmarkRoot);
    console.log(
      `Michelin import prototype tests passed: ${SYNTHETIC_RESTAURANTS.length} adversarial rows, ` +
        `real full-table digest ${realDigest.fullTableSha256}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
