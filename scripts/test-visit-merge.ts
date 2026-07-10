#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  buildVisitMergePlan,
  VISIT_MERGE_COPY_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_VISITS_SQL,
  VISIT_MERGE_MOVE_PHOTOS_SQL,
  VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL,
  VISIT_MERGE_PREFLIGHT_SQL,
  VISIT_MERGE_UPDATE_TARGETS_SQL,
  type VisitMergePreflightRow,
} from "../utils/db/visit-merge-core.ts";
import {
  isVisitMergeDatabaseBusyError,
  runVisitMergeWithBusyRetry,
  VISIT_MERGE_RETRY_POLICY,
  type VisitMergeRetryRuntime,
} from "../utils/db/visit-merge-retry-core.ts";
import type { MergeableVisitGroup } from "../utils/db/types.ts";

export const FIXED_UPDATED_AT = 1_789_456_123_000;
export const LEGACY_CALLS_PER_SOURCE = 11;
export const CANDIDATE_PREFLIGHT_CALLS = 1;
export const CANDIDATE_BODY_CALLS = 6;
export const CANDIDATE_TRANSACTION_CONTROL_CALLS = 2;

interface VirtualRetryClock {
  monotonicTimeMs: number;
  wallTimeMs: number;
  readonly requestedSleeps: number[];
}

function createVirtualRetryRuntime({
  initialMonotonicTimeMs = 0,
  initialWallTimeMs = FIXED_UPDATED_AT,
  sleepOvershootMs = 0,
  onSleep,
}: {
  initialMonotonicTimeMs?: number;
  initialWallTimeMs?: number;
  sleepOvershootMs?: number;
  onSleep?: (clock: VirtualRetryClock) => void;
} = {}): { readonly clock: VirtualRetryClock; readonly runtime: VisitMergeRetryRuntime } {
  const clock: VirtualRetryClock = {
    monotonicTimeMs: initialMonotonicTimeMs,
    wallTimeMs: initialWallTimeMs,
    requestedSleeps: [],
  };
  return {
    clock,
    runtime: {
      monotonicNow: () => clock.monotonicTimeMs,
      wallNow: () => clock.wallTimeMs,
      sleep: async (milliseconds) => {
        clock.requestedSleeps.push(milliseconds);
        const elapsedMs = milliseconds + sleepOvershootMs;
        clock.monotonicTimeMs += elapsedMs;
        clock.wallTimeMs += elapsedMs;
        onSleep?.(clock);
      },
    },
  };
}

type SQLiteValue = string | number | null;
type Row = Record<string, SQLiteValue>;
type TableName =
  | "michelin_restaurants"
  | "restaurants"
  | "visits"
  | "photos"
  | "visit_suggested_restaurants"
  | "reservation_import_sources";

export interface DatabaseSnapshot {
  readonly michelin_restaurants: readonly Row[];
  readonly restaurants: readonly Row[];
  readonly visits: readonly Row[];
  readonly photos: readonly Row[];
  readonly visit_suggested_restaurants: readonly Row[];
  readonly reservation_import_sources: readonly Row[];
}

export interface ExecutionCounts {
  readonly mergeCount: number;
  readonly executionCalls: number;
  readonly transactionControlCalls: number;
  readonly statementPreparations: number;
}

export interface VisitSeed {
  readonly id: string;
  readonly restaurantId?: string | null;
  readonly suggestedRestaurantId?: string | null;
  readonly status?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly centerLat: number;
  readonly centerLon: number;
  readonly photoCount?: number;
  readonly foodProbable?: number;
  readonly calendarEventId?: string | null;
  readonly calendarEventTitle?: string | null;
  readonly calendarEventLocation?: string | null;
  readonly calendarEventIsAllDay?: number | null;
  readonly exportedToCalendarId?: string | null;
  readonly notes?: string | null;
  readonly updatedAt?: number | null;
  readonly awardAtVisit?: string | null;
}

export interface PhotoSeed {
  readonly id: string;
  readonly visitId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly foodDetected?: number | null;
  readonly creationTime?: number;
  readonly marker?: string;
}

const TABLE_QUERIES: Record<TableName, string> = {
  michelin_restaurants: "SELECT * FROM michelin_restaurants ORDER BY id",
  restaurants: "SELECT * FROM restaurants ORDER BY id",
  visits: "SELECT * FROM visits ORDER BY id",
  photos: "SELECT * FROM photos ORDER BY id",
  visit_suggested_restaurants: "SELECT * FROM visit_suggested_restaurants ORDER BY visitId, restaurantId",
  reservation_import_sources: "SELECT * FROM reservation_import_sources ORDER BY sourceEventId",
};

export function createVisitMergeDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;

    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      marker TEXT NOT NULL
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
      marker TEXT NOT NULL,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );

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
      mediaType TEXT NOT NULL,
      duration REAL,
      marker TEXT NOT NULL,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );

    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      marker TEXT NOT NULL DEFAULT 'suggestion-sentinel',
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );

    CREATE TABLE reservation_import_sources (
      sourceEventId TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      visitId TEXT NOT NULL,
      importedAt INTEGER NOT NULL,
      marker TEXT NOT NULL,
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_suggestions_visit ON visit_suggested_restaurants(visitId);
    CREATE INDEX idx_reservation_visit ON reservation_import_sources(visitId);
  `);
  return database;
}

export function insertMichelin(database: DatabaseSync, ids: readonly string[]): void {
  const insert = database.prepare("INSERT OR IGNORE INTO michelin_restaurants VALUES (?, ?)");
  for (const id of ids) {
    insert.run(id, `Michelin ${id}`);
  }
}

export function insertRestaurant(database: DatabaseSync, id: string): void {
  database
    .prepare("INSERT OR IGNORE INTO restaurants VALUES (?, ?, ?, ?, ?)")
    .run(id, `Restaurant ${id}`, 37.5, -122.4, `restaurant-marker:${id}`);
}

export function insertVisit(database: DatabaseSync, visit: VisitSeed): void {
  database
    .prepare(`INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      exportedToCalendarId, notes, updatedAt, awardAtVisit, marker
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      visit.id,
      visit.restaurantId ?? null,
      visit.suggestedRestaurantId ?? null,
      visit.status ?? "confirmed",
      visit.startTime,
      visit.endTime,
      visit.centerLat,
      visit.centerLon,
      visit.photoCount ?? 0,
      visit.foodProbable ?? 0,
      visit.calendarEventId ?? null,
      visit.calendarEventTitle ?? null,
      visit.calendarEventLocation ?? null,
      visit.calendarEventIsAllDay ?? null,
      visit.exportedToCalendarId ?? null,
      visit.notes ?? null,
      visit.updatedAt ?? null,
      visit.awardAtVisit ?? null,
      `visit-marker:${visit.id}`,
    );
}

