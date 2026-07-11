#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { QueryClient } from "@tanstack/query-core";
import { reconcileCalendarImportCache } from "../utils/calendar-import-cache-policy.ts";
import {
  CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE,
  dedupeCalendarImportSnapshots,
  planCalendarImportFromSnapshots,
  type CalendarImportSnapshot,
  type CalendarImportSnapshotPlan,
} from "../utils/calendar-import-plan-core.ts";
import {
  executeCalendarImportTransaction,
  type CalendarImportTransactionBackend,
  type CalendarImportTransactionResult,
} from "../utils/db/calendar-import-transaction-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function restaurant(index: number, name: string = `Restaurant ${index}`): MichelinRestaurantRecord {
  return {
    id: `restaurant-${index}`,
    name,
    latitude: 30 + index / 100,
    longitude: -120 - index / 100,
    address: `${index} O'Brien Way`,
    location: index % 2 === 0 ? "東京" : "Montréal",
    cuisine: index % 2 === 0 ? "Sushi 🍣" : "Café",
    latestAwardYear: 2026,
    award: index % 2 === 0 ? "1 Star" : "Bib Gourmand",
  };
}

function snapshot(
  id: string,
  startDate: number,
  matches: readonly MichelinRestaurantRecord[],
  title: string = `Dinner at ${matches[0]!.name}`,
): CalendarImportSnapshot {
  return {
    calendarEventId: id,
    calendarEventTitle: title,
    calendarEventLocation: `Location for ${id}`,
    startDate,
    endDate: startDate + 90 * 60 * 1_000,
    matchedRestaurants: matches,
    matchedRestaurant: matches[0]!,
  };
}

