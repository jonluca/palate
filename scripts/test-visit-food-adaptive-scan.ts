#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  commitAdaptiveVisitFoodTransition,
  createAdaptiveVisitFoodPlan,
  createAdaptiveVisitFoodState,
  getAdaptiveVisitFoodWave,
  resolveAdaptiveVisitFoodWave,
  type AdaptiveVisitFoodOutcome,
  type AdaptiveVisitFoodSample,
  type AdaptiveVisitFoodState,
} from "../utils/visit-food-adaptive-scan-core.ts";

function successfulFoodPhotoIds(outcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>): ReadonlySet<string> {
  return new Set(
    [...outcomes.values()]
      .filter((outcome) => outcome.status === "success" && outcome.containsFood === true)
      .map(({ photoId }) => photoId),
  );
}

/** Independent literal full-plan visit oracle; it does not use rank-wave state. */
function fullPlanPositiveVisitIds(
  samples: readonly AdaptiveVisitFoodSample[],
  outcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>,
): string[] {
  const foodPhotoIds = successfulFoodPhotoIds(outcomes);
  const positives = new Set<string>();
  for (const sample of samples) {
    if (foodPhotoIds.has(sample.photoId)) {
      positives.add(sample.visitId);
    }
  }
  return [...positives].sort();
}

function runAdaptiveScan(
  samples: readonly AdaptiveVisitFoodSample[],
  outcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>,
): AdaptiveVisitFoodState {
  let state = createAdaptiveVisitFoodState(samples);
  while (!state.isComplete) {
    const wave = getAdaptiveVisitFoodWave(state);
    const returnedOutcomes = wave.flatMap((sample) => {
      const outcome = outcomes.get(sample.photoId);
      return outcome ? [outcome] : [];
    });
    const transition = resolveAdaptiveVisitFoodWave(state, returnedOutcomes);
    state = commitAdaptiveVisitFoodTransition(state, transition);
  }
  return state;
}

function assertDeterministicAttemptedPrefixes(state: AdaptiveVisitFoodState): void {
  const attemptedRanksByVisit = new Map<string, number[]>();
  for (const attempt of state.attempts) {
    const ranks = attemptedRanksByVisit.get(attempt.sample.visitId) ?? [];
    ranks.push(attempt.sample.sampleRank);
    attemptedRanksByVisit.set(attempt.sample.visitId, ranks);
  }

  const positiveVisitIds = new Set(state.positiveVisitIds);
  const skippedIds = new Set(state.skippedAfterPositive.map(({ photoId }) => photoId));
  const attemptedIds = new Set(state.attempts.map(({ sample }) => sample.photoId));
  for (const visit of state.plan.visits) {
    const attemptedRanks = attemptedRanksByVisit.get(visit.visitId) ?? [];
    assert.deepEqual(
      attemptedRanks,
      Array.from({ length: attemptedRanks.length }, (_, index) => index + 1),
      `visit ${visit.visitId} did not attempt a contiguous prefix`,
    );
    if (positiveVisitIds.has(visit.visitId)) {
      assert.ok(attemptedRanks.length >= 1);
      const finalAttempt = state.attempts.find(
        ({ sample }) => sample.visitId === visit.visitId && sample.sampleRank === attemptedRanks.length,
      );
      assert.equal(finalAttempt?.status, "food");
    } else {
      assert.equal(attemptedRanks.length, visit.samples.length);
    }
  }
  for (const skippedId of skippedIds) {
    assert.equal(attemptedIds.has(skippedId), false, `skipped photo ${skippedId} was attempted`);
  }
}

const samples: AdaptiveVisitFoodSample[] = [
  { visitId: "visit-a", photoId: "a-1", sampleRank: 1 },
  { visitId: "visit-a", photoId: "a-2", sampleRank: 2 },
  { visitId: "visit-a", photoId: "a-3", sampleRank: 3 },
  { visitId: "visit-b", photoId: "b-1", sampleRank: 1 },
  { visitId: "visit-b", photoId: "b-2", sampleRank: 2 },
  { visitId: "visit-b", photoId: "b-3", sampleRank: 3 },
  { visitId: "visit-c", photoId: "c-1", sampleRank: 1 },
  { visitId: "visit-c", photoId: "c-2", sampleRank: 2 },
  { visitId: "visit-d", photoId: "d-1", sampleRank: 1 },
  { visitId: "visit-d", photoId: "d-2", sampleRank: 2 },
  { visitId: "visit-e", photoId: "e-1", sampleRank: 1 },
];
const outcomes = new Map<string, AdaptiveVisitFoodOutcome>([
  ["a-1", { photoId: "a-1", status: "success", containsFood: false }],
  ["a-2", { photoId: "a-2", status: "success", containsFood: true }],
  ["a-3", { photoId: "a-3", status: "success", containsFood: true }],
  ["b-1", { photoId: "b-1", status: "failure" }],
  ["b-2", { photoId: "b-2", status: "success", containsFood: false }],
  ["b-3", { photoId: "b-3", status: "success", containsFood: true }],
  // c-1 is intentionally absent and therefore modeled as a missing native result.
  ["c-2", { photoId: "c-2", status: "success", containsFood: false }],
  ["d-1", { photoId: "d-1", status: "success", containsFood: true }],
  ["d-2", { photoId: "d-2", status: "success", containsFood: false }],
  ["e-1", { photoId: "e-1", status: "success", containsFood: false }],
]);

