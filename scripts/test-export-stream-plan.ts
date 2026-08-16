#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import {
  buildExportPhotoCountsQuery,
  EXPORT_PHOTO_PAGE_SIZE,
  type ExportPhotoCountsQuery,
} from "../utils/db/export-photos-core.ts";
import {
  EXPORT_STREAM_MAX_VISITS_PER_BATCH,
  planExportPhotoBatches,
  type ExportPhotoBatch,
  type ExportStreamPlanOptions,
} from "../utils/export-stream-plan.ts";

interface CountRow {
  readonly visitId: string;
  readonly photoCount: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

type SQLiteRow = ReturnType<StatementSync["all"]>[number];

function isSQLiteString(value: SQLOutputValue): value is string {
  return typeof value === "string";
}

function isSQLiteNumber(value: SQLOutputValue): value is number {
  return typeof value === "number";
}

function requiredString(value: SQLOutputValue, column: string): string {
  assert.ok(isSQLiteString(value), `${column} must be a SQLite TEXT value`);
  return value;
}

function requiredNumber(value: SQLOutputValue, column: string): number {
  assert.ok(isSQLiteNumber(value), `${column} must be a SQLite numeric value`);
  return value;
}

function assertDefined<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "Expected the count query to return a row.");
  return value;
}

function parseCountRow(row: SQLiteRow): CountRow {
  return {
    visitId: requiredString(row.visitId, "photo counts.visitId"),
    photoCount: requiredNumber(row.photoCount, "photo counts.photoCount"),
  };
}

function parsePhotoCount(row: SQLiteRow): number {
  return requiredNumber(row.photoCount, "photo count");
}

function parseQueryPlanRow(row: SQLiteRow): QueryPlanRow {
  return { detail: requiredString(row.detail, "query plan.detail") };
}

