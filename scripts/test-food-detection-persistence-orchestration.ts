#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { runBufferedResultPersistence } from "../utils/food-detection-persistence-core.ts";
import { runOrderedPagePipeline } from "../utils/ordered-page-pipeline-core.ts";
import { createVisionResultPagePlan } from "../utils/vision-result-page-plan.ts";
import { DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE } from "../utils/food-detection-buffer-core.ts";
import * as photoFoodPersistence from "../utils/db/photo-food-detection-core.ts";
import * as photoFoodFailures from "../utils/db/photo-food-detection-failure-core.ts";
import type * as photosDatabase from "../utils/db/photos.ts";
import type * as visitService from "../services/visit.ts";

interface TestResult {
  readonly id: string;
  readonly value: number;
}

function makeResults(count: number, start = 0): TestResult[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `result-${start + index}`,
    value: start + index,
  }));
}

async function captureRejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (cause) {
    assert.ok(cause instanceof Error, "Expected the rejection reason to be an Error.");
    return cause;
  }
  assert.fail("Expected operation to reject.");
}

function assertAggregateErrors(error: Error, expectedErrors: readonly Error[]): void {
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, expectedErrors);
}

// Happy path preserves page order and duplicates. Terminal work runs only after
// the final remainder is persisted and derived state is synchronized.
{
  const duplicate = { id: "duplicate", value: 99 };
  const pageOne = [...makeResults(2), duplicate];
  const pageTwo = [makeResults(1, 2)[0]!, duplicate];
  const expected = [...pageOne, ...pageTwo];
  const persisted: TestResult[] = [];
  const events: string[] = [];
  const expectedResult = { foodFoundCount: 2 };

  const result = await runBufferedResultPersistence<TestResult, typeof expectedResult>({
    maximumPageSize: 3,
    persistenceFlushSize: 4,
    process: async (appendResults) => {
      await appendResults(pageOne);
      await appendResults(pageTwo);
      events.push("process-complete");
      return expectedResult;
    },
    persist: async (batch) => {
      events.push(`persist-${batch.length}`);
      for (const item of batch) {
        persisted.push(item);
      }
    },
    synchronize: async () => {
      events.push("synchronize");
    },
    onComplete: async (completedResult) => {
      assert.equal(completedResult, expectedResult);
      events.push("terminal-progress");
    },
  });

  assert.equal(result, expectedResult);
  assert.deepEqual(persisted, expected);
  assert.deepEqual(events, ["persist-4", "process-complete", "persist-1", "synchronize", "terminal-progress"]);
}

// A later Vision failure force-flushes its successful pending prefix once,
// synchronizes derived state, and rethrows the original failure.
{
  const visionError = new Error("injected Vision failure");
  const pending = makeResults(3, 100);
  const persisted: TestResult[] = [];
  let synchronizeCalls = 0;
  let completionCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, never>({
      maximumPageSize: 3,
      persistenceFlushSize: 5,
      process: async (appendResults) => {
        await appendResults(pending);
        throw visionError;
      },
      persist: async (batch) => {
        for (const item of batch) {
          persisted.push(item);
        }
      },
      synchronize: async () => {
        synchronizeCalls += 1;
      },
      onComplete: async () => {
        completionCalls += 1;
      },
    }),
  );

  assert.equal(error, visionError);
  assert.deepEqual(persisted, pending);
  assert.equal(synchronizeCalls, 1);
  assert.equal(completionCalls, 0);
}

// A progress callback failure has the same durability boundary as Vision work.
{
  const progressError = new Error("injected progress failure");
  const pending = makeResults(2, 200);
  const persisted: TestResult[] = [];
  let synchronizeCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, never>({
      maximumPageSize: 2,
      persistenceFlushSize: 4,
      process: async (appendResults) => {
        await appendResults(pending);
        throw progressError;
      },
      persist: async (batch) => {
        for (const item of batch) {
          persisted.push(item);
        }
      },
      synchronize: async () => {
        synchronizeCalls += 1;
      },
    }),
  );

  assert.equal(error, progressError);
  assert.deepEqual(persisted, pending);
  assert.equal(synchronizeCalls, 1);
}

