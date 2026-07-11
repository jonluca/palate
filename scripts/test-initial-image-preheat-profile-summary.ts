#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  expectedInitialImagePreheatActiveKeyCount,
  summarizeInitialImagePreheatProfile,
} from "./initial-image-preheat-profile-summary-core.ts";

const bounds = {
  pixelWidth: 100,
  pixelHeight: 100,
  preheatEstimatedBytesPerPixel: 4,
  preheatMaximumPixelCount: 50_000,
  preheatMaximumEstimatedByteCount: 120_000,
  preheatMaximumKeyCount: 24,
};

assert.equal(expectedInitialImagePreheatActiveKeyCount(9, bounds), 3, "byte bound should be the tightest bound");
assert.equal(
  expectedInitialImagePreheatActiveKeyCount(9, {
    ...bounds,
    preheatMaximumEstimatedByteCount: 1_000_000,
    preheatMaximumKeyCount: 2,
  }),
  2,
  "key bound should be enforced",
);
assert.equal(
  expectedInitialImagePreheatActiveKeyCount(9, {
    ...bounds,
    preheatMaximumPixelCount: 40_000,
    preheatMaximumEstimatedByteCount: 1_000_000,
  }),
  4,
  "target dimensions and pixel bound should be enforced",
);
assert.equal(
  expectedInitialImagePreheatActiveKeyCount(2, {
    ...bounds,
    preheatMaximumPixelCount: 1_000_000,
    preheatMaximumEstimatedByteCount: 1_000_000,
  }),
  2,
  "requested count should be enforced",
);

const measurement = (
  arm: "control" | "windowedPreheat",
  iteration: number,
  lead: number,
  target: number,
  endToEnd: number,
) => {
  const candidateSchedule = [
    { samplePosition: "later", executedFirst: false },
    { samplePosition: "earlier", executedFirst: true },
    { samplePosition: "later", executedFirst: true },
    { samplePosition: "earlier", executedFirst: false },
  ] as const;
  const candidateAssignment = candidateSchedule[(iteration - 1) % candidateSchedule.length];
  const samplePosition =
    arm === "windowedPreheat"
      ? candidateAssignment.samplePosition
      : candidateAssignment.samplePosition === "earlier"
        ? "later"
        : "earlier";
  const executedFirst =
    arm === "windowedPreheat" ? candidateAssignment.executedFirst : !candidateAssignment.executedFirst;
  const activeKeyCount = arm === "control" ? 0 : 3;
  const preheatBatchCount = arm === "control" ? 0 : 1;
  const preheatBatchIdentifierCount = arm === "control" ? 0 : activeKeyCount;
  const leadRequestStartedMilliseconds = 0.2;
  const leadTerminalMilliseconds = leadRequestStartedMilliseconds + lead;
  const targetRequestStartedMilliseconds = endToEnd - target - 0.2;
  const preheatMetrics = {
    updateCount: arm === "control" ? 0 : 1,
    startedKeyCount: activeKeyCount,
    activeKeyCount,
    pendingKeyCount: 0,
    cacheStartCallCount: arm === "control" ? 0 : 1,
  };
  const storeMetrics = (phase: "lead" | "target") => {
    const visibleBatchCount = phase === "lead" ? 1 : 2;
    const visibleBatchIdentifierCount = phase === "lead" ? 9 : 18 - preheatBatchIdentifierCount;
    return {
      assetFetchBatchCount: preheatBatchCount + visibleBatchCount,
      assetFetchIdentifierCount: preheatBatchIdentifierCount + visibleBatchIdentifierCount,
      imageRequestCount: phase === "lead" ? 9 : 18,
      assetFetchScheduler: {
        supersededPreheatBatchCount: 0,
        supersededPreheatIdentifierCount: 0,
        visiblePromotionIdentifierCount: 0,
        removedQueuedVisibleIdentifierCount: 0,
        invalidatedInFlightBatchCount: 0,
        invalidatedInFlightIdentifierCount: 0,
        maximumQueuedPreheatIdentifierCount: preheatBatchIdentifierCount,
        maximumQueuedVisibleIdentifierCount: 9,
        preheatBatchCount,
        preheatBatchIdentifierCount,
        visibleBatchCount,
        visibleBatchIdentifierCount,
        queuedPreheatIdentifierCount: 0,
        queuedVisibleIdentifierCount: 0,
        isQuiescent: true,
      },
      preheat: { ...preheatMetrics },
    };
  };
  return {
    arm,
    imageCount: 9,
    iteration,
    samplePosition,
    executedFirst,
    lead: { elapsedMilliseconds: lead, failureCount: 0, timedOutCount: 0, requestedCount: 9, finalCount: 9 },
    target: {
      allTerminalMilliseconds: target,
      failureCount: 0,
      timedOutCount: 0,
      requestedCount: 9,
      finalCount: 9,
      unexpectedEventCount: 0,
      duplicateTerminalEventCount: 0,
      invalidDimensionCount: 0,
    },
    continuousTiming: {
      elapsedThroughTargetTerminalMilliseconds: endToEnd,
      phaseMarkers: {
        ...(arm === "windowedPreheat" ? { preheatSubmittedMilliseconds: 0.1 } : {}),
        leadRequestStartedMilliseconds,
        leadTerminalMilliseconds,
        leadValidationCompletedMilliseconds: leadTerminalMilliseconds + 0.1,
        metricsAfterLeadCapturedMilliseconds: leadTerminalMilliseconds + 0.2,
        targetRequestStartedMilliseconds,
        targetTerminalMilliseconds: endToEnd,
        targetValidationCompletedMilliseconds: endToEnd + 0.1,
        metricsAfterTargetCapturedMilliseconds: endToEnd + 0.2,
      },
    },
    metricsAfterLead: storeMetrics("lead"),
    metricsAfterTarget: storeMetrics("target"),
  };
};

