#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

interface Configuration {
  readonly restaurants: number;
  readonly visitsPerRestaurant: number;
  readonly photosPerVisit: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly seed: number;
}

interface DatasetCounts {
  readonly restaurants: number;
  readonly visits: number;
  readonly confirmedVisits: number;
  readonly photos: number;
  readonly confirmedPhotos: number;
}

interface PreviewRow {
  readonly restaurantId: string;
  readonly previewPhotosJson: string | null;
}

interface PreviewResult {
  readonly restaurantId: string;
  readonly previewPhotos: string[];
}

interface MeasurementSummary {
  readonly samplesMs: number[];
  readonly minimumMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

type PreviewStatement = ReturnType<DatabaseSync["prepare"]>;

const DEFAULT_CONFIGURATION: Configuration = {
  restaurants: 1_000,
  visitsPerRestaurant: 4,
  photosPerVisit: 24,
  samples: 7,
  warmupIterations: 1,
  seed: 0x51a7e,
};

const EDGE_CASE_NAMES = [
  "food priority (true, false, null)",
  "newest-first order within a priority",
  "photos spread across confirmed visits",
  "fewer than three photos",
  "confirmed visit without photos",
  "pending and rejected visit exclusion",
  "mixed confirmed and unconfirmed visits",
  "JSON-sensitive and Unicode URIs",
  "equal-rank ties use the photo ID as a stable final key",
] as const;

// This is the preview-photo portion of getConfirmedRestaurantsWithVisits as it
// exists today: rank every confirmed photo globally, then aggregate the top 3.
const GLOBAL_WINDOW_QUERY = `
  WITH
    restaurant_stats AS (
      SELECT
        restaurantId,
        COUNT(id) AS visitCount,
        MAX(startTime) AS lastVisit,
        MAX(updatedAt) AS lastConfirmedAt
      FROM visits
      WHERE status = 'confirmed' AND restaurantId IS NOT NULL
      GROUP BY restaurantId
    ),
    ranked_photos AS (
      SELECT
        v.restaurantId,
        p.uri,
        ROW_NUMBER() OVER (
          PARTITION BY v.restaurantId
          ORDER BY
            CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
            p.creationTime DESC,
            p.id ASC
        ) AS rn
      FROM photos p
      INNER JOIN visits v ON p.visitId = v.id
      WHERE v.status = 'confirmed' AND v.restaurantId IS NOT NULL
    ),
    preview_photos AS (
      SELECT
        restaurantId,
        json_group_array(uri) AS uris
      FROM ranked_photos
      WHERE rn <= 3
      GROUP BY restaurantId
    )
  SELECT
    r.id AS restaurantId,
    pp.uris AS previewPhotosJson
  FROM restaurants r
  INNER JOIN restaurant_stats rs ON rs.restaurantId = r.id
  LEFT JOIN preview_photos pp ON pp.restaurantId = r.id
  ORDER BY rs.lastVisit DESC
`;

// The candidate keeps the restaurant summary pass, but limits preview work to
// an indexed, correlated top-3 lookup for each restaurant instead of assigning
// a window row number to the complete confirmed-photo set.
const CORRELATED_TOP_THREE_QUERY = `
  WITH
    restaurant_stats AS (
      SELECT
        restaurantId,
        COUNT(id) AS visitCount,
        MAX(startTime) AS lastVisit,
        MAX(updatedAt) AS lastConfirmedAt
      FROM visits
      WHERE status = 'confirmed' AND restaurantId IS NOT NULL
      GROUP BY restaurantId
    )
  SELECT
    r.id AS restaurantId,
    (
      SELECT json_group_array(uri)
      FROM (
        SELECT p.uri
        FROM visits preview_visits
        INNER JOIN photos p ON p.visitId = preview_visits.id
        WHERE preview_visits.restaurantId = r.id
          AND preview_visits.status = 'confirmed'
        ORDER BY
          CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
          p.creationTime DESC,
          p.id ASC
        LIMIT 3
      )
    ) AS previewPhotosJson
  FROM restaurants r
  INNER JOIN restaurant_stats rs ON rs.restaurantId = r.id
  ORDER BY rs.lastVisit DESC
`;

function usage(): string {
  return `Usage: benchmark-home-preview-query.ts [options]

  --restaurants=N                Restaurant rows (default: ${DEFAULT_CONFIGURATION.restaurants})
  --visits-per-restaurant=N      Visits generated per restaurant (default: ${DEFAULT_CONFIGURATION.visitsPerRestaurant})
  --photos-per-visit=N           Photos generated per visit (default: ${DEFAULT_CONFIGURATION.photosPerVisit})
  --samples=N                    Measured samples per query (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N                     Warmup iterations per query (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --seed=N                       Unsigned deterministic dataset seed (default: ${DEFAULT_CONFIGURATION.seed})
  --help, -h                     Print this help`;
}

function parsePositiveInteger(option: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive safe integer; received ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(option: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${option} must be a non-negative safe integer; received ${value}`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const values = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    // pnpm versions differ in whether `pnpm script -- --flag` preserves the
    // separator. Accept both invocation styles without weakening option checks.
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }

    const separatorIndex = argument.indexOf("=");
    if (!argument.startsWith("--") || separatorIndex === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);

    switch (option) {
      case "--restaurants":
        values.restaurants = parsePositiveInteger(option, value);
        break;
      case "--visits-per-restaurant":
        values.visitsPerRestaurant = parsePositiveInteger(option, value);
        break;
      case "--photos-per-visit":
        values.photosPerVisit = parsePositiveInteger(option, value);
        break;
      case "--samples":
        values.samples = parsePositiveInteger(option, value);
        break;
      case "--warmup":
        values.warmupIterations = parseNonNegativeInteger(option, value);
        break;
      case "--seed":
        values.seed = parseNonNegativeInteger(option, value);
        if (values.seed > 0xffff_ffff) {
          throw new RangeError(`${option} must fit in an unsigned 32-bit integer; received ${value}`);
        }
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return values;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      updatedAt INTEGER,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id)
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );

    CREATE INDEX idx_visits_restaurant_status_time
      ON visits(restaurantId, status, startTime DESC);
    CREATE INDEX idx_photos_visit_food_time
      ON photos(visitId, foodDetected, creationTime);
  `);
  return database;
}

function runInTransaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertEdgeCaseDataset(database: DatabaseSync): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime, updatedAt) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );

  const restaurants = [
    ["r-food", "Food priority"],
    ["r-multi", "Multiple visits"],
    ["r-few", "Fewer than three"],
    ["r-empty", "No photos"],
    ["r-excluded", "No confirmed visits"],
    ["r-mixed-status", "Mixed statuses"],
    ["r-ties", "Equal rank ties"],
  ] as const;

  runInTransaction(database, () => {
    for (const restaurant of restaurants) {
      insertRestaurant.run(...restaurant);
    }

    insertVisit.run("v-food", "r-food", "confirmed", 1_000, 1_001);
    insertPhoto.run("p-null-new", "ph://null-new", 600, "v-food", null);
    insertPhoto.run("p-false-new", "ph://false-new", 500, "v-food", 0);
    insertPhoto.run("p-true-old", "ph://true-old", 100, "v-food", 1);
    insertPhoto.run("p-true-new", "ph://true-new", 400, "v-food", 1);
    insertPhoto.run("p-false-old", "ph://false-old", 200, "v-food", 0);

    insertVisit.run("v-multi-a", "r-multi", "confirmed", 2_000, 2_001);
    insertVisit.run("v-multi-b", "r-multi", "confirmed", 2_100, 2_101);
    insertPhoto.run("p-multi-null", "ph://multi-null", 500, "v-multi-a", null);
    insertPhoto.run("p-multi-false", "ph://multi-false", 400, "v-multi-a", 0);
    insertPhoto.run("p-multi-true-old", "ph://multi-true-old", 100, "v-multi-b", 1);
    insertPhoto.run("p-multi-true-new", "ph://multi-true-new", 300, "v-multi-b", 1);

    insertVisit.run("v-few", "r-few", "confirmed", 3_000, null);
    insertPhoto.run("p-few-new", 'ph://quote-"-snowman-☃', 200, "v-few", 0);
    insertPhoto.run("p-few-old", "ph://slash/L0/001", 100, "v-few", null);

    insertVisit.run("v-empty", "r-empty", "confirmed", 4_000, 4_001);

    insertVisit.run("v-pending", "r-excluded", "pending", 5_000, 5_001);
    insertVisit.run("v-rejected", "r-excluded", "rejected", 5_100, 5_101);
    insertPhoto.run("p-pending", "ph://pending", 900, "v-pending", 1);
    insertPhoto.run("p-rejected", "ph://rejected", 800, "v-rejected", 1);

    insertVisit.run("v-mixed-confirmed", "r-mixed-status", "confirmed", 6_000, 6_001);
    insertVisit.run("v-mixed-pending", "r-mixed-status", "pending", 6_100, 6_101);
    insertVisit.run("v-mixed-rejected", "r-mixed-status", "rejected", 6_200, 6_201);
    insertPhoto.run("p-mixed-confirmed", "ph://mixed-confirmed", 100, "v-mixed-confirmed", null);
    insertPhoto.run("p-mixed-pending", "ph://mixed-pending", 900, "v-mixed-pending", 1);
    insertPhoto.run("p-mixed-rejected", "ph://mixed-rejected", 800, "v-mixed-rejected", 1);

    insertVisit.run("v-ties", "r-ties", "confirmed", 7_000, 7_001);
    insertPhoto.run("p-tie-b", "ph://tie-b", 700, "v-ties", 1);
    insertPhoto.run("p-tie-a", "ph://tie-a", 700, "v-ties", 1);
    insertPhoto.run("p-tie-d", "ph://tie-d", 700, "v-ties", 1);
    insertPhoto.run("p-tie-c", "ph://tie-c", 700, "v-ties", 1);
  });
}