// A rejected database operation is never retried, even if the producer catches
// the append rejection and tries to continue. Earlier durable work is synced.
{
  const persistenceError = new Error("injected persistence failure");
  const firstBatch = makeResults(2, 300);
  const failedBatch = makeResults(2, 302);
  const ignoredPage = makeResults(1, 304);
  const persisted: TestResult[] = [];
  let persistenceAttempts = 0;
  let synchronizeCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, string>({
      maximumPageSize: 2,
      persistenceFlushSize: 2,
      process: async (appendResults) => {
        await appendResults(firstBatch);
        await assert.rejects(appendResults(failedBatch), (caught) => caught === persistenceError);
        await assert.rejects(appendResults(ignoredPage), (caught) => caught === persistenceError);
        return "producer-swallowed-persistence-error";
      },
      persist: async (batch) => {
        persistenceAttempts += 1;
        if (persistenceAttempts === 2) {
          throw persistenceError;
        }
        for (const item of batch) {
          persisted.push(item);
        }
      },
      synchronize: async () => {
        synchronizeCalls += 1;
      },
    }),
  );

  assert.equal(error, persistenceError);
  assert.equal(persistenceAttempts, 2);
  assert.deepEqual(persisted, firstBatch);
  assert.equal(synchronizeCalls, 1);
}

// A final force-flush failure is attempted once, does not synchronize when
// nothing was persisted, and suppresses terminal progress.
{
  const persistenceError = new Error("injected final flush failure");
  let persistenceAttempts = 0;
  let synchronizeCalls = 0;
  let completionCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, string>({
      maximumPageSize: 2,
      persistenceFlushSize: 4,
      process: async (appendResults) => {
        await appendResults(makeResults(2, 400));
        return "processed";
      },
      persist: async () => {
        persistenceAttempts += 1;
        throw persistenceError;
      },
      synchronize: async () => {
        synchronizeCalls += 1;
      },
      onComplete: async () => {
        completionCalls += 1;
      },
    }),
  );

  assert.equal(error, persistenceError);
  assert.equal(persistenceAttempts, 1);
  assert.equal(synchronizeCalls, 0);
  assert.equal(completionCalls, 0);
}

// If both processing and its recovery flush fail, neither failure is hidden.
{
  const visionError = new Error("injected Vision failure before recovery");
  const persistenceError = new Error("injected recovery persistence failure");
  let persistenceAttempts = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, never>({
      maximumPageSize: 2,
      persistenceFlushSize: 4,
      process: async (appendResults) => {
        await appendResults(makeResults(2, 500));
        throw visionError;
      },
      persist: async () => {
        persistenceAttempts += 1;
        throw persistenceError;
      },
    }),
  );

  assertAggregateErrors(error, [visionError, persistenceError]);
  assert.equal(persistenceAttempts, 1);
}

// A synchronization failure after partial durability is aggregated with the
// processing failure, and terminal progress remains suppressed.
{
  const processingError = new Error("injected processing failure after durable batch");
  const synchronizationError = new Error("injected synchronization failure");
  let completionCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, never>({
      maximumPageSize: 2,
      persistenceFlushSize: 2,
      process: async (appendResults) => {
        await appendResults(makeResults(2, 600));
        throw processingError;
      },
      persist: async () => {},
      synchronize: async () => {
        throw synchronizationError;
      },
      onComplete: async () => {
        completionCalls += 1;
      },
    }),
  );

  assertAggregateErrors(error, [processingError, synchronizationError]);
  assert.equal(completionCalls, 0);
}

// Concurrent persistence and lookahead failures flatten deterministically and
// retain each error identity exactly once across the two orchestration layers.
{
  const persistenceError = new Error("injected concurrent persistence failure");
  const lookaheadError = new Error("injected concurrent lookahead failure");

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, void>({
      maximumPageSize: 1,
      persistenceFlushSize: 1,
      process: async (appendResults) => {
        await runOrderedPagePipeline({
          pages: [0, 1],
          strategy: "lookahead",
          produce: (page) => {
            if (page === 1) {
              throw lookaheadError;
            }
            return Promise.resolve(makeResults(1, 700));
          },
          consume: async (results) => {
            await appendResults(results);
          },
        });
      },
      persist: async () => {
        throw persistenceError;
      },
    }),
  );

  assertAggregateErrors(error, [persistenceError, lookaheadError]);
}

// Nested aggregates and repeated additional failures use depth-first ordering
// and identity-based deduplication without discarding distinct errors.
{
  const firstError = new Error("injected first nested failure");
  const secondError = new Error("injected second nested failure");
  const processingError = new AggregateError(
    [firstError, new AggregateError([secondError, firstError], "nested duplicate")],
    "processing aggregate",
  );

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, never>({
      maximumPageSize: 1,
      persistenceFlushSize: 1,
      process: async (appendResults) => {
        await appendResults(makeResults(1, 800));
        throw processingError;
      },
      persist: async () => {},
      synchronize: async () => {
        throw secondError;
      },
    }),
  );

  assertAggregateErrors(error, [firstError, secondError]);
}

