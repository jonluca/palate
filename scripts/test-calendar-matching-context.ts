#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import {
  buildCalendarEnrichmentVisitSnapshot,
  CALENDAR_ENRICHMENT_SNAPSHOT_SQL,
  type CalendarEnrichmentSnapshotRow,
  type CalendarEnrichmentVisitSnapshot,
} from "../utils/db/calendar-enrichment-snapshot-core.ts";

interface LegacyVisitRow {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
}

interface LegacySuggestionRow {
  readonly visitId: string;
  readonly id: string;
  readonly name: string;
}

type SQLiteRow = ReturnType<StatementSync["all"]>[number];

function isSQLiteString(value: SQLOutputValue | undefined): value is string {
  return typeof value === "string";
}

function isSQLiteNumber(value: SQLOutputValue | undefined): value is number {
  return typeof value === "number";
}

function requiredString(value: SQLOutputValue | undefined, column: string): string {
  assert.ok(isSQLiteString(value), `${column} must be a SQLite TEXT value`);
  return value;
}

function nullableString(value: SQLOutputValue | undefined, column: string): string | null {
  return value === null ? null : requiredString(value, column);
}

function requiredNumber(value: SQLOutputValue | undefined, column: string): number {
  assert.ok(isSQLiteNumber(value), `${column} must be a SQLite numeric value`);
  return value;
}

function parseLegacyVisitRow(row: SQLiteRow): LegacyVisitRow {
  return {
    id: requiredString(row.id, "visits.id"),
    startTime: requiredNumber(row.startTime, "visits.startTime"),
    endTime: requiredNumber(row.endTime, "visits.endTime"),
  };
}

function parseLegacySuggestionRow(row: SQLiteRow): LegacySuggestionRow {
  return {
    visitId: requiredString(row.visitId, "suggestions.visitId"),
    id: requiredString(row.id, "suggestions.id"),
    name: requiredString(row.name, "suggestions.name"),
  };
}

function parseCalendarEnrichmentSnapshotRow(row: SQLiteRow): CalendarEnrichmentSnapshotRow {
  return {
    visitId: requiredString(row.visitId, "snapshot.visitId"),
    startTime: requiredNumber(row.startTime, "snapshot.startTime"),
    endTime: requiredNumber(row.endTime, "snapshot.endTime"),
    suggestedRestaurantId: nullableString(row.suggestedRestaurantId, "snapshot.suggestedRestaurantId"),
    suggestedRestaurantName: nullableString(row.suggestedRestaurantName, "snapshot.suggestedRestaurantName"),
  };
}

function parseQueryPlanDetail(row: SQLiteRow): string {
  return requiredString(row.detail, "query plan.detail");
}

function loadLegacyOracle(database: DatabaseSync, batchSize: number): CalendarEnrichmentVisitSnapshot[] {
  const visits = database
    .prepare(
      `SELECT id, startTime, endTime
       FROM visits
       WHERE calendarEventId IS NULL
       ORDER BY startTime DESC`,
    )
    .all()
    .map(parseLegacyVisitRow);
  const suggestionsByVisitId = new Map<string, Array<{ id: string; name: string }>>();

  for (let offset = 0; offset < visits.length; offset += batchSize) {
    const visitIds = visits.slice(offset, offset + batchSize).map((visit) => visit.id);
    const placeholders = visitIds.map(() => "?").join(", ");
    const suggestions = database
      .prepare(
        `SELECT vsr.visitId, m.id, m.name
         FROM visit_suggested_restaurants vsr
         JOIN michelin_restaurants m ON m.id = vsr.restaurantId
         WHERE vsr.visitId IN (${placeholders})
         ORDER BY vsr.visitId, vsr.distance ASC`,
      )
      .all(...visitIds)
      .map(parseLegacySuggestionRow);
    for (const suggestion of suggestions) {
      const grouped = suggestionsByVisitId.get(suggestion.visitId) ?? [];
      grouped.push({ id: suggestion.id, name: suggestion.name });
      suggestionsByVisitId.set(suggestion.visitId, grouped);
    }
  }

  return visits.map((visit) => ({
    ...visit,
    suggestedRestaurants: suggestionsByVisitId.get(visit.id) ?? [],
  }));
}

