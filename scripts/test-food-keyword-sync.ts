#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_FOOD_KEYWORDS,
  syncDefaultFoodKeywords,
  type FoodKeywordSyncConnection,
  type FoodKeywordSyncDatabase,
} from "../utils/db/food-keyword-sync-core.ts";

interface FoodKeywordRow {
  readonly id: number;
  readonly keyword: string;
  readonly enabled: number;
  readonly isBuiltIn: number;
  readonly createdAt: number;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes: number;
  readonly sha256: string | null;
}

interface ContentionWorkerResult {
  readonly result: {
    readonly inserted: number;
    readonly reclassified: number;
    readonly inspectionReads: number;
    readonly transactionStarted: boolean;
  };
  readonly inspectionCount: number;
  readonly writeExecutions: number;
}

type ContentionWorkerMessage =
  | {
      readonly type: "preflight";
      readonly missingKeywordPresent: boolean;
      readonly reclassifiedValue: number | undefined;
    }
  | ({ readonly type: "complete" } & ContentionWorkerResult)
  | { readonly type: "failure"; readonly message: string; readonly stack?: string };

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE food_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      isBuiltIn INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX idx_food_keywords_enabled ON food_keywords(enabled);
  `);
}

function createAdapter(database: DatabaseSync): FoodKeywordSyncDatabase {
  const connection: FoodKeywordSyncConnection = {
    async getAllAsync<T>(source: string, parameters: Array<string | number>) {
      return database.prepare(source).all(...parameters) as T[];
    },
    async runAsync(source, parameters) {
      const result = database.prepare(source).run(...parameters);
      return { changes: Number(result.changes) };
    },
  };

  return {
    ...connection,
    async withExclusiveTransactionAsync(task) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await task(connection);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        throw error;
      }
    },
  };
}

function readRows(database: DatabaseSync): FoodKeywordRow[] {
  return database
    .prepare("SELECT id, keyword, enabled, isBuiltIn, createdAt FROM food_keywords ORDER BY id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      keyword: String(row.keyword),
      enabled: Number(row.enabled),
      isBuiltIn: Number(row.isBuiltIn),
      createdAt: Number(row.createdAt),
    }));
}

function readSequence(database: DatabaseSync): number | null {
  const row = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'food_keywords'").get();
  return row ? Number(row.seq) : null;
}

function readTotalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS totalChanges").get();
  assert(row);
  return Number(row.totalChanges);
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, bytes: 0, sha256: null };
  }
  const contents = readFileSync(path);
  return {
    exists: true,
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function rowByKeyword(rows: readonly FoodKeywordRow[], keyword: string): FoodKeywordRow {
  const row = rows.find((candidate) => candidate.keyword === keyword);
  assert(row, `Missing keyword row: ${keyword}`);
  return row;
}

async function runContendingWorkers(
  databasePath: string,
  missingKeyword: string,
  reclassifiedKeyword: string,
  createdAt: number,
): Promise<ContentionWorkerResult[]> {
  const workers = Array.from(
    { length: 2 },
    () =>
      new Worker(new URL("./fixtures/food-keyword-sync/contention-worker.ts", import.meta.url), {
        execArgv: ["--no-warnings", "--experimental-sqlite", "--experimental-strip-types"],
        workerData: { databasePath, missingKeyword, reclassifiedKeyword, createdAt },
      }),
  );

  return new Promise((resolve, reject) => {
    const results: ContentionWorkerResult[] = [];
    let preflights = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const worker of workers) {
        void worker.terminate();
      }
      reject(error);
    };

    for (const worker of workers) {
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!settled && code !== 0) {
          fail(new Error(`Food keyword contention worker exited with code ${code}.`));
        }
      });
      worker.on("message", (message: ContentionWorkerMessage) => {
        if (settled) {
          return;
        }
        if (message.type === "failure") {
          fail(new Error(message.stack ?? message.message));
          return;
        }
        if (message.type === "preflight") {
          try {
            assert.equal(message.missingKeywordPresent, false);
            assert.equal(message.reclassifiedValue, 0);
          } catch (error) {
            fail(error);
            return;
          }
          preflights += 1;
          if (preflights === workers.length) {
            for (const candidate of workers) {
              candidate.postMessage("release");
            }
          }
          return;
        }

        results.push({
          result: message.result,
          inspectionCount: message.inspectionCount,
          writeExecutions: message.writeExecutions,
        });
        if (results.length === workers.length) {
          settled = true;
          resolve(results);
        }
      });
    }
  });
}

assert.equal(DEFAULT_FOOD_KEYWORDS.length, 58);
assert.equal(new Set(DEFAULT_FOOD_KEYWORDS).size, DEFAULT_FOOD_KEYWORDS.length);

const directory = mkdtempSync(join(tmpdir(), "palate-food-keyword-sync-"));
const databasePath = join(directory, "keywords.db");
const walPath = `${databasePath}-wal`;
const database = new DatabaseSync(databasePath);

try {
  createSchema(database);
  const adapter = createAdapter(database);
  const initialCreatedAt = 1_700_000_000_123;
  const initialResult = await syncDefaultFoodKeywords(adapter, initialCreatedAt);

  assert.deepEqual(initialResult, {
    inserted: DEFAULT_FOOD_KEYWORDS.length,
    reclassified: 0,
    inspectionReads: 2,
    transactionStarted: true,
  });
  const initialRows = readRows(database);
  assert.equal(initialRows.length, DEFAULT_FOOD_KEYWORDS.length);
  assert.deepEqual(
    initialRows.map((row) => row.keyword),
    [...DEFAULT_FOOD_KEYWORDS],
  );
  assert(initialRows.every((row) => row.enabled === 1 && row.isBuiltIn === 1));
  assert(initialRows.every((row) => row.createdAt === initialCreatedAt));
  assert.equal(readSequence(database), DEFAULT_FOOD_KEYWORDS.length);

  const steadyRowsBefore = readRows(database);
  const steadySequenceBefore = readSequence(database);
  const steadyChangesBefore = readTotalChanges(database);
  const steadyWalBefore = snapshotFile(walPath);
  assert.equal(steadyWalBefore.exists, true, "WAL fixture must exist before the no-write assertion");

  const steadyResult = await syncDefaultFoodKeywords(adapter, 1_799_999_999_999);
  const steadyWalAfter = snapshotFile(walPath);
  assert.deepEqual(steadyResult, {
    inserted: 0,
    reclassified: 0,
    inspectionReads: 1,
    transactionStarted: false,
  });
  assert.deepEqual(readRows(database), steadyRowsBefore);
  assert.equal(readSequence(database), steadySequenceBefore);
  assert.equal(readTotalChanges(database), steadyChangesBefore);
  assert.deepEqual(steadyWalAfter, steadyWalBefore);

  const disabledDefault = DEFAULT_FOOD_KEYWORDS[3];
  const reclassifiedDefault = DEFAULT_FOOD_KEYWORDS[54];
  const missingDefault = DEFAULT_FOOD_KEYWORDS[57];
  const preservedCreatedAt = 1_600_000_000_777;
  database
    .prepare("UPDATE food_keywords SET enabled = 0, createdAt = ? WHERE keyword = ?")
    .run(preservedCreatedAt, disabledDefault);
  database.prepare("UPDATE food_keywords SET isBuiltIn = 0 WHERE keyword = ?").run(reclassifiedDefault);
  database.prepare("DELETE FROM food_keywords WHERE keyword = ?").run(missingDefault);
  database
    .prepare("INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt) VALUES (?, 0, 0, ?)")
    .run("ramen_custom_雪", 1_650_000_000_456);

  const repairRowsBefore = readRows(database);
  const disabledBefore = rowByKeyword(repairRowsBefore, disabledDefault);
  const reclassifiedBefore = rowByKeyword(repairRowsBefore, reclassifiedDefault);
  const userBefore = rowByKeyword(repairRowsBefore, "ramen_custom_雪");
  const repairChangesBefore = readTotalChanges(database);
  const repairCreatedAt = 1_800_000_000_999;
  const repairResult = await syncDefaultFoodKeywords(adapter, repairCreatedAt);
  const repairRowsAfter = readRows(database);

  assert.deepEqual(repairResult, {
    inserted: 1,
    reclassified: 1,
    inspectionReads: 2,
    transactionStarted: true,
  });
  assert.equal(readTotalChanges(database) - repairChangesBefore, 2);
  assert.deepEqual(rowByKeyword(repairRowsAfter, disabledDefault), disabledBefore);
  assert.deepEqual(rowByKeyword(repairRowsAfter, "ramen_custom_雪"), userBefore);
  assert.deepEqual(rowByKeyword(repairRowsAfter, reclassifiedDefault), {
    ...reclassifiedBefore,
    isBuiltIn: 1,
  });
  assert.deepEqual(rowByKeyword(repairRowsAfter, missingDefault), {
    id: Number(readSequence(database)),
    keyword: missingDefault,
    enabled: 1,
    isBuiltIn: 1,
    createdAt: repairCreatedAt,
  });
  assert.equal(rowByKeyword(repairRowsAfter, disabledDefault).enabled, 0);
  assert.equal(rowByKeyword(repairRowsAfter, disabledDefault).createdAt, preservedCreatedAt);

  const rollbackReclassified = DEFAULT_FOOD_KEYWORDS[55];
  const rollbackMissing = DEFAULT_FOOD_KEYWORDS[56];
  database.prepare("UPDATE food_keywords SET isBuiltIn = 0 WHERE keyword = ?").run(rollbackReclassified);
  database.prepare("DELETE FROM food_keywords WHERE keyword = ?").run(rollbackMissing);
  database.exec(`CREATE TRIGGER fail_default_keyword_insert
    BEFORE INSERT ON food_keywords
    WHEN NEW.keyword = '${rollbackMissing}'
    BEGIN
      SELECT RAISE(ABORT, 'injected default keyword insert failure');
    END`);
  const rollbackRowsBefore = readRows(database);
  const rollbackSequenceBefore = readSequence(database);

  await assert.rejects(syncDefaultFoodKeywords(adapter, 1_810_000_000_111), /injected default keyword insert failure/);
  assert.equal(database.isTransaction, false);
  assert.deepEqual(readRows(database), rollbackRowsBefore);
  assert.equal(readSequence(database), rollbackSequenceBefore);

  database.exec("DROP TRIGGER fail_default_keyword_insert");
  const retryResult = await syncDefaultFoodKeywords(adapter, 1_810_000_000_222);
  assert.deepEqual(retryResult, {
    inserted: 1,
    reclassified: 1,
    inspectionReads: 2,
    transactionStarted: true,
  });

  await assert.rejects(syncDefaultFoodKeywords(adapter, Number.NaN), /createdAt must be a non-negative safe integer/);

  const contentionPath = join(directory, "contention.db");
  const contentionDatabase = new DatabaseSync(contentionPath);
  try {
    createSchema(contentionDatabase);
    const contentionAdapter = createAdapter(contentionDatabase);
    await syncDefaultFoodKeywords(contentionAdapter, initialCreatedAt);
    const contentionReclassified = DEFAULT_FOOD_KEYWORDS[10];
    const contentionMissing = DEFAULT_FOOD_KEYWORDS[11];
    contentionDatabase.prepare("UPDATE food_keywords SET isBuiltIn = 0 WHERE keyword = ?").run(contentionReclassified);
    contentionDatabase.prepare("DELETE FROM food_keywords WHERE keyword = ?").run(contentionMissing);
    const contentionSequenceBefore = readSequence(contentionDatabase);
    const contentionWalBefore = snapshotFile(`${contentionPath}-wal`);

    const contentionResults = await runContendingWorkers(
      contentionPath,
      contentionMissing,
      contentionReclassified,
      1_820_000_000_333,
    );
    assert.deepEqual(
      contentionResults
        .map(({ result }) => ({ inserted: result.inserted, reclassified: result.reclassified }))
        .sort((left, right) => left.inserted - right.inserted),
      [
        { inserted: 0, reclassified: 0 },
        { inserted: 1, reclassified: 1 },
      ],
    );
    assert(contentionResults.every(({ result }) => result.transactionStarted && result.inspectionReads === 2));
    assert(contentionResults.every(({ inspectionCount }) => inspectionCount === 2));
    assert.deepEqual(
      contentionResults.map(({ writeExecutions }) => writeExecutions).sort((left, right) => left - right),
      [0, 2],
    );
    assert.equal(Number(readSequence(contentionDatabase)) - Number(contentionSequenceBefore), 1);
    assert.equal(rowByKeyword(readRows(contentionDatabase), contentionReclassified).isBuiltIn, 1);
    assert.equal(rowByKeyword(readRows(contentionDatabase), contentionMissing).createdAt, 1_820_000_000_333);
    assert.notDeepEqual(snapshotFile(`${contentionPath}-wal`), contentionWalBefore);

    const contentionRowsBeforeRetry = readRows(contentionDatabase);
    const contentionSequenceBeforeRetry = readSequence(contentionDatabase);
    const contentionChangesBeforeRetry = readTotalChanges(contentionDatabase);
    const contentionWalBeforeRetry = snapshotFile(`${contentionPath}-wal`);
    const contentionRetry = await syncDefaultFoodKeywords(contentionAdapter, 1_820_000_000_444);
    assert.equal(contentionRetry.transactionStarted, false);
    assert.deepEqual(readRows(contentionDatabase), contentionRowsBeforeRetry);
    assert.equal(readSequence(contentionDatabase), contentionSequenceBeforeRetry);
    assert.equal(readTotalChanges(contentionDatabase), contentionChangesBeforeRetry);
    assert.deepEqual(snapshotFile(`${contentionPath}-wal`), contentionWalBeforeRetry);
  } finally {
    contentionDatabase.close();
  }

  console.log(
    `Food keyword sync tests passed: ${DEFAULT_FOOD_KEYWORDS.length} first-install defaults; steady-state rows, sqlite_sequence, total_changes, and WAL byte-identical; exact repair; rollback/retry safe; two-connection WAL contention serialized without duplicate repair.`,
  );
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