/** Independent literal oracle for the removed service mapping. */
function oraclePlan(
  snapshots: readonly CalendarImportSnapshot[],
  now: number,
  overrides: ReadonlyMap<string, string> | undefined,
): CalendarImportSnapshotPlan {
  const firstSnapshotByEventId = new Map<string, CalendarImportSnapshot>();
  for (const event of snapshots) {
    if (!firstSnapshotByEventId.has(event.calendarEventId)) {
      firstSnapshotByEventId.set(event.calendarEventId, event);
    }
  }

  const visitsToCreate: CalendarImportSnapshotPlan["visitsToCreate"] = [];
  for (const event of firstSnapshotByEventId.values()) {
    if (event.startDate > now) {
      continue;
    }

    let selectedRestaurant = event.matchedRestaurant;
    if (overrides?.has(event.calendarEventId)) {
      const requestedRestaurantId = overrides.get(event.calendarEventId)!;
      const requestedRestaurant = event.matchedRestaurants.find((candidate) => candidate.id === requestedRestaurantId);
      if (!requestedRestaurant) {
        throw new RangeError("invalid independent-oracle override");
      }
      selectedRestaurant = requestedRestaurant;
    }

    visitsToCreate.push({
      id: `cal-${event.calendarEventId}-${Math.floor(event.startDate / 3_600_000)}`,
      calendarEventId: event.calendarEventId,
      calendarEventTitle: event.calendarEventTitle,
      calendarEventLocation: event.calendarEventLocation,
      startTime: event.startDate,
      endTime: event.endDate,
      matchedRestaurantIds: [...new Set(event.matchedRestaurants.map((match) => match.id))],
      matchedRestaurant: {
        id: selectedRestaurant.id,
        name: selectedRestaurant.name,
        latitude: selectedRestaurant.latitude,
        longitude: selectedRestaurant.longitude,
        address: selectedRestaurant.address,
        cuisine: selectedRestaurant.cuisine,
      },
    });
  }
  return { visitsToCreate };
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY);
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      cuisine TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL DEFAULT 0,
      foodProbable INTEGER NOT NULL DEFAULT 0,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      updatedAt INTEGER,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE INDEX idx_visits_calendar_event ON visits(calendarEventId);
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE dismissed_calendar_events (
      calendarEventId TEXT PRIMARY KEY,
      dismissedAt INTEGER NOT NULL
    );
  `);
}

function seedMichelinRestaurants(database: DatabaseSync, snapshots: readonly CalendarImportSnapshot[]): void {
  const ids = new Set(snapshots.flatMap((event) => event.matchedRestaurants.map((match) => match.id)));
  const statement = database.prepare("INSERT OR IGNORE INTO michelin_restaurants (id) VALUES (?)");
  for (const id of ids) {
    statement.run(id);
  }
}

function nodeBackend(
  database: DatabaseSync,
  beforeFirstWrite?: () => void,
  counters?: { availabilityReads: number },
): CalendarImportTransactionBackend {
  let interceptedWrite = false;
  const interceptWrite = (): void => {
    if (!interceptedWrite) {
      interceptedWrite = true;
      beforeFirstWrite?.();
    }
  };
  return {
    getAllAsync: async <Row>(sql: string, parameters: Array<string | number | null>) => {
      if (sql.startsWith("WITH requested")) {
        if (counters) {
          counters.availabilityReads += 1;
        }
      }
      if (sql.startsWith("INSERT")) {
        interceptWrite();
      }
      return database.prepare(sql).all(...parameters) as unknown as Row[];
    },
    runAsync: async (sql: string, parameters: Array<string | number | null>) => {
      interceptWrite();
      const result = database.prepare(sql).run(...parameters);
      return { changes: Number(result.changes) };
    },
  };
}

async function runTransaction(
  database: DatabaseSync,
  plan: CalendarImportSnapshotPlan,
  backend: CalendarImportTransactionBackend = nodeBackend(database),
): Promise<CalendarImportTransactionResult> {
  database.exec("BEGIN");
  try {
    const result = await executeCalendarImportTransaction(backend, plan, NOW);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertExistingVisit(
  database: DatabaseSync,
  input: { id: string; calendarEventId: string | null; startTime: number; status?: string },
): void {
  database
    .prepare(
      `INSERT INTO visits (
         id, status, startTime, endTime, centerLat, centerLon,
         photoCount, foodProbable, calendarEventId
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`,
    )
    .run(input.id, input.status ?? "pending", input.startTime, input.startTime + HOUR_MS, input.calendarEventId);
}

function testPlannerParityAndBoundaries(): void {
  const primary = restaurant(1, "L’Ami Jean");
  const override = restaurant(2, "鮨 さいとう");
  const third = restaurant(3, "Café O'Brien 🍣");
  const first = snapshot("event-'雪-1", NOW - 5 * HOUR_MS, [primary, override, primary]);
  const duplicate = snapshot("event-'雪-1", NOW - 4 * HOUR_MS, [third], "Must not replace first snapshot");
  const exactBoundary = snapshot("event-boundary", NOW, [primary, override]);
  const future = snapshot("event-future", NOW + 1, [third]);
  const snapshots = [first, duplicate, exactBoundary, future];
  const overrides = new Map([
    [exactBoundary.calendarEventId, override.id],
    [future.calendarEventId, "not-a-match"],
  ]);

  assert.deepEqual(
    planCalendarImportFromSnapshots(snapshots, { now: NOW, restaurantOverrides: overrides }),
    oraclePlan(snapshots, NOW, overrides),
  );
  assert.deepEqual(dedupeCalendarImportSnapshots(snapshots), [first, exactBoundary, future]);
  assert.deepEqual(planCalendarImportFromSnapshots([], { now: NOW }), { visitsToCreate: [] });
  assert.throws(() => planCalendarImportFromSnapshots([first], { now: Number.NaN }), /must be finite/);
  assert.throws(
    () =>
      planCalendarImportFromSnapshots([first], {
        now: NOW,
        restaurantOverrides: new Map([[first.calendarEventId, "not-a-match"]]),
      }),
    /is not a match for event/,
  );
}

async function testPartialAvailabilityAndActualInsertCount(): Promise<void> {
  const primary = restaurant(10);
  const events = [
    snapshot("linked", NOW - 5 * HOUR_MS, [primary]),
    snapshot("dismissed", NOW - 4 * HOUR_MS, [primary]),
    snapshot("id-collision", NOW - 3 * HOUR_MS, [primary]),
    snapshot("available", NOW - 2 * HOUR_MS, [primary], "Snapshot title must persist"),
  ];
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  seedMichelinRestaurants(database, events);
  insertExistingVisit(database, { id: "already-linked", calendarEventId: "linked", startTime: NOW - 10 * DAY_MS });
  database.prepare("INSERT INTO dismissed_calendar_events VALUES (?, ?)").run("dismissed", NOW);
  const plan = planCalendarImportFromSnapshots(events, { now: NOW });
  const collisionPlan = plan.visitsToCreate.find((visit) => visit.calendarEventId === "id-collision")!;
  insertExistingVisit(database, {
    id: collisionPlan.id,
    calendarEventId: "different-event",
    startTime: NOW - 20 * DAY_MS,
  });

  const result = await runTransaction(database, plan);
  assert.deepEqual(result.insertedCalendarEventIds, ["available"]);
  assert.deepEqual(result.unavailableCalendarEventIds, ["linked", "dismissed"]);
  assert.deepEqual(result.insertConflictCalendarEventIds, ["id-collision"]);
  assert.equal(result.insertedCount, 1, "INSERT OR IGNORE conflicts must not be reported as inserted");
  const availableSnapshot = events.at(-1)!;
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT
             calendarEventId,
             calendarEventTitle,
             calendarEventLocation,
             startTime,
             endTime,
             centerLat,
             centerLon
           FROM visits
           WHERE calendarEventId = 'available'`,
        )
        .get(),
    },
    {
      calendarEventId: "available",
      calendarEventTitle: "Snapshot title must persist",
      calendarEventLocation: availableSnapshot.calendarEventLocation,
      startTime: availableSnapshot.startDate,
      endTime: availableSnapshot.endDate,
      centerLat: primary.latitude,
      centerLon: primary.longitude,
    },
  );
  assert.deepEqual(
    database
      .prepare("SELECT visitId, restaurantId, distance FROM visit_suggested_restaurants")
      .all()
      .map((row) => ({ ...row })),
    [{ visitId: plan.visitsToCreate.at(-1)!.id, restaurantId: primary.id, distance: 0 }],
  );
  database.close();
}

