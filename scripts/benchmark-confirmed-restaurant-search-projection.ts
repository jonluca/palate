import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import {
  CONFIRMED_RESTAURANT_SEARCH_SQL,
  filterConfirmedRestaurantSearchRows,
  shouldLoadConfirmedRestaurantSearch,
  type ConfirmedRestaurantSearchRow,
} from "../utils/db/confirmed-restaurant-search-core.ts";

const RESTAURANT_COUNT = 1_200;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 9;
const REPORT_PATH = ".build/confirmed-restaurant-search-profile.json";

const LEGACY_CONFIRMED_RESTAURANTS_SQL = `WITH
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
  first_visit_award AS (
    SELECT restaurantId, awardAtVisit AS visitedAward
    FROM (
      SELECT
        restaurantId,
        awardAtVisit,
        ROW_NUMBER() OVER (PARTITION BY restaurantId ORDER BY startTime ASC) AS rn
      FROM visits
      WHERE status = 'confirmed' AND restaurantId IS NOT NULL AND awardAtVisit IS NOT NULL
    )
    WHERE rn = 1
  )
SELECT
  r.*,
  rs.visitCount,
  rs.lastVisit,
  rs.lastConfirmedAt,
  NULLIF((
    SELECT json_group_array(preview.uri)
    FROM (
      SELECT p.uri
      FROM visits preview_visit
      INNER JOIN photos p ON p.visitId = preview_visit.id
      WHERE preview_visit.restaurantId = r.id
        AND preview_visit.status = 'confirmed'
      ORDER BY
        CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
        p.creationTime DESC,
        p.id ASC
      LIMIT 3
    ) preview
  ), '[]') AS previewPhotosJson,
  m.award AS currentAward,
  fva.visitedAward
FROM restaurants r
INNER JOIN restaurant_stats rs ON rs.restaurantId = r.id
LEFT JOIN michelin_restaurants m ON r.id = m.id
LEFT JOIN first_visit_award fva ON fva.restaurantId = r.id
ORDER BY rs.lastVisit DESC`;

interface LegacyRow extends ConfirmedRestaurantSearchRow {
  readonly phone: string | null;
  readonly website: string | null;
  readonly googlePlaceId: string | null;
  readonly priceLevel: number | null;
  readonly rating: number | null;
  readonly notes: string | null;
  readonly lastConfirmedAt: number | null;
  readonly previewPhotosJson: string | null;
  readonly visitedAward: string | null;
}

interface ModalRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly cuisine: string | null;
  readonly visitCount: number;
  readonly currentAward: string | null;
}