export function insertPhoto(database: DatabaseSync, photo: PhotoSeed): void {
  database
    .prepare(`INSERT INTO photos (
      id, uri, creationTime, latitude, longitude, visitId, foodDetected,
      foodLabels, foodConfidence, allLabels, mediaType, duration, marker
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      photo.id,
      `fixture://${encodeURIComponent(photo.id)}`,
      photo.creationTime ?? 1_700_000_000_000,
      photo.latitude,
      photo.longitude,
      photo.visitId,
      photo.foodDetected ?? null,
      `[{"label":"${photo.id}","confidence":0.75}]`,
      0.75,
      `[{"label":"all-${photo.id}","confidence":0.8}]`,
      photo.id.includes("video") ? "video" : "photo",
      photo.id.includes("video") ? 12.5 : null,
      photo.marker ?? `photo-marker:${photo.id}`,
    );
}

export function insertSuggestion(
  database: DatabaseSync,
  visitId: string,
  restaurantId: string,
  distance: number,
): void {
  database
    .prepare(`INSERT INTO visit_suggested_restaurants
      (visitId, restaurantId, distance, marker) VALUES (?, ?, ?, ?)`)
    .run(visitId, restaurantId, distance, `suggestion-marker:${visitId}:${restaurantId}`);
}

export function insertReservation(database: DatabaseSync, sourceEventId: string, visitId: string): void {
  database
    .prepare(`INSERT INTO reservation_import_sources
      (sourceEventId, source, visitId, importedAt, marker) VALUES (?, ?, ?, ?, ?)`)
    .run(sourceEventId, "fixture-provider", visitId, 1_700_123_456_789, `reservation-marker:${sourceEventId}`);
}

export function createGroup(restaurantId: string, visitIds: readonly string[], baseTime = 10_000): MergeableVisitGroup {
  return {
    restaurantId,
    restaurantName: `Restaurant ${restaurantId}`,
    visits: visitIds.map((id, index) => ({
      id,
      startTime: baseTime + index * 1_000,
      endTime: baseTime + index * 1_000 + 500,
      photoCount: index + 1,
    })),
    totalPhotos: (visitIds.length * (visitIds.length + 1)) / 2,
  };
}

export function executeLegacySequential(
  database: DatabaseSync,
  groups: readonly MergeableVisitGroup[],
  updatedAt = FIXED_UPDATED_AT,
): ExecutionCounts {
  let mergeCount = 0;
  let executionCalls = 0;
  let statementPreparations = 0;

  const prepare = (sql: string) => {
    statementPreparations += 1;
    return database.prepare(sql);
  };

  for (const group of groups) {
    if (group.visits.length < 2) {
      continue;
    }
    const targetVisitId = group.visits[0]!.id;

    for (let index = 1; index < group.visits.length; index++) {
      const sourceVisitId = group.visits[index]!.id;
      const targetVisit = prepare("SELECT * FROM visits WHERE id = ?").get(targetVisitId) as Row | undefined;
      executionCalls += 1;
      const sourceVisit = prepare("SELECT * FROM visits WHERE id = ?").get(sourceVisitId) as Row | undefined;
      executionCalls += 1;
      if (!targetVisit || !sourceVisit) {
        throw new Error("One or both visits not found");
      }

      prepare("UPDATE photos SET visitId = ? WHERE visitId = ?").run(targetVisitId, sourceVisitId);
      executionCalls += 1;

      const locatedPhotos = prepare(
        `SELECT latitude, longitude FROM photos
         WHERE visitId = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`,
      ).all(targetVisitId) as Array<{ latitude: number; longitude: number }>;
      executionCalls += 1;

      let centerLat = Number(targetVisit.centerLat);
      let centerLon = Number(targetVisit.centerLon);
      if (locatedPhotos.length > 0) {
        centerLat = locatedPhotos.reduce((sum, photo) => sum + photo.latitude, 0) / locatedPhotos.length;
        centerLon = locatedPhotos.reduce((sum, photo) => sum + photo.longitude, 0) / locatedPhotos.length;
      }

      const countRow = prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId = ?").get(targetVisitId) as {
        count: number;
      };
      executionCalls += 1;
      const foodRow = prepare(
        `SELECT MAX(CASE WHEN foodDetected = 1 THEN 1 ELSE 0 END) AS hasFood
         FROM photos WHERE visitId = ?`,
      ).get(targetVisitId) as { hasFood: number | null };
      executionCalls += 1;

      prepare(`UPDATE visits SET
          startTime = ?, endTime = ?, centerLat = ?, centerLon = ?,
          photoCount = ?, foodProbable = ?, updatedAt = ?
        WHERE id = ?`).run(
        Math.min(Number(targetVisit.startTime), Number(sourceVisit.startTime)),
        Math.max(Number(targetVisit.endTime), Number(sourceVisit.endTime)),
        centerLat,
        centerLon,
        countRow.count,
        foodRow.hasFood === 1 || Number(targetVisit.foodProbable) !== 0 || Number(sourceVisit.foodProbable) !== 0
          ? 1
          : 0,
        updatedAt,
        targetVisitId,
      );
      executionCalls += 1;

      prepare(`INSERT OR IGNORE INTO visit_suggested_restaurants
          (visitId, restaurantId, distance)
        SELECT ?, restaurantId, distance
        FROM visit_suggested_restaurants WHERE visitId = ?`).run(targetVisitId, sourceVisitId);
      executionCalls += 1;
      prepare("UPDATE reservation_import_sources SET visitId = ? WHERE visitId = ?").run(targetVisitId, sourceVisitId);
      executionCalls += 1;
      prepare("DELETE FROM visit_suggested_restaurants WHERE visitId = ?").run(sourceVisitId);
      executionCalls += 1;
      prepare("DELETE FROM visits WHERE id = ?").run(sourceVisitId);
      executionCalls += 1;
      mergeCount += 1;
    }
  }

  assert.equal(executionCalls, mergeCount * LEGACY_CALLS_PER_SOURCE);
  return { mergeCount, executionCalls, transactionControlCalls: 0, statementPreparations };
}