async function testNearbyConfirmedAcrossAnyOriginalMatch(): Promise<void> {
  const selected = restaurant(20, "Shared Name");
  const alternate = restaurant(21, "Shared Name");
  const suppressed = snapshot("suppressed", NOW, [selected, alternate]);
  const farEnough = snapshot("far-enough", NOW + 2 * DAY_MS + 1, [selected, alternate]);
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  seedMichelinRestaurants(database, [suppressed, farEnough]);
  insertExistingVisit(database, {
    id: "confirmed",
    calendarEventId: null,
    startTime: NOW + DAY_MS,
    status: "confirmed",
  });
  database.prepare("INSERT INTO visit_suggested_restaurants VALUES (?, ?, 0)").run("confirmed", alternate.id);

  const plan = planCalendarImportFromSnapshots([suppressed, farEnough], { now: NOW + 3 * DAY_MS });
  const result = await runTransaction(database, plan);
  assert.deepEqual(result.nearbyConfirmedCalendarEventIds, ["suppressed"]);
  assert.deepEqual(result.insertedCalendarEventIds, ["far-enough"]);
  assert.equal(result.insertedCount, 1);
  database.close();
}

async function testMultipleAvailabilityBatches(): Promise<void> {
  const primary = restaurant(30);
  const eventCount = CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE + 2;
  const events = Array.from({ length: eventCount }, (_, index) =>
    snapshot(`batch-${index}`, NOW - index * HOUR_MS, [primary]),
  );
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  seedMichelinRestaurants(database, events);
  insertExistingVisit(database, {
    id: "batch-linked",
    calendarEventId: `batch-${CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE}`,
    startTime: NOW - 100 * DAY_MS,
  });
  database
    .prepare("INSERT INTO dismissed_calendar_events VALUES (?, ?)")
    .run(`batch-${CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE + 1}`, NOW);
  const counters = { availabilityReads: 0 };
  const result = await runTransaction(
    database,
    planCalendarImportFromSnapshots(events, { now: NOW }),
    nodeBackend(database, undefined, counters),
  );
  assert.equal(counters.availabilityReads, 2);
  assert.equal(result.insertedCount, CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM visit_suggested_restaurants").get()!.count, 1_000);
  database.close();
}

async function testWriteFailureRollsBackEverything(): Promise<void> {
  const primary = restaurant(40);
  const event = snapshot("rollback", NOW - HOUR_MS, [primary]);
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  seedMichelinRestaurants(database, [event]);
  database.exec(`
    CREATE TRIGGER fail_calendar_suggestion
    BEFORE INSERT ON visit_suggested_restaurants
    BEGIN
      SELECT RAISE(ABORT, 'forced suggestion failure');
    END;
  `);
  await assert.rejects(
    () => runTransaction(database, planCalendarImportFromSnapshots([event], { now: NOW })),
    /forced suggestion failure/,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM visits").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM restaurants").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM visit_suggested_restaurants").get()!.count, 0);
  database.close();
}

async function testDeferredTransactionInterleavingFailsClosed(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "palate-calendar-import-"));
  const path = join(directory, "interleaving.db");
  const readerWriter = new DatabaseSync(path);
  readerWriter.exec("PRAGMA journal_mode = WAL;");
  initializeDatabase(readerWriter);
  const concurrentWriter = new DatabaseSync(path);
  concurrentWriter.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
  const primary = restaurant(50);
  const event = snapshot("interleaved-dismissal", NOW - HOUR_MS, [primary]);
  seedMichelinRestaurants(readerWriter, [event]);
  const plan = planCalendarImportFromSnapshots([event], { now: NOW });

  const backend = nodeBackend(readerWriter, () => {
    concurrentWriter.exec("BEGIN IMMEDIATE;");
    concurrentWriter.prepare("INSERT INTO dismissed_calendar_events VALUES (?, ?)").run(event.calendarEventId, NOW);
    concurrentWriter.exec("COMMIT;");
  });
  await assert.rejects(
    () => runTransaction(readerWriter, plan, backend),
    /locked|busy/i,
    "a writer interleaving after the read snapshot must prevent a stale transaction from committing",
  );
  assert.equal(readerWriter.prepare("SELECT COUNT(*) AS count FROM visits").get()!.count, 0);
  const retry = await runTransaction(readerWriter, plan);
  assert.equal(retry.insertedCount, 0);
  assert.deepEqual(retry.unavailableCalendarEventIds, [event.calendarEventId]);

  concurrentWriter.close();
  readerWriter.close();
  rmSync(directory, { recursive: true, force: true });
}

