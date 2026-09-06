import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as records from "../utils/db/visit-record-core.ts";
import * as details from "../utils/db/visit-details-core.ts";
import * as paging from "../utils/db/visit-list-paging-core.ts";
import * as statuses from "../utils/db/visit-status-batch-core.ts";
import * as sampling from "../utils/db/visit-photo-sampling-core.ts";
import * as merge from "../utils/db/visit-merge-core.ts";
import * as mergeRetry from "../utils/db/transaction-retry-core.ts";
import * as json from "../utils/runtime-json.ts";
import { buildExportVisits } from "../utils/export-core.ts";
import type { VisitRecord } from "../utils/db/types.ts";
import type { VisitListFilter } from "../utils/visit-status.ts";

interface VisitReadApi {
  getVisits(filter?: VisitListFilter): Promise<VisitRecord[]>;
  getVisitById(id: string): Promise<VisitRecord | null>;
  getVisitsWithDetails(filter?: VisitListFilter): Promise<VisitRecord[]>;
  getRestaurantVisitsWithPreviews(id: string): Promise<VisitRecord[]>;
  getMergeableVisits(id: string, startTime: number): Promise<VisitRecord[]>;
}

const database = new DatabaseSync(":memory:");
database.exec(`
  CREATE TABLE visits (
    id TEXT PRIMARY KEY, restaurantId TEXT, suggestedRestaurantId TEXT, status TEXT,
    startTime INTEGER, endTime INTEGER, centerLat REAL, centerLon REAL,
    photoCount INTEGER, foodProbable INTEGER, calendarEventId TEXT, calendarEventTitle TEXT,
    calendarEventLocation TEXT, calendarEventIsAllDay INTEGER, exportedToCalendarId TEXT,
    notes TEXT, updatedAt INTEGER, awardAtVisit TEXT
  );
  CREATE TABLE photos (
    id TEXT PRIMARY KEY, visitId TEXT, uri TEXT, creationTime INTEGER,
    foodDetected INTEGER, mediaType TEXT, duration REAL
  );
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT, award TEXT);
  INSERT INTO restaurants VALUES ('restaurant', 'Test Restaurant');
`);

const fixture: records.VisitQueryRow = {
  id: "visit-0",
  restaurantId: "restaurant",
  suggestedRestaurantId: null,
  status: "confirmed",
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_100_000,
  centerLat: 0,
  centerLon: 0,
  photoCount: 0,
  foodProbable: 0,
  calendarEventId: "event",
  calendarEventTitle: "Reservation",
  calendarEventLocation: "Location",
  calendarEventIsAllDay: null,
  exportedToCalendarId: null,
  notes: "Preserved notes",
  updatedAt: null,
  awardAtVisit: "1 Star",
};

function insertVisit(row: records.VisitQueryRow): void {
  database
    .prepare(
      `INSERT INTO visits (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
}

insertVisit(fixture);
insertVisit({ ...fixture, id: "visit-1", foodProbable: 1, calendarEventIsAllDay: 0 });
insertVisit({ ...fixture, id: "visit-2", foodProbable: 1, calendarEventIsAllDay: 1 });

const adapter = {
  async getAllAsync(sql: string, parameters: readonly SQLInputValue[] = []) {
    return database.prepare(sql).all(...parameters);
  },
  async getFirstAsync(sql: string, parameters: readonly SQLInputValue[] = []) {
    return database.prepare(sql).get(...parameters) ?? null;
  },
};
const modules = new Map<string, object>([
  ["./core", { DEBUG_TIMING: false, getDatabase: async () => adapter }],
  ["./visit-record-core", records],
  ["./visit-details-core", details],
  ["./visit-list-paging-core", paging],
  ["./visit-status-batch-core", statuses],
  ["./visit-photo-sampling-core", sampling],
  ["./visit-merge-core", merge],
  ["./transaction-retry-core", mergeRetry],
  ["../runtime-json.ts", json],
]);
const exports: Partial<VisitReadApi> = {};
for (const filename of ["visits.ts", "merge.ts"]) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../utils/db/${filename}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      const module = modules.get(name);
      assert.ok(module, `Unexpected database dependency: ${name}`);
      return module;
    },
  });
}

const { getVisits, getVisitById, getVisitsWithDetails, getRestaurantVisitsWithPreviews, getMergeableVisits } = exports;
assert.ok(getVisits && getVisitById && getVisitsWithDetails && getRestaurantVisitsWithPreviews && getMergeableVisits);

function assertDomainVisit(visit: VisitRecord): void {
  const expected = visit.id === "visit-0" ? [false, null] : visit.id === "visit-1" ? [true, false] : [true, true];
  assert.deepEqual([visit.foodProbable, visit.calendarEventIsAllDay], expected);
  assert.equal(visit.status, "confirmed");
  assert.equal(visit.notes, fixture.notes);
  assert.equal(visit.awardAtVisit, fixture.awardAtVisit);
}

for (const rows of await Promise.all([
  getVisits(),
  getVisits("confirmed"),
  getVisits("food"),
  getVisitsWithDetails(),
  getRestaurantVisitsWithPreviews("restaurant"),
  getMergeableVisits("missing", fixture.startTime),
])) {
  assert.ok(rows.length > 0);
  rows.forEach(assertDomainVisit);
}
const one = await getVisitById("visit-1");
assert.ok(one);
assertDomainVisit(one);
assert.equal(await getVisitById("missing"), null);
assert.deepEqual(await getVisits("rejected"), []);

const joined = Object.freeze({ ...fixture, joinedName: "Retained projection" });
assert.equal(records.parseVisitQueryRow(joined).joinedName, joined.joinedName);
assert.equal(joined.foodProbable, 0, "decoding must not mutate raw rows");

const exported = buildExportVisits({ visits: await getVisits(), restaurants: [], photosByVisitId: new Map() });
for (const visit of exported) {
  const encoded = JSON.stringify(visit);
  assert.match(encoded, /"foodProbable":(?:true|false)[,}]/);
  assert.match(encoded, /"isAllDay":(?:true|false|null)[,}]/);
}

for (const invalid of [2, -1, NaN]) {
  assert.throws(() => records.parseVisitQueryRow({ ...fixture, foodProbable: invalid }), /SQLite boolean/);
  assert.throws(() => records.parseVisitQueryRow({ ...fixture, calendarEventIsAllDay: invalid }), /SQLite boolean/);
}
database.exec("UPDATE visits SET foodProbable = 2 WHERE id = 'visit-0'");
await assert.rejects(getVisitById("visit-0"), /SQLite boolean/);
database.exec("UPDATE visits SET foodProbable = 0, status = 'unknown' WHERE id = 'visit-0'");
await assert.rejects(getVisitById("visit-0"), /unsupported status/);
database.close();
console.log(
  "Visit model passed: six production read APIs, raw SQLite flags, nullable calendar values, metadata, joined fields, JSON export, and invalid boundary rejection.",
);
