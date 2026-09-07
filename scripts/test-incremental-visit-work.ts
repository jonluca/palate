#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementResultingChanges } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as associationCore from "../utils/db/photo-association-core.ts";
import * as cacheCore from "../utils/db/calendar-enrichment-cache-core.ts";
import * as countCore from "../utils/db/visit-photo-count-core.ts";
import * as automaticQueueCore from "../utils/db/automatic-photo-deep-scan-queue-core.ts";
import * as retryCore from "../utils/db/transaction-retry-core.ts";
import {
  buildCalendarEnrichmentVisitSnapshot,
  type CalendarEnrichmentSnapshotRow,
  type CalendarEnrichmentVisitSnapshot,
} from "../utils/db/calendar-enrichment-snapshot-core.ts";

const database = new DatabaseSync(":memory:");
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE visits (
    id TEXT PRIMARY KEY, startTime INTEGER NOT NULL, endTime INTEGER NOT NULL,
    calendarEventId TEXT, photoCount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT
  );
  CREATE TABLE photos (id TEXT PRIMARY KEY, visitId TEXT REFERENCES visits(id));
  CREATE INDEX idx_photos_visit ON photos(visitId);
  CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE visit_suggested_restaurants (visitId TEXT, restaurantId TEXT, distance REAL);
  ${cacheCore.CREATE_CALENDAR_ENRICHMENT_CACHE_SQL}
  INSERT INTO visits VALUES ('old', 100, 200, NULL, 99, 'confirmed', 'Keep my notes');
  INSERT INTO visits VALUES ('new', 300, 400, NULL, 0, 'pending', NULL);
  INSERT INTO visits VALUES ('untouched', 500, 600, NULL, 0, 'rejected', 'Keep rejection');
  INSERT INTO photos VALUES ('photo-a', 'old'), ('photo-b', NULL);