const fixture = {
  schemaVersion: 1,
  status: "ok",
  authorizationStatus: "authorized",
  configuration: { mode: "initial-image-preheat" },
  initialImagePreheat: {
    schemaVersion: 2,
    configuration: {
      imageCounts: [9],
      iterations: 4,
      ...bounds,
    },
    sampledIdentifierCount: 144,
    disjointLeadAndTargetWindows: true,
    measurements: [
      measurement("control", 1, 30, 20, 55),
      measurement("windowedPreheat", 1, 40, 2, 50),
      measurement("control", 2, 40, 30, 75),
      measurement("windowedPreheat", 2, 50, 3, 60),
      measurement("control", 3, 30, 20, 55),
      measurement("windowedPreheat", 3, 40, 2, 50),
      measurement("control", 4, 40, 30, 75),
      measurement("windowedPreheat", 4, 50, 3, 60),
    ],
  },
};

const summary = summarizeInitialImagePreheatProfile(fixture);
assert.equal(summary.validationPassed, true);
assert.equal(summary.sourceBenchmarkSchemaVersion, 2);
assert.equal(summary.counts.length, 1);
assert.equal(summary.counts[0].expectedPreheatedKeyCount, 3);
assert.equal(summary.counts[0].control.medianTargetPhaseMilliseconds, 25);
assert.equal(summary.counts[0].windowedPreheat.medianTargetPhaseMilliseconds, 2.5);
assert.equal(summary.counts[0].targetSpeedup, 10);
assert.equal(summary.counts[0].control.medianEndToEndMilliseconds, 65);
assert.equal(summary.counts[0].windowedPreheat.medianEndToEndMilliseconds, 55);
assert.equal(summary.counts[0].endToEndSpeedup, 65 / 55);
assert.equal(summary.counts[0].candidateWonTargetMeasurements, 4);
assert.equal(summary.counts[0].candidateWonEndToEndMeasurements, 4);
assert.equal(summary.counts[0].scheduleValidationPassed, true);
assert.equal(summary.counts[0].correctnessValidationPassed, true);
assert.equal(summary.counts[0].targetPerformancePassed, true);
assert.equal(summary.counts[0].endToEndPerformancePassed, true);

const pending = structuredClone(fixture);
pending.initialImagePreheat.measurements[1].metricsAfterLead.preheat.pendingKeyCount = 1;
assert.equal(summarizeInitialImagePreheatProfile(pending).validationPassed, false);

const wrongBoundedCount = structuredClone(fixture);
wrongBoundedCount.initialImagePreheat.measurements[1].metricsAfterLead.preheat.activeKeyCount = 9;
assert.equal(summarizeInitialImagePreheatProfile(wrongBoundedCount).validationPassed, false);

const nonQuiescentScheduler = structuredClone(fixture);
nonQuiescentScheduler.initialImagePreheat.measurements[1].metricsAfterLead.assetFetchScheduler.isQuiescent = false;
assert.equal(summarizeInitialImagePreheatProfile(nonQuiescentScheduler).validationPassed, false);