function statusForVisit(restaurantIndex: number, visitIndex: number, visitsPerRestaurant: number): string {
  if (restaurantIndex % 43 === 0) {
    return visitIndex % 2 === 0 ? "pending" : "rejected";
  }
  if (visitIndex === visitsPerRestaurant - 1 && restaurantIndex % 11 === 0) {
    return "pending";
  }
  if (visitIndex === visitsPerRestaurant - 1 && restaurantIndex % 17 === 0) {
    return "rejected";
  }
  return "confirmed";
}

function insertBenchmarkDataset(database: DatabaseSync, configuration: Configuration): DatasetCounts {
  const random = createRandom(configuration.seed);
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime, updatedAt) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );

  let visitCount = 0;
  let confirmedVisitCount = 0;
  let photoCount = 0;
  let confirmedPhotoCount = 0;
  const epoch = 1_700_000_000_000;

  runInTransaction(database, () => {
    for (let restaurantIndex = 0; restaurantIndex < configuration.restaurants; restaurantIndex++) {
      const restaurantId = `restaurant-${restaurantIndex.toString().padStart(6, "0")}`;
      insertRestaurant.run(restaurantId, `Restaurant ${restaurantIndex}`);

      for (let visitIndex = 0; visitIndex < configuration.visitsPerRestaurant; visitIndex++) {
        const visitId = `${restaurantId}-visit-${visitIndex.toString().padStart(2, "0")}`;
        const status = statusForVisit(restaurantIndex, visitIndex, configuration.visitsPerRestaurant);
        const startTime = epoch + restaurantIndex * 100_000_000 + visitIndex * 1_000_000;
        insertVisit.run(visitId, restaurantId, status, startTime, startTime + 1_000);
        visitCount++;
        if (status === "confirmed") {
          confirmedVisitCount++;
        }

        // Some confirmed restaurants intentionally have an empty visit so the
        // LEFT JOIN/null-preview path remains represented in the large fixture.
        const photosInVisit = restaurantIndex % 97 === 0 && visitIndex === 0 ? 0 : configuration.photosPerVisit;
        for (let photoIndex = 0; photoIndex < photosInVisit; photoIndex++) {
          const photoId = `${visitId}-photo-${photoIndex.toString().padStart(4, "0")}`;
          const priorityRoll = Math.floor(random() * 10);
          const foodDetected = priorityRoll < 3 ? 1 : priorityRoll < 7 ? 0 : null;
          // The rank keys are unique within a restaurant. This makes the
          // benchmark parity assertion independent of SQLite's undefined tie order.
          const creationTime = startTime + photoIndex * 1_000 + visitIndex;
          insertPhoto.run(photoId, `ph://${photoId}/L0/001`, creationTime, visitId, foodDetected);
          photoCount++;
          if (status === "confirmed") {
            confirmedPhotoCount++;
          }
        }
      }
    }

    insertVisit.run("unassigned-visit", null, "confirmed", epoch - 1, epoch);
    insertPhoto.run("unassigned-photo", "ph://unassigned/L0/001", epoch - 1, "unassigned-visit", null);
    visitCount++;
    confirmedVisitCount++;
    photoCount++;
    confirmedPhotoCount++;
  });

  return {
    restaurants: configuration.restaurants,
    visits: visitCount,
    confirmedVisits: confirmedVisitCount,
    photos: photoCount,
    confirmedPhotos: confirmedPhotoCount,
  };
}