// Normal completion still synchronizes when no rows were produced, preserving
// callers that use synchronization to clear stale derived values.
{
  let synchronizeCalls = 0;
  let completionCalls = 0;
  const result = await runBufferedResultPersistence<TestResult, string>({
    process: async () => "empty",
    persist: async () => assert.fail("Empty processing must not persist."),
    synchronize: async () => {
      synchronizeCalls += 1;
    },
    onComplete: async () => {
      completionCalls += 1;
    },
  });

  assert.equal(result, "empty");
  assert.equal(synchronizeCalls, 1);
  assert.equal(completionCalls, 1);
}

// An awaited semantic checkpoint persists a sub-threshold prefix before the
// producer advances, while synchronization and terminal work remain final-only.
{
  const events: string[] = [];
  const persisted: TestResult[] = [];
  const prefix = makeResults(2, 900);
  const remainder = makeResults(1, 902);

  await runBufferedResultPersistence<TestResult, void>({
    maximumPageSize: 2,
    persistenceFlushSize: 4,
    process: async (appendResults, flushPendingResults) => {
      await appendResults(prefix);
      events.push("prefix-buffered");
      await flushPendingResults();
      events.push("prefix-durable");
      await appendResults(remainder);
    },
    persist: async (batch) => {
      events.push(`persist-${batch.length}`);
      persisted.push(...batch);
    },
    synchronize: async () => {
      events.push("synchronize");
    },
    onComplete: async () => {
      events.push("complete");
    },
  });

  assert.deepEqual(persisted, [...prefix, ...remainder]);
  assert.deepEqual(events, ["prefix-buffered", "persist-2", "prefix-durable", "persist-1", "synchronize", "complete"]);
}

// A producer cannot swallow and retry a failed checkpoint. Every later entry
// point rethrows the identical latched persistence failure without another write.
{
  const persistenceError = new Error("injected checkpoint persistence failure");
  let persistenceAttempts = 0;
  let completionCalls = 0;

  const error = await captureRejection(
    runBufferedResultPersistence<TestResult, string>({
      maximumPageSize: 1,
      persistenceFlushSize: 2,
      process: async (appendResults, flushPendingResults) => {
        await appendResults(makeResults(1, 1_000));
        await assert.rejects(flushPendingResults(), (caught) => caught === persistenceError);
        await assert.rejects(flushPendingResults(), (caught) => caught === persistenceError);
        await assert.rejects(appendResults(makeResults(1, 1_001)), (caught) => caught === persistenceError);
        return "producer-swallowed-checkpoint-error";
      },
      persist: async () => {
        persistenceAttempts += 1;
        throw persistenceError;
      },
      synchronize: async () => assert.fail("No successful persistence operation should synchronize."),
      onComplete: async () => {
        completionCalls += 1;
      },
    }),
  );

  assert.equal(error, persistenceError);
  assert.equal(persistenceAttempts, 1);
  assert.equal(completionCalls, 0);
}