`);

type Parameters = Array<SQLInputValue | SQLInputValue[]>;
interface DatabaseAdapter {
  getFirstAsync<T>(sql: string, ...parameters: Parameters): Promise<T | null>;
  getAllAsync<T>(sql: string, ...parameters: Parameters): Promise<T[]>;
  runAsync(sql: string, ...parameters: Parameters): Promise<StatementResultingChanges>;
  execAsync(sql: string): Promise<void>;
  withExclusiveTransactionAsync(callback: (transaction: DatabaseAdapter) => Promise<void>): Promise<void>;
}
const adapter: DatabaseAdapter = {
  async getFirstAsync<T>(sql: string, ...parameters: Parameters): Promise<T | null> {
    // SAFETY: The production SQL and controlled fixture own each named row contract.
    return (database.prepare(sql).get(...parameters.flat()) as T | undefined) ?? null;
  },
  async getAllAsync<T>(sql: string, ...parameters: Parameters): Promise<T[]> {
    // SAFETY: The production SQL and controlled fixture own each named row contract.
    return database.prepare(sql).all(...parameters.flat()) as T[];
  },
  async runAsync(sql: string, ...parameters: Parameters) {
    return database.prepare(sql).run(...parameters.flat());
  },
  async execAsync(sql: string) {
    database.exec(sql);
  },
  async withExclusiveTransactionAsync(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      await callback(adapter);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
};

const now = 1_800_000_000_000;
function snapshot(context: string | null = "revision-1", at = now): CalendarEnrichmentVisitSnapshot[] {
  const query = cacheCore.buildIncrementalCalendarEnrichmentQuery(context, at);
  // SAFETY: This is the production projection against the schema above.
  const rows = database.prepare(query.sql).all(...query.parameters) as Array<
    CalendarEnrichmentSnapshotRow & Record<string, SQLOutputValue>
  >;
  return buildCalendarEnrichmentVisitSnapshot(rows);
}
function recordAttempts(visits = snapshot(null), context = "revision-1", at = now): void {
  database.prepare(cacheCore.RECORD_CALENDAR_ENRICHMENT_ATTEMPTS_SQL).run(JSON.stringify(visits), context, at);
}
interface PhotoCountRow {
  photoCount: number;
}
function photoCount(id: string): number {
  // SAFETY: The fixture owns this non-null integer projection.
  const row = database.prepare("SELECT photoCount FROM visits WHERE id = ?").get(id) as PhotoCountRow | undefined;
  assert.ok(row);
  return row.photoCount;
}

// Repair pre-upgrade interruption atomically; a failed migration cannot stamp success.
database.exec(`CREATE TRIGGER fail_migration BEFORE INSERT ON app_metadata
  BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END;`);
await assert.rejects(countCore.repairLegacyVisitPhotoCounts(adapter), /migration interrupted/);
assert.equal(photoCount("old"), 99);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_metadata").get()?.count, 0);
database.exec("DROP TRIGGER fail_migration");
await countCore.repairLegacyVisitPhotoCounts(adapter);
assert.equal(photoCount("old"), 1);
const totalChanges = database.prepare("SELECT total_changes() AS count").get()?.count;
await countCore.repairLegacyVisitPhotoCounts(adapter);
assert.equal(database.prepare("SELECT total_changes() AS count").get()?.count, totalChanges);

// Successful negative matches remain cached across warm updates, while changes retry.
assert.equal(snapshot().length, 3);
recordAttempts();
assert.equal(snapshot().length, 0);
assert.equal(snapshot(null).length, 3, "manual matching remains a full pass");
assert.equal(snapshot("revision-2").length, 3, "new launch/EventKit/permission/selection context retries negatives");
assert.equal(snapshot("revision-1", now + cacheCore.CALENDAR_ENRICHMENT_CACHE_MAX_AGE_MS + 1).length, 3);
assert.equal(snapshot("revision-1", now - 1).length, 3, "clock rollback must not retain future checkpoints");
database.exec("UPDATE visits SET endTime = 601 WHERE id = 'untouched'");
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["untouched"],
);
database.exec("UPDATE visits SET endTime = 600 WHERE id = 'untouched'");
const beforeSuggestionChange = snapshot(null);
database.exec(`INSERT INTO michelin_restaurants VALUES ('restaurant', 'Dinner');
  INSERT INTO visit_suggested_restaurants VALUES ('untouched', 'restaurant', 10);`);
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["untouched"],
);
recordAttempts(beforeSuggestionChange);
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["untouched"],
  "a stale async snapshot must not overwrite suggestion invalidation",
);
recordAttempts();
assert.equal(snapshot().length, 0);
database.exec("UPDATE visit_suggested_restaurants SET distance = 20 WHERE visitId = 'untouched'");
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["untouched"],
);
recordAttempts();
database.exec("DELETE FROM visit_suggested_restaurants WHERE visitId = 'untouched'");
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["untouched"],
);
recordAttempts();

// Exercise the production association transaction, including source visits and crash recovery.
interface AssociationExports {
  batchUpdatePhotoVisits?: (updates: Array<{ photoIds: string[]; visitId: string }>) => Promise<void>;
}
const associationExports: AssociationExports = {};
const associationSource = readFileSync(new URL("../utils/db/photo-association.ts", import.meta.url), "utf8");
const associationDependencies = new Map<string, object>([
  ["./core", { getDatabase: async () => adapter }],
  ["./photo-association-core", associationCore],
  ["./calendar-enrichment-cache-core", cacheCore],
  ["./visit-photo-count-core", countCore],
  ["./automatic-photo-deep-scan-queue-core", automaticQueueCore],
  ["./transaction-retry-core", retryCore],
]);
runInNewContext(
  ts.transpileModule(associationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: associationExports, require: (name: string) => associationDependencies.get(name) ?? {} },
);
assert.ok(associationExports.batchUpdatePhotoVisits);
database.exec(`CREATE TRIGGER fail_count_refresh BEFORE UPDATE OF photoCount ON visits
  WHEN NEW.id = 'new' BEGIN SELECT RAISE(ABORT, 'summary interrupted'); END;`);
const updates = [{ photoIds: ["photo-a", "photo-b"], visitId: "new" }];
await assert.rejects(associationExports.batchUpdatePhotoVisits(updates), /summary interrupted/);
assert.equal(database.prepare("SELECT visitId FROM photos WHERE id = 'photo-a'").get()?.visitId, "old");
assert.equal(database.prepare("SELECT visitId FROM photos WHERE id = 'photo-b'").get()?.visitId, null);
assert.equal(photoCount("old"), 1);
assert.equal(snapshot().length, 0, "failed assignments must retain committed calendar checkpoints");
assert.equal(database.prepare(automaticQueueCore.IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).get()?.isPending, 0);
database.exec("DROP TRIGGER fail_count_refresh");
await associationExports.batchUpdatePhotoVisits(updates);
assert.equal(photoCount("old"), 0);
assert.equal(photoCount("new"), 2);
assert.deepEqual(
  snapshot().map(({ id }) => id),
  ["new", "old"],
);
assert.equal(database.prepare(automaticQueueCore.IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).get()?.isPending, 1);
assert.deepEqual(
  { ...database.prepare("SELECT status, notes FROM visits WHERE id = 'old'").get() },
  {
    status: "confirmed",
    notes: "Keep my notes",
  },
);
assert.deepEqual(
  { ...database.prepare("SELECT status, notes FROM visits WHERE id = 'untouched'").get() },
  {
    status: "rejected",
    notes: "Keep rejection",
  },
);

// Run actual calendar orchestration to ensure successful negatives checkpoint and failed writes retry.
let nativeCalls = 0;
let failCalendarWrite = false;
let matchNextVisit = false;
let activeRevision = "revision-1";
const receivedVisitIds: string[][] = [];
interface ServiceExports {
  enrichVisitsWithCalendarEvents?: (options: { incremental: boolean }) => Promise<{ totalVisits: number }>;
}
const serviceExports: ServiceExports = {};
const serviceDependencies = new Map<string, object>([
  [
    "@/utils/db",
    {
      getCalendarEnrichmentVisitSnapshot: async (context: string | null) => snapshot(context, Date.now()),
      recordCalendarEnrichmentAttempts: async (visits: CalendarEnrichmentVisitSnapshot[], context: string) =>
        recordAttempts(visits, context, Date.now()),
      batchUpdateVisitsCalendarEvents: async () => {
        if (failCalendarWrite) {
          throw new Error("calendar persistence interrupted");
        }
      },
      batchUpdateVisitSuggestedRestaurants: async () => undefined,
    },
  ],
  ["./michelin", { getMichelinDatasetVersion: () => "guide-1" }],
  [
    "./calendar",
    {
      hasCalendarPermission: async () => true,
      getCalendarMatchingSelection: () => null,
      getCalendarEnrichmentContext: async () => activeRevision,
      isNativeCalendarMatchingAvailable: () => true,
      matchCalendarEventsForVisitsNatively: async (visits: CalendarEnrichmentVisitSnapshot[]) => {
        nativeCalls++;
        receivedVisitIds.push(visits.map(({ id }) => id));
        return matchNextVisit
          ? [{ visitId: visits[0]!.id, id: "event", title: "Dinner", location: null, isAllDay: false }]
          : [];
      },
    },
  ],
  ["@/modules/batch-asset-info", { getVisionResultPageSize: () => 24 }],
]);
const serviceSource = readFileSync(new URL("../services/visit.ts", import.meta.url), "utf8");
runInNewContext(
  ts.transpileModule(`${serviceSource}\nexports.enrichVisitsWithCalendarEvents = enrichVisitsWithCalendarEvents;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: serviceExports, require: (name: string) => serviceDependencies.get(name) ?? {}, __DEV__: false, console },
);
assert.ok(serviceExports.enrichVisitsWithCalendarEvents);
const enrich = serviceExports.enrichVisitsWithCalendarEvents;
assert.equal((await enrich({ incremental: true })).totalVisits, 3);
assert.equal(nativeCalls, 1);
assert.equal((await enrich({ incremental: true })).totalVisits, 0);
assert.equal(nativeCalls, 1, "a warm quick scan must not retry old negative matches");
database.exec("INSERT INTO visits (id, startTime, endTime) VALUES ('later', 700, 800)");
assert.equal((await enrich({ incremental: true })).totalVisits, 1);
assert.deepEqual(receivedVisitIds.at(-1), ["later"]);
activeRevision = "revision-2";
failCalendarWrite = true;
matchNextVisit = true;
await assert.rejects(enrich({ incremental: true }), /calendar persistence interrupted/);
failCalendarWrite = false;
matchNextVisit = false;
assert.equal(
  (await enrich({ incremental: true })).totalVisits,
  4,
  "failed persistence must leave every attempt retryable",
);
assert.equal((await enrich({ incremental: true })).totalVisits, 0);
assert.equal((await enrich({ incremental: false })).totalVisits, 4);