function parsePreviewPhotos(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  assert.ok(Array.isArray(parsed), "previewPhotosJson must decode to an array");
  assert.ok(
    parsed.every((uri) => typeof uri === "string"),
    "every preview URI must be a string",
  );
  return parsed;
}

function normalizeRows(rows: readonly PreviewRow[]): PreviewResult[] {
  return rows
    .map((row) => ({ restaurantId: row.restaurantId, previewPhotos: parsePreviewPhotos(row.previewPhotosJson) }))
    .sort((left, right) => left.restaurantId.localeCompare(right.restaurantId));
}

function execute(statement: PreviewStatement): PreviewRow[] {
  return statement.all() as unknown as PreviewRow[];
}

function assertQueryParity(database: DatabaseSync): PreviewResult[] {
  const globalRows = normalizeRows(execute(database.prepare(GLOBAL_WINDOW_QUERY)));
  const correlatedRows = normalizeRows(execute(database.prepare(CORRELATED_TOP_THREE_QUERY)));
  assert.deepEqual(correlatedRows, globalRows);
  for (const row of globalRows) {
    assert.ok(row.previewPhotos.length <= 3, `${row.restaurantId} returned more than three previews`);
  }
  return globalRows;
}

function assertCandidateUsesPreviewIndexes(database: DatabaseSync): string[] {
  const details = database
    .prepare(`EXPLAIN QUERY PLAN ${CORRELATED_TOP_THREE_QUERY}`)
    .all()
    .map((row) => (row as unknown as QueryPlanRow).detail);
  const expectedIndexes = ["idx_visits_restaurant_status_time", "idx_photos_visit_food_time"];
  for (const index of expectedIndexes) {
    assert.ok(
      details.some((detail) => detail.includes(index)),
      `candidate query plan did not use ${index}`,
    );
  }
  return expectedIndexes;
}

