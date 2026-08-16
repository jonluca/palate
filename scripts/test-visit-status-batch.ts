#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { buildVisitStatusBatchStatement, type VisitStatus } from "../utils/db/visit-status-batch-core.ts";

interface VisitRow {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly payload: string;
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

function requiredNumber(value: SQLOutputValue | undefined, column: string): number {
  assert.ok(isSQLiteNumber(value), `${column} must be a SQLite numeric value`);
  return value;
}

function parseVisitRow(row: SQLiteRow): VisitRow {
  return {
    id: requiredString(row.id, "visits.id"),
    status: requiredString(row.status, "visits.status"),
    updatedAt: requiredNumber(row.updatedAt, "visits.updatedAt"),
    payload: requiredString(row.payload, "visits.payload"),
  };
}

function readCount(row: SQLiteRow | undefined, label: string): number {
  assert.ok(row, `${label} must return one row`);
  return requiredNumber(row.count, `${label}.count`);
}

const EDGE_IDS = ["", "plain", "O'Brien", 'double-"quote"', "back\\slash", "訪問-東京-🍣", "line\nbreak"];
const STATUSES: VisitStatus[] = ["pending", "confirmed", "rejected"];
const UPDATED_AT = 1_789_123_456_789;

function createDatabase(ids: readonly string[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const insert = database.prepare("INSERT INTO visits VALUES (?, ?, ?, ?)");
  for (const [index, id] of ids.entries()) {
    insert.run(id, STATUSES[index % STATUSES.length], index, `sentinel-${index}-雪`);
  }
  return database;
}

function applySequentialOracle(
  database: DatabaseSync,
  visitIds: readonly string[],
  status: VisitStatus,
  updatedAt: number,
): void {
  const update = database.prepare("UPDATE visits SET status = ?, updatedAt = ? WHERE id = ?");
  for (const visitId of visitIds) {
    update.run(status, updatedAt, visitId);
  }
}

function applyCandidate(
  database: DatabaseSync,
  visitIds: readonly string[],
  status: VisitStatus,
  updatedAt: number,
): number {
  const statement = buildVisitStatusBatchStatement(visitIds, status, updatedAt);
  if (!statement) {
    return 0;
  }
  return Number(database.prepare(statement.sql).run(...statement.parameters).changes);
}

function snapshot(database: DatabaseSync): VisitRow[] {
  return database.prepare("SELECT id, status, updatedAt, payload FROM visits ORDER BY id").all().map(parseVisitRow);
}

function assertParity(visitIds: readonly string[], status: VisitStatus, allIds: readonly string[]): void {
  const reference = createDatabase(allIds);
  const candidate = createDatabase(allIds);
  try {
    applySequentialOracle(reference, visitIds, status, UPDATED_AT);
    const changes = applyCandidate(candidate, visitIds, status, UPDATED_AT);
    assert.deepEqual(snapshot(candidate), snapshot(reference));
    const existingUniqueIds = new Set(visitIds.filter((id) => allIds.includes(id)));
    assert.equal(changes, existingUniqueIds.size);
  } finally {
    reference.close();
    candidate.close();
  }
}

assert.equal(buildVisitStatusBatchStatement([], "confirmed", UPDATED_AT), null);
assert.throws(
  // @ts-expect-error: The boundary test deliberately supplies an unsupported status.
  () => buildVisitStatusBatchStatement(["visit"], "invalid", UPDATED_AT),
  /Unsupported visit status/,
);
assert.throws(() => buildVisitStatusBatchStatement(["visit"], "confirmed", Number.NaN), /must be finite/);
assert.throws(
  // @ts-expect-error: The boundary test deliberately supplies a non-string visit ID.
  () => buildVisitStatusBatchStatement(["visit", 42], "confirmed", UPDATED_AT),
  /string visit IDs/,
);

const edgeSelection = [...EDGE_IDS, EDGE_IDS[2]!, "missing-'雪'", EDGE_IDS[0]!];
for (const status of STATUSES) {
  assertParity(edgeSelection, status, [...EDGE_IDS, "untouched"]);
  assertParity([], status, [...EDGE_IDS, "untouched"]);
  assertParity([EDGE_IDS[1]!], status, [...EDGE_IDS, "untouched"]);
}

// The set-based statement must be atomic when any selected row aborts.
const atomicDatabase = createDatabase(["before", "fail", "after"]);
try {
  const before = snapshot(atomicDatabase);
  atomicDatabase.exec(`
    CREATE TRIGGER reject_fail_visit
    BEFORE UPDATE OF status ON visits
    WHEN OLD.id = 'fail'
    BEGIN
      SELECT RAISE(ABORT, 'injected failure');
    END;
  `);
  assert.throws(
    () => applyCandidate(atomicDatabase, ["before", "fail", "after"], "rejected", UPDATED_AT),
    /injected failure/,
  );
  assert.deepEqual(snapshot(atomicDatabase), before);
} finally {
  atomicDatabase.close();
}

// Deterministic randomized parity catches JSON escaping and duplicate ordering.
let randomState = 0x51a7_2026;
const random = (): number => {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const randomIds = Array.from({ length: 40 }, (_, index) =>
  index % 11 === 0 ? `visit-${index}-雪's\\path` : `visit-${index}`,
);
for (let trial = 0; trial < 250; trial++) {
  const selection = Array.from({ length: Math.floor(random() * 80) }, () => {
    const index = Math.floor(random() * (randomIds.length + 5));
    return randomIds[index] ?? `missing-${index}`;
  });
  assertParity(selection, STATUSES[trial % STATUSES.length]!, randomIds);
}

// Production-scale payload: one three-parameter statement updates 4,000 rows.
const largeIds = Array.from({ length: 5_000 }, (_, index) => `visit-${index.toString().padStart(5, "0")}`);
const largeSelection = largeIds.slice(0, 4_000);
const largeStatement = buildVisitStatusBatchStatement(largeSelection, "rejected", UPDATED_AT);
assert.ok(largeStatement);
assert.equal(largeStatement.parameters.length, 3);
assert.equal(largeStatement.requestedCount, 4_000);
assert.equal(JSON.parse(largeStatement.parameters[2]).length, 4_000);
const largeDatabase = createDatabase(largeIds);
try {
  assert.equal(applyCandidate(largeDatabase, largeSelection, "rejected", UPDATED_AT), 4_000);
  assert.equal(
    readCount(
      largeDatabase.prepare("SELECT COUNT(*) AS count FROM visits WHERE status = 'rejected'").get(),
      "status count",
    ),
    4_333,
  );
  assert.equal(
    readCount(
      largeDatabase.prepare("SELECT COUNT(*) AS count FROM visits WHERE updatedAt = ?").get(UPDATED_AT),
      "updated count",
    ),
    4_000,
  );
} finally {
  largeDatabase.close();
}

console.log("Visit status batch tests passed.");