export function executeCandidatePlan(
  database: DatabaseSync,
  groups: readonly MergeableVisitGroup[],
  updatedAt = FIXED_UPDATED_AT,
): ExecutionCounts {
  const plan = buildVisitMergePlan(groups);
  if (plan.mergeCount === 0) {
    return { mergeCount: 0, executionCalls: 0, transactionControlCalls: 0, statementPreparations: 0 };
  }

  let executionCalls = 0;
  let transactionControlCalls = 0;
  let statementPreparations = 0;
  const prepare = (sql: string) => {
    statementPreparations += 1;
    return database.prepare(sql);
  };

  database.exec("BEGIN IMMEDIATE");
  transactionControlCalls += 1;
  try {
    const preflight = prepare(VISIT_MERGE_PREFLIGHT_SQL).get(plan.payload) as VisitMergePreflightRow | undefined;
    executionCalls += 1;
    if (
      !preflight ||
      preflight.plannedVisitCount !== plan.referencedVisitCount ||
      preflight.existingVisitCount !== plan.referencedVisitCount
    ) {
      throw new Error("One or more visits in the merge plan were not found");
    }

    prepare(VISIT_MERGE_MOVE_PHOTOS_SQL).run(plan.payload);
    executionCalls += 1;
    const targetUpdate = prepare(VISIT_MERGE_UPDATE_TARGETS_SQL).run(plan.payload, updatedAt);
    executionCalls += 1;
    if (Number(targetUpdate.changes) !== plan.targetVisitIds.length) {
      throw new Error("Unexpected target update count");
    }

    prepare(VISIT_MERGE_COPY_SUGGESTIONS_SQL).run(plan.payload);
    executionCalls += 1;
    prepare(VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL).run(plan.payload);
    executionCalls += 1;
    prepare(VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL).run(plan.payload);
    executionCalls += 1;
    const sourceDelete = prepare(VISIT_MERGE_DELETE_SOURCE_VISITS_SQL).run(plan.payload);
    executionCalls += 1;
    if (Number(sourceDelete.changes) !== plan.mergeCount) {
      throw new Error("Unexpected source delete count");
    }

    database.exec("COMMIT");
    transactionControlCalls += 1;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
      transactionControlCalls += 1;
    } catch {
      // Preserve the original failure if SQLite already ended the transaction.
    }
    throw error;
  }

  assert.equal(executionCalls, CANDIDATE_PREFLIGHT_CALLS + CANDIDATE_BODY_CALLS);
  return { mergeCount: plan.mergeCount, executionCalls, transactionControlCalls, statementPreparations };
}

export function snapshotDatabase(database: DatabaseSync): DatabaseSnapshot {
  const read = (table: TableName): Row[] =>
    (database.prepare(TABLE_QUERIES[table]).all() as unknown as Row[]).map((row) => ({ ...row }));
  return {
    michelin_restaurants: read("michelin_restaurants"),
    restaurants: read("restaurants"),
    visits: read("visits"),
    photos: read("photos"),
    visit_suggested_restaurants: read("visit_suggested_restaurants"),
    reservation_import_sources: read("reservation_import_sources"),
  };
}

function withoutVisitCenters(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  return {
    ...snapshot,
    visits: snapshot.visits.map((visit) => {
      const { centerLat: _centerLat, centerLon: _centerLon, ...rest } = visit;
      return rest;
    }),
  };
}

