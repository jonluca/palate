#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { runBufferedResultPersistence } from "../utils/food-detection-persistence-core.ts";

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

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject.");
}

function assertAggregateErrors(error: unknown, expectedErrors: readonly unknown[]): void {
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

console.log("Food detection buffered persistence orchestration tests passed.");
