#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  AsyncResultBuffer,
  DEFAULT_VISION_NATIVE_PAGE_SIZE,
  DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
  LEGACY_VISION_NATIVE_PAGE_SIZE,
  MAXIMUM_VISION_NATIVE_PAGE_SIZE,
  resolveVisionNativePageSize,
} from "../utils/food-detection-buffer-core.ts";

interface TestResult {
  readonly sequence: number;
  readonly assetId: string;
}

function makeResults(count: number, start = 0): TestResult[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: start + index,
    assetId: `asset-${(start + index).toString().padStart(5, "0")}`,
  }));
}

function concatenateOracle(pages: readonly (readonly TestResult[])[]): TestResult[] {
  const concatenated: TestResult[] = [];
  for (const page of pages) {
    for (const result of page) {
      concatenated.push(result);
    }
  }
  return concatenated;
}

assert.equal(DEFAULT_VISION_NATIVE_PAGE_SIZE, 1_000);
assert.equal(LEGACY_VISION_NATIVE_PAGE_SIZE, 50);
assert.equal(DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE, 1_000);
assert.equal(resolveVisionNativePageSize(undefined), LEGACY_VISION_NATIVE_PAGE_SIZE);
assert.equal(resolveVisionNativePageSize(1_000), 1_000);
assert.equal(resolveVisionNativePageSize(MAXIMUM_VISION_NATIVE_PAGE_SIZE), MAXIMUM_VISION_NATIVE_PAGE_SIZE);
for (const invalidPageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000", 2_001]) {
  assert.equal(resolveVisionNativePageSize(invalidPageSize), LEGACY_VISION_NATIVE_PAGE_SIZE);
}
assert.throws(
  () => new AsyncResultBuffer<TestResult>({ persist: async () => {}, persistenceFlushSize: 0 }),
  /Persistence flush size must be a positive safe integer/,
);
assert.throws(
  () => new AsyncResultBuffer<TestResult>({ persist: async () => {}, maximumPageSize: -1 }),
  /Maximum page size must be a positive safe integer/,
);
assert.throws(
  () => new AsyncResultBuffer<TestResult>({ persist: async () => {}, maximumPageSize: 1.5 }),
  /Maximum page size must be a positive safe integer/,
);

// Ordered subpages combine into 1,000-row persistence operations while retaining
// exact page and row order. flush() writes the final remainder.
const orderedPages = [
  makeResults(200, 0),
  makeResults(200, 200),
  makeResults(200, 400),
  makeResults(200, 600),
  makeResults(200, 800),
  makeResults(60, 1_000),
];
const orderedBatches: TestResult[][] = [];
const orderedBuffer = new AsyncResultBuffer<TestResult>({
  persist: async (batch) => {
    orderedBatches.push(batch.slice());
  },
});
for (const page of orderedPages) {
  await orderedBuffer.append(page);
}
assert.deepEqual(
  orderedBatches.map((batch) => batch.length),
  [1_000],
);
assert.equal(orderedBuffer.pendingCount, 60);
assert.equal(orderedBuffer.maximumPendingCountObserved, 1_000);
await orderedBuffer.flush();
assert.deepEqual(
  orderedBatches.map((batch) => batch.length),
  [1_000, 60],
);
assert.deepEqual(concatenateOracle(orderedBatches), concatenateOracle(orderedPages));
assert.equal(orderedBuffer.pendingCount, 0);

// Irregular pages can cross a flush boundary. Only the full prefix is removed,
// and the remainder keeps its original order for a later force-flush.
const irregularBatches: TestResult[][] = [];
const irregularBuffer = new AsyncResultBuffer<TestResult>({
  maximumPageSize: 6,
  persistenceFlushSize: 4,
  persist: async (batch) => {
    irregularBatches.push(batch.slice());
  },
});
const irregularPage = makeResults(6, 10_000);
await irregularBuffer.append(irregularPage);
assert.deepEqual(
  irregularBatches.map((batch) => batch.length),
  [4],
);
assert.equal(irregularBuffer.pendingCount, 2);
assert.equal(irregularBuffer.maximumPendingCountObserved, 6);
await irregularBuffer.flush();
assert.deepEqual(concatenateOracle(irregularBatches), irregularPage);

