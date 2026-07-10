#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "../utils/db/visit-review-core.ts";

interface Configuration {
  pendingVisits: number;
  photos: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface DatasetCounts {
  readonly pendingVisits: number;
  readonly excludedVisits: number;
  readonly photos: number;
  readonly visitsWithoutPhotos: number;
  readonly directSuggestions: number;
  readonly nearbySuggestions: number;
  readonly foodLabelPhotos: number;
  readonly unanalyzedPhotos: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface QueryPlanRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

interface CandidatePlanEvidence {
  readonly previewIndex: "idx_photos_visit_preview";
  readonly previewSubqueryId: number;
  readonly previewSubqueryPlan: string[];
  readonly previewUsesTemporaryOrderBy: false;
  readonly candidateContainsWindowFunction: false;
  readonly fullPlan: string[];
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly checksum: string;
}

type ReviewStatement = ReturnType<DatabaseSync["prepare"]>;
type Strategy = "windowOracle" | "correlatedTopThree";

const DEFAULT_CONFIGURATION: Configuration = {
  pendingVisits: 4_000,
  photos: 68_027,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/pending-visit-review-profile.json",
};

const EDGE_CASES = [
  "all four review-priority classes",
  "direct and nearby restaurant suggestions",
  "food-label aggregation",
  "unanalyzed-photo detection",
  "a pending visit without photos",
  "food-detection priority followed by creation time and photo ID",
  "equal-rank photo ties",
  "JSON-sensitive and Unicode values",
  "confirmed and rejected visit exclusion",
] as const;

// Independent legacy oracle: rank every pending photo with a window and then
// aggregate the first three. Keep this SQL separate from the production query
// so parity catches accidental changes to either implementation.
const WINDOW_ORACLE_SQL = `WITH
  pending_visits AS (
    SELECT
      v.*,
      r.name AS restaurantName,
      m.name AS suggestedRestaurantName,
      m.award AS suggestedRestaurantAward,
      m.cuisine AS suggestedRestaurantCuisine,
      m.address AS suggestedRestaurantAddress
    FROM visits v
    LEFT JOIN restaurants r ON v.restaurantId = r.id
    LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
    WHERE v.status = 'pending'
  ),
  ranked_photos AS (
    SELECT
      p.visitId,
      p.uri,
      ROW_NUMBER() OVER (
        PARTITION BY p.visitId
        ORDER BY
          CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
          p.creationTime ASC,
          p.id ASC
      ) AS rn
    FROM photos p
    WHERE p.visitId IN (SELECT id FROM pending_visits)
  ),
  preview_photos AS (
    SELECT visitId, json_group_array(uri) AS uris
    FROM (
      SELECT visitId, uri, rn
      FROM ranked_photos
      WHERE rn <= 3
      ORDER BY visitId ASC, rn ASC
    )
    GROUP BY visitId
  ),
  suggested_restaurants AS (
    SELECT
      vsr.visitId,
      json_group_array(
        json_object(
          'id', m.id,
          'name', m.name,
          'latitude', m.latitude,
          'longitude', m.longitude,
          'address', m.address,
          'location', m.location,
          'cuisine', m.cuisine,
          'latestAwardYear', m.latestAwardYear,
          'award', m.award,
          'distance', vsr.distance
        )
      ) AS restaurants
    FROM visit_suggested_restaurants vsr
    JOIN michelin_restaurants m ON vsr.restaurantId = m.id
    WHERE vsr.visitId IN (SELECT id FROM pending_visits)
    GROUP BY vsr.visitId
  ),
  food_labels AS (
    SELECT
      p.visitId,
      json_group_array(json(p.foodLabels)) AS labelsJson
    FROM photos p
    WHERE p.visitId IN (SELECT id FROM pending_visits WHERE foodProbable = 1)
      AND p.foodDetected = 1
      AND p.foodLabels IS NOT NULL
    GROUP BY p.visitId
  )
SELECT
  pv.*,
  pp.uris AS previewPhotosJson,
  sr.restaurants AS suggestedRestaurantsJson,
  fl.labelsJson AS foodLabelsJson,
  CASE
    WHEN pv.foodProbable = 1 AND (pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL) THEN 1
    WHEN pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL THEN 2
    WHEN pv.foodProbable = 1 THEN 3
    ELSE 4
  END AS priority,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM photos p_check
      WHERE p_check.visitId = pv.id
        AND p_check.foodDetected IS NULL
    ) THEN 1
    ELSE 0
  END AS hasUnanalyzedPhotos
FROM pending_visits pv
LEFT JOIN preview_photos pp ON pv.id = pp.visitId
LEFT JOIN suggested_restaurants sr ON pv.id = sr.visitId
LEFT JOIN food_labels fl ON pv.id = fl.visitId
ORDER BY priority ASC, pv.startTime DESC`;

function usage(): string {
  return `Usage: benchmark-pending-visit-review-query.ts [options]

  --pending-visits=N  Pending visits (default: ${DEFAULT_CONFIGURATION.pendingVisits})
  --photos=N          Total photo rows (default: ${DEFAULT_CONFIGURATION.photos})
  --samples=N         Measured query pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N          Warmup query pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH       JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h          Show this help`;
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
      case "--pending-visits":
        configuration.pendingVisits = parseInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parseInteger(value, option, true);
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
  return configuration;
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

    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL,
      location TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      latestAwardYear INTEGER,
      award TEXT NOT NULL,
      datasetVersion TEXT
    );

    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL,
      foodProbable INTEGER NOT NULL,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      notes TEXT,
      updatedAt INTEGER,
      exportedToCalendarId TEXT,
      awardAtVisit TEXT,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );

    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );

    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
    CREATE INDEX idx_photos_food_labels ON photos(visitId)
      WHERE foodDetected = 1 AND foodLabels IS NOT NULL;
    CREATE INDEX idx_visit_suggested_restaurants_visit ON visit_suggested_restaurants(visitId);
  `);
  return database;
}

function photosForVisit(index: number, configuration: Configuration): number {
  const photoBearingVisits = configuration.pendingVisits > 1 ? configuration.pendingVisits - 1 : 1;
  if (configuration.pendingVisits > 1 && index === configuration.pendingVisits - 1) {
    return 0;
  }
  const base = Math.floor(configuration.photos / photoBearingVisits);
  const remainder = configuration.photos % photoBearingVisits;
  return base + (index < remainder ? 1 : 0);
}

function padded(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

function seedDataset(database: DatabaseSync, configuration: Configuration): DatasetCounts {
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertMichelin = database.prepare(`
    INSERT INTO michelin_restaurants (
      id, name, latitude, longitude, address, location, cuisine,
      latestAwardYear, award, datasetVersion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      notes, updatedAt, exportedToCalendarId, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSuggestion = database.prepare(`
    INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
    VALUES (?, ?, ?)
  `);
  const insertPhoto = database.prepare(`
    INSERT INTO photos (
      id, uri, creationTime, visitId, foodDetected, foodLabels, foodConfidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let directSuggestions = 0;
  let nearbySuggestions = 0;
  let photoCount = 0;
  let foodLabelPhotos = 0;
  let unanalyzedPhotos = 0;
  const epoch = 1_700_000_000_000;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 8; index++) {
      insertRestaurant.run(
        `restaurant-${padded(index, 2)}`,
        index === 0 ? 'Local "Bistro" 東京' : `Local Restaurant ${index}`,
      );
      insertMichelin.run(
        `michelin-${padded(index, 2)}`,
        index === 0 ? 'Café "Direct" 🍽️' : `Guide Restaurant ${index}`,
        34 + index * 0.1,
        -118 - index * 0.1,
        `${index + 1} Quoted "Street"`,
        index === 0 ? "München, Deutschland" : `Benchmark City ${index}`,
        index === 0 ? "Crème brûlée" : `Cuisine ${index}`,
        2026,
        index % 3 === 0 ? "1 Star" : index % 3 === 1 ? "Bib Gourmand" : "Selected",
        "synthetic-benchmark-v1",
      );
    }

    for (let visitIndex = 0; visitIndex < configuration.pendingVisits; visitIndex++) {
      const visitId = `visit-${padded(visitIndex, 6)}`;
      const priorityClass = visitIndex % 4;
      const foodProbable = priorityClass === 0 || priorityClass === 2 ? 1 : 0;
      const hasSuggestion = priorityClass === 0 || priorityClass === 1;
      const usesNearbySuggestion = hasSuggestion && visitIndex % 8 >= 4;
      const michelinId = `michelin-${padded(visitIndex % 8, 2)}`;
      const suggestedRestaurantId = hasSuggestion && !usesNearbySuggestion ? michelinId : null;
      const restaurantId = visitIndex % 17 === 0 ? `restaurant-${padded(visitIndex % 8, 2)}` : null;
      const startTime = epoch + visitIndex * 100_000;
      const visitPhotoCount = photosForVisit(visitIndex, configuration);

      insertVisit.run(
        visitId,
        restaurantId,
        suggestedRestaurantId,
        "pending",
        startTime,
        startTime + 7_200_000,
        34 + (visitIndex % 100) / 1_000,
        -118 - (visitIndex % 100) / 1_000,
        visitPhotoCount,
        foodProbable,
        visitIndex % 29 === 0 ? `event-${visitIndex}-雪` : null,
        visitIndex % 29 === 0 ? 'Dinner at "Café"' : null,
        visitIndex % 29 === 0 ? "Los Angeles, CA" : null,
        visitIndex % 29 === 0 ? 0 : null,
        visitIndex % 31 === 0 ? "notes with 'quotes', emoji 🍮, and newline\nvalue" : null,
        startTime + 1,
        visitIndex % 43 === 0 ? `calendar-${visitIndex}` : null,
        visitIndex % 47 === 0 ? "Historic Award" : null,
      );

      if (suggestedRestaurantId) {
        directSuggestions++;
      } else if (usesNearbySuggestion) {
        insertSuggestion.run(visitId, michelinId, 5 + (visitIndex % 200) / 10);
        nearbySuggestions++;
      }

      for (let photoIndex = 0; photoIndex < visitPhotoCount; photoIndex++) {
        const photoId = `${visitId}-photo-${padded(photoIndex, 4)}`;
        const detectionBucket = (visitIndex + photoIndex) % 10;
        const foodDetected = detectionBucket < 4 ? 1 : detectionBucket < 8 ? 0 : null;
        const foodLabels =
          foodProbable === 1 && foodDetected === 1 && photoIndex % 11 === 0
            ? JSON.stringify([{ label: visitIndex % 2 === 0 ? 'Crème "brûlée" 🍮' : "東京寿司", confidence: 0.93 }])
            : null;
        const creationTime = visitIndex === 0 && photoIndex < 4 ? startTime + 10 : startTime + photoIndex * 10 + 100;
        const uri =
          photoCount === 0
            ? 'ph://雪/"quoted"/L0/001'
            : photoCount === 1
              ? "ph://apostrophe-'and-emoji-🍣/L0/001"
              : `ph://${photoId}/L0/001`;

        insertPhoto.run(
          photoId,
          uri,
          creationTime,
          visitId,
          foodDetected,
          foodLabels,
          foodDetected === 1 ? 0.5 + ((visitIndex + photoIndex) % 50) / 100 : null,
        );
        photoCount++;
        if (foodLabels) {
          foodLabelPhotos++;
        }
        if (foodDetected === null) {
          unanalyzedPhotos++;
        }
      }
    }

    for (const [status, suffix] of [
      ["confirmed", "confirmed-excluded"],
      ["rejected", "rejected-excluded"],
    ] as const) {
      insertVisit.run(
        `visit-${suffix}`,
        null,
        "michelin-00",
        status,
        epoch + configuration.pendingVisits * 100_000 + (status === "confirmed" ? 1 : 2),
        epoch + configuration.pendingVisits * 100_000 + 100,
        0,
        0,
        0,
        1,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.equal(photoCount, configuration.photos, "fixture must contain the requested exact photo count");
  const pendingCount = (
    database.prepare("SELECT COUNT(*) AS count FROM visits WHERE status = 'pending'").get() as { count: number }
  ).count;
  const persistedPhotoCount = (database.prepare("SELECT COUNT(*) AS count FROM photos").get() as { count: number })
    .count;
  assert.equal(pendingCount, configuration.pendingVisits);
  assert.equal(persistedPhotoCount, configuration.photos);

  return {
    pendingVisits: pendingCount,
    excludedVisits: 2,
    photos: persistedPhotoCount,
    visitsWithoutPhotos: (
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM visits v
          WHERE v.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.visitId = v.id)
        `)
        .get() as { count: number }
    ).count,
    directSuggestions,
    nearbySuggestions,
    foodLabelPhotos,
    unanalyzedPhotos,
  };
}

function execute(statement: ReviewStatement): PendingVisitReviewQueryRow[] {
  return statement.all() as unknown as PendingVisitReviewQueryRow[];
}

function checksum(rows: readonly PendingVisitReviewQueryRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function assertRowsMatch(
  rows: readonly PendingVisitReviewQueryRow[],
  expected: readonly PendingVisitReviewQueryRow[],
  expectedChecksum: string,
  context: string,
): void {
  assert.deepEqual(rows, expected, `${context}: full raw rows diverged from the independent window oracle`);
  assert.equal(checksum(rows), expectedChecksum, `${context}: full raw-row SHA-256 checksum diverged`);
}

function isDescendantOf(row: QueryPlanRow, ancestorId: number, rowsById: ReadonlyMap<number, QueryPlanRow>): boolean {
  let parentId = row.parent;
  while (parentId !== 0) {
    if (parentId === ancestorId) {
      return true;
    }
    const parent = rowsById.get(parentId);
    if (!parent) {
      return false;
    }
    parentId = parent.parent;
  }
  return false;
}

function candidatePlanEvidence(database: DatabaseSync): CandidatePlanEvidence {
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${PENDING_VISITS_FOR_REVIEW_SQL}`)
    .all() as unknown as QueryPlanRow[];
  const previewSearch = plan.find((row) => row.detail.includes("idx_photos_visit_preview"));
  assert.ok(previewSearch, "candidate query must use idx_photos_visit_preview for top-three previews");
  assert.doesNotMatch(PENDING_VISITS_FOR_REVIEW_SQL, /ROW_NUMBER|ranked_photos/i);

  const rowsById = new Map(plan.map((row) => [row.id, row]));
  let previewSubquery = rowsById.get(previewSearch.parent);
  while (previewSubquery && !previewSubquery.detail.includes("CORRELATED SCALAR SUBQUERY")) {
    previewSubquery = rowsById.get(previewSubquery.parent);
  }
  assert.ok(previewSubquery, "preview index scan must belong to a correlated scalar subquery");

  const previewPlanRows = plan.filter(
    (row) => row.id === previewSubquery.id || isDescendantOf(row, previewSubquery.id, rowsById),
  );
  assert.ok(
    previewPlanRows.every((row) => !row.detail.includes("USE TEMP B-TREE FOR ORDER BY")),
    `preview lookup unexpectedly uses a temporary sort:\n${previewPlanRows.map((row) => row.detail).join("\n")}`,
  );

  return {
    previewIndex: "idx_photos_visit_preview",
    previewSubqueryId: previewSubquery.id,
    previewSubqueryPlan: previewPlanRows.map((row) => row.detail),
    previewUsesTemporaryOrderBy: false,
    candidateContainsWindowFunction: false,
    fullPlan: plan.map((row) => row.detail),
  };
}

function measure(statement: ReviewStatement, expectedChecksum: string, context: string): Measurement {
  const startedAt = performance.now();
  const rows = execute(statement);
  const elapsedMilliseconds = performance.now() - startedAt;
  const resultChecksum = checksum(rows);
  assert.equal(resultChecksum, expectedChecksum, `${context}: measured full raw-row checksum diverged`);
  return { elapsedMilliseconds, checksum: resultChecksum };
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

function priorityCounts(rows: readonly PendingVisitReviewQueryRow[]): Record<string, number> {
  const counts: Record<string, number> = { priority1: 0, priority2: 0, priority3: 0, priority4: 0 };
  for (const row of rows) {
    counts[`priority${row.priority}`] = (counts[`priority${row.priority}`] ?? 0) + 1;
  }
  return counts;
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const database = createDatabase();
try {
  const buildStartedAt = performance.now();
  const dataset = seedDataset(database, configuration);
  const datasetBuildMilliseconds = performance.now() - buildStartedAt;

  const oracleStatement = database.prepare(WINDOW_ORACLE_SQL);
  const candidateStatement = database.prepare(PENDING_VISITS_FOR_REVIEW_SQL);
  const planEvidence = candidatePlanEvidence(database);

  // Complete raw-row parity and digest before any warmup or timing.
  const oracleRowsBeforeTiming = execute(oracleStatement);
  const candidateRowsBeforeTiming = execute(candidateStatement);
  const beforeTimingChecksum = checksum(oracleRowsBeforeTiming);
  assertRowsMatch(candidateRowsBeforeTiming, oracleRowsBeforeTiming, beforeTimingChecksum, "before timing");
  assert.equal(oracleRowsBeforeTiming.length, configuration.pendingVisits);

  for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
    const order: Strategy[] =
      iteration % 2 === 0 ? ["windowOracle", "correlatedTopThree"] : ["correlatedTopThree", "windowOracle"];
    for (const strategy of order) {
      const statement = strategy === "windowOracle" ? oracleStatement : candidateStatement;
      measure(statement, beforeTimingChecksum, `warmup ${iteration + 1} ${strategy}`);
    }
  }

  const samples: Record<Strategy, number[]> = { windowOracle: [], correlatedTopThree: [] };
  const measuredChecksums = new Set<string>();
  for (let iteration = 0; iteration < configuration.samples; iteration++) {
    // Alternate execution order to avoid systematically favoring either query
    // with the immediately preceding SQLite cache state.
    const order: Strategy[] =
      iteration % 2 === 0 ? ["windowOracle", "correlatedTopThree"] : ["correlatedTopThree", "windowOracle"];
    for (const strategy of order) {
      const statement = strategy === "windowOracle" ? oracleStatement : candidateStatement;
      const result = measure(statement, beforeTimingChecksum, `sample ${iteration + 1} ${strategy}`);
      samples[strategy].push(result.elapsedMilliseconds);
      measuredChecksums.add(result.checksum);
    }
  }

  // Repeat complete raw-row parity and digest after all timed executions.
  const oracleRowsAfterTiming = execute(oracleStatement);
  const candidateRowsAfterTiming = execute(candidateStatement);
  const afterTimingChecksum = checksum(oracleRowsAfterTiming);
  assertRowsMatch(candidateRowsAfterTiming, oracleRowsAfterTiming, afterTimingChecksum, "after timing");
  assert.deepEqual(oracleRowsAfterTiming, oracleRowsBeforeTiming, "oracle rows changed during read-only timing");
  assert.equal(afterTimingChecksum, beforeTimingChecksum);
  assert.deepEqual([...measuredChecksums], [beforeTimingChecksum]);

  const windowSummary = summarize(samples.windowOracle);
  const correlatedSummary = summarize(samples.correlatedTopThree);
  const speedup = windowSummary.medianMilliseconds / correlatedSummary.medianMilliseconds;
  const report = {
    schemaVersion: 1,
    status: "ok",
    benchmarkScope:
      "Synthetic Node/V8 benchmark using node:sqlite with an in-memory SQLite database; not the macOS app bridge, real Palate database, Photos library, or Calendar data.",
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      sqlite: (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
    },
    configuration,
    dataset: {
      ...dataset,
      buildMilliseconds: datasetBuildMilliseconds,
    },
    correctness: {
      fullRawRowParityBeforeTiming: true,
      fullRawRowParityAfterTiming: true,
      fullRawRowSha256BeforeTiming: beforeTimingChecksum,
      fullRawRowSha256AfterTiming: afterTimingChecksum,
      measuredSampleChecksums: [...measuredChecksums],
      comparedRows: oracleRowsBeforeTiming.length,
      priorityCounts: priorityCounts(oracleRowsBeforeTiming),
      edgeCases: EDGE_CASES,
      candidatePlan: planEvidence,
    },
    timings: {
      independentWindowOracle: windowSummary,
      productionCorrelatedTopThree: correlatedSummary,
      medianSpeedup: speedup,
    },
  };

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  database.close();
}
