#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildVisitsWithDetailsQuery,
  parseVisitDetailsRows,
  type VisitDetailsFilter,
  type VisitDetailsQueryRow,
} from "../utils/db/visit-details-core.ts";
import type { VisitWithDetails } from "../utils/db/types.ts";

interface QueryPlanRow {
  readonly detail: string;
}

interface LegacyVisitRow {
  readonly id: string;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly suggestedRestaurantAward: string | null;
  readonly [column: string]: unknown;
}

interface LegacyPreviewRow {
  readonly visitId: string;
  readonly uri: string;
}

const database = new DatabaseSync(":memory:");

function createSchema(): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      award TEXT NOT NULL
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
      exportedToCalendarId TEXT,
      notes TEXT,
      updatedAt INTEGER,
      awardAtVisit TEXT,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );

    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_food_time ON visits(foodProbable, startTime DESC);
    CREATE INDEX idx_visits_time ON visits(startTime);
  `);
}

function seedEdgeCases(): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertMichelin = database.prepare("INSERT INTO michelin_restaurants (id, name, award) VALUES (?, ?, ?)");
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      exportedToCalendarId, notes, updatedAt, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );

  database.exec("BEGIN");
  try {
    insertRestaurant.run("restaurant-local", "Local Restaurant");
    insertRestaurant.run("restaurant-東京", "東京 Kitchen");
    insertMichelin.run("michelin-current", "Current Guide Name", "Two Stars");
    insertMichelin.run("michelin-empty-award", "Empty Award", "Selected");

    insertVisit.run(
      "visit-priority",
      "restaurant-local",
      "michelin-current",
      "pending",
      900,
      950,
      1,
      2,
      4,
      1,
      "event-priority",
      "Dinner",
      null,
      0,
      null,
      "priority notes",
      901,
      null,
    );
    insertPhoto.run("priority-null", "ph://priority-null", 1, "visit-priority", null);
    insertPhoto.run("priority-false", "ph://priority-false", 2, "visit-priority", 0);
    insertPhoto.run("priority-true-new", "ph://priority-true-new", 30, "visit-priority", 1);
    insertPhoto.run("priority-true-old", "ph://priority-true-old", 20, "visit-priority", 1);

    insertVisit.run(
      "visit-history",
      null,
      "michelin-current",
      "confirmed",
      800,
      850,
      -10,
      20,
      0,
      0,
      null,
      null,
      null,
      null,
      "exported-history",
      null,
      801,
      "One Star",
    );

    insertVisit.run(
      "visit-empty-award",
      null,
      "michelin-empty-award",
      "confirmed",
      700,
      750,
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
      "",
    );

    insertVisit.run(
      "visit-ties",
      "restaurant-local",
      null,
      "confirmed",
      600,
      650,
      0,
      0,
      4,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      601,
      null,
    );
    insertPhoto.run("tie-z", "ph://tie-inserted-first", 100, "visit-ties", 1);
    insertPhoto.run("tie-a", "ph://tie-inserted-second", 100, "visit-ties", 1);
    insertPhoto.run("tie-y", "ph://tie-inserted-third", 100, "visit-ties", 1);
    insertPhoto.run("tie-b", "ph://tie-excluded-fourth", 100, "visit-ties", 1);

    insertVisit.run(
      "vis'it-雪",
      "restaurant-東京",
      null,
      "rejected",
      500,
      550,
      35.7,
      139.7,
      2,
      1,
      "event-'雪'",
      "予約 🍣",
      "東京都",
      1,
      null,
      "quote ' and snow 雪",
      501,
      null,
    );
    insertPhoto.run("unicode-1", "ph://雪/'quoted'/🍣", 10, "vis'it-雪", null);
    insertPhoto.run("unicode-2", 'ph://json-"quoted"-\\slash', 5, "vis'it-雪", 0);

    insertVisit.run(
      "visit-missing-joins",
      null,
      null,
      "pending",
      400,
      450,
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

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function legacyWhere(filter?: VisitDetailsFilter): { readonly clause: string; readonly parameters: string[] } {
  if (filter === "food") {
    return { clause: "WHERE c.foodProbable = 1", parameters: [] };
  }
  if (filter) {
    return { clause: "WHERE c.status = ?", parameters: [filter] };
  }
  return { clause: "", parameters: [] };
}

function executeLegacy(filter?: VisitDetailsFilter): VisitWithDetails[] {
  const selection = legacyWhere(filter);
  const visits = database
    .prepare(
      `SELECT c.*,
              r.name AS restaurantName,
              m.name AS suggestedRestaurantName,
              COALESCE(c.awardAtVisit, m.award) AS suggestedRestaurantAward
       FROM visits c
       LEFT JOIN restaurants r ON c.restaurantId = r.id
       LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
       ${selection.clause}
       ORDER BY c.startTime DESC`,
    )
    .all(...selection.parameters) as unknown as LegacyVisitRow[];

  if (visits.length === 0) {
    return [];
  }

  const visitIds = visits.map((visit) => visit.id);
  const previews = database
    .prepare(
      `SELECT visitId, uri
       FROM (
         SELECT visitId,
                uri,
                ROW_NUMBER() OVER (
                  PARTITION BY visitId
                  ORDER BY
                    CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
                    creationTime ASC,
                    id ASC
                ) AS rn
         FROM photos
         WHERE visitId IN (${visitIds.map(() => "?").join(", ")})
       )
       WHERE rn <= 3
       ORDER BY rn ASC`,
    )
    .all(...visitIds) as unknown as LegacyPreviewRow[];

  const previewsByVisit = new Map<string, string[]>();
  for (const preview of previews) {
    const uris = previewsByVisit.get(preview.visitId);
    if (uris) {
      uris.push(preview.uri);
    } else {
      previewsByVisit.set(preview.visitId, [preview.uri]);
    }
  }

  return visits.map((visit) => ({
    ...visit,
    previewPhotos: previewsByVisit.get(visit.id) ?? [],
  })) as VisitWithDetails[];
}

function executeCandidate(filter?: VisitDetailsFilter): VisitWithDetails[] {
  const query = buildVisitsWithDetailsQuery(filter);
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitDetailsQueryRow[];
  return parseVisitDetailsRows(rows);
}

function ids(rows: readonly VisitWithDetails[]): string[] {
  return rows.map((row) => row.id);
}

try {
  createSchema();
  seedEdgeCases();

  const filters = [undefined, "pending", "confirmed", "rejected", "food"] as const;
  for (const filter of filters) {
    assert.deepEqual(executeCandidate(filter), executeLegacy(filter), `candidate differed for ${filter ?? "all"}`);
  }

  const all = executeCandidate();
  const byId = new Map(all.map((visit) => [visit.id, visit]));
  assert.deepEqual(ids(all), [
    "visit-priority",
    "visit-history",
    "visit-empty-award",
    "visit-ties",
    "vis'it-雪",
    "visit-missing-joins",
  ]);
  assert.deepEqual(byId.get("visit-priority")?.previewPhotos, [
    "ph://priority-true-old",
    "ph://priority-true-new",
    "ph://priority-false",
  ]);
  assert.deepEqual(byId.get("visit-ties")?.previewPhotos, [
    "ph://tie-inserted-second",
    "ph://tie-excluded-fourth",
    "ph://tie-inserted-third",
  ]);
  assert.deepEqual(byId.get("vis'it-雪")?.previewPhotos, ['ph://json-"quoted"-\\slash', "ph://雪/'quoted'/🍣"]);
  assert.deepEqual(byId.get("visit-history"), {
    ...byId.get("visit-history"),
    restaurantName: null,
    suggestedRestaurantName: "Current Guide Name",
    suggestedRestaurantAward: "One Star",
    previewPhotos: [],
  });
  assert.equal(byId.get("visit-empty-award")?.suggestedRestaurantAward, "");
  assert.equal(byId.get("visit-missing-joins")?.restaurantName, null);
  assert.equal(byId.get("visit-missing-joins")?.suggestedRestaurantName, null);
  assert.equal(byId.get("visit-missing-joins")?.suggestedRestaurantAward, null);

  assert.deepEqual(ids(executeCandidate("pending")), ["visit-priority", "visit-missing-joins"]);
  assert.deepEqual(ids(executeCandidate("confirmed")), ["visit-history", "visit-empty-award", "visit-ties"]);
  assert.deepEqual(ids(executeCandidate("rejected")), ["vis'it-雪"]);
  assert.deepEqual(ids(executeCandidate("food")), ["visit-priority", "visit-empty-award", "vis'it-雪"]);

  const emptyDatabase = new DatabaseSync(":memory:");
  emptyDatabase.exec(`
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, award TEXT NOT NULL);
    CREATE TABLE visits (
      id TEXT PRIMARY KEY, restaurantId TEXT, suggestedRestaurantId TEXT, status TEXT,
      startTime INTEGER, endTime INTEGER, centerLat REAL, centerLon REAL, photoCount INTEGER,
      foodProbable INTEGER, calendarEventId TEXT, calendarEventTitle TEXT,
      calendarEventLocation TEXT, calendarEventIsAllDay INTEGER, exportedToCalendarId TEXT,
      notes TEXT, updatedAt INTEGER, awardAtVisit TEXT
    );
    CREATE TABLE photos (id TEXT PRIMARY KEY, uri TEXT, creationTime INTEGER, visitId TEXT, foodDetected INTEGER);
  `);
  const emptyQuery = buildVisitsWithDetailsQuery();
  assert.deepEqual(emptyDatabase.prepare(emptyQuery.sql).all(), []);
  emptyDatabase.close();

  const { previewPhotos: _, ...malformedPreviewRow } = all[0];
  assert.deepEqual(
    parseVisitDetailsRows([{ ...malformedPreviewRow, previewPhotosJson: "not-json" }])[0].previewPhotos,
    [],
  );

  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${buildVisitsWithDetailsQuery().sql}`)
    .all() as unknown as QueryPlanRow[];
  assert.ok(
    plan.some((row) => row.detail.includes("idx_photos_visit_preview")),
    `expected preview lookup index in plan:\n${plan.map((row) => row.detail).join("\n")}`,
  );

  console.log(
    `visit details query tests passed (${filters.length} filters; one result row per visit; indexed top-three previews)`,
  );
} finally {
  database.close();
}