// A rejected automatic flush retains the complete pending prefix. Retrying
// flush() receives the same rows in the same order and can commit them once.
const retryInput = makeResults(4, 20_000);
const retryAttempts: TestResult[][] = [];
const retryCommitted: TestResult[] = [];
let rejectNextAttempt = true;
const retryBuffer = new AsyncResultBuffer<TestResult>({
  maximumPageSize: 4,
  persistenceFlushSize: 4,
  persist: async (batch) => {
    retryAttempts.push(batch.slice());
    if (rejectNextAttempt) {
      rejectNextAttempt = false;
      throw new Error("injected persistence failure");
    }
    retryCommitted.push(...batch);
  },
});
await assert.rejects(retryBuffer.append(retryInput), /injected persistence failure/);
assert.equal(retryBuffer.pendingCount, 4);
assert.deepEqual(retryCommitted, []);
await retryBuffer.flush();
assert.equal(retryBuffer.pendingCount, 0);
assert.deepEqual(retryAttempts, [retryInput, retryInput]);
assert.deepEqual(retryCommitted, retryInput);

// A force-flush failure of a sub-threshold remainder is equally retryable.
const remainder = makeResults(3, 30_000);
let remainderAttempts = 0;
const remainderCommitted: TestResult[] = [];
const remainderBuffer = new AsyncResultBuffer<TestResult>({
  maximumPageSize: 5,
  persistenceFlushSize: 5,
  persist: async (batch) => {
    remainderAttempts += 1;
    if (remainderAttempts === 1) {
      throw new Error("injected remainder failure");
    }
    remainderCommitted.push(...batch);
  },
});
await remainderBuffer.append(remainder);
await assert.rejects(remainderBuffer.flush(), /injected remainder failure/);
assert.equal(remainderBuffer.pendingCount, 3);
await remainderBuffer.flush();
assert.deepEqual(remainderCommitted, remainder);

// Pending rows remain visible until the asynchronous persistence promise has
// resolved, proving the buffer never removes them optimistically.
let releasePersistence: (() => void) | undefined;
const persistenceBarrier = new Promise<void>((resolve) => {
  releasePersistence = resolve;
});
let persistenceStarted: (() => void) | undefined;
const persistenceStart = new Promise<void>((resolve) => {
  persistenceStarted = resolve;
});
const delayedBuffer = new AsyncResultBuffer<TestResult>({
  maximumPageSize: 2,
  persistenceFlushSize: 2,
  persist: async () => {
    persistenceStarted?.();
    await persistenceBarrier;
  },
});
const delayedAppend = delayedBuffer.append(makeResults(2, 40_000));
await persistenceStart;
assert.equal(delayedBuffer.pendingCount, 2);
await assert.rejects(delayedBuffer.flush(), /must be awaited and cannot overlap/);
await assert.rejects(delayedBuffer.append([]), /must be awaited and cannot overlap/);
releasePersistence?.();
await delayedAppend;
assert.equal(delayedBuffer.pendingCount, 0);

// Configured pages above common JavaScript spread argument limits remain valid.
const largePageSize = 150_000;
const largePage = Array.from({ length: largePageSize }, (_, index) => index);
let largePersistedCount = 0;
const largePageBuffer = new AsyncResultBuffer<number>({
  maximumPageSize: largePageSize,
  persistenceFlushSize: largePageSize,
  persist: async (results) => {
    assert.equal(results[0], 0);
    assert.equal(results.at(-1), largePageSize - 1);
    largePersistedCount += results.length;
  },
});
await largePageBuffer.append(largePage);
assert.equal(largePersistedCount, largePageSize);
assert.equal(largePageBuffer.pendingCount, 0);

const oversizedBuffer = new AsyncResultBuffer<TestResult>({ persist: async () => {} });
await assert.rejects(
  oversizedBuffer.append(makeResults(DEFAULT_VISION_NATIVE_PAGE_SIZE + 1)),
  /pages support at most 1000 rows; received 1001/,
);
assert.equal(oversizedBuffer.pendingCount, 0);
await oversizedBuffer.append([]);
await oversizedBuffer.flush();
assert.equal(oversizedBuffer.maximumPendingCountObserved, 0);

console.log("Food detection async result buffer tests passed.");