function assertEdgeCases(): number {
  const database = createDatabase();
  try {
    insertEdgeCaseDataset(database);
    const results = assertQueryParity(database);
    const byRestaurant = new Map(results.map((result) => [result.restaurantId, result.previewPhotos]));

    assert.deepEqual(byRestaurant.get("r-food"), ["ph://true-new", "ph://true-old", "ph://false-new"]);
    assert.deepEqual(byRestaurant.get("r-multi"), ["ph://multi-true-new", "ph://multi-true-old", "ph://multi-false"]);
    assert.deepEqual(byRestaurant.get("r-few"), ['ph://quote-"-snowman-☃', "ph://slash/L0/001"]);
    assert.deepEqual(byRestaurant.get("r-empty"), []);
    assert.equal(byRestaurant.has("r-excluded"), false);
    assert.deepEqual(byRestaurant.get("r-mixed-status"), ["ph://mixed-confirmed"]);
    assert.deepEqual(byRestaurant.get("r-ties"), ["ph://tie-a", "ph://tie-b", "ph://tie-c"]);
    assert.equal(results.length, 6);
    return results.length;
  } finally {
    database.close();
  }
}

function measure(statement: PreviewStatement): { readonly elapsedMs: number; readonly rows: PreviewRow[] } {
  const startedAt = performance.now();
  const rows = execute(statement);
  return { elapsedMs: performance.now() - startedAt, rows };
}

function checksum(results: readonly PreviewResult[]): number {
  let value = 2_166_136_261;
  for (const result of results) {
    for (const character of `${result.restaurantId}\0${result.previewPhotos.join("\0")}\u0001`) {
      value ^= character.codePointAt(0) ?? 0;
      value = Math.imul(value, 16_777_619) >>> 0;
    }
  }
  return value;
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

function summarize(samples: readonly number[]): MeasurementSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMs: samples.map(rounded),
    minimumMs: rounded(sorted[0]),
    medianMs: rounded(median(samples)),
    p95Ms: rounded(percentile95(samples)),
    maximumMs: rounded(sorted[sorted.length - 1]),
  };
}