// The production deep-scan entrypoint preserves the manual synchronization
// default, while automatic batches can persist results and defer one final sync.
const compiledVisitService = ts.transpileModule(
  readFileSync(new URL("../services/visit.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

for (const synchronizeVisitFood of [undefined, true, false]) {
  for (const failSecondPage of [false, true]) {
    const events: string[] = [];
    const persistedIds: string[] = [];
    const visionError = new Error("injected second-page Vision failure");
    const exports: Partial<Pick<typeof visitService, "deepScanAllPhotosForFood">> = {};
    const dependencies = new Map<string, object>([
      [
        "@/utils/db",
        {
          getEnabledFoodKeywords: async () => ["food"],
          batchUpdatePhotosFoodDetected: async (results: ReadonlyArray<{ photoId: string }>) => {
            persistedIds.push(...results.map((result) => result.photoId));
            events.push("persist");
          },
          syncAllVisitsFoodProbable: async () => {
            events.push("synchronize");
          },
        },
      ],
      [
        "@/modules/batch-asset-info",
        {
          getVisionResultPageSize: () => 2,
          getResolvedVisionPageOrchestrationStrategy: () => "serial",
          isBatchAssetInfoAvailable: () => true,
          isVisionVisitFoodValidationModeEnabled: () => false,
          detectFoodInImageBatch: async (ids: string[]) => {
            if (failSecondPage && ids.includes("third")) {
              throw visionError;
            }
            return ids.map((id) => ({ assetId: id, containsFood: true, foodLabels: [], labels: [] }));
          },
        },
      ],
      ["@/utils/food-detection-persistence-core", { runBufferedResultPersistence }],
      ["@/utils/food-detection-buffer-core", { DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE }],
      ["@/utils/db/photo-food-detection-failure-core", photoFoodFailures],
      ["@/utils/vision-result-page-plan", { createVisionResultPagePlan }],
      ["@/utils/ordered-page-pipeline-core", { runOrderedPagePipeline }],
    ]);
    runInNewContext(compiledVisitService, {
      exports,
      require: (name: string) => dependencies.get(name) ?? {},
    });
    const { deepScanAllPhotosForFood } = exports;
    assert.ok(deepScanAllPhotosForFood);
    const operation = deepScanAllPhotosForFood({
      photos: [{ id: "first" }, { id: "second" }, { id: "third" }],
      synchronizeVisitFood,
      onProgress: (progress) => {
        if (progress.isComplete) {
          events.push("complete");
        }
      },
    });

    if (failSecondPage) {
      assert.equal(await captureRejection(operation), visionError);
      assert.deepEqual(persistedIds, ["first", "second"], "a failed run must retain its successful prefix");
    } else {
      const result = await operation;
      assert.equal(result.processedPhotos, 3);
      assert.equal(result.isComplete, true);
      assert.deepEqual(persistedIds, ["first", "second", "third"]);
    }
    assert.deepEqual(events, [
      "persist",
      ...(synchronizeVisitFood === false ? [] : ["synchronize"]),
      ...(failSecondPage ? [] : ["complete"]),
    ]);
  }
}

// Exercise the production service, selection queries, and food-result writer
// together: permanently failing assets leave pending work after a bounded number
// of failures without reprocessing or changing successfully classified photos.
const compiledPhotosDatabase = ts.transpileModule(
  readFileSync(new URL("../utils/db/photos.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

interface DeepScanFailureFixtureOptions {
  nativeAvailable?: boolean;
  failurePersistenceError?: Error;
  pipelineStrategy?: "serial" | "lookahead";
  nativeAttempt?: (
    ids: readonly string[],
    attempts: ReadonlyMap<string, number>,
    recoveredIds: Set<string>,
  ) => void | Promise<void>;
}

function createDeepScanFailureFixture(options: DeepScanFailureFixtureOptions = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    creationTime REAL NOT NULL,
    foodDetected INTEGER,
    foodLabels TEXT,
    foodConfidence REAL,
    allLabels TEXT,
    foodDetectionFailureCount INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = database.prepare(
    "INSERT INTO photos (id, creationTime, foodDetected, foodLabels, foodConfidence, allLabels) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("prior-classified-failed", 30, 1, "preserved-food", 0.91, "preserved-labels");
  insert.run("prior-true", 10, 1, "old-food", 0.8, "old-labels");
  insert.run("pending-missing", 20, null, null, null, null);
  insert.run("pending-error", 21, null, null, null, null);
  insert.run("pending-food", 22, null, null, null, null);
  insert.run("prior-false", 10, 0, "[]", 0, "old-labels");

  const events: string[] = [];
  const pendingReads: string[] = [];
  const recoveredIds = new Set<string>();
  const attemptedIds: string[] = [];
  const requests: string[][] = [];
  const attempts = new Map<string, number>();
  const retryDelays: number[] = [];
  const transaction = {
    runAsync: async (sql: string, parameters: SQLInputValue[]) => database.prepare(sql).run(...parameters),
    prepareAsync: async (sql: string) => {
      const statement = database.prepare(sql);
      return {
        executeAsync: async (parameters: SQLInputValue[]) => statement.run(...parameters),
        finalizeAsync: async () => {},
      };
    },
  };
  const databaseAdapter = {
    runAsync: async (sql: string, parameters: SQLInputValue[]) => {
      if (options.failurePersistenceError) {
        throw options.failurePersistenceError;
      }
      return transaction.runAsync(sql, parameters);
    },
    getAllAsync: async (sql: string, parameters: SQLInputValue[] = []) => {
      if (options.failurePersistenceError && sql === photoFoodFailures.RECORD_PHOTO_FOOD_DETECTION_FAILURES_SQL) {
        throw options.failurePersistenceError;
      }
      return database.prepare(sql).all(...parameters);
    },
    getFirstAsync: async (sql: string, parameters: SQLInputValue[] = []) => database.prepare(sql).get(...parameters),
    withExclusiveTransactionAsync: async (operation: (value: typeof transaction) => Promise<void>) => {
      database.exec("BEGIN");
      try {
        await operation(transaction);
        database.exec("COMMIT");
        events.push("persist");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const photoExports: Partial<
    Pick<
      typeof photosDatabase,
      | "getUnanalyzedPhotoIds"
      | "getUnanalyzedPhotoCount"
      | "batchUpdatePhotosFoodDetected"
      | "recordPhotoFoodDetectionFailures"
    >
  > = {};
  const photoDependencies = new Map<string, object>([
    ["./core", { getDatabase: async () => databaseAdapter }],
    ["./photo-food-detection-core", photoFoodPersistence],
    ["./photo-food-detection-failure-core", photoFoodFailures],
  ]);
  runInNewContext(compiledPhotosDatabase, {
    exports: photoExports,
    require: (name: string) => photoDependencies.get(name) ?? {},
  });
  const {
    getUnanalyzedPhotoIds,
    getUnanalyzedPhotoCount,
    batchUpdatePhotosFoodDetected,
    recordPhotoFoodDetectionFailures,
  } = photoExports;
  assert.ok(
    getUnanalyzedPhotoIds &&
      getUnanalyzedPhotoCount &&
      batchUpdatePhotosFoodDetected &&
      recordPhotoFoodDetectionFailures,
  );

  const exports: Partial<Pick<typeof visitService, "deepScanAllPhotosForFood">> = {};
  const dependencies = new Map<string, object>([
    [
      "@/utils/db",
      {
        getUnanalyzedPhotoIds: async () => {
          pendingReads.push("pending");
          return getUnanalyzedPhotoIds();
        },
        getEnabledFoodKeywords: async () => ["food"],
        batchUpdatePhotosFoodDetected,
        recordPhotoFoodDetectionFailures,
        syncAllVisitsFoodProbable: async () => {
          events.push("synchronize");
        },
      },
    ],
    [
      "@/modules/batch-asset-info",
      {
        getVisionResultPageSize: () => 2,
        getResolvedVisionPageOrchestrationStrategy: () => options.pipelineStrategy ?? "serial",
        isBatchAssetInfoAvailable: () => options.nativeAvailable !== false,
        isVisionVisitFoodValidationModeEnabled: () => false,
        detectFoodInImageBatch: async (ids: string[]) => {
          attemptedIds.push(...ids);
          requests.push([...ids]);
          for (const id of ids) {
            attempts.set(id, (attempts.get(id) ?? 0) + 1);
          }
          await options.nativeAttempt?.(ids, attempts, recoveredIds);
          return ids
            .filter((id) => id !== "pending-missing" || recoveredIds.has(id))
            .map((id) => ({
              assetId: id,
              containsFood: id === "pending-food" || recoveredIds.has(id),
              foodConfidence: id === "pending-food" || recoveredIds.has(id) ? 0.9 : 0,
              foodLabels: id === "pending-food" || recoveredIds.has(id) ? [{ label: "food", confidence: 0.9 }] : [],
              labels: [{ label: id === "pending-food" || recoveredIds.has(id) ? "food" : "tree", confidence: 0.9 }],
              error:
                (id === "pending-error" || id === "prior-classified-failed") && !recoveredIds.has(id)
                  ? "PhotoKit could not load the photo"
                  : undefined,
            }));
        },
      },
    ],
    ["@/utils/food-detection-persistence-core", { runBufferedResultPersistence }],
    ["@/utils/food-detection-buffer-core", { DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE }],
    ["@/utils/db/photo-food-detection-failure-core", photoFoodFailures],
    ["@/utils/vision-result-page-plan", { createVisionResultPagePlan }],
    ["@/utils/ordered-page-pipeline-core", { runOrderedPagePipeline }],
  ]);
  runInNewContext(compiledVisitService, {
    exports,
    require: (name: string) => dependencies.get(name) ?? {},
    setTimeout: (callback: () => void, delay: number) => {
      retryDelays.push(delay);
      callback();
      return 0;
    },
  });
  const { deepScanAllPhotosForFood } = exports;
  assert.ok(deepScanAllPhotosForFood);
  return {
    database,
    deepScanAllPhotosForFood,
    getUnanalyzedPhotoCount,
    attemptedIds,
    requests,
    attempts,
    retryDelays,
    pendingReads,
    recoveredIds,
    events,
  };
}

{
  const fixture = createDeepScanFailureFixture();
  try {
    const classifiedBefore = fixture.database
      .prepare("SELECT * FROM photos WHERE foodDetected IS NOT NULL ORDER BY id")
      .all();
    const readPhoto = (id: string) => fixture.database.prepare("SELECT * FROM photos WHERE id = ?").get(id);
    const progress: visitService.DeepScanProgress[] = [];
    const result = await fixture.deepScanAllPhotosForFood({ onProgress: (value) => progress.push(value) });
    assert.deepEqual(fixture.requests, [
      ["pending-missing", "pending-error"],
      ["pending-error", "pending-missing"],
      ["pending-error", "pending-missing"],
      ["pending-food"],
    ]);
    assert.deepEqual(fixture.retryDelays, [250, 500]);
    assert.equal(result.retryableFailures, 2);
    assert.equal(result.foodPhotosFound, 1);
    assert.equal(result.totalPhotos, 3);
    assert.equal(result.processedPhotos, 3, "Retry attempts must not inflate the unique photo count");
    assert.equal(result.isComplete, true);
    for (const value of progress) {
      assert.equal(value.totalPhotos, 3);
      assert.ok(value.processedPhotos <= 3);
      assert.ok(value.retryableFailures <= 2);
    }
    for (const id of ["pending-missing", "pending-error"]) {
      assert.equal(readPhoto(id)?.foodDetectionFailureCount, 3);
      assert.equal(readPhoto(id)?.foodDetected, null, "Failures must not become a false food classification");
    }
    assert.deepEqual(
      fixture.database.prepare("SELECT * FROM photos WHERE id LIKE 'prior-%' ORDER BY id").all(),
      classifiedBefore,
      "Pending-only scans must never reprocess classified photos",
    );
    assert.equal(await fixture.getUnanalyzedPhotoCount(), 0, "Settings must hide deep scan after the single run");
    fixture.attemptedIds.length = 0;
    const afterExhaustion = await fixture.deepScanAllPhotosForFood();
    assert.deepEqual(fixture.attemptedIds, [], "Permanent failures must stop resurfacing in subsequent deep scans");
    assert.equal(afterExhaustion.totalPhotos, 0);
    assert.equal(afterExhaustion.processedPhotos, 0);
    assert.equal(afterExhaustion.retryableFailures, 0);
    assert.equal(afterExhaustion.isComplete, true);

    // An intentional per-photo retry can recover after Photos makes the image available.
    fixture.recoveredIds.add("pending-missing");
    const recovery = await fixture.deepScanAllPhotosForFood({ photos: [{ id: "pending-missing" }] });
    assert.equal(recovery.foodPhotosFound, 1);
    assert.equal(readPhoto("pending-missing")?.foodDetected, 1);
    assert.equal(readPhoto("pending-missing")?.foodDetectionFailureCount, 0);
    assert.equal(readPhoto("pending-error")?.foodDetectionFailureCount, 3);
  } finally {
    fixture.database.close();
  }
}

// The user's exact one-photo failure must exhaust its budget inside one invocation.
{
  const fixture = createDeepScanFailureFixture();
  try {
    fixture.database.exec("DELETE FROM photos WHERE id IN ('pending-error', 'pending-food')");
    const result = await fixture.deepScanAllPhotosForFood();
    assert.deepEqual(fixture.requests, [["pending-missing"], ["pending-missing"], ["pending-missing"]]);
    assert.equal(result.processedPhotos, 1);
    assert.equal(result.retryableFailures, 1);
    assert.equal(await fixture.getUnanalyzedPhotoCount(), 0);
    assert.equal((await fixture.deepScanAllPhotosForFood()).totalPhotos, 0);
  } finally {
    fixture.database.close();
  }
}

// A failed retry-counter write must not discard successfully classified photos
// already buffered from the same page or falsely report a completed scan.
{
  const failurePersistenceError = new Error("Injected failure-counter persistence error");
  const fixture = createDeepScanFailureFixture({ failurePersistenceError });
  try {
    fixture.database.exec("UPDATE photos SET creationTime = 0 WHERE id = 'pending-food'");
    const progress: visitService.DeepScanProgress[] = [];
    await assert.rejects(
      fixture.deepScanAllPhotosForFood({ onProgress: (value) => progress.push(value) }),
      (error) => error === failurePersistenceError,
    );
    assert.equal(
      fixture.database.prepare("SELECT foodDetected FROM photos WHERE id = 'pending-food'").get()?.foodDetected,
      1,
    );
    assert.equal(
      fixture.database.prepare("SELECT SUM(foodDetectionFailureCount) AS failures FROM photos").get()?.failures,
      0,
    );
    assert.equal(
      progress.some((value) => value.isComplete),
      false,
    );
    assert.deepEqual(fixture.requests, [["pending-food", "pending-missing"]]);
    assert.deepEqual(fixture.retryDelays, [], "A failed durable counter update must abort before retrying");
  } finally {
    fixture.database.close();
  }
}

// A budget persisted by an interrupted scan limits retries in the current invocation.
{
  const fixture = createDeepScanFailureFixture();
  try {
    fixture.database.exec(`
      DELETE FROM photos WHERE id IN ('pending-error', 'pending-food');
      UPDATE photos SET foodDetectionFailureCount = 2 WHERE id = 'pending-missing';
    `);
    const result = await fixture.deepScanAllPhotosForFood();
    assert.deepEqual(fixture.requests, [["pending-missing"]]);
    assert.deepEqual(fixture.retryDelays, []);
    assert.equal(result.processedPhotos, 1);
    assert.equal(result.retryableFailures, 1);
    assert.equal(await fixture.getUnanalyzedPhotoCount(), 0);
    assert.equal(
      fixture.database.prepare("SELECT foodDetectionFailureCount FROM photos WHERE id = 'pending-missing'").get()
        ?.foodDetectionFailureCount,
      3,
    );
  } finally {
    fixture.database.close();
  }
}

// Retry only failed IDs within this invocation, including recovery on different attempts.
{
  const fixture = createDeepScanFailureFixture({
    nativeAttempt: (ids, attempts, recoveredIds) => {
      for (const id of ids) {
        if (
          (id === "pending-error" && attempts.get(id) === 2) ||
          (id === "pending-missing" && attempts.get(id) === 3)
        ) {
          recoveredIds.add(id);
        }
      }
    },
  });
  try {
    fixture.database.exec("UPDATE photos SET creationTime = 0 WHERE id = 'pending-food'");
    const result = await fixture.deepScanAllPhotosForFood();
    assert.deepEqual(fixture.requests, [
      ["pending-food", "pending-missing"],
      ["pending-missing"],
      ["pending-missing"],
      ["pending-error"],
      ["pending-error"],
    ]);
    assert.equal(fixture.attempts.get("pending-food"), 1, "Successful photos must never enter a retry request");
    assert.deepEqual(fixture.retryDelays, [250, 500, 250]);
    assert.equal(result.processedPhotos, 3);
    assert.equal(result.foodPhotosFound, 3);
    assert.equal(result.retryableFailures, 0);
    assert.equal(
      fixture.database.prepare("SELECT SUM(foodDetectionFailureCount) AS failures FROM photos").get()?.failures,
      0,
    );
    assert.equal((await fixture.deepScanAllPhotosForFood()).totalPhotos, 0);
  } finally {
    fixture.database.close();
  }
}

// Speculative next-page production and retry requests must share the native request slot.
{
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fixture = createDeepScanFailureFixture({
    pipelineStrategy: "lookahead",
    nativeAttempt: async (ids, attempts, recoveredIds) => {
      activeRequests++;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise(setImmediate);
      for (const id of ids) {
        if ((attempts.get(id) ?? 0) >= 2) {
          recoveredIds.add(id);
        }
      }
      activeRequests--;
    },
  });
  try {
    const result = await fixture.deepScanAllPhotosForFood();
    assert.deepEqual(fixture.requests, [
      ["pending-missing", "pending-error"],
      ["pending-food"],
      ["pending-error", "pending-missing"],
    ]);
    assert.equal(maximumActiveRequests, 1, "A retry must not overlap an in-flight lookahead native request");
    assert.equal(result.processedPhotos, 3);
    assert.equal(result.foodPhotosFound, 3);
    assert.equal(result.retryableFailures, 0);
    assert.equal(await fixture.getUnanalyzedPhotoCount(), 0);
  } finally {
    fixture.database.close();
  }
}

// A thrown retry request preserves successes and charges only the earlier reported asset failure.
{
  const transportError = new Error("Injected native retry transport failure");
  const fixture = createDeepScanFailureFixture({
    nativeAttempt: (ids, attempts) => {
      if (ids.includes("pending-missing") && attempts.get("pending-missing") === 2) {
        throw transportError;
      }
    },
  });
  try {
    fixture.database.exec("UPDATE photos SET creationTime = 0 WHERE id = 'pending-food'");
    const progress: visitService.DeepScanProgress[] = [];
    await assert.rejects(
      fixture.deepScanAllPhotosForFood({ onProgress: (value) => progress.push(value) }),
      (error) => error === transportError,
    );
    assert.deepEqual(fixture.requests, [["pending-food", "pending-missing"], ["pending-missing"]]);
    assert.equal(
      fixture.database.prepare("SELECT foodDetected FROM photos WHERE id = 'pending-food'").get()?.foodDetected,
      1,
    );
    assert.equal(
      fixture.database.prepare("SELECT foodDetectionFailureCount FROM photos WHERE id = 'pending-missing'").get()
        ?.foodDetectionFailureCount,
      1,
      "Thrown batch failures must not consume an individual photo's retry budget",
    );
    assert.equal(
      fixture.database.prepare("SELECT foodDetectionFailureCount FROM photos WHERE id = 'pending-error'").get()
        ?.foodDetectionFailureCount,
      0,
    );
    assert.equal(
      progress.some((value) => value.isComplete),
      false,
    );
  } finally {
    fixture.database.close();
  }
}

// A whole-batch transport error is not evidence that any requested asset is unreadable.
{
  const transportError = new Error("Injected initial native transport failure");
  const fixture = createDeepScanFailureFixture({
    nativeAttempt: () => {
      throw transportError;
    },
  });
  try {
    await assert.rejects(fixture.deepScanAllPhotosForFood(), (error) => error === transportError);
    assert.deepEqual(fixture.requests, [["pending-missing", "pending-error"]]);
    assert.deepEqual(fixture.retryDelays, []);
    assert.equal(
      fixture.database.prepare("SELECT SUM(foodDetectionFailureCount) AS failures FROM photos").get()?.failures,
      0,
    );
    assert.equal(await fixture.getUnanalyzedPhotoCount(), 3);
  } finally {
    fixture.database.close();
  }
}

// Explicit caller-supplied selections still retain their contract, including an empty selection.
for (const photos of [[], [{ id: "pending-food" }]]) {
  const fixture = createDeepScanFailureFixture();
  try {
    const result = await fixture.deepScanAllPhotosForFood({ photos });
    assert.deepEqual(fixture.pendingReads, []);
    assert.deepEqual(
      fixture.attemptedIds,
      photos.map((photo) => photo.id),
    );
    assert.equal(result.totalPhotos, photos.length);
    assert.equal(result.isComplete, true);
  } finally {
    fixture.database.close();
  }
}

// Even an explicit failed recheck preserves a photo's existing classification payload.
{
  const fixture = createDeepScanFailureFixture();
  try {
    const selectPayload = fixture.database.prepare(
      "SELECT foodDetected, foodLabels, foodConfidence, allLabels FROM photos WHERE id = 'prior-classified-failed'",
    );
    const before = selectPayload.get();
    const result = await fixture.deepScanAllPhotosForFood({ photos: [{ id: "prior-classified-failed" }] });
    assert.deepEqual(fixture.pendingReads, []);
    assert.deepEqual(fixture.requests, [
      ["prior-classified-failed"],
      ["prior-classified-failed"],
      ["prior-classified-failed"],
    ]);
    assert.equal(result.processedPhotos, 1);
    assert.equal(result.retryableFailures, 1);
    assert.deepEqual(selectPayload.get(), before);
  } finally {
    fixture.database.close();
  }
}

{
  const fixture = createDeepScanFailureFixture({ nativeAvailable: false });
  try {
    const progress: visitService.DeepScanProgress[] = [];
    await assert.rejects(
      fixture.deepScanAllPhotosForFood({ onProgress: (value) => progress.push(value) }),
      /Food detection is unavailable/,
    );
    assert.deepEqual(fixture.pendingReads, []);
    assert.deepEqual(fixture.attemptedIds, []);
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(progress, [], "Missing native capability must not report a successful empty scan");
  } finally {
    fixture.database.close();
  }
}

console.log("Food detection buffered persistence orchestration tests passed.");