const EDGE_VISIT_ID = "訪問-雪-🍣\n'quoted'\"\\path";
const INJECTION_LIKE_VISIT_ID = "visit') OR 1=1 --";

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT
    );
    CREATE INDEX idx_photos_visit ON photos(visitId);
  `);
  return database;
}

function seedPhotos(database: DatabaseSync): void {
  const insert = database.prepare("INSERT INTO photos (id, visitId) VALUES (?, ?)");
  const counts = new Map<string, number>([
    ["visit-a", 3],
    [EDGE_VISIT_ID, 2],
    [INJECTION_LIKE_VISIT_ID, 1],
    ["", 4],
  ]);
  database.exec("BEGIN");
  try {
    for (const [visitId, photoCount] of counts) {
      for (let index = 0; index < photoCount; index++) {
        insert.run(`${visitId}-photo-${index}`, visitId);
      }
    }
    insert.run("unrequested-photo", "unrequested-visit");
    insert.run("null-visit-photo", null);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function requireCountQuery(visitIds: readonly string[]): ExportPhotoCountsQuery {
  const query = buildExportPhotoCountsQuery(visitIds);
  assert.ok(query);
  return query;
}

function runCountQuery(database: DatabaseSync, visitIds: readonly string[]): Map<string, number> {
  const query = requireCountQuery(visitIds);
  const rows = database
    .prepare(query.sql)
    .all(...query.parameters)
    .map(parseCountRow);
  return new Map(rows.map((row) => [row.visitId, row.photoCount]));
}

function runIndependentCounts(database: DatabaseSync, visitIds: readonly string[]): Map<string, number> {
  const count = database.prepare("SELECT COUNT(*) AS photoCount FROM photos WHERE visitId = ?");
  return new Map(
    [...new Set(visitIds)].map((visitId) => {
      const photoCount = parsePhotoCount(assertDefined(count.get(visitId)));
      return [visitId, photoCount] as const;
    }),
  );
}

function sortedEntries(counts: ReadonlyMap<string, number>): readonly (readonly [string, number])[] {
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function flattenVisitIds(batches: readonly ExportPhotoBatch[]): string[] {
  return batches.flatMap((batch) => [...batch.visitIds]);
}

function assertPlanStructure(
  batches: readonly ExportPhotoBatch[],
  orderedVisitIds: readonly string[],
  expectedPhotoCount: number,
  options: Required<ExportStreamPlanOptions> = {
    maxPhotosPerBatch: EXPORT_PHOTO_PAGE_SIZE,
    maxVisitsPerBatch: EXPORT_STREAM_MAX_VISITS_PER_BATCH,
  },
): void {
  assert.deepEqual(flattenVisitIds(batches), orderedVisitIds);
  assert.equal(
    batches.reduce((sum, batch) => sum + batch.photoCount, 0),
    expectedPhotoCount,
  );
  for (const batch of batches) {
    assert.ok(batch.visitIds.length > 0);
    if (batch.mode === "bounded") {
      assert.ok(batch.visitIds.length <= options.maxVisitsPerBatch);
      assert.ok(batch.photoCount <= options.maxPhotosPerBatch);
    } else {
      assert.equal(batch.visitIds.length, 1);
      assert.ok(batch.photoCount > options.maxPhotosPerBatch);
    }
  }
}

function testExactCountQuery(): void {
  const database = createDatabase();
  try {
    seedPhotos(database);
    const requestedIds = ["visit-a", EDGE_VISIT_ID, "missing-visit", "visit-a", INJECTION_LIKE_VISIT_ID, ""];
    const query = requireCountQuery(requestedIds);
    assert.equal(query.parameters.length, 1);
    assert.deepEqual(JSON.parse(query.parameters[0]), requestedIds);
    assert.doesNotMatch(query.sql, new RegExp(INJECTION_LIKE_VISIT_ID.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(query.sql.includes("json_each(?)"));
    assert.ok(query.sql.includes("SELECT DISTINCT"));

    const actual = runCountQuery(database, requestedIds);
    const expected = runIndependentCounts(database, requestedIds);
    assert.deepEqual(sortedEntries(actual), sortedEntries(expected));
    assert.equal(actual.size, new Set(requestedIds).size);
    assert.equal(actual.get("visit-a"), 3);
    assert.equal(actual.get(EDGE_VISIT_ID), 2);
    assert.equal(actual.get(INJECTION_LIKE_VISIT_ID), 1);
    assert.equal(actual.get(""), 4);
    assert.equal(actual.get("missing-visit"), 0);

    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.parameters)
      .map(parseQueryPlanRow);
    const planDetails = plan.map((row) => row.detail).join("\n");
    assert.match(planDetails, /SCAN json_each VIRTUAL TABLE/);
    assert.match(planDetails, /SEARCH p USING COVERING INDEX idx_photos_visit/);
    assert.doesNotMatch(planDetails, /SCAN p(?:\s|$)/);

    assert.equal(buildExportPhotoCountsQuery([]), null);
    // @ts-expect-error -- a numeric ID exercises runtime validation at the query boundary.
    assert.throws(() => buildExportPhotoCountsQuery(["valid", 42]), /string visit IDs/);
  } finally {
    database.close();
  }
}

function testBoundaryAndStreamingBatches(): void {
  const orderedVisitIds = ["zero-before", "fit-a", "fit-b", "overflow", "exact-boundary", "heavy", "zero-after"];
  const counts = new Map<string, number>([
    ["zero-before", 0],
    ["fit-a", 1_500],
    ["fit-b", 2_500],
    ["overflow", 1],
    ["exact-boundary", EXPORT_PHOTO_PAGE_SIZE],
    ["heavy", EXPORT_PHOTO_PAGE_SIZE + 1],
    ["zero-after", 0],
  ]);
  const expected: readonly ExportPhotoBatch[] = [
    { mode: "bounded", visitIds: ["zero-before", "fit-a", "fit-b"], photoCount: 4_000 },
    { mode: "bounded", visitIds: ["overflow"], photoCount: 1 },
    { mode: "bounded", visitIds: ["exact-boundary"], photoCount: 4_000 },
    { mode: "streaming", visitIds: ["heavy"], photoCount: 4_001 },
    { mode: "bounded", visitIds: ["zero-after"], photoCount: 0 },
  ];
  const plan = planExportPhotoBatches(orderedVisitIds, counts);
  assert.deepEqual(plan, expected);
  assertPlanStructure(plan, orderedVisitIds, 12_002);
}

function testAllZeroAndVisitLimitBatches(): void {
  const orderedVisitIds = Array.from({ length: 600 }, (_, index) => `zero-${index}`);
  const counts = new Map(orderedVisitIds.map((visitId) => [visitId, 0]));
  const plan = planExportPhotoBatches(orderedVisitIds, counts);
  assert.deepEqual(
    plan.map((batch) => ({ mode: batch.mode, visits: batch.visitIds.length, photos: batch.photoCount })),
    [
      { mode: "bounded", visits: 256, photos: 0 },
      { mode: "bounded", visits: 256, photos: 0 },
      { mode: "bounded", visits: 88, photos: 0 },
    ],
  );
  assert.ok(plan.every((batch) => batch.photoCount === 0));
  assertPlanStructure(plan, orderedVisitIds, 0);
}

function testDefaultScaleStructureAndStableOrder(): void {
  const orderedVisitIds = Array.from({ length: 4_000 }, (_, index) => {
    if (index === 0) {
      return EDGE_VISIT_ID;
    }
    if (index === 1) {
      return "";
    }
    return `visit-${index.toString().padStart(4, "0")}`;
  });
  const counts = new Map(orderedVisitIds.map((visitId, index) => [visitId, index < 30 ? 18 : 17] as const).reverse());
  const firstPlan = planExportPhotoBatches(orderedVisitIds, counts);
  const secondPlan = planExportPhotoBatches(orderedVisitIds, counts);
  assert.deepEqual(secondPlan, firstPlan);
  assert.equal(firstPlan.length, 18);
  assert.ok(firstPlan.every((batch) => batch.mode === "bounded"));
  assertPlanStructure(firstPlan, orderedVisitIds, 68_030);
}

function testCustomBounds(): void {
  const orderedVisitIds = ["a", "b", "c", "heavy", "tail"];
  const counts = new Map<string, number>([
    ["a", 2],
    ["b", 1],
    ["c", 1],
    ["heavy", 4],
    ["tail", 0],
  ]);
  const options = { maxPhotosPerBatch: 3, maxVisitsPerBatch: 2 } as const;
  const plan = planExportPhotoBatches(orderedVisitIds, counts, options);
  assert.deepEqual(plan, [
    { mode: "bounded", visitIds: ["a", "b"], photoCount: 3 },
    { mode: "bounded", visitIds: ["c"], photoCount: 1 },
    { mode: "streaming", visitIds: ["heavy"], photoCount: 4 },
    { mode: "bounded", visitIds: ["tail"], photoCount: 0 },
  ]);
  assertPlanStructure(plan, orderedVisitIds, 8, options);
}

function testInvalidPlannerInputs(): void {
  assert.deepEqual(planExportPhotoBatches([], new Map()), []);
  assert.throws(
    () => planExportPhotoBatches(["duplicate", "duplicate"], new Map([["duplicate", 0]])),
    /duplicate visit ID/,
  );
  assert.throws(() => planExportPhotoBatches(["missing"], new Map()), /missing visit ID/);
  assert.throws(() => planExportPhotoBatches(["expected"], new Map([["unexpected", 0]])), /unexpected visit ID/);
  // @ts-expect-error -- a numeric ID exercises runtime validation at the planner boundary.
  assert.throws(() => planExportPhotoBatches([42], new Map([["42", 0]])), /string visit IDs/);
  const invalidKeyCounts = new Map([[42, 0]]);
  assert.throws(
    // @ts-expect-error -- a numeric map key exercises runtime validation of count keys.
    () => planExportPhotoBatches(["valid"], invalidKeyCounts),
    /string visit IDs/,
  );
  for (const invalidCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => planExportPhotoBatches(["invalid-count"], new Map([["invalid-count", invalidCount]])),
      /non-negative safe integer/,
    );
  }
  // @ts-expect-error -- null exercises runtime validation of the visit ID collection.
  assert.throws(() => planExportPhotoBatches(null, new Map()), /array of visit IDs/);
  // @ts-expect-error -- a plain object exercises runtime validation of the count map.
  assert.throws(() => planExportPhotoBatches([], {}), /requires a Map/);
  assert.throws(
    // @ts-expect-error -- null exercises runtime validation of planner options.
    () => planExportPhotoBatches([], new Map(), null),
    /options must be an object/,
  );

  for (const maxPhotosPerBatch of [0, -1, 1.5, EXPORT_PHOTO_PAGE_SIZE + 1, Number.NaN]) {
    assert.throws(() => planExportPhotoBatches([], new Map(), { maxPhotosPerBatch }), /maxPhotosPerBatch/);
  }
  for (const maxVisitsPerBatch of [0, -1, 1.5, EXPORT_STREAM_MAX_VISITS_PER_BATCH + 1, Number.NaN]) {
    assert.throws(() => planExportPhotoBatches([], new Map(), { maxVisitsPerBatch }), /maxVisitsPerBatch/);
  }
}

testExactCountQuery();
testBoundaryAndStreamingBatches();
testAllZeroAndVisitLimitBatches();
testDefaultScaleStructureAndStableOrder();
testCustomBounds();
testInvalidPlannerInputs();

console.log("Export stream planning tests passed.");