const plan = createAdaptiveVisitFoodPlan(samples);
assert.equal(plan.totalSamples, 11);
assert.equal(plan.maximumRank, 3);
let committed = createAdaptiveVisitFoodState(plan);
assert.deepEqual(
  getAdaptiveVisitFoodWave(committed).map(({ photoId }) => photoId),
  ["a-1", "b-1", "c-1", "d-1", "e-1"],
);

// Resolving is side-effect-free. A simulated persistence rejection adopts no
// state and records no durable attempt, so the exact wave remains retryable.
const firstWaveOutcomes = getAdaptiveVisitFoodWave(committed).flatMap((sample) => {
  const outcome = outcomes.get(sample.photoId);
  return outcome ? [outcome] : [];
});
const rejectedTransition = resolveAdaptiveVisitFoodWave(committed, firstWaveOutcomes);
const durableAttempts: string[] = [];
const persistTransition = (transition: typeof rejectedTransition, shouldReject: boolean): void => {
  if (shouldReject) {
    throw new Error("simulated persistence rejection before writes");
  }
  durableAttempts.push(...transition.attempts.map(({ sample }) => sample.photoId));
};
assert.throws(() => persistTransition(rejectedTransition, true), /simulated persistence rejection/);
assert.equal(durableAttempts.length, 0);
assert.equal(committed.attempts.length, 0);
assert.deepEqual(
  getAdaptiveVisitFoodWave(committed).map(({ photoId }) => photoId),
  ["a-1", "b-1", "c-1", "d-1", "e-1"],
);

const retryTransition = resolveAdaptiveVisitFoodWave(committed, firstWaveOutcomes);
persistTransition(retryTransition, false);
committed = commitAdaptiveVisitFoodTransition(committed, retryTransition);
assert.throws(() => commitAdaptiveVisitFoodTransition(committed, rejectedTransition), /does not belong/);
assert.deepEqual(
  getAdaptiveVisitFoodWave(committed).map(({ photoId }) => photoId),
  ["a-2", "b-2", "c-2"],
);

const finalState = runAdaptiveScan(samples, outcomes);
assert.deepEqual([...finalState.positiveVisitIds].sort(), fullPlanPositiveVisitIds(samples, outcomes));
assert.deepEqual([...finalState.positiveVisitIds].sort(), ["visit-a", "visit-b", "visit-d"]);
assert.deepEqual(finalState.failedPhotoIds, ["b-1"]);
assert.deepEqual(finalState.missingPhotoIds, ["c-1"]);
assert.deepEqual(finalState.skippedAfterPositive.map(({ photoId }) => photoId).sort(), ["a-3", "d-2"]);
assert.equal(finalState.attempts.length, 9);
assertDeterministicAttemptedPrefixes(finalState);

const attemptedIds = new Set(finalState.attempts.map(({ sample }) => sample.photoId));
assert.equal(attemptedIds.has("a-3"), false);
assert.equal(attemptedIds.has("d-2"), false);

assert.throws(
  () =>
    createAdaptiveVisitFoodPlan([
      { visitId: "visit", photoId: "same", sampleRank: 1 },
      { visitId: "other", photoId: "same", sampleRank: 1 },
    ]),
  /duplicate photoId/,
);
assert.throws(
  () =>
    createAdaptiveVisitFoodPlan([
      { visitId: "visit", photoId: "one", sampleRank: 1 },
      { visitId: "visit", photoId: "duplicate-rank", sampleRank: 1 },
    ]),
  /duplicate rank/,
);
assert.throws(() => createAdaptiveVisitFoodPlan([{ visitId: "visit", photoId: "two", sampleRank: 2 }]), /skip rank 1/);
assert.throws(
  () => createAdaptiveVisitFoodPlan([{ visitId: "visit", photoId: "zero", sampleRank: 0 }]),
  /positive safe integer/,
);
assert.throws(
  () => createAdaptiveVisitFoodPlan([{ visitId: "", photoId: "photo", sampleRank: 1 }]),
  /visitId must be a non-empty string/,
);