export function snapshotDigest(snapshot: DatabaseSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function assertSnapshotsEquivalent(
  actual: DatabaseSnapshot,
  expected: DatabaseSnapshot,
  coordinateTolerance = 1e-12,
): { exact: boolean; digest: string; maximumCentroidAbsoluteDifference: number } {
  const exact = JSON.stringify(actual) === JSON.stringify(expected);
  assert.deepEqual(withoutVisitCenters(actual), withoutVisitCenters(expected));
  assert.equal(actual.visits.length, expected.visits.length);
  let maximumCentroidAbsoluteDifference = 0;
  for (let index = 0; index < actual.visits.length; index++) {
    const actualVisit = actual.visits[index]!;
    const expectedVisit = expected.visits[index]!;
    assert.equal(actualVisit.id, expectedVisit.id);
    const latitudeDifference = Math.abs(Number(actualVisit.centerLat) - Number(expectedVisit.centerLat));
    const longitudeDifference = Math.abs(Number(actualVisit.centerLon) - Number(expectedVisit.centerLon));
    maximumCentroidAbsoluteDifference = Math.max(
      maximumCentroidAbsoluteDifference,
      latitudeDifference,
      longitudeDifference,
    );
    assert.ok(latitudeDifference <= coordinateTolerance, `centerLat differs for ${String(actualVisit.id)}`);
    assert.ok(longitudeDifference <= coordinateTolerance, `centerLon differs for ${String(actualVisit.id)}`);
  }

  const canonical = {
    ...actual,
    visits: actual.visits.map((visit) => ({
      ...visit,
      centerLat: Number(Number(visit.centerLat).toFixed(12)),
      centerLon: Number(Number(visit.centerLon).toFixed(12)),
    })),
  };
  return { exact, digest: snapshotDigest(canonical), maximumCentroidAbsoluteDifference };
}

export function assertDatabaseHealth(database: DatabaseSync): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
  assert.deepEqual(Object.values(quickCheck), ["ok"]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

export function seedSemanticFixture(database: DatabaseSync): readonly MergeableVisitGroup[] {
  const restaurantIds = ["restaurant-a", "restaurant-b", "restaurant-unrelated"];
  for (const id of restaurantIds) {
    insertRestaurant(database, id);
  }
  insertMichelin(database, [
    "m-common",
    "m-shared",
    "m-target-only",
    "m-first-only",
    "m-second-only",
    "m-empty-only",
    "m-direct-target",
    "m-direct-source",
    "m-unrelated",
  ]);

  insertVisit(database, {
    id: "target-O'Brien-雪",
    restaurantId: "restaurant-a",
    suggestedRestaurantId: "m-direct-target",
    startTime: 1_000,
    endTime: 2_000,
    centerLat: 99,
    centerLon: -99,
    photoCount: 999,
    foodProbable: 0,
    calendarEventId: "target-calendar",
    calendarEventTitle: "Target dinner 🍣",
    calendarEventLocation: "Target location",
    calendarEventIsAllDay: 1,
    exportedToCalendarId: "target-export-calendar",
    notes: "target notes stay",
    updatedAt: 123,
    awardAtVisit: "Two Stars",
  });
  insertVisit(database, {
    id: "source-first",
    restaurantId: "restaurant-a",
    suggestedRestaurantId: "m-direct-source",
    startTime: 500,
    endTime: 1_800,
    centerLat: 1,
    centerLon: 2,
    photoCount: 123,
    foodProbable: 0,
    calendarEventId: "discard-calendar-first",
    calendarEventTitle: "Discard title first",
    exportedToCalendarId: "discard-export-first",
    notes: "discard notes first",
    awardAtVisit: "One Star",
  });
  insertVisit(database, {
    id: "source-second",
    restaurantId: "restaurant-a",
    startTime: 1_200,
    endTime: 3_500,
    centerLat: 3,
    centerLon: 4,
    photoCount: 456,
    foodProbable: 1,
    calendarEventId: "discard-calendar-second",
    notes: "discard notes second",
  });
  insertVisit(database, {
    id: "",
    restaurantId: "restaurant-a",
    startTime: 700,
    endTime: 2_100,
    centerLat: 5,
    centerLon: 6,
    photoCount: 789,
    foodProbable: 0,
    notes: "empty identifier is valid",
  });
  insertVisit(database, {
    id: "target-two",
    restaurantId: "restaurant-b",
    startTime: 10_000,
    endTime: 11_000,
    centerLat: 12.5,
    centerLon: 45.5,
    photoCount: 42,
    foodProbable: 1,
    calendarEventId: "target-two-calendar",
    notes: "second target notes",
  });
  insertVisit(database, {
    id: "source-no-coordinates",
    restaurantId: "restaurant-b",
    startTime: 9_000,
    endTime: 12_000,
    centerLat: -1,
    centerLon: -2,
    photoCount: 88,
    foodProbable: 0,
  });
  insertVisit(database, {
    id: "singleton",
    restaurantId: "restaurant-unrelated",
    startTime: 20_000,
    endTime: 21_000,
    centerLat: 7,
    centerLon: 8,
    photoCount: 1,
    foodProbable: 0,
  });
  insertVisit(database, {
    id: "unrelated",
    restaurantId: "restaurant-unrelated",
    suggestedRestaurantId: "m-unrelated",
    status: "pending",
    startTime: 30_000,
    endTime: 31_000,
    centerLat: 70,
    centerLon: 80,
    photoCount: 1,
    foodProbable: 0,
    notes: "unrelated sentinel",
  });

  insertPhoto(database, { id: "a-target-full", visitId: "target-O'Brien-雪", latitude: 10, longitude: 20 });
  insertPhoto(database, { id: "a-target-partial-lat", visitId: "target-O'Brien-雪", latitude: 30, longitude: null });
  insertPhoto(database, { id: "a-first-full-video", visitId: "source-first", latitude: 20, longitude: 40 });
  insertPhoto(database, { id: "a-first-partial-lon", visitId: "source-first", latitude: null, longitude: 60 });
  insertPhoto(database, {
    id: "a-second-no-location-food",
    visitId: "source-second",
    latitude: null,
    longitude: null,
    foodDetected: 1,
  });
  insertPhoto(database, { id: "a-empty-full", visitId: "", latitude: 40, longitude: 80 });
  insertPhoto(database, {
    id: "b-target-none",
    visitId: "target-two",
    latitude: null,
    longitude: null,
    foodDetected: 0,
  });
  insertPhoto(database, { id: "b-source-partial-lat", visitId: "source-no-coordinates", latitude: 5, longitude: null });
  insertPhoto(database, { id: "b-source-partial-lon", visitId: "source-no-coordinates", latitude: null, longitude: 7 });
  insertPhoto(database, { id: "unrelated-photo", visitId: "unrelated", latitude: 70, longitude: 80 });

  insertSuggestion(database, "target-O'Brien-雪", "m-common", 1.1);
  insertSuggestion(database, "target-O'Brien-雪", "m-target-only", 1.2);
  insertSuggestion(database, "source-first", "m-common", 2.1);
  insertSuggestion(database, "source-first", "m-shared", 2.2);
  insertSuggestion(database, "source-first", "m-first-only", 2.3);
  insertSuggestion(database, "source-second", "m-common", 3.1);
  insertSuggestion(database, "source-second", "m-shared", 3.2);
  insertSuggestion(database, "source-second", "m-second-only", 3.3);
  insertSuggestion(database, "", "m-shared", 4.1);
  insertSuggestion(database, "", "m-empty-only", 4.2);
  insertSuggestion(database, "unrelated", "m-unrelated", 9.9);

  insertReservation(database, "reservation-target", "target-O'Brien-雪");
  insertReservation(database, "reservation-first", "source-first");
  insertReservation(database, "reservation-second", "source-second");
  insertReservation(database, "reservation-empty", "");
  insertReservation(database, "reservation-no-coordinates", "source-no-coordinates");
  insertReservation(database, "reservation-unrelated", "unrelated");

  return [
    createGroup("restaurant-a", ["target-O'Brien-雪", "source-first", "source-second", ""], 1_000),
    { ...createGroup("restaurant-b", ["target-two", "source-no-coordinates"], 10_000), totalPhotos: 999 },
    createGroup("restaurant-unrelated", ["singleton"], 20_000),
    createGroup("restaurant-unrelated", [], 25_000),
  ];
}

function getVisit(database: DatabaseSync, id: string): Row {
  const visit = database.prepare("SELECT * FROM visits WHERE id = ?").get(id) as Row | undefined;
  assert.ok(visit, `missing visit ${JSON.stringify(id)}`);
  return visit;
}

function runPlannerTests(): number {
  let scenarios = 0;
  const empty = buildVisitMergePlan([]);
  assert.deepEqual(empty, {
    entries: [],
    targetVisitIds: [],
    sourceVisitIds: [],
    mergeCount: 0,
    referencedVisitCount: 0,
    payload: "[]",
  });
  scenarios += 1;

  const singleton = buildVisitMergePlan([createGroup("r", [""])]);
  assert.equal(singleton.mergeCount, 0);
  assert.equal(singleton.payload, "[]");
  scenarios += 1;

  const ordered = buildVisitMergePlan([
    createGroup("r1", ["target", "source-a", "source-b"]),
    createGroup("r2", ["目標", "來源-🍣"]),
  ]);
  assert.deepEqual(ordered.entries, [
    { targetVisitId: "target", sourceVisitId: "source-a", sourceOrder: 0 },
    { targetVisitId: "target", sourceVisitId: "source-b", sourceOrder: 1 },
    { targetVisitId: "目標", sourceVisitId: "來源-🍣", sourceOrder: 2 },
  ]);
  assert.equal(ordered.referencedVisitCount, 5);
  assert.deepEqual(JSON.parse(ordered.payload), ordered.entries);
  scenarios += 1;

  assert.throws(
    () => buildVisitMergePlan([{ ...createGroup("r", ["a", "b"]), visits: null } as unknown as MergeableVisitGroup]),
    /Invalid visit merge group/,
  );
  assert.throws(
    () =>
      buildVisitMergePlan([
        {
          ...createGroup("r", ["a", "b"]),
          visits: [
            { id: 42 as unknown as string, startTime: 0, endTime: 1, photoCount: 0 },
            { id: "valid", startTime: 2, endTime: 3, photoCount: 0 },
          ],
        },
      ]),
    /Invalid visit ID/,
  );
  assert.throws(() => buildVisitMergePlan([createGroup("r", ["same", "same"])]), /overlap/);
  assert.throws(() => buildVisitMergePlan([createGroup("r1", ["a", "b"]), createGroup("r2", ["c", "b"])]), /overlap/);
  assert.throws(() => buildVisitMergePlan([createGroup("r1", ["a", "b"]), createGroup("r2", ["b", "c"])]), /overlap/);
  scenarios += 5;
  return scenarios;
}

function runSemanticParityTest(): { scenarios: number; exact: boolean; digest: string } {
  const legacy = createVisitMergeDatabase();
  const candidate = createVisitMergeDatabase();
  try {
    const legacyGroups = seedSemanticFixture(legacy);
    const candidateGroups = seedSemanticFixture(candidate);
    const unrelatedBefore = legacy.prepare("SELECT * FROM visits WHERE id = 'unrelated'").get();

    const legacyCounts = executeLegacySequential(legacy, legacyGroups);
    const candidateCounts = executeCandidatePlan(candidate, candidateGroups);
    assert.equal(legacyCounts.mergeCount, 4);
    assert.equal(legacyCounts.executionCalls, 44);
    assert.equal(candidateCounts.mergeCount, 4);
    assert.equal(candidateCounts.executionCalls, 7);
    assert.equal(candidateCounts.transactionControlCalls, 2);

    const legacySnapshot = snapshotDatabase(legacy);
    const candidateSnapshot = snapshotDatabase(candidate);
    const parity = assertSnapshotsEquivalent(candidateSnapshot, legacySnapshot);

    const target = getVisit(candidate, "target-O'Brien-雪");
    assert.equal(target.startTime, 500);
    assert.equal(target.endTime, 3_500);
    assert.equal(target.photoCount, 6);
    assert.equal(target.foodProbable, 1);
    assert.equal(target.updatedAt, FIXED_UPDATED_AT);
    assert.ok(Math.abs(Number(target.centerLat) - 70 / 3) <= 1e-12);
    assert.ok(Math.abs(Number(target.centerLon) - 140 / 3) <= 1e-12);
    assert.equal(target.restaurantId, "restaurant-a");
    assert.equal(target.suggestedRestaurantId, "m-direct-target");
    assert.equal(target.calendarEventId, "target-calendar");
    assert.equal(target.calendarEventTitle, "Target dinner 🍣");
    assert.equal(target.calendarEventLocation, "Target location");
    assert.equal(target.calendarEventIsAllDay, 1);
    assert.equal(target.exportedToCalendarId, "target-export-calendar");
    assert.equal(target.notes, "target notes stay");
    assert.equal(target.awardAtVisit, "Two Stars");

    const secondTarget = getVisit(candidate, "target-two");
    assert.equal(secondTarget.centerLat, 12.5);
    assert.equal(secondTarget.centerLon, 45.5);
    assert.equal(secondTarget.photoCount, 3);
    assert.equal(secondTarget.foodProbable, 1);

    for (const sourceId of ["source-first", "source-second", "", "source-no-coordinates"]) {
      assert.equal(candidate.prepare("SELECT 1 FROM visits WHERE id = ?").get(sourceId), undefined);
      assert.equal(
        (candidate.prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId = ?").get(sourceId) as { count: number })
          .count,
        0,
      );
    }

    const suggestions = candidate
      .prepare(`SELECT restaurantId, distance FROM visit_suggested_restaurants
        WHERE visitId = ? ORDER BY restaurantId`)
      .all("target-O'Brien-雪")
      .map((row) => ({ ...row })) as Array<{ restaurantId: string; distance: number }>;
    assert.deepEqual(suggestions, [
      { restaurantId: "m-common", distance: 1.1 },
      { restaurantId: "m-empty-only", distance: 4.2 },
      { restaurantId: "m-first-only", distance: 2.3 },
      { restaurantId: "m-second-only", distance: 3.3 },
      { restaurantId: "m-shared", distance: 2.2 },
      { restaurantId: "m-target-only", distance: 1.2 },
    ]);

    const movedReservations = candidate
      .prepare(`SELECT sourceEventId, visitId, importedAt, marker
        FROM reservation_import_sources ORDER BY sourceEventId`)
      .all() as Array<{ sourceEventId: string; visitId: string; importedAt: number; marker: string }>;
    assert.equal(
      movedReservations.find(({ sourceEventId }) => sourceEventId === "reservation-first")?.visitId,
      "target-O'Brien-雪",
    );
    assert.equal(
      movedReservations.find(({ sourceEventId }) => sourceEventId === "reservation-empty")?.visitId,
      "target-O'Brien-雪",
    );
    assert.equal(
      movedReservations.find(({ sourceEventId }) => sourceEventId === "reservation-no-coordinates")?.visitId,
      "target-two",
    );
    assert.deepEqual(candidate.prepare("SELECT * FROM visits WHERE id = 'unrelated'").get(), unrelatedBefore);
    assertDatabaseHealth(legacy);
    assertDatabaseHealth(candidate);
    return { scenarios: 1, exact: parity.exact, digest: parity.digest };
  } finally {
    legacy.close();
    candidate.close();
  }
}

function runFoodOriginCases(): number {
  const cases = [
    { target: 0, source: 0, photo: 0, expected: 0 },
    { target: 1, source: 0, photo: 0, expected: 1 },
    { target: 0, source: 1, photo: 0, expected: 1 },
    { target: 0, source: 0, photo: 1, expected: 1 },
  ] as const;
  for (const [index, foodCase] of cases.entries()) {
    const legacy = createVisitMergeDatabase();
    const candidate = createVisitMergeDatabase();
    try {
      for (const database of [legacy, candidate]) {
        insertRestaurant(database, "food-r");
        insertVisit(database, {
          id: "target",
          restaurantId: "food-r",
          startTime: 0,
          endTime: 1,
          centerLat: 1,
          centerLon: 2,
          foodProbable: foodCase.target,
        });
        insertVisit(database, {
          id: "source",
          restaurantId: "food-r",
          startTime: 2,
          endTime: 3,
          centerLat: 3,
          centerLon: 4,
          foodProbable: foodCase.source,
        });
        insertPhoto(database, {
          id: `food-photo-${index}`,
          visitId: "source",
          latitude: null,
          longitude: null,
          foodDetected: foodCase.photo,
        });
      }
      const groups = [createGroup("food-r", ["target", "source"])];
      executeLegacySequential(legacy, groups);
      executeCandidatePlan(candidate, groups);
      assertSnapshotsEquivalent(snapshotDatabase(candidate), snapshotDatabase(legacy));
      assert.equal(getVisit(candidate, "target").foodProbable, foodCase.expected);
      assertDatabaseHealth(candidate);
    } finally {
      legacy.close();
      candidate.close();
    }
  }
  return cases.length;
}

function runNoOpTest(): number {
  const database = createVisitMergeDatabase();
  try {
    insertRestaurant(database, "noop-r");
    insertVisit(database, {
      id: "singleton",
      restaurantId: "noop-r",
      startTime: 0,
      endTime: 1,
      centerLat: 2,
      centerLon: 3,
    });
    const before = snapshotDatabase(database);
    const counts = executeCandidatePlan(database, [createGroup("noop-r", []), createGroup("noop-r", ["singleton"])]);
    assert.deepEqual(counts, {
      mergeCount: 0,
      executionCalls: 0,
      transactionControlCalls: 0,
      statementPreparations: 0,
    });
    assert.deepEqual(snapshotDatabase(database), before);
    assertDatabaseHealth(database);
    return 1;
  } finally {
    database.close();
  }
}

function runMissingVisitRollbackTest(): number {
  const database = createVisitMergeDatabase();
  try {
    insertRestaurant(database, "missing-r");
    insertVisit(database, {
      id: "target",
      restaurantId: "missing-r",
      startTime: 0,
      endTime: 1,
      centerLat: 1,
      centerLon: 1,
    });
    const before = snapshotDatabase(database);
    assert.throws(
      () => executeCandidatePlan(database, [createGroup("missing-r", ["target", "missing-source"])]),
      /not found/,
    );
    assert.deepEqual(snapshotDatabase(database), before);
    assertDatabaseHealth(database);
    return 1;
  } finally {
    database.close();
  }
}

function runInjectedFailureRollbackTests(): number {
  const triggers = [
    `CREATE TRIGGER injected_suggestion_failure
      BEFORE INSERT ON visit_suggested_restaurants
      WHEN NEW.visitId = 'target-O''Brien-雪' AND NEW.restaurantId = 'm-first-only'
      BEGIN SELECT RAISE(ABORT, 'injected suggestion failure'); END`,
    `CREATE TRIGGER injected_delete_failure
      BEFORE DELETE ON visits
      WHEN OLD.id = 'source-second'
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`,
  ];
  for (const [index, trigger] of triggers.entries()) {
    const database = createVisitMergeDatabase();
    try {
      const groups = seedSemanticFixture(database);
      const before = snapshotDatabase(database);
      database.exec(trigger);
      assert.throws(() => executeCandidatePlan(database, groups), /injected/);
      assert.deepEqual(snapshotDatabase(database), before, `failure ${index} was not atomic`);
      assertDatabaseHealth(database);
      database.exec(`DROP TRIGGER ${index === 0 ? "injected_suggestion_failure" : "injected_delete_failure"}`);
      executeCandidatePlan(database, groups);
      assertDatabaseHealth(database);
    } finally {
      database.close();
    }
  }
  return triggers.length;
}

function runMalformedPlanNoMutationTest(): number {
  const database = createVisitMergeDatabase();
  try {
    insertRestaurant(database, "r");
    for (const id of ["a", "b", "c"]) {
      insertVisit(database, { id, restaurantId: "r", startTime: 0, endTime: 1, centerLat: 0, centerLon: 0 });
    }
    const before = snapshotDatabase(database);
    assert.throws(
      () => executeCandidatePlan(database, [createGroup("r", ["a", "b"]), createGroup("r", ["c", "b"])]),
      /overlap/,
    );
    assert.deepEqual(snapshotDatabase(database), before);
    assertDatabaseHealth(database);
    return 1;
  } finally {
    database.close();
  }
}

async function runRetryPolicyTests(): Promise<number> {
  let scenarios = 0;
  const expectedAttemptOffsets = [0, 50, 150, 350, 750, 1_550, 2_550, 3_550, 4_550, 5_000];
  const expectedSleeps = [50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 450];
  const iosBusyError = new Error(
    "Call to function 'NativeStatement.runAsync' has been rejected: Error code 5: database is locked",
  );
  const androidBusyError = new Error(
    `Call to function 'NativeStatement.runAsync' has been rejected: Error code ${String.fromCharCode(5)}: database is locked`,
  );

  assert.equal(isVisitMergeDatabaseBusyError(iosBusyError), true);
  assert.equal(isVisitMergeDatabaseBusyError(androidBusyError), true);
  assert.equal(isVisitMergeDatabaseBusyError(new Error("SQLite error: SQLITE_BUSY")), true);
  assert.equal(isVisitMergeDatabaseBusyError(new Error("constraint failed")), false);
  assert.equal(isVisitMergeDatabaseBusyError("database is locked"), false);
  scenarios += 1;

  {
    const { clock, runtime } = createVirtualRetryRuntime();
    const attemptOffsets: number[] = [];
    const attemptTimestamps: number[] = [];
    const result = await runVisitMergeWithBusyRetry(async (updatedAt) => {
      attemptOffsets.push(clock.monotonicTimeMs);
      attemptTimestamps.push(updatedAt);
      if (clock.monotonicTimeMs < VISIT_MERGE_RETRY_POLICY.retryWindowMs) {
        throw iosBusyError;
      }
      return "merged";
    }, runtime);

    assert.equal(result, "merged");
    assert.deepEqual(attemptOffsets, expectedAttemptOffsets);
    assert.deepEqual(
      attemptTimestamps,
      expectedAttemptOffsets.map((offset) => FIXED_UPDATED_AT + offset),
    );
    assert.deepEqual(clock.requestedSleeps, expectedSleeps);
    scenarios += 1;
  }

  {
    const { clock, runtime } = createVirtualRetryRuntime();
    let attempts = 0;
    let finalBusyError: Error | null = null;
    await assert.rejects(
      runVisitMergeWithBusyRetry(async () => {
        attempts += 1;
        finalBusyError = new Error(`Error code 5: database is locked (attempt ${attempts})`);
        throw finalBusyError;
      }, runtime),
      (error: unknown) => error === finalBusyError,
    );
    assert.equal(attempts, expectedAttemptOffsets.length);
    assert.equal(clock.monotonicTimeMs, VISIT_MERGE_RETRY_POLICY.retryWindowMs);
    assert.deepEqual(clock.requestedSleeps, expectedSleeps);
    scenarios += 1;
  }

  {
    const { clock, runtime } = createVirtualRetryRuntime();
    const nonBusyError = new Error("constraint failed");
    let attempts = 0;
    await assert.rejects(
      runVisitMergeWithBusyRetry(async () => {
        attempts += 1;
        throw nonBusyError;
      }, runtime),
      (error: unknown) => error === nonBusyError,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(clock.requestedSleeps, []);
    scenarios += 1;
  }

  {
    const { clock, runtime } = createVirtualRetryRuntime({ sleepOvershootMs: 25 });
    let attempts = 0;
    await assert.rejects(
      runVisitMergeWithBusyRetry(async () => {
        attempts += 1;
        throw androidBusyError;
      }, runtime),
      (error: unknown) => error === androidBusyError,
    );
    assert.equal(attempts, 10);
    assert.equal(clock.monotonicTimeMs, VISIT_MERGE_RETRY_POLICY.retryWindowMs + 25);
    assert.deepEqual(clock.requestedSleeps, [50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 250]);
    scenarios += 1;
  }

  return scenarios;
}

async function runRealSQLiteContentionTests(): Promise<number> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-visit-merge-retry-"));
  const databasePath = join(temporaryDirectory, "contention.db");
  const locker = new DatabaseSync(databasePath, { timeout: 0 });
  const candidate = new DatabaseSync(databasePath, { timeout: 0 });
  let scenarios = 0;

  const resetFixture = () => {
    candidate.exec(`
      DELETE FROM visits;
      INSERT INTO visits (id, updatedAt, marker) VALUES
        ('target', NULL, 'target-original'),
        ('source', NULL, 'source-original');
    `);
  };
  const acquireWriterLock = () => {
    locker.exec("BEGIN IMMEDIATE");
    locker.prepare("UPDATE visits SET marker = 'source-uncommitted' WHERE id = 'source'").run();
  };
  const releaseWriterLock = () => {
    if (locker.isTransaction) {
      locker.exec("ROLLBACK");
    }
  };
  const executeMergeAttempt = async (updatedAt: number): Promise<number> => {
    try {
      candidate.exec("BEGIN");
      const preflight = candidate.prepare("SELECT COUNT(*) AS count FROM visits").get() as { count: number };
      assert.equal(preflight.count, 2);
      candidate.prepare("UPDATE visits SET updatedAt = ? WHERE id = 'target'").run(updatedAt);
      candidate.prepare("DELETE FROM visits WHERE id = 'source'").run();
      candidate.exec("COMMIT");
      return updatedAt;
    } catch (error) {
      if (candidate.isTransaction) {
        candidate.exec("ROLLBACK");
      }
      throw error;
    }
  };
  const readRows = () =>
    candidate
      .prepare("SELECT id, updatedAt, marker FROM visits ORDER BY id")
      .all()
      .map((row) => ({ ...row }));

  try {
    locker.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = OFF;
      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        updatedAt INTEGER,
        marker TEXT NOT NULL
      );
    `);
    candidate.exec("PRAGMA busy_timeout = 0");

    resetFixture();
    acquireWriterLock();
    let releasedBelowDeadline = false;
    const belowDeadline = createVirtualRetryRuntime({
      onSleep: (clock) => {
        if (clock.monotonicTimeMs >= 1_200 && locker.isTransaction) {
          releaseWriterLock();
          releasedBelowDeadline = true;
        }
      },
    });
    let belowDeadlineAttempts = 0;
    const successfulUpdatedAt = await runVisitMergeWithBusyRetry(async (updatedAt) => {
      belowDeadlineAttempts += 1;
      return executeMergeAttempt(updatedAt);
    }, belowDeadline.runtime);
    assert.equal(releasedBelowDeadline, true);
    assert.equal(belowDeadlineAttempts, 6);
    assert.deepEqual(belowDeadline.clock.requestedSleeps, [50, 100, 200, 400, 800]);
    assert.equal(successfulUpdatedAt, FIXED_UPDATED_AT + 1_550);
    assert.deepEqual(readRows(), [{ id: "target", updatedAt: successfulUpdatedAt, marker: "target-original" }]);
    assert.equal(candidate.isTransaction, false);
    scenarios += 1;

    resetFixture();
    const beforeExhaustion = readRows();
    acquireWriterLock();
    const exhausted = createVirtualRetryRuntime();
    let exhaustedAttempts = 0;
    await assert.rejects(
      runVisitMergeWithBusyRetry(async (updatedAt) => {
        exhaustedAttempts += 1;
        return executeMergeAttempt(updatedAt);
      }, exhausted.runtime),
      (error: unknown) => error instanceof Error && error.message.toLowerCase().includes("database is locked"),
    );
    assert.equal(exhaustedAttempts, 10);
    assert.deepEqual(readRows(), beforeExhaustion);
    assert.equal(candidate.isTransaction, false);
    assert.equal(locker.isTransaction, true);
    scenarios += 1;

    releaseWriterLock();
    const recovered = createVirtualRetryRuntime({ initialWallTimeMs: FIXED_UPDATED_AT + 10_000 });
    const recoveredUpdatedAt = await runVisitMergeWithBusyRetry(executeMergeAttempt, recovered.runtime);
    assert.equal(recoveredUpdatedAt, FIXED_UPDATED_AT + 10_000);
    assert.deepEqual(recovered.clock.requestedSleeps, []);
    assert.deepEqual(readRows(), [{ id: "target", updatedAt: recoveredUpdatedAt, marker: "target-original" }]);
    assert.deepEqual(
      candidate
        .prepare("PRAGMA quick_check")
        .all()
        .map((row) => ({ ...row })),
      [{ quick_check: "ok" }],
    );
    scenarios += 1;

    return scenarios;
  } finally {
    if (candidate.isTransaction) {
      candidate.exec("ROLLBACK");
    }
    releaseWriterLock();
    candidate.close();
    locker.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  let scenarios = runPlannerTests();
  const semantic = runSemanticParityTest();
  scenarios += semantic.scenarios;
  scenarios += runFoodOriginCases();
  scenarios += runNoOpTest();
  scenarios += runMissingVisitRollbackTest();
  scenarios += runInjectedFailureRollbackTests();
  scenarios += runMalformedPlanNoMutationTest();
  scenarios += await runRetryPolicyTests();
  scenarios += await runRealSQLiteContentionTests();

  console.log(
    `Visit merge tests passed: ${scenarios} scenarios; full-table parity digest ${semantic.digest}; ` +
      `centroids ${semantic.exact ? "bit-exact" : "within 1e-12 tolerance"}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