function seedFixture(database: DatabaseSync): void {
  database.exec(`CREATE TABLE visits (
    id TEXT PRIMARY KEY,
    startTime INTEGER NOT NULL,
    endTime INTEGER NOT NULL,
    calendarEventId TEXT
  );
  CREATE TABLE michelin_restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE visit_suggested_restaurants (
    visitId TEXT NOT NULL,
    restaurantId TEXT NOT NULL,
    distance REAL NOT NULL,
    PRIMARY KEY (visitId, restaurantId)
  );
  CREATE INDEX idx_visits_calendar_event ON visits(calendarEventId);
  CREATE INDEX idx_visit_suggested_distance ON visit_suggested_restaurants(visitId, distance);
  ANALYZE;`);

  const insertVisit = database.prepare(
    "INSERT INTO visits (id, startTime, endTime, calendarEventId) VALUES (?, ?, ?, ?)",
  );
  insertVisit.run("visit-tie-first", 200, 220, null);
  insertVisit.run("visit-late", 300, 330, null);
  insertVisit.run("visit-tie-second", 200, 230, null);
  insertVisit.run("visit-early", 100, 110, null);
  insertVisit.run("visit-linked", 400, 420, "event-already-linked");

  const insertRestaurant = database.prepare("INSERT INTO michelin_restaurants (id, name) VALUES (?, ?)");
  insertRestaurant.run("restaurant-first", "O'Brien 食堂");
  insertRestaurant.run("restaurant-second", "Café 🍜");
  insertRestaurant.run("restaurant-linked", "Excluded Restaurant");
  insertRestaurant.run("restaurant-tie-z", "Tie Z");
  insertRestaurant.run("restaurant-tie-a", "Tie A");

  const insertSuggestion = database.prepare(
    "INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES (?, ?, ?)",
  );
  insertSuggestion.run("visit-tie-first", "restaurant-second", 20);
  insertSuggestion.run("visit-tie-first", "restaurant-first", 10);
  insertSuggestion.run("visit-tie-first", "orphaned-restaurant", 5);
  insertSuggestion.run("visit-tie-second", "restaurant-second", 15);
  // Equal-distance insertion order intentionally differs from ID order. The
  // candidate explicitly retains the former index encounter (rowid) order.
  insertSuggestion.run("visit-early", "restaurant-tie-z", 12);
  insertSuggestion.run("visit-early", "restaurant-tie-a", 12);
  insertSuggestion.run("visit-linked", "restaurant-linked", 1);
}

function assertProductionQueryMatchesLegacy(database: DatabaseSync): void {
  const legacy = loadLegacyOracle(database, 2);
  const candidateRows = database
    .prepare(CALENDAR_ENRICHMENT_SNAPSHOT_SQL)
    .all()
    .map(parseCalendarEnrichmentSnapshotRow);
  const candidate = buildCalendarEnrichmentVisitSnapshot(candidateRows);

  assert.deepEqual(candidate, legacy);
  assert.deepEqual(candidate, [
    {
      id: "visit-late",
      startTime: 300,
      endTime: 330,
      suggestedRestaurants: [],
    },
    {
      id: "visit-tie-first",
      startTime: 200,
      endTime: 220,
      suggestedRestaurants: [
        { id: "restaurant-first", name: "O'Brien 食堂" },
        { id: "restaurant-second", name: "Café 🍜" },
      ],
    },
    {
      id: "visit-tie-second",
      startTime: 200,
      endTime: 230,
      suggestedRestaurants: [{ id: "restaurant-second", name: "Café 🍜" }],
    },
    {
      id: "visit-early",
      startTime: 100,
      endTime: 110,
      suggestedRestaurants: [
        { id: "restaurant-tie-z", name: "Tie Z" },
        { id: "restaurant-tie-a", name: "Tie A" },
      ],
    },
  ]);
  assert.equal(
    candidate.some((visit) => visit.id === "visit-linked"),
    false,
  );
}