const outcomeValidationState = createAdaptiveVisitFoodState([{ visitId: "visit", photoId: "photo", sampleRank: 1 }]);
assert.throws(
  () =>
    resolveAdaptiveVisitFoodWave(outcomeValidationState, [
      { photoId: "photo", status: "success", containsFood: false },
      { photoId: "photo", status: "success", containsFood: false },
    ]),
  /duplicate photoId/,
);
assert.throws(
  () =>
    resolveAdaptiveVisitFoodWave(outcomeValidationState, [
      { photoId: "outside", status: "success", containsFood: false },
    ]),
  /outside the current wave/,
);
assert.throws(
  () => resolveAdaptiveVisitFoodWave(outcomeValidationState, [{ photoId: "photo", status: "success" }]),
  /must include containsFood/,
);
assert.throws(
  () =>
    resolveAdaptiveVisitFoodWave(outcomeValidationState, [
      { photoId: "photo", status: "failure", containsFood: false },
    ]),
  /cannot include containsFood/,
);

const emptyState = createAdaptiveVisitFoodState([]);
assert.equal(emptyState.isComplete, true);
assert.deepEqual(getAdaptiveVisitFoodWave(emptyState), []);
assert.throws(() => resolveAdaptiveVisitFoodWave(emptyState, []), /completed/);

// Randomized independent-oracle coverage exercises uneven visit lengths,
// interleaved input, missing results, failures, and food at every valid rank.
let randomState = 0x5eedc0de;
const nextRandom = (): number => {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return randomState;
};
const randomizedDigests: string[] = [];
for (let fixtureIndex = 0; fixtureIndex < 128; fixtureIndex++) {
  const fixtureSamples: AdaptiveVisitFoodSample[] = [];
  const fixtureOutcomes = new Map<string, AdaptiveVisitFoodOutcome>();
  const visitCount = 1 + (nextRandom() % 18);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex++) {
    const visitId = `fixture-${fixtureIndex}-visit-${visitIndex}`;
    const sampleCount = 1 + (nextRandom() % 9);
    for (let rank = 1; rank <= sampleCount; rank++) {
      const photoId = `${visitId}-photo-${rank}`;
      fixtureSamples.push({ visitId, photoId, sampleRank: rank });
      const outcomeKind = nextRandom() % 19;
      if (outcomeKind === 0) {
        continue;
      }
      if (outcomeKind === 1) {
        fixtureOutcomes.set(photoId, { photoId, status: "failure" });
      } else {
        fixtureOutcomes.set(photoId, {
          photoId,
          status: "success",
          containsFood: nextRandom() % 7 === 0,
        });
      }
    }
  }

  // Interleave visits while preserving rank data; the planner must reconstruct
  // each visit's deterministic prefix from explicit ranks.
  fixtureSamples.sort((left, right) => left.sampleRank - right.sampleRank || left.visitId.localeCompare(right.visitId));
  const candidate = runAdaptiveScan(fixtureSamples, fixtureOutcomes);
  assert.deepEqual(
    [...candidate.positiveVisitIds].sort(),
    fullPlanPositiveVisitIds(fixtureSamples, fixtureOutcomes),
    `randomized fixture ${fixtureIndex} changed positive visits`,
  );
  assertDeterministicAttemptedPrefixes(candidate);
  randomizedDigests.push(
    createHash("sha256")
      .update(
        JSON.stringify({
          attempts: candidate.attempts.map(({ sample, status }) => [sample.photoId, status]),
          positives: [...candidate.positiveVisitIds].sort(),
          skipped: candidate.skippedAfterPositive.map(({ photoId }) => photoId).sort(),
        }),
      )
      .digest("hex"),
  );
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "adaptive visit food detection",
      fixture: {
        plannedSamples: samples.length,
        attemptedSamples: finalState.attempts.length,
        skippedAfterPositive: finalState.skippedAfterPositive.length,
        positiveVisits: finalState.positiveVisitIds.length,
      },
      assertions: {
        exactPositiveVisitParity: true,
        deterministicAttemptedPrefixes: true,
        missingAndFailedResultsAdvance: true,
        duplicateAndMalformedInputsRejected: true,
        persistenceAbortLeavesCommittedStateUntouched: true,
        skippedAfterPositiveRowsRemainUnattempted: true,
        randomizedFixtures: randomizedDigests.length,
        randomizedDigest: createHash("sha256").update(randomizedDigests.join("\n")).digest("hex"),
      },
    },
    null,
    2,
  ),
);