// Permission changes, selection changes, and backend failures cannot cache a false negative.
let permissionGranted = true;
let selectedCalendarIds: string[] | null = ["second", "first"];
let eventRevision = "event-revision-1";
let calendarReadFails = false;
interface CalendarServiceExports {
  getCalendarEnrichmentContext?: () => Promise<string | null>;
  batchFindCandidateEventsForVisits?: (
    visits: Array<{ id: string; startTime: number; endTime: number }>,
    buffer: number,
    throwOnError: boolean,
  ) => Promise<Map<string, unknown[]>>;
}
const calendarExports: CalendarServiceExports = {};
const calendarDependencies = new Map<string, object>([
  [
    "expo-calendar/legacy",
    {
      EntityTypes: { EVENT: "event" },
      getCalendarPermissionsAsync: async () => ({ status: permissionGranted ? "granted" : "denied" }),
      getCalendarsAsync: async () => {
        if (calendarReadFails) {
          throw new Error("calendar store unavailable");
        }
        return [];
      },
    },
  ],
  ["@/store", { getSelectedCalendarIds: () => selectedCalendarIds }],
  [
    "@/modules/calendar-matching",
    {
      getCalendarRevision: async () => eventRevision,
      isCalendarMatchingAvailable: () => false,
    },
  ],
]);
runInNewContext(
  ts.transpileModule(readFileSync(new URL("../services/calendar.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: calendarExports,
    require: (name: string) => calendarDependencies.get(name) ?? {},
    console: { warn: () => undefined },
  },
);
assert.ok(calendarExports.getCalendarEnrichmentContext);
assert.ok(calendarExports.batchFindCandidateEventsForVisits);
const firstContext = await calendarExports.getCalendarEnrichmentContext();
selectedCalendarIds = ["first", "second"];
assert.equal(await calendarExports.getCalendarEnrichmentContext(), firstContext);
selectedCalendarIds = ["first"];
assert.notEqual(await calendarExports.getCalendarEnrichmentContext(), firstContext);
selectedCalendarIds = ["first", "second"];
permissionGranted = false;
assert.equal(await calendarExports.getCalendarEnrichmentContext(), null);
permissionGranted = true;
const regrantedContext = await calendarExports.getCalendarEnrichmentContext();
assert.notEqual(regrantedContext, firstContext);
eventRevision = "event-revision-2";
assert.notEqual(await calendarExports.getCalendarEnrichmentContext(), regrantedContext);
calendarReadFails = true;
await assert.rejects(
  calendarExports.batchFindCandidateEventsForVisits([{ id: "visit", startTime: now, endTime: now }], 30, true),
  /calendar store unavailable/,
);

// Automatic maintenance skips no-op updates and limits changed-data work to once a day.
interface MaintenanceExports {
  useTestDatabase?: (testDatabase: DatabaseAdapter) => void;
  performIncrementalDatabaseMaintenance?: (changedPhotos: number, now: number) => Promise<void>;
}
const maintenanceExports: MaintenanceExports = {};
const maintenanceStatements: string[] = [];
const maintenanceWarnings: Error[] = [];
let maintenanceFailure: "read" | "optimize" | "stamp" | null = null;
const maintenanceDatabase: DatabaseAdapter = {
  ...adapter,
  async getFirstAsync<T>(sql: string, ...parameters: Parameters): Promise<T | null> {
    if (maintenanceFailure === "read") {
      throw new Error("maintenance checkpoint read failed");
    }
    return adapter.getFirstAsync<T>(sql, ...parameters);
  },
  async runAsync(sql: string, ...parameters: Parameters) {
    if (maintenanceFailure === "stamp") {
      throw new Error("maintenance checkpoint write failed");
    }
    return adapter.runAsync(sql, ...parameters);
  },
  execAsync: async (sql) => {
    maintenanceStatements.push(sql);
    if (maintenanceFailure === "optimize") {
      throw new Error("database is locked during maintenance");
    }
    database.exec(sql);
  },
};
runInNewContext(
  ts.transpileModule(
    `${readFileSync(new URL("../utils/db/core.ts", import.meta.url), "utf8")}\nexports.useTestDatabase = (value) => { db = value; };`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText,
  {
    exports: maintenanceExports,
    require: () => ({}),
    __DEV__: false,
    console: { warn: (_message: string, error: Error) => maintenanceWarnings.push(error) },
  },
);
assert.ok(maintenanceExports.useTestDatabase);
assert.ok(maintenanceExports.performIncrementalDatabaseMaintenance);
maintenanceExports.useTestDatabase(maintenanceDatabase);
await maintenanceExports.performIncrementalDatabaseMaintenance(0, now);
assert.equal(maintenanceStatements.length, 0);
await maintenanceExports.performIncrementalDatabaseMaintenance(1, now);
assert.equal(maintenanceStatements.length, 1);
assert.match(maintenanceStatements[0]!, /PRAGMA optimize/);
assert.doesNotMatch(maintenanceStatements[0]!, /ANALYZE/);
await maintenanceExports.performIncrementalDatabaseMaintenance(1, now + 1000);
assert.equal(maintenanceStatements.length, 1);
await maintenanceExports.performIncrementalDatabaseMaintenance(0, now + 25 * 60 * 60 * 1000);
assert.equal(maintenanceStatements.length, 1);
await maintenanceExports.performIncrementalDatabaseMaintenance(1, now + 25 * 60 * 60 * 1000);
assert.equal(maintenanceStatements.length, 2);

// The final optional optimization cannot reject already persisted photo work.
// Its failure also must not mark the daily checkpoint, so the next update retries.
const maintenanceCheckpointSql = "SELECT value FROM app_metadata WHERE key = 'incremental_database_maintenance_at'";
for (const failure of ["read", "optimize", "stamp"] as const) {
  database.exec("DELETE FROM app_metadata WHERE key = 'incremental_database_maintenance_at'");
  maintenanceFailure = failure;
  await maintenanceExports.performIncrementalDatabaseMaintenance(1, now);
  assert.equal(database.prepare(maintenanceCheckpointSql).get(), undefined, `${failure}: failure must not checkpoint`);
  maintenanceFailure = null;
  await maintenanceExports.performIncrementalDatabaseMaintenance(1, now);
  assert.equal(database.prepare(maintenanceCheckpointSql).get()?.value, String(now), `${failure}: later work retries`);
}
assert.equal(maintenanceWarnings.length, 3);

interface ProcessPhotosExports {
  processPhotos?: (
    onProgress: undefined,
    options: { incrementalVisitWork: boolean; runVisitFoodDetection: boolean },
  ) => Promise<{ visitsCreated: number; photosProcessed: number }>;
}
const processExports: ProcessPhotosExports = {};
const processStart = serviceSource.indexOf("let processPhotosPromise:");
assert.ok(processStart >= 0);
runInNewContext(
  ts.transpileModule(serviceSource.slice(processStart), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: processExports,
    scanCameraRoll: async () => ({ newPhotosAdded: 2 }),
    visitPhotos: async () => ({ visitsCreated: 1 }),
    enrichVisitsWithCalendarEvents: async () => ({ visitsWithEvents: 0 }),
    yieldToEventLoop: async () => undefined,
    performIncrementalDatabaseMaintenance: maintenanceExports.performIncrementalDatabaseMaintenance,
    clearAutomaticPhotoQuickPipelineIncomplete: async () =>
      database.prepare(automaticQueueCore.CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run(),
  },
);
assert.ok(processExports.processPhotos);
database.exec("DELETE FROM app_metadata WHERE key = 'incremental_database_maintenance_at'");
database.prepare(automaticQueueCore.MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run();
maintenanceFailure = "optimize";
const completedScan = await processExports.processPhotos(undefined, {
  incrementalVisitWork: true,
  runVisitFoodDetection: false,
});
assert.equal(completedScan.photosProcessed, 2);
assert.equal(completedScan.visitsCreated, 1);
assert.equal(
  database.prepare(automaticQueueCore.IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).get()?.isPending,
  0,
  "completed photo work must clear its recovery marker despite optional maintenance failure",
);
assert.equal(database.prepare(maintenanceCheckpointSql).get(), undefined);

database.close();
console.log(
  "Incremental visit work passed: negative-cache invalidation, scoped assignments and counts, atomic rollback, legacy repair, preserved user fields, and interrupted-calendar recovery.",
);
