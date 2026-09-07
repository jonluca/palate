#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as associations from "../utils/db/photo-association-core.ts";
import * as summaries from "../utils/db/visit-photo-summary-core.ts";
import * as retry from "../utils/db/transaction-retry-core.ts";
import * as countCore from "../utils/db/visit-photo-count-core.ts";
import * as calendarCache from "../utils/db/calendar-enrichment-cache-core.ts";
import * as automaticQueue from "../utils/db/automatic-photo-deep-scan-queue-core.ts";
import type { MovePhotosResult, RemovePhotosResult } from "../utils/db/types.ts";

interface PhotoAssociationApi {
  movePhotosToVisit(photoIds: string[], targetVisitId: string): Promise<MovePhotosResult>;
  removePhotosFromVisit(photoIds: string[], visitId: string): Promise<RemovePhotosResult>;
}

const compiledApi = ts.transpileModule(
  readFileSync(new URL("../utils/db/photo-association.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

interface ProductionApiTestOptions {
  readonly retryRuntime?: retry.TransactionRetryRuntime;
  readonly afterSourceRead?: () => void;
}

function loadProductionApi(database: DatabaseSync, failureStage = 0, options: ProductionApiTestOptions = {}) {
  let inTransaction = false;
  const counts = { acquisitions: 0, transactions: 0, writes: 0, busyFailures: 0 };
  const transaction = {
    async getAllAsync(sql: string, parameters: SQLInputValue[]) {
      assert.ok(inTransaction, "source ownership must be read inside the mutation transaction");
      const rows = database.prepare(sql).all(...parameters);
      options.afterSourceRead?.();
      return rows;
    },
    async getFirstAsync(sql: string, parameters: SQLInputValue[]) {
      assert.ok(inTransaction, "destination validation must share the mutation transaction");
      return database.prepare(sql).get(...parameters) ?? null;
    },
    async runAsync(sql: string, parameters: SQLInputValue[]) {
      assert.ok(inTransaction, "photo and visit-summary updates must share a transaction");
      const result = database.prepare(sql).run(...parameters);
      counts.writes += 1;
      if (failureStage === counts.writes) {
        throw new Error("injected photo-association failure");
      }
      return { changes: Number(result.changes) };
    },
  };
  const databaseAdapter = {
    async withExclusiveTransactionAsync(operation: (value: typeof transaction) => Promise<void>) {
      assert.equal(inTransaction, false);
      // Match Expo's exclusive transaction: it owns a separate connection,
      // but begins deferred and can lose a read snapshot to another writer.
      database.exec("BEGIN");
      inTransaction = true;
      counts.transactions += 1;
      try {
        await operation(transaction);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        if (retry.isSQLiteBusyError(error)) {
          counts.busyFailures += 1;
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
  const modules = new Map<string, object>([
    [
      "./core",
      {
        getDatabase: async () => {
          counts.acquisitions += 1;
          return databaseAdapter;
        },
      },
    ],
    ["./photo-association-core", associations],
    ["./visit-photo-summary-core", summaries],
    ["./visit-photo-count-core", countCore],
    ["./calendar-enrichment-cache-core", calendarCache],
    ["./automatic-photo-deep-scan-queue-core", automaticQueue],
    [
      "./transaction-retry-core",
      {
        runTransactionWithBusyRetry: <T>(operation: (updatedAt: number) => Promise<T>) =>
          retry.runTransactionWithBusyRetry(operation, options.retryRuntime),
      },
    ],
  ]);
  const exports: Partial<PhotoAssociationApi> = {};
  runInNewContext(compiledApi, {
    exports,
    require: (name: string) => {
      const module = modules.get(name);
      if (!module) {
        throw new Error(`Unexpected photo association dependency: ${name}`);
      }
      return module;
    },
  });
  const { movePhotosToVisit, removePhotosFromVisit } = exports;
  if (!movePhotosToVisit || !removePhotosFromVisit) {
    throw new Error("Photo association exports missing");
  }
  return { movePhotosToVisit, removePhotosFromVisit, counts };
}

function createFixture(foreignKeys = false, path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: 0 });
  database.exec(`
    PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"};
    CREATE TABLE visits (id TEXT PRIMARY KEY, startTime INTEGER NOT NULL, endTime INTEGER NOT NULL,
      photoCount INTEGER NOT NULL, foodProbable INTEGER NOT NULL,
      status TEXT NOT NULL, calendarEventId TEXT, notes TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, visitId TEXT REFERENCES visits(id), creationTime INTEGER NOT NULL,
      foodDetected INTEGER, marker TEXT NOT NULL);
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
  `);
  const visit = database.prepare("INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const id of ["target", "source-a", "source-b", "calendar-only", "", "unrelated"]) {
    visit.run(id, 100, 900, 77, 1, id === "target" ? "confirmed" : "pending", `calendar:${id}`, `notes:${id}`);
  }
  const photo = database.prepare("INSERT INTO photos VALUES (?, ?, ?, ?, ?)");
  for (const [id, visitId, time, food] of [
    ["a-nonfood", "source-a", 200, 0],
    ["a-food", "source-a", 400.125, 1],
    ["b-unanalyzed", "source-b", 300, null],
    ["target-photo", "target", 500, 0],
    ["photo's-雪", null, 600, 1],
    ["empty-source-photo", "", 700, 1],
    ["unrelated-photo", "unrelated", 1000, 1],
  ] as const) {
    photo.run(id, visitId, time, food, `marker:${id}`);
  }
  return database;
}

function snapshot(database: DatabaseSync) {
  return {
    visits: database.prepare("SELECT * FROM visits ORDER BY id").all(),
    photos: database.prepare("SELECT * FROM photos ORDER BY id").all(),
  };
}

function isSqlString(value: SQLOutputValue | undefined): value is string {
  return typeof value === "string";
}

// Literal copies of the former manual writers keep the parity oracle independent
// of the shared summary statement. Safety fixes are covered separately below.
function legacyMove(database: DatabaseSync, ids: string[], target: string): MovePhotosResult {
  const bindings = ids.map(() => "?").join(",");
  const rows = database.prepare(`SELECT id, visitId FROM photos WHERE id IN (${bindings})`).all(...ids);
  const sources: string[] = [];
  for (const row of rows) {
    const id = row.visitId;
    assert.ok(id === null || isSqlString(id), "fixture photo ownership must be a text ID or null");
    if (id && id !== target && !sources.includes(id)) {
      sources.push(id);
    }
  }
  database.prepare(`UPDATE photos SET visitId = ? WHERE id IN (${bindings})`).run(target, ...ids);
  const affected = [...sources, target];
  const affectedBindings = affected.map(() => "?").join(",");
  database
    .prepare(`UPDATE visits SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id)
    WHERE id IN (${affectedBindings})`)
    .run(...affected);
  database
    .prepare(`UPDATE visits SET startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
    endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?) WHERE id = ?`)
    .run(target, target, target);
  database
    .prepare(`UPDATE visits SET foodProbable = COALESCE((SELECT MAX(foodDetected) FROM photos WHERE photos.visitId = visits.id), 0)
    WHERE id IN (${affectedBindings})`)
    .run(...affected);
  return { movedCount: rows.length, fromVisitIds: sources };
}

function legacyRemove(database: DatabaseSync, ids: string[], visitId: string): RemovePhotosResult {
  const bindings = ids.map(() => "?").join(",");
  const count = database
    .prepare(`SELECT COUNT(*) AS count FROM photos WHERE id IN (${bindings}) AND visitId = ?`)
    .get(...ids, visitId)?.count;
  if (!count) {
    return { removedCount: 0 };
  }
  database.prepare(`UPDATE photos SET visitId = NULL WHERE id IN (${bindings}) AND visitId = ?`).run(...ids, visitId);
  database
    .prepare(
      `UPDATE visits SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id) WHERE id = ?`,
    )
    .run(visitId);
  const remaining = database.prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId = ?").get(visitId)?.count;
  if (remaining) {
    database
      .prepare(`UPDATE visits SET startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
      endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?) WHERE id = ?`)
      .run(visitId, visitId, visitId);
  }
  database
    .prepare(
      `UPDATE visits SET foodProbable = COALESCE((SELECT MAX(foodDetected) FROM photos WHERE photos.visitId = visits.id), 0) WHERE id = ?`,
    )
    .run(visitId);
  return { removedCount: Number(count) };
}

const moveCases = [
  ["b-unanalyzed", "a-food", "target-photo", "photo's-雪", "a-food", "missing"],
  ["target-photo", "target-photo"],
  ["a-nonfood"],
  ["a-food", "a-nonfood"],
] as const;
const removeCases = [
  ["a-food", "a-food", "b-unanalyzed", "missing"],
  ["a-food", "a-nonfood"],
  ["missing", "target-photo"],
] as const;

for (const foreignKeys of [false, true]) {
  for (const ids of moveCases) {
    const database = createFixture(foreignKeys);
    const reference = createFixture(foreignKeys);
    try {
      const api = loadProductionApi(database);
      const expected = legacyMove(reference, [...ids], "target");
      const actual = await api.movePhotosToVisit([...ids], "target");
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), "move return count/source order matches");
      assert.deepEqual(snapshot(database), snapshot(reference));
      assert.equal(api.counts.writes, 2);
    } finally {
      database.close();
      reference.close();
    }
  }
  for (const ids of removeCases) {
    const database = createFixture(foreignKeys);
    const reference = createFixture(foreignKeys);
    try {
      const actual = await loadProductionApi(database).removePhotosFromVisit([...ids], "source-a");
      const expected = legacyRemove(reference, [...ids], "source-a");
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      assert.deepEqual(snapshot(database), snapshot(reference));
    } finally {
      database.close();
      reference.close();
    }
  }
}

for (const operation of ["move", "remove"]) {
  for (const stage of [1, 2]) {
    const database = createFixture();
    try {
      const before = snapshot(database);
      const api = loadProductionApi(database, stage);
      const mutation =
        operation === "move"
          ? api.movePhotosToVisit(["a-food"], "target")
          : api.removePhotosFromVisit(["a-food"], "source-a");
      await assert.rejects(mutation, /injected photo-association failure/);
      assert.deepEqual(snapshot(database), before, `${operation} failure after stage ${stage} fully rolls back`);
    } finally {
      database.close();
    }
  }
}

const database = createFixture();
try {
  const api = loadProductionApi(database);
  const before = snapshot(database);
  assert.equal(
    JSON.stringify(await api.movePhotosToVisit([], "target")),
    JSON.stringify({ movedCount: 0, fromVisitIds: [] }),
  );
  assert.equal(JSON.stringify(await api.removePhotosFromVisit([], "source-a")), JSON.stringify({ removedCount: 0 }));
  assert.equal(api.counts.acquisitions, 0);
  assert.equal(
    JSON.stringify(await api.movePhotosToVisit(["missing"], "calendar-only")),
    JSON.stringify({ movedCount: 0, fromVisitIds: [] }),
  );
  assert.deepEqual(snapshot(database), before, "unknown photos cannot erase a calendar-only visit's time range");
  assert.equal(api.counts.writes, 0);
  await assert.rejects(api.movePhotosToVisit(["a-food"], "missing-target"), /Target visit not found/);
  assert.deepEqual(snapshot(database), before, "target is validated even with foreign keys disabled");
  assert.equal(api.counts.writes, 0);
  const emptySource = await api.movePhotosToVisit(["empty-source-photo"], "target");
  assert.equal(JSON.stringify(emptySource.fromVisitIds), '[""]', "empty source IDs remain valid visits");
  assert.deepEqual(
    { ...database.prepare("SELECT photoCount, foodProbable, startTime, endTime FROM visits WHERE id = ''").get() },
    { photoCount: 0, foodProbable: 0, startTime: 100, endTime: 900 },
  );
  await api.movePhotosToVisit(["a-food"], "");
  assert.equal(
    database.prepare("SELECT visitId FROM photos WHERE id = 'a-food'").get()?.visitId,
    "",
    "empty target ID is valid",
  );
  await api.removePhotosFromVisit(["a-food"], "");
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT photoCount, foodProbable, startTime, endTime, calendarEventId, notes FROM visits WHERE id = ''",
        )
        .get(),
    },
    {
      photoCount: 0,
      foodProbable: 0,
      startTime: 400.125,
      endTime: 400.125,
      calendarEventId: "calendar:",
      notes: "notes:",
    },
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
} finally {
  database.close();
}

// One JSON binding keeps large selections below SQLite's variable limit.
const largeDatabase = createFixture();
try {
  const insert = largeDatabase.prepare("INSERT INTO photos VALUES (?, 'source-a', ?, 0, 'large')");
  const ids = Array.from({ length: 1500 }, (_, index) => `large-${index}`);
  largeDatabase.exec("BEGIN");
  for (const [index, id] of ids.entries()) {
    insert.run(id, 2000 + index);
  }
  largeDatabase.exec("COMMIT");
  const api = loadProductionApi(largeDatabase);
  const moved = await api.movePhotosToVisit(ids, "target");
  assert.equal(moved.movedCount, 1500);
  assert.equal(largeDatabase.prepare("SELECT photoCount FROM visits WHERE id = 'target'").get()?.photoCount, 1501);
  assert.equal((await api.removePhotosFromVisit(ids, "target")).removedCount, 1500);
  assert.equal(largeDatabase.prepare("SELECT photoCount FROM visits WHERE id = 'target'").get()?.photoCount, 1);
  const plan = largeDatabase
    .prepare(`EXPLAIN QUERY PLAN ${summaries.REFRESH_VISIT_PHOTO_SUMMARIES_SQL}`)
    .all('["target"]', "target");
  assert.match(plan.map((row) => row.detail).join("\n"), /idx_photos_visit/);
} finally {
  largeDatabase.close();
}

function virtualRetryRuntime(onSleep?: (elapsedMs: number) => void) {
  let elapsedMs = 0;
  const sleeps: number[] = [];
  const runtime: retry.TransactionRetryRuntime = {
    monotonicNow: () => elapsedMs,
    wallNow: () => 1_789_456_123_000 + elapsedMs,
    sleep: async (milliseconds) => {
      elapsedMs += milliseconds;
      sleeps.push(milliseconds);
      onSleep?.(elapsedMs);
    },
  };
  return { runtime, sleeps };
}

let realLockScenarios = 0;
for (const operation of ["move", "remove"]) {
  for (const releaseLock of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), "palate-photo-association-lock-"));
    const path = join(directory, "photos.db");
    const candidate = createFixture(false, path);
    candidate.exec("PRAGMA journal_mode = WAL");
    const locker = new DatabaseSync(path, { timeout: 0 });
    const reference = createFixture();
    try {
      const before = snapshot(candidate);
      locker.exec("BEGIN IMMEDIATE");
      locker.prepare("UPDATE photos SET marker = 'uncommitted' WHERE id = 'a-food'").run();
      const clock = virtualRetryRuntime((elapsedMs) => {
        if (releaseLock && elapsedMs >= 150 && locker.isTransaction) {
          locker.exec("ROLLBACK");
        }
      });
      const api = loadProductionApi(candidate, 0, { retryRuntime: clock.runtime });
      const mutate = () =>
        operation === "move"
          ? api.movePhotosToVisit(["a-food"], "target")
          : api.removePhotosFromVisit(["a-food"], "source-a");
      if (releaseLock) {
        const expected =
          operation === "move"
            ? legacyMove(reference, ["a-food"], "target")
            : legacyRemove(reference, ["a-food"], "source-a");
        assert.equal(JSON.stringify(await mutate()), JSON.stringify(expected));
        assert.deepEqual(snapshot(candidate), snapshot(reference));
        assert.deepEqual(clock.sleeps, [50, 100]);
        assert.equal(api.counts.transactions, 3);
        assert.equal(api.counts.busyFailures, 2);
        assert.equal(api.counts.writes, 2, "only the successful attempt writes ownership and summaries");
      } else {
        await assert.rejects(mutate(), retry.isSQLiteBusyError);
        assert.deepEqual(snapshot(candidate), before, "bounded retry exhaustion preserves all rows");
        assert.equal(api.counts.transactions, 10);
        assert.equal(api.counts.busyFailures, 10);
        assert.equal(api.counts.writes, 0);
        assert.equal(
          clock.sleeps.reduce((total, delay) => total + delay, 0),
          retry.TRANSACTION_RETRY_POLICY.retryWindowMs,
        );
      }
      assert.equal(candidate.isTransaction, false, "every failed snapshot has been rolled back");
      realLockScenarios += 1;
    } finally {
      if (locker.isTransaction) {
        locker.exec("ROLLBACK");
      }
      locker.close();
      candidate.close();
      reference.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

// A WAL writer can change ownership after the initial SELECT. Retrying only
// UPDATE would use a stale source list; the entire transaction must re-read it.
const snapshotDirectory = mkdtempSync(join(tmpdir(), "palate-photo-association-snapshot-"));
const snapshotPath = join(snapshotDirectory, "photos.db");
const snapshotCandidate = createFixture(false, snapshotPath);
snapshotCandidate.exec("PRAGMA journal_mode = WAL");
const snapshotWriter = new DatabaseSync(snapshotPath, { timeout: 0 });
const snapshotReference = createFixture();
try {
  const concurrentMove = (connection: DatabaseSync) => {
    connection.exec("BEGIN IMMEDIATE");
    connection.prepare("UPDATE photos SET visitId = 'source-b' WHERE id = 'a-food'").run();
    connection.prepare(summaries.REFRESH_VISIT_PHOTO_SUMMARIES_SQL).run('["source-a","source-b"]', "source-b");
    connection.exec("COMMIT");
  };
  concurrentMove(snapshotReference);
  const expected = legacyMove(snapshotReference, ["a-food"], "target");
  let writerCommitted = false;
  const clock = virtualRetryRuntime();
  const api = loadProductionApi(snapshotCandidate, 0, {
    retryRuntime: clock.runtime,
    afterSourceRead: () => {
      if (!writerCommitted) {
        concurrentMove(snapshotWriter);
        writerCommitted = true;
      }
    },
  });
  const actual = await api.movePhotosToVisit(["a-food"], "target");
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(JSON.stringify(actual.fromVisitIds), '["source-b"]', "retry must rediscover the committed source");
  assert.deepEqual(snapshot(snapshotCandidate), snapshot(snapshotReference));
  assert.equal(api.counts.transactions, 2);
  assert.equal(api.counts.busyFailures, 1);
  assert.deepEqual(clock.sleeps, [50]);
  assert.equal(snapshotCandidate.isTransaction, false);
  realLockScenarios += 1;
} finally {
  snapshotWriter.close();
  snapshotCandidate.close();
  snapshotReference.close();
  rmSync(snapshotDirectory, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    suite: "photo-association-summary",
    productionApiParityCases: 14,
    rollbackCases: 4,
    unknownPhotoNoOp: true,
    missingTargetRejectedBeforeWrite: true,
    emptyVisitIds: true,
    emptyVisitTimesAndCalendarMetadataPreserved: true,
    largeSelectionSize: 1500,
    summaryUsesPhotoVisitIndex: true,
    realLockScenarios,
    staleSourceSnapshotRefreshed: true,
  }),
);
