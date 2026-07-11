#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_VISIT_FOOD_DETECTION_STRATEGY,
  FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY,
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
  resolveVisitFoodDetectionStrategy,
} from "../modules/batch-asset-info/src/visit-food-detection-strategy.ts";
import {
  runRank3BulkTailVisitFoodDetection,
  type VisitFoodDetectionBatchExecution,
} from "../utils/visit-food-detection-orchestration-core.ts";
import type { AdaptiveVisitFoodOutcome, AdaptiveVisitFoodSample } from "../utils/visit-food-adaptive-scan-core.ts";

interface PersistedDetection {
  readonly photoId: string;
  readonly foodDetected: boolean;
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function makeVisitSamples(visitId: string, count: number): AdaptiveVisitFoodSample[] {
  return Array.from({ length: count }, (_, index) => ({
    visitId,
    photoId: `${visitId}-${index + 1}`,
    sampleRank: index + 1,
  }));
}

function executionFor(
  samples: readonly AdaptiveVisitFoodSample[],
  configuredOutcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>,
): {
  readonly execution: VisitFoodDetectionBatchExecution;
  readonly persisted: PersistedDetection[];
  readonly foodFoundSamples: number;
  readonly retryableFailures: number;
} {
  const outcomes = samples.flatMap((sample) => {
    const outcome = configuredOutcomes.get(sample.photoId);
    return outcome ? [outcome] : [];
  });
  const successfulOutcomes = outcomes.filter((outcome) => outcome.status === "success");
  return {
    execution: { outcomes },
    persisted: successfulOutcomes.map((outcome) => ({
      photoId: outcome.photoId,
      foodDetected: outcome.containsFood === true,
    })),
    foodFoundSamples: successfulOutcomes.filter((outcome) => outcome.containsFood === true).length,
    retryableFailures: samples.length - successfulOutcomes.length,
  };
}

function fullPlanPositiveVisitIds(
  samples: readonly AdaptiveVisitFoodSample[],
  outcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>,
): string[] {
  const positiveVisitIds = new Set<string>();
  for (const sample of samples) {
    const outcome = outcomes.get(sample.photoId);
    if (outcome?.status === "success" && outcome.containsFood) {
      positiveVisitIds.add(sample.visitId);
    }
  }
  return [...positiveVisitIds].sort();
}

// The candidate attempts three adaptive waves, then one visit-major bulk tail.
// Native failures and missing results remain active; early positives prune every
// later row for that visit without writing synthetic false results.
{
  const samples = [
    ...makeVisitSamples("a", 5),
    ...makeVisitSamples("b", 5),
    ...makeVisitSamples("c", 4),
    ...makeVisitSamples("d", 2),
  ];
  const outcomes = new Map<string, AdaptiveVisitFoodOutcome>([
    ["a-1", { photoId: "a-1", status: "success", containsFood: false }],
    ["a-2", { photoId: "a-2", status: "success", containsFood: true }],
    ["a-3", { photoId: "a-3", status: "success", containsFood: false }],
    ["a-4", { photoId: "a-4", status: "success", containsFood: false }],
    ["a-5", { photoId: "a-5", status: "success", containsFood: true }],
    ["b-1", { photoId: "b-1", status: "failure" }],
    // b-2 is intentionally omitted to model a missing native result.
    ["b-3", { photoId: "b-3", status: "success", containsFood: false }],
    ["b-4", { photoId: "b-4", status: "success", containsFood: true }],
    ["b-5", { photoId: "b-5", status: "success", containsFood: false }],
    ["c-1", { photoId: "c-1", status: "success", containsFood: false }],
    ["c-2", { photoId: "c-2", status: "success", containsFood: false }],
    ["c-3", { photoId: "c-3", status: "success", containsFood: false }],
    ["c-4", { photoId: "c-4", status: "success", containsFood: false }],
    ["d-1", { photoId: "d-1", status: "success", containsFood: true }],
    ["d-2", { photoId: "d-2", status: "success", containsFood: false }],
  ]);
  const batchCalls: string[][] = [];
  const durableBatches: string[][] = [];
  const persistedRows: PersistedDetection[] = [];
  const events: string[] = [];
  const progress: Array<{ processedSamples: number; foodFoundSamples: number; retryableFailures: number }> = [];
  let synchronizeCalls = 0;

  const summary = await runRank3BulkTailVisitFoodDetection<PersistedDetection>({
    samples,
    persistenceFlushSize: 100,
    maximumPageSize: 100,
    processBatch: async (batchSamples, context) => {
      const photoIds = batchSamples.map(({ photoId }) => photoId);
      batchCalls.push(photoIds);
      events.push(`process:${photoIds.join(",")}`);
      const resolved = executionFor(batchSamples, outcomes);
      await context.appendResults(resolved.persisted);
      context.onProgress({
        processedSamples: batchSamples.length,
        foodFoundSamples: resolved.foodFoundSamples,
        retryableFailures: resolved.retryableFailures,
      });
      return resolved.execution;
    },
    persist: async (batch) => {
      durableBatches.push(batch.map(({ photoId }) => photoId));
      persistedRows.push(...batch);
      events.push(`persist:${batch.map(({ photoId }) => photoId).join(",")}`);
    },
    synchronize: async () => {
      synchronizeCalls += 1;
      events.push("synchronize");
    },
    onProgress: (snapshot) => {
      progress.push({ ...snapshot });
    },
  });

  assert.deepEqual(batchCalls, [
    ["a-1", "b-1", "c-1", "d-1"],
    ["a-2", "b-2", "c-2"],
    ["b-3", "c-3"],
    ["b-4", "b-5", "c-4"],
  ]);
  assert.deepEqual(durableBatches, [
    ["a-1", "c-1", "d-1"],
    ["a-2", "c-2"],
    ["b-3", "c-3"],
    ["b-4", "b-5", "c-4"],
  ]);
  assert.deepEqual(events, [
    "process:a-1,b-1,c-1,d-1",
    "persist:a-1,c-1,d-1",
    "process:a-2,b-2,c-2",
    "persist:a-2,c-2",
    "process:b-3,c-3",
    "persist:b-3,c-3",
    "process:b-4,b-5,c-4",
    "persist:b-4,b-5,c-4",
    "synchronize",
  ]);
  assert.equal(summary.totalPlannedSamples, 16);
  assert.equal(summary.attemptedSamples, 12);
  assert.equal(summary.foodFoundSamples, 3);
  assert.equal(summary.retryableFailures, 2);
  assert.deepEqual([...summary.positiveVisitIds].sort(), fullPlanPositiveVisitIds(samples, outcomes));
  assert.deepEqual([...summary.positiveVisitIds].sort(), ["a", "b", "d"]);
  assert.deepEqual(summary.failedPhotoIds, ["b-1"]);
  assert.deepEqual(summary.missingPhotoIds, ["b-2"]);
  assert.deepEqual(summary.skippedAfterPositive.map(({ photoId }) => photoId).sort(), ["a-3", "a-4", "a-5", "d-2"]);
  const persistedById = new Map(persistedRows.map((row) => [row.photoId, row]));
  for (const skippedPhotoId of ["a-3", "a-4", "a-5", "d-2"]) {
    assert.equal(persistedById.has(skippedPhotoId), false, `${skippedPhotoId} must remain unwritten`);
  }
  assert.equal(persistedById.has("b-1"), false);
  assert.equal(persistedById.has("b-2"), false);
  assert.equal(synchronizeCalls, 1);
  assert.deepEqual(progress, [
    { processedSamples: 4, foodFoundSamples: 1, retryableFailures: 1 },
    { processedSamples: 7, foodFoundSamples: 2, retryableFailures: 2 },
    { processedSamples: 9, foodFoundSamples: 2, retryableFailures: 2 },
    { processedSamples: 12, foodFoundSamples: 3, retryableFailures: 2 },
  ]);
}

// The tail filters the original validated plan instead of regrouping it, so
// even an interleaved caller retains its exact rank>=4 order.
{
  const samples: AdaptiveVisitFoodSample[] = [
    { visitId: "left", photoId: "left-1", sampleRank: 1 },
    { visitId: "right", photoId: "right-1", sampleRank: 1 },
    { visitId: "left", photoId: "left-2", sampleRank: 2 },
    { visitId: "right", photoId: "right-2", sampleRank: 2 },
    { visitId: "left", photoId: "left-3", sampleRank: 3 },
    { visitId: "right", photoId: "right-3", sampleRank: 3 },
    { visitId: "right", photoId: "right-4", sampleRank: 4 },
    { visitId: "left", photoId: "left-4", sampleRank: 4 },
    { visitId: "right", photoId: "right-5", sampleRank: 5 },
    { visitId: "left", photoId: "left-5", sampleRank: 5 },
  ];
  const batchCalls: string[][] = [];
  await runRank3BulkTailVisitFoodDetection<PersistedDetection>({
    samples,
    processBatch: async (batchSamples, context) => {
      batchCalls.push(batchSamples.map(({ photoId }) => photoId));
      const successful = batchSamples.map(
        (sample): AdaptiveVisitFoodOutcome => ({
          photoId: sample.photoId,
          status: "success",
          containsFood: false,
        }),
      );
      await context.appendResults(successful.map(({ photoId }) => ({ photoId, foodDetected: false })));
      return { outcomes: successful };
    },
    persist: async () => {},
    synchronize: async () => {},
  });
  assert.deepEqual(batchCalls, [
    ["left-1", "right-1"],
    ["left-2", "right-2"],
    ["left-3", "right-3"],
    ["right-4", "left-4", "right-5", "left-5"],
  ]);
}

// A failed wave checkpoint aborts before state adoption or later native work.
// Earlier durable rows still trigger exactly one recovery synchronization.
{
  const checkpointError = new Error("injected rank-two checkpoint failure");
  const samples = [...makeVisitSamples("x", 4), ...makeVisitSamples("y", 4)];
  const outcomes = new Map<string, AdaptiveVisitFoodOutcome>(
    samples.map((sample) => [
      sample.photoId,
      { photoId: sample.photoId, status: "success", containsFood: false } as const,
    ]),
  );
  const batchCalls: string[][] = [];
  const durableRows: string[] = [];
  const progress: number[] = [];
  let persistenceAttempts = 0;
  let synchronizeCalls = 0;

  await assert.rejects(
    runRank3BulkTailVisitFoodDetection<PersistedDetection>({
      samples,
      persistenceFlushSize: 100,
      maximumPageSize: 100,
      processBatch: async (batchSamples, context) => {
        batchCalls.push(batchSamples.map(({ photoId }) => photoId));
        const resolved = executionFor(batchSamples, outcomes);
        await context.appendResults(resolved.persisted);
        context.onProgress({
          processedSamples: batchSamples.length,
          foodFoundSamples: resolved.foodFoundSamples,
          retryableFailures: resolved.retryableFailures,
        });
        return resolved.execution;
      },
      persist: async (batch) => {
        persistenceAttempts += 1;
        if (persistenceAttempts === 2) {
          throw checkpointError;
        }
        durableRows.push(...batch.map(({ photoId }) => photoId));
      },
      synchronize: async () => {
        synchronizeCalls += 1;
      },
      onProgress: ({ processedSamples }) => {
        progress.push(processedSamples);
      },
    }),
    (caught) => caught === checkpointError,
  );

  assert.deepEqual(batchCalls, [
    ["x-1", "y-1"],
    ["x-2", "y-2"],
  ]);
  assert.deepEqual(durableRows, ["x-1", "y-1"]);
  assert.equal(persistenceAttempts, 2);
  assert.equal(synchronizeCalls, 1);
  assert.deepEqual(progress, [2], "a failed checkpoint must not publish its terminal batch progress");
}

// New native builds default to the validated adaptive path. Missing or unknown
// values still retain the literal full-plan path for older binaries.
assert.equal(DEFAULT_VISIT_FOOD_DETECTION_STRATEGY, RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY);
assert.equal(resolveVisitFoodDetectionStrategy(undefined), FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY);
assert.equal(resolveVisitFoodDetectionStrategy("unknown"), FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY);
assert.equal(
  resolveVisitFoodDetectionStrategy(RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY),
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
);

// Production wiring is deliberately a narrow early branch. The original full
// plan still flows through its single existing buffered-persistence call.
const visitSource = readFileSync(join(repositoryRoot, "services/visit.ts"), "utf8");
const detectionStart = visitSource.indexOf("async function detectFoodInVisits(");
const detectionEnd = visitSource.indexOf("interface CalendarEnrichmentProgress", detectionStart);
assert.notEqual(detectionStart, -1);
assert.notEqual(detectionEnd, -1);
const detectionSource = visitSource.slice(detectionStart, detectionEnd);
assert.match(
  detectionSource,
  /getResolvedVisitFoodDetectionStrategy\(\) === RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY/,
);
assert.match(detectionSource, /return processRank3BulkTailVisitFoodDetection\(/);
assert.match(detectionSource, /await processFoodDetectionBatchesWithBufferedPersistence\(/);
assert.ok(
  detectionSource.indexOf("return processRank3BulkTailVisitFoodDetection(") <
    detectionSource.indexOf("await processFoodDetectionBatchesWithBufferedPersistence("),
  "full-plan persistence must remain after the opt-in candidate branch",
);

const candidateStart = visitSource.indexOf("async function processRank3BulkTailVisitFoodDetection(");
const candidateEnd = visitSource.indexOf("/**\n * Enrich visits with calendar event data.", candidateStart);
assert.notEqual(candidateStart, -1);
assert.notEqual(candidateEnd, -1);
const candidateSource = visitSource.slice(candidateStart, candidateEnd);
assert.equal(candidateSource.match(/await getEnabledFoodKeywords\(\)/g)?.length, 1);
assert.match(candidateSource, /synchronize: syncAllVisitsFoodProbable/);
assert.match(candidateSource, /tracker\.update\(orchestrationProgress\.processedSamples, progress\.totalSamples\)/);
assert.match(candidateSource, /progress\.totalSamples = summary\.attemptedSamples/);
assert.match(candidateSource, /progress\.processedSamples = summary\.attemptedSamples/);
assert.match(candidateSource, /progress\.retryableFailures = summary\.retryableFailures/);
assert.match(candidateSource, /progress\.samplesPerSecond = finalStats\.perSecond/);

console.log("Visit food-detection production orchestration tests passed.");
