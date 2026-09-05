#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as mergeCore from "../utils/db/visit-merge-core.ts";
import * as mergeRetry from "../utils/db/transaction-retry-core.ts";
import * as visitRecords from "../utils/db/visit-record-core.ts";
import type { MergeableVisitGroup } from "../utils/db/types.ts";
import {
  FIXED_UPDATED_AT,
  assertDatabaseHealth,
  assertSnapshotsEquivalent,
  createGroup,
  createVisitMergeDatabase,
  executeLegacySequential,
  insertVisit,
  seedSemanticFixture,
  snapshotDatabase,
} from "./test-visit-merge.ts";

interface MergeApi {
  mergeVisits(targetVisitId: string, sourceVisitId: string): Promise<void>;
  batchMergeSameRestaurantVisits(groups: MergeableVisitGroup[]): Promise<number>;
}

const compiledModule = ts.transpileModule(readFileSync(new URL("../utils/db/merge.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadProductionApi(database: DatabaseSync, failAfterMutation = 0) {
  let inTransaction = false;
  const counts = { acquisitions: 0, transactions: 0, mutations: 0 };
  const parameters = (values: string | readonly SQLInputValue[]) => (Array.isArray(values) ? values : [values]);
  const transaction = {
    async getFirstAsync(sql: string, values: string | readonly SQLInputValue[]) {
      assert.ok(inTransaction, "preflight reads belong to the merge transaction");
      return database.prepare(sql).get(...parameters(values)) ?? null;
    },
    async runAsync(sql: string, values: string | readonly SQLInputValue[]) {
      assert.ok(inTransaction, "all merge writes belong to the same transaction");
      const result = database.prepare(sql).run(...parameters(values));
      counts.mutations += 1;
      if (counts.mutations === failAfterMutation) {
        throw new Error("injected merge failure");
      }
      return { changes: Number(result.changes) };
    },
  };
  const adapter = {
    async withExclusiveTransactionAsync(operation: (backend: typeof transaction) => Promise<void>) {
      assert.equal(inTransaction, false);
      counts.transactions += 1;
      database.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      try {
        await operation(transaction);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
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
        DEBUG_TIMING: false,
        getDatabase: async () => {
          counts.acquisitions += 1;
          return adapter;
        },
      },
    ],
    ["./visit-merge-core", mergeCore],
    [
      "./transaction-retry-core",
      {
        runTransactionWithBusyRetry: <T>(operation: (updatedAt: number) => Promise<T>) =>
          mergeRetry.runTransactionWithBusyRetry(operation, {
            monotonicNow: () => performance.now(),
            wallNow: () => FIXED_UPDATED_AT,
            sleep: async () => {},
          }),
      },
    ],
    ["./visit-record-core", visitRecords],
  ]);
  const exports: Partial<MergeApi> = {};
  runInNewContext(compiledModule, {
    exports,
    performance,
    setTimeout,
    require: (name: string) => {
      const module = modules.get(name);
      if (!module) {
        throw new Error(`Unexpected merge dependency: ${name}`);
      }
      return module;
    },
  });
  const { mergeVisits, batchMergeSameRestaurantVisits } = exports;
  if (!mergeVisits || !batchMergeSameRestaurantVisits) {
    throw new Error("Merge API exports missing");
  }
  return { mergeVisits, batchMergeSameRestaurantVisits, counts };
}

const manualPairs = [
  ["target-O'Brien-雪", "source-first"],
  ["source-first", "target-O'Brien-雪"],
  ["target-O'Brien-雪", "source-second"],
  ["target-O'Brien-雪", ""],
  ["target-two", "source-no-coordinates"],
  ["unrelated", "source-first"],
] as const;

let maxCentroidDifference = 0;
for (const [target, source] of manualPairs) {
  const database = createVisitMergeDatabase();
  const reference = createVisitMergeDatabase();
  try {
    seedSemanticFixture(database);
    seedSemanticFixture(reference);
    const api = loadProductionApi(database);
    executeLegacySequential(reference, [createGroup("unused", [target, source])]);
    await api.mergeVisits(target, source);
    const parity = assertSnapshotsEquivalent(snapshotDatabase(database), snapshotDatabase(reference));
    maxCentroidDifference = Math.max(maxCentroidDifference, parity.maximumCentroidAbsoluteDifference);
    assert.equal(api.counts.transactions, 1);
    assert.equal(api.counts.mutations, 6);
    assertDatabaseHealth(database);
  } finally {
    database.close();
    reference.close();
  }
}

// Manual merges can have no photos; preserve the chosen target's coordinates,
// status and metadata even when the source starts earlier or has another status.
for (const targetStatus of ["pending", "confirmed", "rejected"]) {
  const database = createVisitMergeDatabase();
  const reference = createVisitMergeDatabase();
  try {
    for (const fixture of [database, reference]) {
      insertVisit(fixture, {
        id: "target",
        status: targetStatus,
        startTime: 2000,
        endTime: 3000,
        centerLat: 12.34,
        centerLon: -56.78,
        notes: "target metadata",
        calendarEventId: "calendar-target",
        awardAtVisit: "1 Star",
        photoCount: 50,
      });
      insertVisit(fixture, {
        id: "source",
        status: "confirmed",
        startTime: 1000,
        endTime: 1500,
        centerLat: -1,
        centerLon: 2,
        notes: "source metadata",
        foodProbable: 1,
      });
    }
    executeLegacySequential(reference, [createGroup("unused", ["target", "source"])]);
    await loadProductionApi(database).mergeVisits("target", "source");
    assertSnapshotsEquivalent(snapshotDatabase(database), snapshotDatabase(reference));
  } finally {
    database.close();
    reference.close();
  }
}

for (const failurePoint of [1, 2, 3, 4, 5, 6]) {
  const database = createVisitMergeDatabase();
  try {
    seedSemanticFixture(database);
    const before = snapshotDatabase(database);
    await assert.rejects(
      loadProductionApi(database, failurePoint).mergeVisits("target-O'Brien-雪", "source-first"),
      /injected merge failure/,
    );
    assert.deepEqual(snapshotDatabase(database), before, `mutation ${failurePoint} rolls back the entire merge`);
    assertDatabaseHealth(database);
  } finally {
    database.close();
  }
}

for (const [target, source] of [
  ["missing", "source-first"],
  ["target-two", "missing"],
  ["target-two", "target-two"],
]) {
  const database = createVisitMergeDatabase();
  try {
    seedSemanticFixture(database);
    const before = snapshotDatabase(database);
    const api = loadProductionApi(database);
    await assert.rejects(api.mergeVisits(target, source), /not found|overlap/);
    assert.deepEqual(snapshotDatabase(database), before);
    assert.equal(api.counts.mutations, 0);
    if (target === source) {
      assert.equal(api.counts.acquisitions, 0);
    }
  } finally {
    database.close();
  }
}

const database = createVisitMergeDatabase();
const reference = createVisitMergeDatabase();
try {
  const groups = [...seedSemanticFixture(database)];
  seedSemanticFixture(reference);
  const api = loadProductionApi(database);
  assert.equal(await api.batchMergeSameRestaurantVisits([]), 0);
  assert.equal(api.counts.acquisitions, 0);
  const expected = executeLegacySequential(reference, groups);
  assert.equal(await api.batchMergeSameRestaurantVisits(groups), expected.mergeCount);
  assertSnapshotsEquivalent(snapshotDatabase(database), snapshotDatabase(reference));
  assert.equal(api.counts.transactions, 1);
  assert.equal(api.counts.mutations, 6);
} finally {
  database.close();
  reference.close();
}

console.log(
  JSON.stringify({
    suite: "visit-merge-api",
    manualParityCases: 9,
    rollbackStages: 6,
    missingOrSelfMergeCases: 3,
    batchApiParity: true,
    productionApiExecuted: true,
    maxCentroidDifference,
  }),
);
