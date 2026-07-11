#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  calculateGeodesicDistanceMeters,
  MichelinLocationIndex,
  type MichelinLocation,
  type MichelinLocationSearchOptions,
} from "../utils/michelin-location-index.ts";
import {
  ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL,
  loadActiveMichelinSuggestionLocations,
  type MichelinSuggestionLocation,
} from "../utils/db/michelin-suggestion-index-core.ts";

interface FullRestaurant extends MichelinLocation {
  readonly name: string;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion: string;
}

interface FileSnapshot {
  readonly present: boolean;
  readonly bytes: number | null;
  readonly mode: number | null;
  readonly sha256: string | null;
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const benchmarkPath = join(repositoryRoot, "scripts/benchmark-michelin-suggestion-index-projection.ts");
const productionIndexSource = readFileSync(join(repositoryRoot, "utils/db/michelin-index.ts"), "utf8");
const benchmarkSource = readFileSync(benchmarkPath, "utf8");
assert.match(
  productionIndexSource,
  /const restaurants = await loadActiveMichelinSuggestionLocations\(database\)/,
  "the production cache must build from the shared minimal loader",
);
assert.doesNotMatch(
  productionIndexSource,
  /SELECT\s+m\.\*/,
  "the production index module must not restore full-row materialization",
);
const formerQuerySource = benchmarkSource.match(/const ACTIVE_FULL_ROWS_SQL = `([\s\S]*?)`;/)?.[1];
assert.ok(formerQuerySource, "the benchmark must retain an explicit former-production SQL oracle");
assert.match(
  formerQuerySource,
  /metadata\.key = 'michelin_dataset_version'/,
  "the former-production oracle must preserve the exact literal metadata predicate",
);
assert.doesNotMatch(
  formerQuerySource,
  /metadata\.key = \?/,
  "the A/B must not confound column projection with parameter binding",
);

function projectRestaurant({ id, latitude, longitude }: MichelinLocation): MichelinLocation {
  return { id, latitude, longitude };
}

function queryIndex(
  index: MichelinLocationIndex<MichelinLocation>,
  options: MichelinLocationSearchOptions,
): Array<{ id: string; distanceMeters: number }> {
  return index.findNearby(options).map(({ restaurant, distanceMeters }) => ({ id: restaurant.id, distanceMeters }));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { present: false, bytes: null, mode: null, sha256: null };
  }
  const metadata = statSync(path);
  return {
    present: true,
    bytes: metadata.size,
    mode: metadata.mode & 0o7777,
    sha256: sha256File(path),
  };
}

function sqliteSourceSnapshot(databasePath: string): Record<string, FileSnapshot> {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => [suffix || "main", fileSnapshot(`${databasePath}${suffix}`)]),
  );
}

function benchmarkArguments(databasePath: string, outputPath: string): string[] {
  return [
    "--no-warnings",
    "--experimental-sqlite",
    "--experimental-strip-types",
    benchmarkPath,
    `--database=${databasePath}`,
    "--samples=2",
    "--warmup=1",
    `--output=${outputPath}`,
  ];
}