function assertMeasuredRows(
  rows: readonly PreviewRow[],
  expected: readonly PreviewResult[],
  expectedChecksum: number,
): void {
  const normalized = normalizeRows(rows);
  assert.deepEqual(normalized, expected);
  assert.equal(checksum(normalized), expectedChecksum);
}

function benchmark(
  database: DatabaseSync,
  configuration: Configuration,
): {
  readonly globalWindow: MeasurementSummary;
  readonly correlatedTopThree: MeasurementSummary;
  readonly comparedRestaurants: number;
  readonly resultChecksum: number;
  readonly candidateIndexesUsed: string[];
} {
  const globalStatement = database.prepare(GLOBAL_WINDOW_QUERY);
  const correlatedStatement = database.prepare(CORRELATED_TOP_THREE_QUERY);
  const expected = normalizeRows(execute(globalStatement));
  const correlated = normalizeRows(execute(correlatedStatement));
  assert.deepEqual(correlated, expected);
  const expectedChecksum = checksum(expected);
  const candidateIndexesUsed = assertCandidateUsesPreviewIndexes(database);

  for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
    assertMeasuredRows(execute(globalStatement), expected, expectedChecksum);
    assertMeasuredRows(execute(correlatedStatement), expected, expectedChecksum);
  }

  const globalSamples: number[] = [];
  const correlatedSamples: number[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    // Alternate order so neither strategy is systematically favored by the
    // immediately preceding SQLite page-cache state.
    if (sample % 2 === 0) {
      const globalMeasurement = measure(globalStatement);
      assertMeasuredRows(globalMeasurement.rows, expected, expectedChecksum);
      globalSamples.push(globalMeasurement.elapsedMs);

      const correlatedMeasurement = measure(correlatedStatement);
      assertMeasuredRows(correlatedMeasurement.rows, expected, expectedChecksum);
      correlatedSamples.push(correlatedMeasurement.elapsedMs);
    } else {
      const correlatedMeasurement = measure(correlatedStatement);
      assertMeasuredRows(correlatedMeasurement.rows, expected, expectedChecksum);
      correlatedSamples.push(correlatedMeasurement.elapsedMs);

      const globalMeasurement = measure(globalStatement);
      assertMeasuredRows(globalMeasurement.rows, expected, expectedChecksum);
      globalSamples.push(globalMeasurement.elapsedMs);
    }
  }

  return {
    globalWindow: summarize(globalSamples),
    correlatedTopThree: summarize(correlatedSamples),
    comparedRestaurants: expected.length,
    resultChecksum: expectedChecksum,
    candidateIndexesUsed,
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const edgeFixtureRestaurants = assertEdgeCases();
const database = createDatabase();
try {
  const buildStartedAt = performance.now();
  const dataset = insertBenchmarkDataset(database, configuration);
  const datasetBuildMs = performance.now() - buildStartedAt;

  const benchmarkResult = benchmark(database, configuration);
  const speedup =
    benchmarkResult.correlatedTopThree.medianMs > 0
      ? benchmarkResult.globalWindow.medianMs / benchmarkResult.correlatedTopThree.medianMs
      : 0;

  const report = {
    schemaVersion: 1,
    status: "ok",
    runtime: {
      node: process.version,
      sqlite: (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
    },
    configuration,
    dataset: {
      ...dataset,
      buildMs: rounded(datasetBuildMs),
    },
    correctness: {
      exactPreviewParity: true,
      edgeFixtureRestaurants,
      benchmarkRestaurantsCompared: benchmarkResult.comparedRestaurants,
      edgeCases: EDGE_CASE_NAMES,
      candidateIndexesUsed: benchmarkResult.candidateIndexesUsed,
      resultChecksum: benchmarkResult.resultChecksum.toString(16).padStart(8, "0"),
    },
    globalWindow: benchmarkResult.globalWindow,
    correlatedTopThree: benchmarkResult.correlatedTopThree,
    correlatedSpeedup: Number(speedup.toFixed(2)),
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  database.close();
}
