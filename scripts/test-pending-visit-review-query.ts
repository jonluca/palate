#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "../utils/db/visit-review-core.ts";

interface QueryPlanRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

// Independent correctness oracle: rank all pending photos with a window, then
// aggregate the first three. The ID key makes equal food/time ranks explicit.
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

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;

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

function seedParityFixture(database: DatabaseSync): void {
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

  database.exec("BEGIN");
  try {
    insertRestaurant.run("restaurant-local", 'Local "Bistro" 東京');

    insertMichelin.run(
      "michelin-direct",
      "Café Direct 🍽️",
      48.137,
      11.575,
      '12 "Quoted" Straße',
      "München, Deutschland",
      "Crème brûlée",
      2026,
      "1 Star",
      "fixture-v1",
    );
    insertMichelin.run(
      "michelin-near-a",
      "近く A",
      35.676,
      139.65,
      "1 雪道",
      "東京, 日本",
      "寿司",
      2025,
      "Selected",
      "fixture-v1",
    );
    insertMichelin.run(
      "michelin-near-b",
      'Near "B"',
      -33.868,
      151.209,
      "2 Harbour Road",
      "Sydney, Australia",
      "Modern Australian",
      null,
      "Bib Gourmand",
      "fixture-v1",
    );

    insertVisit.run(
      "visit-priority-1",
      "restaurant-local",
      "michelin-direct",
      "pending",
      4_000,
      4_100,
      48.137,
      11.575,
      4,
      1,
      "event-'雪'",
      'Dinner at "Café"',
      "München",
      0,
      "notes with 'quotes' and 🍮",
      4_001,
      "export-calendar-id",
      "Historic Award",
    );
    insertSuggestion.run("visit-priority-1", "michelin-near-b", 19.75);
    insertSuggestion.run("visit-priority-1", "michelin-near-a", 8.5);

    const quotedFoodLabels = JSON.stringify([
      { label: 'Crème "brûlée" 🍮', confidence: 0.97 },
      { label: "東京寿司", confidence: 0.83 },
    ]);
    // Insert out of rank order: equal food/time rows must use photo ID ASC.
    insertPhoto.run("tie-z", "ph://tie-z", 100, "visit-priority-1", 1, quotedFoodLabels, 0.97);
    insertPhoto.run("tie-a", "ph://雪/'quote'/tie-a", 100, "visit-priority-1", 1, quotedFoodLabels, 0.97);
    insertPhoto.run("tie-y", 'ph://tie-"y"', 100, "visit-priority-1", 1, quotedFoodLabels, 0.97);
    insertPhoto.run("tie-b", "ph://tie-b", 100, "visit-priority-1", 1, quotedFoodLabels, 0.97);

    insertVisit.run(
      "visit-priority-2",
      null,
      null,
      "pending",
      3_000,
      3_100,
      35.676,
      139.65,
      3,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertSuggestion.run("visit-priority-2", "michelin-near-a", 42.25);
    insertPhoto.run("p2-null", "ph://p2-null", 1, "visit-priority-2", null, null, null);
    insertPhoto.run("p2-false", "ph://p2-false", 2, "visit-priority-2", 0, null, null);
    insertPhoto.run("p2-true", "ph://p2-true", 900, "visit-priority-2", 1, quotedFoodLabels, 0.8);

    insertVisit.run(
      "visit-priority-3",
      null,
      null,
      "pending",
      2_000,
      2_100,
      -33.868,
      151.209,
      4,
      1,
      null,
      null,
      null,
      1,
      "valid JSON labels include malformed-looking text",
      2_001,
      null,
      null,
    );
    insertPhoto.run(
      "p3-true-new",
      "ph://p3-true-new",
      300,
      "visit-priority-3",
      1,
      JSON.stringify([{ label: 'looks {malformed] but is valid "JSON"', confidence: 0.61 }]),
      0.61,
    );
    insertPhoto.run(
      "p3-true-old",
      "ph://p3-true-old",
      200,
      "visit-priority-3",
      1,
      JSON.stringify([{ label: "éclair 🥐", confidence: 0.88 }]),
      0.88,
    );
    insertPhoto.run("p3-false", "ph://p3-false", 1, "visit-priority-3", 0, null, null);
    insertPhoto.run("p3-null", "ph://p3-null", 0, "visit-priority-3", null, null, null);

    insertVisit.run(
      "visit-priority-4-with-photo",
      null,
      null,
      "pending",
      1_500,
      1_600,
      0,
      0,
      1,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertPhoto.run("p4-quoted", 'ph://unicode-雪-"quote"', 10, "visit-priority-4-with-photo", 0, null, null);

    insertVisit.run(
      "visit-priority-4-empty",
      null,
      null,
      "pending",
      1_000,
      1_100,
      0,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );

    for (const [id, status] of [
      ["visit-confirmed-excluded", "confirmed"],
      ["visit-rejected-excluded", "rejected"],
    ] as const) {
      insertVisit.run(
        id,
        null,
        "michelin-direct",
        status,
        9_000,
        9_100,
        0,
        0,
        1,
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
      insertPhoto.run(`${id}-photo`, `ph://${id}`, 1, id, 1, quotedFoodLabels, 0.9);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function execute(database: DatabaseSync, sql: string): PendingVisitReviewQueryRow[] {
  return database.prepare(sql).all() as unknown as PendingVisitReviewQueryRow[];
}

function assertCompleteParity(database: DatabaseSync): void {
  const oracleRows = execute(database, WINDOW_ORACLE_SQL);
  const candidateRows = execute(database, PENDING_VISITS_FOR_REVIEW_SQL);
  assert.deepEqual(candidateRows, oracleRows, "candidate raw rows must exactly match the window-function oracle");

  assert.deepEqual(
    candidateRows.map((row) => row.id),
    [
      "visit-priority-1",
      "visit-priority-2",
      "visit-priority-3",
      "visit-priority-4-with-photo",
      "visit-priority-4-empty",
    ],
  );
  assert.deepEqual(
    candidateRows.map((row) => row.priority),
    [1, 2, 3, 4, 4],
  );

  const rowsById = new Map(candidateRows.map((row) => [row.id, row]));
  const priorityOne = rowsById.get("visit-priority-1");
  assert.ok(priorityOne);
  assert.deepEqual(JSON.parse(priorityOne.previewPhotosJson ?? "null"), [
    "ph://雪/'quote'/tie-a",
    "ph://tie-b",
    'ph://tie-"y"',
  ]);
  assert.equal(priorityOne.restaurantName, 'Local "Bistro" 東京');
  assert.equal(priorityOne.suggestedRestaurantName, "Café Direct 🍽️");
  assert.equal(priorityOne.exportedToCalendarId, "export-calendar-id");
  assert.equal(priorityOne.awardAtVisit, "Historic Award");

  const suggestions = JSON.parse(priorityOne.suggestedRestaurantsJson ?? "null") as Array<{
    id: string;
    name: string;
    latestAwardYear: number | null;
    distance: number;
  }>;
  assert.deepEqual(suggestions.map((suggestion) => suggestion.id).sort(), ["michelin-near-a", "michelin-near-b"]);
  assert.ok(suggestions.some((suggestion) => suggestion.name === 'Near "B"' && suggestion.distance === 19.75));
  assert.deepEqual(suggestions.map((suggestion) => suggestion.latestAwardYear).sort(), [2025, null].sort());

  const priorityTwo = rowsById.get("visit-priority-2");
  assert.ok(priorityTwo);
  assert.deepEqual(JSON.parse(priorityTwo.previewPhotosJson ?? "null"), [
    "ph://p2-true",
    "ph://p2-false",
    "ph://p2-null",
  ]);
  assert.equal(priorityTwo.hasUnanalyzedPhotos, 1);
  assert.equal(priorityTwo.foodLabelsJson, null, "non-food visits must not aggregate food labels");

  const priorityThree = rowsById.get("visit-priority-3");
  assert.ok(priorityThree);
  assert.deepEqual(JSON.parse(priorityThree.previewPhotosJson ?? "null"), [
    "ph://p3-true-old",
    "ph://p3-true-new",
    "ph://p3-false",
  ]);
  assert.equal(priorityThree.hasUnanalyzedPhotos, 1);
  const nestedFoodLabels = JSON.parse(priorityThree.foodLabelsJson ?? "null") as Array<
    Array<{ label: string; confidence: number }>
  >;
  assert.deepEqual(
    nestedFoodLabels
      .flat()
      .map((label) => label.label)
      .sort(),
    ['looks {malformed] but is valid "JSON"', "éclair 🥐"].sort(),
  );

  const emptyVisit = rowsById.get("visit-priority-4-empty");
  assert.ok(emptyVisit);
  assert.equal(emptyVisit.previewPhotosJson, null, "a visit without photos must retain the legacy null value");
  assert.equal(emptyVisit.hasUnanalyzedPhotos, 0);
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

function assertCandidatePlan(database: DatabaseSync): void {
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${PENDING_VISITS_FOR_REVIEW_SQL}`)
    .all() as unknown as QueryPlanRow[];
  const previewSearch = plan.find((row) => row.detail.includes("idx_photos_visit_preview"));
  assert.ok(previewSearch, "candidate must use idx_photos_visit_preview for its top-three lookup");
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
    `preview lookup unexpectedly sorts through a temp B-tree:\n${previewPlanRows.map((row) => row.detail).join("\n")}`,
  );
}

function captureQueryError(database: DatabaseSync, sql: string): Error {
  let captured: unknown;
  try {
    execute(database, sql);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error, "query was expected to reject malformed food-label JSON");
  return captured;
}

function assertMalformedJsonParity(): void {
  const database = createDatabase();
  try {
    database.exec(`
      INSERT INTO visits (
        id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
        centerLat, centerLon, photoCount, foodProbable, calendarEventId,
        calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
        notes, updatedAt, exportedToCalendarId, awardAtVisit
      ) VALUES (
        'malformed-visit', NULL, NULL, 'pending', 1, 2,
        0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      );
      INSERT INTO photos (
        id, uri, creationTime, visitId, foodDetected, foodLabels, foodConfidence
      ) VALUES (
        'malformed-photo', 'ph://malformed', 1, 'malformed-visit', 1, '{not-valid-json', 0.9
      );
    `);

    const oracleError = captureQueryError(database, WINDOW_ORACLE_SQL);
    const candidateError = captureQueryError(database, PENDING_VISITS_FOR_REVIEW_SQL);
    assert.match(oracleError.message, /malformed JSON/i);
    assert.match(candidateError.message, /malformed JSON/i);
  } finally {
    database.close();
  }
}

const database = createDatabase();
try {
  seedParityFixture(database);
  assertCompleteParity(database);
  assertCandidatePlan(database);
} finally {
  database.close();
}
assertMalformedJsonParity();

console.log("Pending visit review query tests passed.");