function runBenchmark(databasePath: string, outputPath: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, benchmarkArguments(databasePath, outputPath), {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function assertBenchmarkRejected(
  databasePath: string,
  outputPath: string,
  expectedMessage: RegExp,
): SpawnSyncReturns<string> {
  const result = runBenchmark(databasePath, outputPath);
  assert.notEqual(result.status, 0, `benchmark unexpectedly succeeded: ${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage);
  return result;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}

const boundaryLatitude = (200 / 6_371_000) * (180 / Math.PI);
const fullRestaurants: FullRestaurant[] = [
  {
    id: "tie-zeta-private",
    name: "Private Zeta Name",
    latitude: 0,
    longitude: 0,
    address: "Private Zeta Address",
    location: "Private Zeta Location",
    cuisine: "Private Zeta Cuisine",
    latestAwardYear: 2025,
    award: "Selected",
    datasetVersion: "active-private-version",
  },
  {
    id: "tie-alpha-private",
    name: "Private Alpha Name",
    latitude: 0,
    longitude: 0,
    address: "Private Alpha Address",
    location: "Private Alpha Location",
    cuisine: "Private Alpha Cuisine",
    latestAwardYear: null,
    award: "1 Star",
    datasetVersion: "active-private-version",
  },
  {
    id: "tie-雪-private",
    name: "Private Unicode Name 雪",
    latitude: 0,
    longitude: 0,
    address: "Private Unicode Address",
    location: "Private Unicode Location",
    cuisine: "Private Unicode Cuisine",
    latestAwardYear: 2024,
    award: "Bib Gourmand",
    datasetVersion: "active-private-version",
  },
  {
    id: "exact-boundary-private",
    name: "Exact Boundary Private Name",
    latitude: boundaryLatitude,
    longitude: 0,
    address: "Exact Boundary Private Address",
    location: "Exact Boundary Private Location",
    cuisine: "Exact Boundary Private Cuisine",
    latestAwardYear: 2023,
    award: "2 Stars",
    datasetVersion: "active-private-version",
  },
  {
    id: "anti-east-private",
    name: "Antimeridian East Private Name",
    latitude: 10,
    longitude: 179.9999,
    address: "Antimeridian East Private Address",
    location: "Antimeridian East Private Location",
    cuisine: "Antimeridian East Private Cuisine",
    latestAwardYear: 2025,
    award: "Selected",
    datasetVersion: "active-private-version",
  },
  {
    id: "anti-west-private",
    name: "Antimeridian West Private Name",
    latitude: 10,
    longitude: -179.9999,
    address: "Antimeridian West Private Address",
    location: "Antimeridian West Private Location",
    cuisine: "Antimeridian West Private Cuisine",
    latestAwardYear: 2025,
    award: "Selected",
    datasetVersion: "active-private-version",
  },
  {
    id: "north-pole-private",
    name: "North Pole Private Name",
    latitude: 89.9999,
    longitude: 135,
    address: "North Pole Private Address",
    location: "North Pole Private Location",
    cuisine: "North Pole Private Cuisine",
    latestAwardYear: 2025,
    award: "3 Stars",
    datasetVersion: "active-private-version",
  },
];

const fullRowsBefore = structuredClone(fullRestaurants);
const minimalRestaurants = fullRestaurants.map(projectRestaurant);
assert.deepEqual(Object.keys(minimalRestaurants[0]!).sort(), ["id", "latitude", "longitude"]);
const fullIndex = new MichelinLocationIndex(fullRestaurants);
const minimalIndex = new MichelinLocationIndex(minimalRestaurants);
const exactBoundaryDistance = calculateGeodesicDistanceMeters(0, 0, boundaryLatitude, 0);
const adversarialQueries: MichelinLocationSearchOptions[] = [
  { latitude: 0, longitude: 0, radiusMeters: 0, limit: 5 },
  { latitude: 0, longitude: 0, radiusMeters: exactBoundaryDistance, limit: 5 },
  { latitude: 0, longitude: 0, radiusMeters: exactBoundaryDistance - 1e-4, limit: 5 },
  { latitude: 10, longitude: 180, radiusMeters: 200, limit: 5 },
  { latitude: 10, longitude: -180, radiusMeters: 200, limit: 1 },
  { latitude: 90, longitude: -45, radiusMeters: 200, limit: 5 },
  { latitude: -90, longitude: 0, radiusMeters: 20_000_000, limit: 5 },
  { latitude: 0, longitude: 0, radiusMeters: 200, limit: 0 },
];

for (const query of adversarialQueries) {
  assert.deepEqual(
    queryIndex(minimalIndex, query),
    queryIndex(fullIndex, query),
    `projection changed exact IDs/distances for ${JSON.stringify(query)}`,
  );
}
assert.deepEqual(fullRestaurants, fullRowsBefore, "index construction and queries must not mutate full rows");
assert.deepEqual(
  queryIndex(minimalIndex, adversarialQueries[0]!).map(({ id }) => id),
  ["tie-alpha-private", "tie-zeta-private", "tie-雪-private"],
  "equal-coordinate ties must retain deterministic ID ordering",
);
assert.ok(
  queryIndex(minimalIndex, adversarialQueries[1]!).some(({ id }) => id === "exact-boundary-private"),
  "the exact inclusive radius boundary must survive projection",
);
assert.ok(
  !queryIndex(minimalIndex, adversarialQueries[2]!).some(({ id }) => id === "exact-boundary-private"),
  "a point outside the radius must remain excluded",
);

const productionRows: MichelinSuggestionLocation[] = [
  { id: "production-alpha", latitude: 0, longitude: 0 },
  { id: "production-zeta", latitude: boundaryLatitude, longitude: 0 },
];
let productionQuery = "";
let productionQueryCount = 0;
let productionQueryParameters: readonly unknown[] = [];
const productionDatabase = {
  async getAllAsync<T>(source: string, ...parameters: unknown[]): Promise<T[]> {
    productionQuery = source;
    productionQueryCount += 1;
    productionQueryParameters = parameters;
    return productionRows as T[];
  },
} as Parameters<typeof loadActiveMichelinSuggestionLocations>[0];
const loadedProductionRows = await loadActiveMichelinSuggestionLocations(productionDatabase);
assert.equal(productionQueryCount, 1, "the production index must execute one active-guide query per generation");
assert.deepEqual(productionQueryParameters, [], "the production active-guide projection must not need row parameters");
assert.equal(productionQuery, ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL);
assert.equal(
  productionQuery.replace(/\s+/g, " ").trim(),
  "SELECT m.id, m.latitude, m.longitude FROM michelin_restaurants m JOIN app_metadata metadata ON metadata.key = 'michelin_dataset_version' AND m.datasetVersion = metadata.value",
  "the shipped index query must project only the three fields consumed by proximity matching",
);
const productionIndex = new MichelinLocationIndex(loadedProductionRows);
const productionMatches = productionIndex.findNearby({
  latitude: 0,
  longitude: 0,
  radiusMeters: exactBoundaryDistance,
  limit: 5,
});
assert.deepEqual(
  productionMatches.map(({ restaurant }) => Object.keys(restaurant).sort()),
  [
    ["id", "latitude", "longitude"],
    ["id", "latitude", "longitude"],
  ],
  "the production index must not retain unused Michelin row fields",
);
assert.deepEqual(
  productionMatches.map(({ restaurant, distanceMeters }) => ({ id: restaurant.id, distanceMeters })),
  [
    { id: "production-alpha", distanceMeters: 0 },
    { id: "production-zeta", distanceMeters: exactBoundaryDistance },
  ],
  "the shipped projection must preserve deterministic IDs and exact distances",
);

for (const invalidLocation of [
  { id: "null-latitude", latitude: null as unknown as number, longitude: 0 },
  { id: "nan-latitude", latitude: Number.NaN, longitude: 0 },
  { id: "infinite-latitude", latitude: Number.POSITIVE_INFINITY, longitude: 0 },
  { id: "latitude-out-of-range", latitude: 90.000_001, longitude: 0 },
  { id: "longitude-out-of-range", latitude: 0, longitude: -180.000_001 },
]) {
  assert.throws(
    () => new MichelinLocationIndex([invalidLocation]),
    /(latitude|longitude) must be a finite number/,
    `invalid projected row must retain the production index failure: ${invalidLocation.id}`,
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-michelin-suggestion-index-projection-"));
const databasePath = join(temporaryDirectory, "private-source.sqlite");
const walPath = `${databasePath}-wal`;
const shmPath = `${databasePath}-shm`;
const journalPath = `${databasePath}-journal`;

try {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE michelin_restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        address TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        cuisine TEXT NOT NULL DEFAULT '',
        latestAwardYear INTEGER,
        award TEXT NOT NULL DEFAULT '',
        datasetVersion TEXT
      );
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        centerLat REAL NOT NULL,
        centerLon REAL NOT NULL
      );
      CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
    `);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES ('michelin_dataset_version', 'active-private-version')")
      .run();
    database.prepare("INSERT INTO sequence_probe (value) VALUES ('private-sequence-sentinel')").run();
    const insertRestaurant = database.prepare(`INSERT INTO michelin_restaurants (
      id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const restaurant of fullRestaurants) {
      insertRestaurant.run(
        restaurant.id,
        restaurant.name,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.address,
        restaurant.location,
        restaurant.cuisine,
        restaurant.latestAwardYear,
        restaurant.award,
        restaurant.datasetVersion,
      );
    }
    insertRestaurant.run(
      "stale-private-restaurant",
      "Stale Private Name",
      0,
      0,
      "Stale Private Address",
      "Stale Private Location",
      "Stale Private Cuisine",
      2020,
      "Selected",
      "stale-private-version",
    );
    const insertVisit = database.prepare("INSERT INTO visits (id, status, centerLat, centerLon) VALUES (?, ?, ?, ?)");
    for (const [index, coordinate] of [
      [0, 0],
      [10, 180],
      [10, -180],
      [90, -45],
      [-90, 0],
      [48.8566, 2.3522],
      [91, 0],
    ].entries()) {
      insertVisit.run(`private-visit-${index}`, index % 2 === 0 ? "pending" : "confirmed", ...coordinate);
    }

    const selectActiveProjection = () =>
      database.prepare(ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL).all() as unknown as MichelinSuggestionLocation[];
    const activeProjection = selectActiveProjection();
    assert.equal(activeProjection.length, fullRestaurants.length);
    assert.ok(!activeProjection.some(({ id }) => id === "stale-private-restaurant"));
    assert.ok(activeProjection.every((row) => Object.keys(row).sort().join(",") === "id,latitude,longitude"));

    database
      .prepare("UPDATE app_metadata SET value = 'stale-private-version' WHERE key = 'michelin_dataset_version'")
      .run();
    assert.deepEqual(
      selectActiveProjection().map(({ id, latitude, longitude }) => ({ id, latitude, longitude })),
      [{ id: "stale-private-restaurant", latitude: 0, longitude: 0 }],
    );
    database.prepare("DELETE FROM app_metadata WHERE key = 'michelin_dataset_version'").run();
    assert.deepEqual(selectActiveProjection(), []);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES ('michelin_dataset_version', 'active-private-version')")
      .run();
  } finally {
    database.close();
  }

  writeFileSync(walPath, "");
  writeFileSync(shmPath, "private-shm-identity-sentinel");
  writeFileSync(journalPath, "");

  assertBenchmarkRejected(databasePath, databasePath, /must not alias/i);

  const rejectedWalOutput = join(temporaryDirectory, "rejected-wal.json");
  writeFileSync(walPath, "private-pending-wal-sentinel");
  assertBenchmarkRejected(databasePath, rejectedWalOutput, /non-empty wal sidecar/i);
  assert.equal(existsSync(rejectedWalOutput), false);
  writeFileSync(walPath, "");

  const rejectedJournalOutput = join(temporaryDirectory, "rejected-journal.json");
  writeFileSync(journalPath, "private-pending-journal-sentinel");
  assertBenchmarkRejected(databasePath, rejectedJournalOutput, /non-empty journal sidecar/i);
  assert.equal(existsSync(rejectedJournalOutput), false);
  writeFileSync(journalPath, "");

  const sourceBefore = sqliteSourceSnapshot(databasePath);
  const outputPath = join(temporaryDirectory, "aggregate-report.json");
  const benchmark = runBenchmark(databasePath, outputPath);
  assert.equal(benchmark.status, 0, `${benchmark.stdout}\n${benchmark.stderr}`);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600, "aggregate report must be owner-only");
  assert.deepEqual(
    sqliteSourceSnapshot(databasePath),
    sourceBefore,
    "successful immutable benchmark must leave main/WAL/SHM/journal byte-identical",
  );
  assert.ok(
    !readdirSync(temporaryDirectory).some((name) => name.includes(".tmp-")),
    "atomic report temporary files must be cleaned up",
  );

  const serializedReport = readFileSync(outputPath, "utf8");
  const report = requiredRecord(JSON.parse(serializedReport), "report");
  const configuration = requiredRecord(report.configuration, "configuration");
  const source = requiredRecord(report.source, "source");
  const correctness = requiredRecord(report.correctness, "correctness");
  const strategies = requiredRecord(report.strategies, "strategies");
  const current = requiredRecord(strategies.currentFullRows, "currentFullRows");
  const minimal = requiredRecord(strategies.minimalProjection, "minimalProjection");
  const currentTiming = requiredRecord(current.nodeModelTiming, "current timing");
  const minimalTiming = requiredRecord(minimal.nodeModelTiming, "minimal timing");
  const comparison = requiredRecord(report.comparison, "comparison");
  const counterbalancing = requiredRecord(report.counterbalancing, "counterbalancing");
  const sourceAttestation = requiredRecord(report.sourceAttestation, "sourceAttestation");
  const writeInvariants = requiredRecord(report.writeInvariants, "writeInvariants");
  const privacy = requiredRecord(report.privacy, "privacy");

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "ok");
  assert.equal(configuration.samples, 2);
  assert.equal(configuration.warmupPairs, 1);
  assert.equal(source.activeGuideRowCount, fullRestaurants.length);
  assert.equal(source.validVisitCentroidCount, 6);
  assert.equal(source.minimalRowColumnCount, 3);
  assert.equal(correctness.exactProjectedRowParity, true);
  assert.equal(correctness.exactSuggestionIdAndDistanceParity, true);
  assert.equal(typeof correctness.suggestionDigestSha256, "string");
  assert.ok(Number(current.payloadBytes) > Number(minimal.payloadBytes));
  assert.ok(Number(comparison.payloadBytesSaved) > 0);
  for (const phase of ["load", "build", "search", "total"]) {
    const currentPhase = requiredRecord(currentTiming[phase], `current ${phase}`);
    const minimalPhase = requiredRecord(minimalTiming[phase], `minimal ${phase}`);
    assert.equal((currentPhase.samplesMilliseconds as unknown[]).length, 2);
    assert.equal((minimalPhase.samplesMilliseconds as unknown[]).length, 2);
  }
  assert.deepEqual(counterbalancing.measuredOrders, [
    ["minimalProjection", "currentFullRows"],
    ["currentFullRows", "minimalProjection"],
  ]);
  assert.equal(sourceAttestation.nonEmptyWalRejected, true);
  assert.equal(sourceAttestation.nonEmptyJournalRejected, true);
  assert.equal(sourceAttestation.mainWalShmJournalByteIdentical, true);
  assert.equal(writeInvariants.totalChangesUnchanged, true);
  assert.equal(writeInvariants.sqliteSequenceUnchanged, true);
  assert.equal(writeInvariants.mainWalShmJournalByteIdentical, true);
  assert.deepEqual(privacy, {
    aggregateOnly: true,
    sourceAndOutputPathsRetained: false,
    rawRestaurantFieldsRetained: false,
    restaurantIdsRetained: false,
    rawVisitFieldsRetained: false,
    visitIdsOrCoordinatesRetained: false,
    photosLibraryAccessed: false,
    calendarDataAccessed: false,
  });
  assert.ok(!serializedReport.includes(databasePath), "aggregate report leaked the source path");
  assert.ok(!serializedReport.includes(outputPath), "aggregate report leaked the output path");
  for (const restaurant of fullRestaurants) {
    for (const privateValue of [
      restaurant.id,
      restaurant.name,
      restaurant.address,
      restaurant.location,
      restaurant.cuisine,
      restaurant.datasetVersion,
    ]) {
      assert.ok(!serializedReport.includes(privateValue), `aggregate report leaked fixture value: ${privateValue}`);
    }
  }
  assert.ok(!serializedReport.includes("private-visit-"), "aggregate report leaked visit IDs");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  "Michelin suggestion index projection tests passed: exact synthetic ID/distance parity across ties, boundary, antimeridian, poles, zero coordinates and limits; immutable real-shape visit workload; WAL/journal rejection; main/WAL/SHM/journal identity; counterbalancing; payload accounting; aggregate-only privacy.",
);