interface RunResult {
  readonly elapsedMs: number;
  readonly queryCalls: number;
  readonly bridgeRows: number;
  readonly bridgeBytes: number;
  readonly matchedRows: ModalRow[];
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -64000;
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      googlePlaceId TEXT,
      cuisine TEXT,
      priceLevel INTEGER,
      rating REAL,
      notes TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL,
      startTime REAL NOT NULL,
      updatedAt REAL,
      awardAtVisit TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      uri TEXT NOT NULL,
      foodDetected INTEGER,
      creationTime REAL NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      award TEXT NOT NULL
    );
    CREATE INDEX idx_visits_restaurant_status_time
      ON visits(restaurantId, status, startTime DESC);
    CREATE INDEX idx_photos_visit_preview
      ON photos(
        visitId,
        (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
        creationTime DESC,
        id
      );
  `);

  const insertRestaurant = database.prepare(
    `INSERT INTO restaurants
       (id, name, latitude, longitude, address, phone, website, googlePlaceId, cuisine, priceLevel, rating, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVisit = database.prepare(
    `INSERT INTO visits
       (id, restaurantId, status, startTime, updatedAt, awardAtVisit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, visitId, uri, foodDetected, creationTime) VALUES (?, ?, ?, ?, ?)",
  );
  const insertAward = database.prepare("INSERT INTO michelin_restaurants (id, award) VALUES (?, ?)");

  database.exec("BEGIN");
  for (let restaurantIndex = 0; restaurantIndex < RESTAURANT_COUNT; restaurantIndex += 1) {
    const isMichelin = restaurantIndex % 5 === 0;
    const id = `${isMichelin ? "michelin" : "google"}-${restaurantIndex.toString().padStart(5, "0")}`;
    const name = restaurantIndex % 10 === 0 ? `Alpha Table ${restaurantIndex}` : `Restaurant ${restaurantIndex}`;
    insertRestaurant.run(
      id,
      name,
      25 + (restaurantIndex % 600) * 0.05,
      -125 + (restaurantIndex % 800) * 0.05,
      `${restaurantIndex} Benchmark Avenue, Example City`,
      `+1-555-${restaurantIndex.toString().padStart(4, "0")}`,
      `https://restaurant-${restaurantIndex}.example.test/menu-and-reservations`,
      `place-${restaurantIndex.toString().padStart(8, "0")}`,
      restaurantIndex % 2 === 0 ? "Contemporary" : "Regional",
      (restaurantIndex % 4) + 1,
      3.5 + (restaurantIndex % 15) / 10,
      `Synthetic benchmark notes for restaurant ${restaurantIndex}; these fields are not consumed by the modal.`,
    );
    if (isMichelin) {
      insertAward.run(id, restaurantIndex % 15 === 0 ? "1 Star" : "Bib Gourmand");
    }

    for (let visitIndex = 0; visitIndex < 3; visitIndex += 1) {
      const visitId = `visit-${restaurantIndex}-${visitIndex}`;
      const startTime = 1_700_000_000_000 + restaurantIndex * 10_000 + visitIndex * 1_000 + 0.25;
      insertVisit.run(
        visitId,
        id,
        "confirmed",
        startTime,
        startTime + 500,
        visitIndex === 0 && isMichelin ? "Selected" : null,
      );
      for (let photoIndex = 0; photoIndex < 4; photoIndex += 1) {
        insertPhoto.run(
          `photo-${restaurantIndex}-${visitIndex}-${photoIndex}`,
          visitId,
          `ph://benchmark/${restaurantIndex.toString().padStart(5, "0")}/${visitIndex}/${photoIndex}/asset-identifier`,
          photoIndex === 0 ? 1 : photoIndex === 1 ? 0 : null,
          startTime + photoIndex,
        );
      }
    }
    insertVisit.run(
      `rejected-${restaurantIndex}`,
      id,
      "rejected",
      1_900_000_000_000 + restaurantIndex,
      1_900_000_000_500 + restaurantIndex,
      null,
    );
  }
  database.exec("COMMIT");
  return database;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function toModalRows(rows: readonly ConfirmedRestaurantSearchRow[], query: string): ModalRow[] {
  return filterConfirmedRestaurantSearchRows(rows, query).map((row) => ({
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    cuisine: row.cuisine,
    visitCount: row.visitCount,
    currentAward: row.currentAward,
  }));
}

function runLegacy(statement: StatementSync, query: string): RunResult {
  const start = performance.now();
  const bridgeRows = statement.all() as unknown as LegacyRow[];
  const hydratedRows = bridgeRows.map((row) => {
    let previewPhotos: string[] = [];
    if (row.previewPhotosJson) {
      previewPhotos = JSON.parse(row.previewPhotosJson) as string[];
    }
    const { previewPhotosJson: _, visitedAward, ...rest } = row;
    return {
      ...rest,
      previewPhotos,
      visitedAward: visitedAward && visitedAward !== row.currentAward ? visitedAward : null,
    };
  });
  const matchedRows = toModalRows(hydratedRows, query);
  const elapsedMs = performance.now() - start;
  return {
    elapsedMs,
    queryCalls: 1,
    bridgeRows: bridgeRows.length,
    bridgeBytes: byteLength(bridgeRows),
    matchedRows,
  };
}

function runCandidate(statement: StatementSync, visible: boolean, query: string): RunResult {
  const start = performance.now();
  if (!shouldLoadConfirmedRestaurantSearch(visible, query)) {
    return {
      elapsedMs: performance.now() - start,
      queryCalls: 0,
      bridgeRows: 0,
      bridgeBytes: 0,
      matchedRows: [],
    };
  }
  const bridgeRows = statement.all() as unknown as ConfirmedRestaurantSearchRow[];
  const matchedRows = toModalRows(bridgeRows, query);
  const elapsedMs = performance.now() - start;
  return {
    elapsedMs,
    queryCalls: 1,
    bridgeRows: bridgeRows.length,
    bridgeBytes: byteLength(bridgeRows),
    matchedRows,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

const database = createDatabase();
try {
  const legacyStatement = database.prepare(LEGACY_CONFIRMED_RESTAURANTS_SQL);
  const candidateStatement = database.prepare(CONFIRMED_RESTAURANT_SEARCH_SQL);
  const scenarios = [
    { name: "closed-with-retained-query", visible: false, query: "alpha" },
    { name: "open-blank", visible: true, query: "   " },
    { name: "open-typed", visible: true, query: "alpha" },
  ] as const;

  const reportScenarios = scenarios.map((scenario) => {
    for (let warmup = 0; warmup < WARMUP_RUNS; warmup += 1) {
      runLegacy(legacyStatement, scenario.query);
      runCandidate(candidateStatement, scenario.visible, scenario.query);
    }

    const legacyRuns: RunResult[] = [];
    const candidateRuns: RunResult[] = [];
    for (let run = 0; run < MEASURED_RUNS; run += 1) {
      legacyRuns.push(runLegacy(legacyStatement, scenario.query));
      candidateRuns.push(runCandidate(candidateStatement, scenario.visible, scenario.query));
    }
    const legacy = legacyRuns[0];
    const candidate = candidateRuns[0];
    if (shouldLoadConfirmedRestaurantSearch(scenario.visible, scenario.query)) {
      assert.deepEqual(candidate.matchedRows, legacy.matchedRows, `${scenario.name} result mismatch`);
    }
    assert.ok(legacyRuns.every((run) => run.bridgeBytes === legacy.bridgeBytes));
    assert.ok(candidateRuns.every((run) => run.bridgeBytes === candidate.bridgeBytes));

    const legacyMedianMs = median(legacyRuns.map((run) => run.elapsedMs));
    const candidateMedianMs = median(candidateRuns.map((run) => run.elapsedMs));
    return {
      name: scenario.name,
      visible: scenario.visible,
      query: scenario.query,
      legacy: {
        queryCalls: legacy.queryCalls,
        bridgeRows: legacy.bridgeRows,
        bridgeBytes: legacy.bridgeBytes,
        matchedRows: legacy.matchedRows.length,
        medianSqliteAndTransformMs: round(legacyMedianMs),
      },
      candidate: {
        queryCalls: candidate.queryCalls,
        bridgeRows: candidate.bridgeRows,
        bridgeBytes: candidate.bridgeBytes,
        matchedRows: candidate.matchedRows.length,
        medianSqliteAndTransformMs: round(candidateMedianMs),
      },
      bridgeByteReductionPercent:
        legacy.bridgeBytes === 0 ? 0 : round((1 - candidate.bridgeBytes / legacy.bridgeBytes) * 100),
      medianSpeedup:
        candidate.queryCalls === 0 || candidateMedianMs === 0 ? null : round(legacyMedianMs / candidateMedianMs),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    fixture: {
      storage: "isolated in-memory node:sqlite database",
      restaurantCount: RESTAURANT_COUNT,
      confirmedVisitsPerRestaurant: 3,
      photosPerConfirmedVisit: 4,
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
    },
    scenarios: reportScenarios,
    limitations: [
      "This isolates SQLite query, row hydration, and JavaScript filtering; it does not model Expo bridge latency or React rendering.",
      "Closed and blank candidate timing is policy overhead only because the production query is disabled in those states.",
      "The fixture is synthetic and never opens the app database or Photos library.",
    ],
  };

  mkdirSync(".build", { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(REPORT_PATH, 0o600);
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${REPORT_PATH}`);
} finally {
  database.close();
}
