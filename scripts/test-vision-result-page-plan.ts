#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { AsyncResultBuffer, MAXIMUM_VISION_NATIVE_PAGE_SIZE } from "../utils/food-detection-buffer-core.ts";
import { calculateVisionResultPeakBufferedRows, createVisionResultPagePlan } from "../utils/vision-result-page-plan.ts";

const boundaryCounts = [0, 1, 199, 200, 201, 499, 500, 501, 999, 1_000, 1_001, 13_059, 68_027];
const pageSizes = [200, 500, 1_000];

for (const totalCount of boundaryCounts) {
  for (const pageSize of pageSizes) {
    const plan = createVisionResultPagePlan(totalCount, pageSize);
    assert.equal(plan.length, Math.ceil(totalCount / pageSize));

    let expectedOffset = 0;
    let plannedCount = 0;
    for (const page of plan) {
      assert.equal(page.offset, expectedOffset);
      assert.equal(page.endOffset, page.offset + page.count);
      assert.ok(page.count > 0 && page.count <= pageSize);
      expectedOffset = page.endOffset;
      plannedCount += page.count;
    }
    assert.equal(expectedOffset, totalCount);
    assert.equal(plannedCount, totalCount);
  }
}

for (const invalidCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => createVisionResultPagePlan(invalidCount, 200), /non-negative safe integer/);
}
for (const invalidPageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_001]) {
  assert.throws(() => createVisionResultPagePlan(1, invalidPageSize), /integer from 1 through 2000/);
}
assert.equal(createVisionResultPagePlan(1, MAXIMUM_VISION_NATIVE_PAGE_SIZE)[0]?.count, 1);
for (const pageSize of pageSizes) {
  assert.equal(calculateVisionResultPeakBufferedRows(13_059, pageSize, 1_000), 1_000);
  assert.equal(calculateVisionResultPeakBufferedRows(68_027, pageSize, 1_000), 1_000);
}
assert.equal(calculateVisionResultPeakBufferedRows(0, 200, 1_000), 0);
assert.equal(calculateVisionResultPeakBufferedRows(999, 200, 1_000), 999);
assert.equal(calculateVisionResultPeakBufferedRows(3_000, 600, 1_000), 1_400);
for (const invalidFlushSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => calculateVisionResultPeakBufferedRows(1, 1, invalidFlushSize), /positive safe integer/);
}

// Partitioning is a stable slice of the original sequence, including duplicate
// identifiers and values that look like missing-asset sentinels.
const edgeInput = ["asset-a", "missing", "asset-a", "asset-二", "", "asset-z"];
for (const pageSize of [1, 2, 5, 6]) {
  const output = createVisionResultPagePlan(edgeInput.length, pageSize).flatMap((page) =>
    edgeInput.slice(page.offset, page.endOffset),
  );
  assert.deepEqual(output, edgeInput);
}

// A 1,000-result native page aligns with the durable flush boundary. The final
// remainder remains ordered and a failed full-page write is exactly retryable.
const tunedInput = Array.from({ length: 1_001 }, (_, index) => `asset-${index.toString().padStart(4, "0")}`);
const persisted: string[] = [];
const batchSizes: number[] = [];
const tunedBuffer = new AsyncResultBuffer<string>({
  maximumPageSize: 1_000,
  persistenceFlushSize: 1_000,
  persist: async (batch) => {
    batchSizes.push(batch.length);
    persisted.push(...batch);
  },
});
for (const page of createVisionResultPagePlan(tunedInput.length, 1_000)) {
  await tunedBuffer.append(tunedInput.slice(page.offset, page.endOffset));
}
await tunedBuffer.flush();
assert.deepEqual(batchSizes, [1_000, 1]);
assert.deepEqual(persisted, tunedInput);
assert.equal(tunedBuffer.maximumPendingCountObserved, 1_000);

const retryInput = tunedInput.slice(0, 1_000);
const retryAttempts: string[][] = [];
let failFirstWrite = true;
const retryBuffer = new AsyncResultBuffer<string>({
  maximumPageSize: 1_000,
  persistenceFlushSize: 1_000,
  persist: async (batch) => {
    retryAttempts.push(batch.slice());
    if (failFirstWrite) {
      failFirstWrite = false;
      throw new Error("injected 1,000-row persistence failure");
    }
  },
});
await assert.rejects(retryBuffer.append(retryInput), /injected 1,000-row persistence failure/);
assert.equal(retryBuffer.pendingCount, 1_000);
await retryBuffer.flush();
assert.deepEqual(retryAttempts, [retryInput, retryInput]);
assert.equal(retryBuffer.pendingCount, 0);

console.log("Vision result page plan tests passed.");