function testQueryCachePartialOutcomePolicy(): void {
  const queryClient = new QueryClient();
  const queryKey = ["importableCalendarEvents"] as const;
  const before = [
    { calendarEventId: "a", version: 1 },
    { calendarEventId: "b", version: 1 },
    { calendarEventId: "c", version: 1 },
  ];
  queryClient.setQueryData(queryKey, before);
  queryClient.setQueryData<typeof before>(queryKey, (current) =>
    current?.filter((event) => event.calendarEventId === "c"),
  );
  queryClient.setQueryData<typeof before>(queryKey, (current) =>
    reconcileCalendarImportCache(current, before, ["a", "b"], ["a"]),
  );
  assert.deepEqual(queryClient.getQueryData(queryKey), [before[1], before[2]]);
  assert.deepEqual(reconcileCalendarImportCache([], before, ["a", "b"], []), [before[0], before[1]]);
  assert.deepEqual(reconcileCalendarImportCache(before, undefined, ["a"], ["a"]), [before[1], before[2]]);

  const concurrentlyChanged = [
    { calendarEventId: "c", version: 2 },
    { calendarEventId: "d", version: 1 },
  ];
  assert.deepEqual(reconcileCalendarImportCache(concurrentlyChanged, before, ["a", "b"], ["a"]), [
    before[1],
    concurrentlyChanged[0],
    concurrentlyChanged[1],
  ]);
}

function testProductionWiring(): void {
  const serviceSource = readFileSync(new URL("../services/visit.ts", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
  const screenSource = readFileSync(new URL("../app/(app)/calendar-import.tsx", import.meta.url), "utf8");
  const databaseSource = readFileSync(new URL("../utils/db/calendar.ts", import.meta.url), "utf8");
  const expoSource = readFileSync(
    new URL("../node_modules/expo-sqlite/src/SQLiteDatabase.ts", import.meta.url),
    "utf8",
  );

  const importFunction = serviceSource.slice(
    serviceSource.indexOf("export async function importCalendarEvents("),
    serviceSource.indexOf("export { dismissCalendarEvents }"),
  );
  assert.match(importFunction, /planCalendarImportFromSnapshots\(events/);
  assert.match(importFunction, /importCalendarSnapshotPlan\(plannedImport, now\)/);
  assert.doesNotMatch(importFunction, /getImportableCalendarEvents\(/);
  assert.match(databaseSource, /withExclusiveTransactionAsync\(async \(transaction\)/);
  assert.match(databaseSource, /transaction\.getAllAsync/);
  assert.match(databaseSource, /transaction\.runAsync/);
  assert.match(expoSource, /await transaction\.execAsync\('BEGIN'\)/);
  assert.match(expoSource, /await transaction\.execAsync\('ROLLBACK'\)/);
  assert.match(hookSource, /reconcileCalendarImportCache/);
  assert.match(hookSource, /result\.insertedCalendarEventIds/);
  const mutationSource = hookSource.slice(
    hookSource.indexOf("export function useImportCalendarEvents()"),
    hookSource.indexOf("export function useDismissCalendarEvents()"),
  );
  assert.doesNotMatch(mutationSource, /optimisticallyUpdateStats/);
  assert.match(screenSource, /result\.insertedCount/);
  assert.doesNotMatch(screenSource, /logCalendarImported\(1\)/);
}

async function main(): Promise<void> {
  testPlannerParityAndBoundaries();
  await testPartialAvailabilityAndActualInsertCount();
  await testNearbyConfirmedAcrossAnyOriginalMatch();
  await testMultipleAvailabilityBatches();
  await testWriteFailureRollsBackEverything();
  await testDeferredTransactionInterleavingFailsClosed();
  testQueryCachePartialOutcomePolicy();
  testProductionWiring();
  console.log(
    "Calendar import snapshot tests passed: independent planner oracle, atomic partial availability, exact INSERT OR IGNORE counts, any-match nearby suppression, multi-batch reads, rollback, deferred-transaction interleaving, and cache reconciliation.",
  );
}

await main();