function testProductionQueryAgainstLegacyOracle(): void {
  const database = new DatabaseSync(":memory:");
  try {
    seedFixture(database);
    const visitPlan = database
      .prepare(`EXPLAIN QUERY PLAN SELECT id, startTime, endTime
        FROM visits WHERE calendarEventId IS NULL ORDER BY startTime DESC`)
      .all()
      .map(parseQueryPlanDetail)
      .join("\n");
    const suggestionPlan = database
      .prepare(`EXPLAIN QUERY PLAN SELECT vsr.visitId, m.id, m.name
        FROM visit_suggested_restaurants vsr
        JOIN michelin_restaurants m ON m.id = vsr.restaurantId
        WHERE vsr.visitId IN (?, ?)
        ORDER BY vsr.visitId, vsr.distance ASC`)
      .all("visit-tie-first", "visit-early")
      .map(parseQueryPlanDetail)
      .join("\n");
    assert.match(visitPlan, /idx_visits_calendar_event/);
    assert.match(suggestionPlan, /idx_visit_suggested_distance/);

    assertProductionQueryMatchesLegacy(database);
    database.exec("VACUUM; ANALYZE;");
    assertProductionQueryMatchesLegacy(database);
  } finally {
    database.close();
  }
}

function testBuilderInvariants(): void {
  const rows: CalendarEnrichmentSnapshotRow[] = [
    {
      visitId: "visit-a",
      startTime: 10,
      endTime: 20,
      suggestedRestaurantId: "restaurant-a",
      suggestedRestaurantName: "Restaurant A",
    },
    {
      visitId: "visit-a",
      startTime: 10,
      endTime: 20,
      suggestedRestaurantId: "orphaned-id",
      suggestedRestaurantName: null,
    },
    {
      visitId: "visit-b",
      startTime: 5,
      endTime: 6,
      suggestedRestaurantId: null,
      suggestedRestaurantName: null,
    },
  ];

  assert.deepEqual(buildCalendarEnrichmentVisitSnapshot(rows), [
    {
      id: "visit-a",
      startTime: 10,
      endTime: 20,
      suggestedRestaurants: [{ id: "restaurant-a", name: "Restaurant A" }],
    },
    {
      id: "visit-b",
      startTime: 5,
      endTime: 6,
      suggestedRestaurants: [],
    },
  ]);

  assert.throws(
    () =>
      buildCalendarEnrichmentVisitSnapshot([
        rows[0]!,
        {
          ...rows[0]!,
          endTime: 21,
        },
      ]),
    /inconsistent times for visit visit-a/,
  );
}

testProductionQueryAgainstLegacyOracle();
testBuilderInvariants();

const visitServiceSource = readFileSync(new URL("../services/visit.ts", import.meta.url), "utf8");
const enrichmentStart = visitServiceSource.indexOf("async function enrichVisitsWithCalendarEvents(");
const enrichmentEnd = visitServiceSource.indexOf("// CALENDAR-ONLY VISITS", enrichmentStart);
assert.ok(enrichmentStart >= 0 && enrichmentEnd > enrichmentStart);
const enrichmentSource = visitServiceSource.slice(enrichmentStart, enrichmentEnd);
assert.match(enrichmentSource, /await getCalendarEnrichmentVisitSnapshot\(context\)/);
assert.doesNotMatch(enrichmentSource, /getVisitsWithoutCalendarData|getSuggestedRestaurantsForVisits/);
assert.match(enrichmentSource, /matchCalendarEventsForVisitsNatively\(visitsToProcess, 30, selectedCalendarIds\)/);
assert.match(enrichmentSource, /const suggestedRestaurants = visit\.suggestedRestaurants/);

console.log(
  JSON.stringify(
    {
      status: "ok",
      productionSqlImportedDirectly: true,
      productionBuilderImportedDirectly: true,
      fixtureChecks: {
        exactLegacyParity: true,
        visitOrder: true,
        suggestionDistanceOrder: true,
        equalDistanceLegacyOrder: true,
        productionIndexesExercised: true,
        vacuumParity: true,
        emptySuggestions: true,
        orphanedSuggestionParity: true,
        linkedVisitExclusion: true,
        unicodeAndQuotes: true,
        inconsistentVisitTimesRejected: true,
        nativeAndFallbackSourceWiring: true,
      },
    },
    null,
    2,
  ),
);