const inconsistentSchedulerTotals = structuredClone(fixture);
inconsistentSchedulerTotals.initialImagePreheat.measurements[1].metricsAfterTarget.assetFetchBatchCount += 1;
assert.equal(summarizeInitialImagePreheatProfile(inconsistentSchedulerTotals).validationPassed, false);

const missingSchedulerMetrics = structuredClone(fixture);
Reflect.deleteProperty(
  missingSchedulerMetrics.initialImagePreheat.measurements[0].metricsAfterLead,
  "assetFetchScheduler",
);
assert.throws(() => summarizeInitialImagePreheatProfile(missingSchedulerMetrics), /assetFetchScheduler/);

const missingSamplePosition = structuredClone(fixture);
Reflect.deleteProperty(missingSamplePosition.initialImagePreheat.measurements[0], "samplePosition");
assert.throws(() => summarizeInitialImagePreheatProfile(missingSamplePosition), /samplePosition/);

const missingExecutionOrder = structuredClone(fixture);
Reflect.deleteProperty(missingExecutionOrder.initialImagePreheat.measurements[0], "executedFirst");
assert.throws(() => summarizeInitialImagePreheatProfile(missingExecutionOrder), /executedFirst/);

const duplicateIteration = structuredClone(fixture);
duplicateIteration.initialImagePreheat.measurements[2].iteration = 1;
const duplicateIterationSummary = summarizeInitialImagePreheatProfile(duplicateIteration);
assert.equal(duplicateIterationSummary.counts[0].scheduleValidationPassed, false);
assert.equal(duplicateIterationSummary.validationPassed, false);

const mismatchedPairAssignments = structuredClone(fixture);
mismatchedPairAssignments.initialImagePreheat.measurements[1].executedFirst = true;
assert.equal(summarizeInitialImagePreheatProfile(mismatchedPairAssignments).counts[0].scheduleValidationPassed, false);

const unbalancedSchedule = structuredClone(fixture);
unbalancedSchedule.initialImagePreheat.measurements[2].samplePosition = "earlier";
unbalancedSchedule.initialImagePreheat.measurements[3].samplePosition = "later";
const unbalancedScheduleSummary = summarizeInitialImagePreheatProfile(unbalancedSchedule);
assert.equal(unbalancedScheduleSummary.counts[0].scheduleValidationPassed, false);
assert.equal(unbalancedScheduleSummary.validationPassed, false);

const incompleteFourWayRotation = structuredClone(fixture);
incompleteFourWayRotation.initialImagePreheat.configuration.iterations = 2;
incompleteFourWayRotation.initialImagePreheat.measurements =
  incompleteFourWayRotation.initialImagePreheat.measurements.slice(0, 4);
const incompleteFourWayRotationSummary = summarizeInitialImagePreheatProfile(incompleteFourWayRotation);
assert.equal(incompleteFourWayRotationSummary.counts[0].scheduleValidationPassed, false);
assert.equal(incompleteFourWayRotationSummary.validationPassed, false);

const omittedInterphaseTiming = structuredClone(fixture);
omittedInterphaseTiming.initialImagePreheat.measurements[1].continuousTiming.elapsedThroughTargetTerminalMilliseconds =
  omittedInterphaseTiming.initialImagePreheat.measurements[1].lead.elapsedMilliseconds +
  omittedInterphaseTiming.initialImagePreheat.measurements[1].target.allTerminalMilliseconds;
assert.equal(summarizeInitialImagePreheatProfile(omittedInterphaseTiming).validationPassed, false);

const endToEndRegression = structuredClone(fixture);
for (const candidate of endToEndRegression.initialImagePreheat.measurements.filter(
  (entry) => entry.arm === "windowedPreheat",
)) {
  candidate.continuousTiming.elapsedThroughTargetTerminalMilliseconds = 80;
  candidate.continuousTiming.phaseMarkers.targetTerminalMilliseconds = 80;
  candidate.continuousTiming.phaseMarkers.targetValidationCompletedMilliseconds = 80.1;
  candidate.continuousTiming.phaseMarkers.metricsAfterTargetCapturedMilliseconds = 80.2;
}
assert.equal(summarizeInitialImagePreheatProfile(endToEndRegression).counts[0].endToEndPerformancePassed, false);

const oldSchema = structuredClone(fixture);
oldSchema.initialImagePreheat.schemaVersion = 1;
assert.throws(() => summarizeInitialImagePreheatProfile(oldSchema), /schema 2/);
assert.throws(() => summarizeInitialImagePreheatProfile({ ...fixture, authorizationStatus: "denied" }));
console.log("Initial-image preheat profile summary tests passed.");
