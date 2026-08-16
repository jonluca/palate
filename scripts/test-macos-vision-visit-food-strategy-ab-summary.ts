#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "../utils/runtime-json.ts";

type Strategy = "full-plan-v1" | "rank3-bulk-tail-v1";
type ResultTransport = "legacy" | "packed-v1";
type PageOrchestrationStrategy = "serial" | "lookahead";

interface NativeWorkCounters {
  startedBatchCount: number;
  startedRequestedAssetCount: number;
  completedBatchCount: number;
  completedRequestedAssetCount: number;
  resolvedBatchCount: number;
  resolvedRequestedAssetCount: number;
  rejectedBatchCount: number;
  rejectedRequestedAssetCount: number;
  cancelledBatchCount: number;
  cancelledRequestedAssetCount: number;
  inFlightBatchCount: number;
  inFlightRequestedAssetCount: number;
}

interface SuccessSummary {
  schemaVersion: number;
  inputReportSchemaVersion: number;
  status: string;
  validation: VisitFoodSummaryValidation;
  inputIdentity: {
    appName: string;
    pageSize: number;
    requestedResultTransport: ResultTransport;
    resultTransport: ResultTransport;
    pageOrchestrationStrategy: PageOrchestrationStrategy;
    classificationStrategy: string;
    classificationStrategyMode: string;
    classificationStrategyEnvironmentValue: string | null;
    fixtureCount: number;
    originalDatabaseSha256: string;
    standaloneSnapshotSha256: string;
    preparedVisionStateSha256ByStrategy: {
      fullPlanV1: string;
      rank3BulkTailV1: string;
    };
  };
  fullPlan: StrategySummary;
  rank3BulkTail: StrategySummary;
  comparison: {
    interpretation: string;
    medianDeltas: {
      firstDurableProgressToCompletionSeconds: Delta;
      triggerToDurableCompletionSeconds: Delta;
      triggerToFirstDurableProgressSeconds: Delta;
      maxRssKiB: Delta;
    };
    aggregateAvoidedWork: {
      requestedAssets: Avoided;
      nativeBatches: Avoided;
    };
    medianAvoidedWork: {
      requestedAssets: Avoided;
      nativeBatches: Avoided;
    };
    pairwiseWins: {
      rank3BulkTail: number;
      fullPlan: number;
      ties: number;
    };
    pairs: Array<{
      pairIndex: number;
      fullPlanRunId: string;
      rank3BulkTailRunId: string;
      timing: {
        firstDurableProgressToCompletionSeconds: Delta;
      };
      directWork: {
        requestedAssets: Avoided;
        nativeBatches: Avoided;
      };
      fasterDurableTail: Strategy | "tie";
    }>;
  };
  limitations: string[];
}

interface VisitFoodSummaryValidation {
  [attestation: string]: boolean;
}

interface Delta {
  baseline: number;
  candidate: number;
  candidateMinusBaseline: number;
  candidateMinusBaselinePercent: number | null;
}

interface Avoided {
  baseline: number;
  candidate: number;
  avoided: number;
  avoidedPercent: number;
}

interface StrategySummary {
  strategy: Strategy;
  reports: string[];
  runIds: string[];
  sampleCount: number;
  timing: {
    firstDurableProgressToCompletionSeconds: number[];
    medianFirstDurableProgressToCompletionSeconds: number;
    triggerToDurableCompletionSeconds: number[];
    medianTriggerToDurableCompletionSeconds: number;
    triggerToFirstDurableProgressSeconds: number[];
    medianTriggerToFirstDurableProgressSeconds: number;
  };
  rss: {
    maxRssKiB: number[];
    medianMaxRssKiB: number;
  };
  directWork: {
    requestedAssets: number[];
    totalRequestedAssets: number;
    medianRequestedAssets: number;
    nativeBatches: number[];
    totalNativeBatches: number;
    medianNativeBatches: number;
  };
}

const summarizerPath = fileURLToPath(new URL("./summarize-macos-vision-visit-food-strategy-ab.ts", import.meta.url));
const repositoryRoot = dirname(dirname(summarizerPath));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-vision-visit-food-strategy-ab-"));
const executableSha256 = "a".repeat(64);
const bundleSha256 = "b".repeat(64);
const originalDatabaseSha256 = "c".repeat(64);
const walSha256 = "d".repeat(64);
const shmSha256 = "e".repeat(64);
const standaloneSnapshotSha256 = "f".repeat(64);
const fullPlanPreparedStateSha256 = "1".repeat(64);
const rank3PreparedStateSha256 = "2".repeat(64);
const resultDatabaseSha256 = "3".repeat(64);

function parseResultTransport(value: string): ResultTransport {
  if (value !== "legacy" && value !== "packed-v1") {
    throw new TypeError(`Unsupported result transport: ${value}`);
  }
  return value;
}

function parsePageOrchestrationStrategy(value: string): PageOrchestrationStrategy {
  if (value !== "serial" && value !== "lookahead") {
    throw new TypeError(`Unsupported page orchestration strategy: ${value}`);
  }
  return value;
}

function makeCounters(requestedAssets: number, nativeBatches: number): NativeWorkCounters {
  return {
    startedBatchCount: nativeBatches,
    startedRequestedAssetCount: requestedAssets,
    completedBatchCount: nativeBatches,
    completedRequestedAssetCount: requestedAssets,
    resolvedBatchCount: nativeBatches,
    resolvedRequestedAssetCount: requestedAssets,
    rejectedBatchCount: 0,
    rejectedRequestedAssetCount: 0,
    cancelledBatchCount: 0,
    cancelledRequestedAssetCount: 0,
    inFlightBatchCount: 0,
    inFlightRequestedAssetCount: 0,
  };
}

function makeReport(
  strategy: Strategy,
  runId: string,
  durableTailSeconds: number,
  triggerToFirstProgressSeconds: number,
  maxRssKiB: number,
) {
  const fixtureCount = 100;
  const fullPlan = strategy === "full-plan-v1";
  const attemptedSamples = fullPlan ? 100 : 60;
  const skippedSamples = fixtureCount - attemptedSamples;
  const expectedNativeBatchCount = fullPlan ? 4 : 3;
  const nativeWorkCounters = makeCounters(attemptedSamples, expectedNativeBatchCount);
  const triggerEpochSeconds = 1_001.25;
  const triggerToDurableCompletionSeconds = triggerToFirstProgressSeconds + durableTailSeconds;
  const durableCompletionObservedAtEpochSeconds = triggerEpochSeconds + triggerToDurableCompletionSeconds;
  const preparedVisionStateSha256 = fullPlan ? fullPlanPreparedStateSha256 : rank3PreparedStateSha256;
  const packedResultTransport = parseResultTransport("packed-v1");
  const lookaheadPageOrchestrationStrategy = parsePageOrchestrationStrategy("lookahead");
  return {
    schemaVersion: 6,
    schemaCompatibility: {
      previousSchemaVersion: 5,
      semanticFieldsPreserved: true,
    },
    status: "ok",
    pageSize: 25,
    resultTransport: packedResultTransport,
    requestedResultTransport: packedResultTransport,
    visitFoodDetectionStrategy: strategy,
    pageOrchestrationStrategy: lookaheadPageOrchestrationStrategy,
    configuration: {
      resultPageSize: 25,
      resultTransport: packedResultTransport,
      requestedResultTransport: packedResultTransport,
      expectedResolvedResultTransport: packedResultTransport,
      classificationStrategy: "pipeline",
      classificationStrategyMode: "native-default",
      classificationStrategyEnvironmentValue: null,
      visitFoodDetectionStrategy: strategy,
      pageOrchestrationStrategy: lookaheadPageOrchestrationStrategy,
      visionConcurrency: 3,
      visionConcurrencyMode: "override",
      visionConcurrencyOverridden: true,
      visionConcurrencyEnvironmentValue: 3,
      pipelineDepth: 4,
      pipelineDepthMode: "native-default",
      pipelineDepthOverridden: false,
      pipelineDepthEnvironmentValue: null,
    },
    fixtureCount,
    expectedFoodCount: 20,
    actualFoodCount: 20,
    expectedFoodVisitCount: 15,
    actualFoodVisitCount: 15,
    workload: {
      visitFoodDetectionStrategy: strategy,
      plannedSamples: fixtureCount,
      attemptedSamples,
      successfulAttempts: attemptedSamples,
      retryableAttempts: 0,
      skippedSamples,
      expectedNativeBatchCount,
      directNativeCountersRequired: true,
      directNativeCountersAvailable: true,
      attemptAccountingSource: "native-dispatch-counters-plus-rank-plan-plus-durable-result-state",
      nativeDispatch: { ...nativeWorkCounters },
    },
    wallSeconds: durableTailSeconds,
    timing: {
      firstDurableProgressToCompletionSeconds: durableTailSeconds,
      triggerToDurableCompletionSeconds,
      triggerToFirstDurableProgressSeconds: triggerToFirstProgressSeconds,
      samplingIntervalSeconds: 0.2,
    },
    maxRssKiB,
    runtimeAttestation: {
      runId,
      observedProcessPageSize: 25,
      requestedResultTransport: packedResultTransport,
      observedProcessResultTransport: packedResultTransport,
      expectedResolvedResultTransport: packedResultTransport,
      observedProcessResultTransportEnvironmentValue: packedResultTransport,
      resultTransportEnvironmentPresent: true,
      expectedResolvedClassificationStrategy: "pipeline",
      observedProcessClassificationStrategyEnvironmentValue: null,
      classificationStrategyEnvironmentPresent: false,
      classificationStrategyAttestationSource: "validated-environment-absence-plus-native-default",
      expectedResolvedVisitFoodDetectionStrategy: strategy,
      observedProcessVisitFoodDetectionStrategyEnvironmentValue: strategy,
      visitFoodDetectionStrategyEnvironmentPresent: true,
      visitFoodDetectionStrategyAttestationSource: "process-environment-plus-strategy-aware-semantic-oracle",
      expectedResolvedPageOrchestrationStrategy: lookaheadPageOrchestrationStrategy,
      observedProcessPageOrchestrationStrategyEnvironmentValue: lookaheadPageOrchestrationStrategy,
      pageOrchestrationStrategyEnvironmentPresent: true,
      expectedResolvedVisionConcurrency: 3,
      observedProcessVisionConcurrencyEnvironmentValue: 3,
      visionConcurrencyEnvironmentPresent: true,
      expectedResolvedPipelineDepth: 4,
      observedProcessPipelineDepthEnvironmentValue: null,
      pipelineDepthEnvironmentPresent: false,
      observedAtEpochSeconds: 1_001.35,
      processEnvironmentObservedAtEpochSeconds: 1_000,
      nativeResultTransport: {
        schemaVersion: 2,
        runId,
        configuredResultTransport: packedResultTransport,
        resolvedResultTransport: packedResultTransport,
        selectedResultTransport: packedResultTransport,
        observedAtEpochSeconds: 1_001.35,
        lastObservedAtEpochSeconds: durableCompletionObservedAtEpochSeconds - 0.1,
        workCountersAvailable: true,
        workCounters: { ...nativeWorkCounters },
      },
      source: "process-environment-plus-native-result-transport-attestation",
    },
    triggerBoundary: {
      preparedVisionStateSha256,
      preTriggerVisionStateSha256: preparedVisionStateSha256,
      unchangedBeforeTrigger: true,
      preTriggerObservedAtEpochSeconds: 1_001,
      triggerEpochSeconds,
      triggerObservedAtEpochSeconds: 1_001.3,
      durableCompletionObservedAtEpochSeconds,
      maxTriggerAgeSeconds: 30,
      triggerFollowedPreTriggerAttestation: true,
      triggerWasNotFutureDated: true,
      triggerWasFresh: true,
    },
    buildAttestation: {
      strictCodeSignatureVerified: true,
      suppliedAppName: "Palate.app",
      runningAppName: "Palate.app",
      suppliedExecutableSha256: executableSha256,
      runningExecutableSha256: executableSha256,
      suppliedMainJsBundleSha256: bundleSha256,
      runningMainJsBundleSha256: bundleSha256,
      exactExecutableMatch: true,
      exactMainJsBundleMatch: true,
    },
    validation: {
      exactSemanticPhotoParity: fullPlan,
      photoMismatchCount: skippedSamples,
      exactStrategySemanticPhotoParity: true,
      strategyPhotoMismatchCount: 0,
      exactFullReferencePhotoParity: fullPlan,
      fullReferencePhotoMismatchCount: skippedSamples,
      successfulAttemptMismatchCount: 0,
      retryablePartialStateCount: 0,
      skippedWriteCount: 0,
      photoIdMismatchCount: 0,
      unplannedPendingCount: 0,
      exactVisitFoodParity: true,
      visitMismatchCount: 0,
      exactPositiveVisitSet: true,
      positiveVisitIdMismatchCount: 0,
      invalidVisitFoodCount: 0,
      pendingCount: skippedSamples,
      pendingRowsAreExpected: true,
      workloadAccountingExact: true,
      nativeWorkCountersRequired: true,
      nativeWorkCountersAvailable: true,
      nativeWorkLifecycleBalanced: true,
      nativeRequestedAssetCountMatchesAttempts: true,
      nativeBatchCountMatchesPlan: true,
      integrity: "ok",
      foreignKeyViolationCount: 0,
    },
    originalDatabaseSha256,
    originalDatabase: {
      main: { present: true, sha256: originalDatabaseSha256, mode: "640" },
      wal: { present: true, sha256: walSha256, mode: "600" },
      shm: { present: true, sha256: shmSha256, mode: "640" },
      journal: { present: false, sha256: null, mode: null },
    },
    standaloneSnapshotSha256,
    semanticReference: {
      source: "live-original-snapshot",
      sha256: standaloneSnapshotSha256,
      components: {
        main: {
          present: true,
          sha256: standaloneSnapshotSha256,
          mode: "600",
          bytes: 52_000_000,
        },
        wal: { present: false, sha256: null, mode: null, bytes: null },
        shm: { present: false, sha256: null, mode: null, bytes: null },
        journal: { present: false, sha256: null, mode: null, bytes: null },
      },
    },
    resultDatabase: {
      sha256: resultDatabaseSha256,
      retained: false,
      path: null,
    },
    rawDatabases: {
      retained: false,
      snapshotPath: null,
    },
    restoration: {
      exactMainAndSidecarSetRestored: true,
      launchEnvironmentRestored: true,
      rawDatabasePolicyApplied: true,
      reportPublishedAfterRestoration: true,
      restoredDatabaseSha256: originalDatabaseSha256,
    },
    samplesPath: `${runId}.samples.tsv`,
  };
}

type TestReport = ReturnType<typeof makeReport>;

interface FixtureSet {
  reports: {
    fullPlan: TestReport[];
    rank3BulkTail: TestReport[];
  };
  paths: {
    fullPlan: string[];
    rank3BulkTail: string[];
    output: string;
  };
}

function createFixtureSet(caseName: string): FixtureSet {
  const directory = join(temporaryDirectory, caseName);
  mkdirSync(directory, { recursive: true });
  return {
    reports: {
      fullPlan: [
        makeReport("full-plan-v1", `${caseName}-full-1`, 12, 2, 500_000),
        makeReport("full-plan-v1", `${caseName}-full-2`, 10, 2, 510_000),
        makeReport("full-plan-v1", `${caseName}-full-3`, 14, 2, 520_000),
      ],
      rank3BulkTail: [
        makeReport("rank3-bulk-tail-v1", `${caseName}-rank3-1`, 9, 1, 450_000),
        makeReport("rank3-bulk-tail-v1", `${caseName}-rank3-2`, 8, 1, 460_000),
        makeReport("rank3-bulk-tail-v1", `${caseName}-rank3-3`, 10, 1, 470_000),
      ],
    },
    paths: {
      fullPlan: [join(directory, "full-1.json"), join(directory, "full-2.json"), join(directory, "full-3.json")],
      rank3BulkTail: [
        join(directory, "rank3-1.json"),
        join(directory, "rank3-2.json"),
        join(directory, "rank3-3.json"),
      ],
      output: join(directory, "summary.json"),
    },
  };
}

function writeFixtureSet(fixtureSet: FixtureSet): void {
  const reports = [...fixtureSet.reports.fullPlan, ...fixtureSet.reports.rank3BulkTail];
  const paths = [...fixtureSet.paths.fullPlan, ...fixtureSet.paths.rank3BulkTail];
  assert.equal(paths.length, reports.length, "fixture path/report count");
  for (let index = 0; index < paths.length; index += 1) {
    writeFileSync(paths[index]!, `${JSON.stringify(reports[index], null, 2)}\n`, { mode: 0o600 });
  }
}

function execute(fixtureSet: FixtureSet): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      summarizerPath,
      `--full-plan-v1=${fixtureSet.paths.fullPlan.join(",")}`,
      `--rank3-bulk-tail-v1=${fixtureSet.paths.rank3BulkTail.join(",")}`,
      `--output=${fixtureSet.paths.output}`,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

function hasErrorCode(cause: Error): cause is Error & { code: string } {
  return "code" in cause && typeof cause.code === "string";
}

function requiredJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requiredJsonNumber(value: JsonValue | undefined, label: string): number {
  if (!isJsonNumber(value)) {
    throw new TypeError(`${label} must be a number.`);
  }
  return value;
}

function requiredNullableJsonNumber(value: JsonValue | undefined, label: string): number | null {
  if (value === null) {
    return null;
  }
  return requiredJsonNumber(value, label);
}

function requiredJsonString(value: JsonValue | undefined, label: string): string {
  if (!isJsonString(value)) {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function requiredNullableJsonString(value: JsonValue | undefined, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredJsonString(value, label);
}

function requiredJsonBoolean(value: JsonValue | undefined, label: string): boolean {
  if (!isJsonBoolean(value)) {
    throw new TypeError(`${label} must be a boolean.`);
  }
  return value;
}

function requiredJsonNumberArray(value: JsonValue | undefined, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return value.map((entry, index) => requiredJsonNumber(entry, `${label}[${index}]`));
}

function requiredJsonStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return value.map((entry, index) => requiredJsonString(entry, `${label}[${index}]`));
}

function parseVisitFoodStrategy(value: JsonValue | undefined, label: string): Strategy {
  const strategy = requiredJsonString(value, label);
  if (strategy !== "full-plan-v1" && strategy !== "rank3-bulk-tail-v1") {
    throw new TypeError(`${label} is unsupported.`);
  }
  return strategy;
}

function parseVisitFoodStrategyOrTie(value: JsonValue | undefined, label: string): Strategy | "tie" {
  if (value === "tie") {
    return value;
  }
  return parseVisitFoodStrategy(value, label);
}

function parseSummaryValidation(value: JsonValue | undefined): VisitFoodSummaryValidation {
  const object = requiredJsonObject(value, "summary.validation");
  const validation: VisitFoodSummaryValidation = {};
  for (const [key, entry] of Object.entries(object)) {
    validation[key] = requiredJsonBoolean(entry, `summary.validation.${key}`);
  }
  return validation;
}

function parseDelta(value: JsonValue | undefined, label: string): Delta {
  const object = requiredJsonObject(value, label);
  return {
    baseline: requiredJsonNumber(object.baseline, `${label}.baseline`),
    candidate: requiredJsonNumber(object.candidate, `${label}.candidate`),
    candidateMinusBaseline: requiredJsonNumber(object.candidateMinusBaseline, `${label}.candidateMinusBaseline`),
    candidateMinusBaselinePercent: requiredNullableJsonNumber(
      object.candidateMinusBaselinePercent,
      `${label}.candidateMinusBaselinePercent`,
    ),
  };
}

function parseAvoided(value: JsonValue | undefined, label: string): Avoided {
  const object = requiredJsonObject(value, label);
  return {
    baseline: requiredJsonNumber(object.baseline, `${label}.baseline`),
    candidate: requiredJsonNumber(object.candidate, `${label}.candidate`),
    avoided: requiredJsonNumber(object.avoided, `${label}.avoided`),
    avoidedPercent: requiredJsonNumber(object.avoidedPercent, `${label}.avoidedPercent`),
  };
}

function parseStrategySummary(value: JsonValue | undefined, label: string): StrategySummary {
  const object = requiredJsonObject(value, label);
  const timing = requiredJsonObject(object.timing, `${label}.timing`);
  const rss = requiredJsonObject(object.rss, `${label}.rss`);
  const directWork = requiredJsonObject(object.directWork, `${label}.directWork`);
  return {
    strategy: parseVisitFoodStrategy(object.strategy, `${label}.strategy`),
    reports: requiredJsonStringArray(object.reports, `${label}.reports`),
    runIds: requiredJsonStringArray(object.runIds, `${label}.runIds`),
    sampleCount: requiredJsonNumber(object.sampleCount, `${label}.sampleCount`),
    timing: {
      firstDurableProgressToCompletionSeconds: requiredJsonNumberArray(
        timing.firstDurableProgressToCompletionSeconds,
        `${label}.timing.firstDurableProgressToCompletionSeconds`,
      ),
      medianFirstDurableProgressToCompletionSeconds: requiredJsonNumber(
        timing.medianFirstDurableProgressToCompletionSeconds,
        `${label}.timing.medianFirstDurableProgressToCompletionSeconds`,
      ),
      triggerToDurableCompletionSeconds: requiredJsonNumberArray(
        timing.triggerToDurableCompletionSeconds,
        `${label}.timing.triggerToDurableCompletionSeconds`,
      ),
      medianTriggerToDurableCompletionSeconds: requiredJsonNumber(
        timing.medianTriggerToDurableCompletionSeconds,
        `${label}.timing.medianTriggerToDurableCompletionSeconds`,
      ),
      triggerToFirstDurableProgressSeconds: requiredJsonNumberArray(
        timing.triggerToFirstDurableProgressSeconds,
        `${label}.timing.triggerToFirstDurableProgressSeconds`,
      ),
      medianTriggerToFirstDurableProgressSeconds: requiredJsonNumber(
        timing.medianTriggerToFirstDurableProgressSeconds,
        `${label}.timing.medianTriggerToFirstDurableProgressSeconds`,
      ),
    },
    rss: {
      maxRssKiB: requiredJsonNumberArray(rss.maxRssKiB, `${label}.rss.maxRssKiB`),
      medianMaxRssKiB: requiredJsonNumber(rss.medianMaxRssKiB, `${label}.rss.medianMaxRssKiB`),
    },
    directWork: {
      requestedAssets: requiredJsonNumberArray(directWork.requestedAssets, `${label}.directWork.requestedAssets`),
      totalRequestedAssets: requiredJsonNumber(
        directWork.totalRequestedAssets,
        `${label}.directWork.totalRequestedAssets`,
      ),
      medianRequestedAssets: requiredJsonNumber(
        directWork.medianRequestedAssets,
        `${label}.directWork.medianRequestedAssets`,
      ),
      nativeBatches: requiredJsonNumberArray(directWork.nativeBatches, `${label}.directWork.nativeBatches`),
      totalNativeBatches: requiredJsonNumber(directWork.totalNativeBatches, `${label}.directWork.totalNativeBatches`),
      medianNativeBatches: requiredJsonNumber(
        directWork.medianNativeBatches,
        `${label}.directWork.medianNativeBatches`,
      ),
    },
  };
}

function parseSummaryPair(value: JsonValue, index: number): SuccessSummary["comparison"]["pairs"][number] {
  const label = `summary.comparison.pairs[${index}]`;
  const object = requiredJsonObject(value, label);
  const timing = requiredJsonObject(object.timing, `${label}.timing`);
  const directWork = requiredJsonObject(object.directWork, `${label}.directWork`);
  return {
    pairIndex: requiredJsonNumber(object.pairIndex, `${label}.pairIndex`),
    fullPlanRunId: requiredJsonString(object.fullPlanRunId, `${label}.fullPlanRunId`),
    rank3BulkTailRunId: requiredJsonString(object.rank3BulkTailRunId, `${label}.rank3BulkTailRunId`),
    timing: {
      firstDurableProgressToCompletionSeconds: parseDelta(
        timing.firstDurableProgressToCompletionSeconds,
        `${label}.timing.firstDurableProgressToCompletionSeconds`,
      ),
    },
    directWork: {
      requestedAssets: parseAvoided(directWork.requestedAssets, `${label}.directWork.requestedAssets`),
      nativeBatches: parseAvoided(directWork.nativeBatches, `${label}.directWork.nativeBatches`),
    },
    fasterDurableTail: parseVisitFoodStrategyOrTie(object.fasterDurableTail, `${label}.fasterDurableTail`),
  };
}

function parseSuccessSummary(source: string): SuccessSummary {
  const object = requiredJsonObject(parseJsonValue(source), "summary");
  const inputIdentity = requiredJsonObject(object.inputIdentity, "summary.inputIdentity");
  const preparedState = requiredJsonObject(
    inputIdentity.preparedVisionStateSha256ByStrategy,
    "summary.inputIdentity.preparedVisionStateSha256ByStrategy",
  );
  const comparison = requiredJsonObject(object.comparison, "summary.comparison");
  const medianDeltas = requiredJsonObject(comparison.medianDeltas, "summary.comparison.medianDeltas");
  const aggregateAvoidedWork = requiredJsonObject(
    comparison.aggregateAvoidedWork,
    "summary.comparison.aggregateAvoidedWork",
  );
  const medianAvoidedWork = requiredJsonObject(comparison.medianAvoidedWork, "summary.comparison.medianAvoidedWork");
  const pairwiseWins = requiredJsonObject(comparison.pairwiseWins, "summary.comparison.pairwiseWins");
  if (!Array.isArray(comparison.pairs)) {
    throw new TypeError("summary.comparison.pairs must be an array.");
  }
  return {
    schemaVersion: requiredJsonNumber(object.schemaVersion, "summary.schemaVersion"),
    inputReportSchemaVersion: requiredJsonNumber(object.inputReportSchemaVersion, "summary.inputReportSchemaVersion"),
    status: requiredJsonString(object.status, "summary.status"),
    validation: parseSummaryValidation(object.validation),
    inputIdentity: {
      appName: requiredJsonString(inputIdentity.appName, "summary.inputIdentity.appName"),
      pageSize: requiredJsonNumber(inputIdentity.pageSize, "summary.inputIdentity.pageSize"),
      requestedResultTransport: parseResultTransport(
        requiredJsonString(inputIdentity.requestedResultTransport, "summary.inputIdentity.requestedResultTransport"),
      ),
      resultTransport: parseResultTransport(
        requiredJsonString(inputIdentity.resultTransport, "summary.inputIdentity.resultTransport"),
      ),
      pageOrchestrationStrategy: parsePageOrchestrationStrategy(
        requiredJsonString(inputIdentity.pageOrchestrationStrategy, "summary.inputIdentity.pageOrchestrationStrategy"),
      ),
      classificationStrategy: requiredJsonString(
        inputIdentity.classificationStrategy,
        "summary.inputIdentity.classificationStrategy",
      ),
      classificationStrategyMode: requiredJsonString(
        inputIdentity.classificationStrategyMode,
        "summary.inputIdentity.classificationStrategyMode",
      ),
      classificationStrategyEnvironmentValue: requiredNullableJsonString(
        inputIdentity.classificationStrategyEnvironmentValue,
        "summary.inputIdentity.classificationStrategyEnvironmentValue",
      ),
      fixtureCount: requiredJsonNumber(inputIdentity.fixtureCount, "summary.inputIdentity.fixtureCount"),
      originalDatabaseSha256: requiredJsonString(
        inputIdentity.originalDatabaseSha256,
        "summary.inputIdentity.originalDatabaseSha256",
      ),
      standaloneSnapshotSha256: requiredJsonString(
        inputIdentity.standaloneSnapshotSha256,
        "summary.inputIdentity.standaloneSnapshotSha256",
      ),
      preparedVisionStateSha256ByStrategy: {
        fullPlanV1: requiredJsonString(
          preparedState.fullPlanV1,
          "summary.inputIdentity.preparedVisionStateSha256ByStrategy.fullPlanV1",
        ),
        rank3BulkTailV1: requiredJsonString(
          preparedState.rank3BulkTailV1,
          "summary.inputIdentity.preparedVisionStateSha256ByStrategy.rank3BulkTailV1",
        ),
      },
    },
    fullPlan: parseStrategySummary(object.fullPlan, "summary.fullPlan"),
    rank3BulkTail: parseStrategySummary(object.rank3BulkTail, "summary.rank3BulkTail"),
    comparison: {
      interpretation: requiredJsonString(comparison.interpretation, "summary.comparison.interpretation"),
      medianDeltas: {
        firstDurableProgressToCompletionSeconds: parseDelta(
          medianDeltas.firstDurableProgressToCompletionSeconds,
          "summary.comparison.medianDeltas.firstDurableProgressToCompletionSeconds",
        ),
        triggerToDurableCompletionSeconds: parseDelta(
          medianDeltas.triggerToDurableCompletionSeconds,
          "summary.comparison.medianDeltas.triggerToDurableCompletionSeconds",
        ),
        triggerToFirstDurableProgressSeconds: parseDelta(
          medianDeltas.triggerToFirstDurableProgressSeconds,
          "summary.comparison.medianDeltas.triggerToFirstDurableProgressSeconds",
        ),
        maxRssKiB: parseDelta(medianDeltas.maxRssKiB, "summary.comparison.medianDeltas.maxRssKiB"),
      },
      aggregateAvoidedWork: {
        requestedAssets: parseAvoided(
          aggregateAvoidedWork.requestedAssets,
          "summary.comparison.aggregateAvoidedWork.requestedAssets",
        ),
        nativeBatches: parseAvoided(
          aggregateAvoidedWork.nativeBatches,
          "summary.comparison.aggregateAvoidedWork.nativeBatches",
        ),
      },
      medianAvoidedWork: {
        requestedAssets: parseAvoided(
          medianAvoidedWork.requestedAssets,
          "summary.comparison.medianAvoidedWork.requestedAssets",
        ),
        nativeBatches: parseAvoided(
          medianAvoidedWork.nativeBatches,
          "summary.comparison.medianAvoidedWork.nativeBatches",
        ),
      },
      pairwiseWins: {
        rank3BulkTail: requiredJsonNumber(pairwiseWins.rank3BulkTail, "summary.comparison.pairwiseWins.rank3BulkTail"),
        fullPlan: requiredJsonNumber(pairwiseWins.fullPlan, "summary.comparison.pairwiseWins.fullPlan"),
        ties: requiredJsonNumber(pairwiseWins.ties, "summary.comparison.pairwiseWins.ties"),
      },
      pairs: comparison.pairs.map(parseSummaryPair),
    },
    limitations: requiredJsonStringArray(object.limitations, "summary.limitations"),
  };
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && hasErrorCode(cause) && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function assertFailure(
  caseName: string,
  fixtureSet: FixtureSet,
  result: SpawnSyncReturns<string>,
  expectedMessage: RegExp,
): void {
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(`${result.stderr}\n${result.stdout}`, expectedMessage, `${caseName} failure message`);
  assert.equal(pathExists(fixtureSet.paths.output), false, `${caseName} published a partial summary`);
}

function expectReportFailure(
  caseName: string,
  mutate: (fixtureSet: FixtureSet) => void,
  expectedMessage: RegExp,
): void {
  const fixtureSet = createFixtureSet(caseName);
  mutate(fixtureSet);
  writeFixtureSet(fixtureSet);
  assertFailure(caseName, fixtureSet, execute(fixtureSet), expectedMessage);
}

function expectPathFailure(caseName: string, mutate: (fixtureSet: FixtureSet) => void, expectedMessage: RegExp): void {
  const fixtureSet = createFixtureSet(caseName);
  writeFixtureSet(fixtureSet);
  mutate(fixtureSet);
  assertFailure(caseName, fixtureSet, execute(fixtureSet), expectedMessage);
}

function updateRunId(report: TestReport, runId: string): void {
  report.runtimeAttestation.runId = runId;
  report.runtimeAttestation.nativeResultTransport.runId = runId;
}

function updateRequestedAssetCounters(report: TestReport, requestedAssets: number): void {
  for (const counters of [
    report.runtimeAttestation.nativeResultTransport.workCounters,
    report.workload.nativeDispatch,
  ]) {
    counters.startedRequestedAssetCount = requestedAssets;
    counters.completedRequestedAssetCount = requestedAssets;
    counters.resolvedRequestedAssetCount = requestedAssets;
  }
}

function updateBatchCounters(report: TestReport, nativeBatches: number): void {
  for (const counters of [
    report.runtimeAttestation.nativeResultTransport.workCounters,
    report.workload.nativeDispatch,
  ]) {
    counters.startedBatchCount = nativeBatches;
    counters.completedBatchCount = nativeBatches;
    counters.resolvedBatchCount = nativeBatches;
  }
}

function updateTransport(report: TestReport, transport: ResultTransport): void {
  report.resultTransport = transport;
  report.requestedResultTransport = transport;
  report.configuration.resultTransport = transport;
  report.configuration.requestedResultTransport = transport;
  report.configuration.expectedResolvedResultTransport = transport;
  report.runtimeAttestation.requestedResultTransport = transport;
  report.runtimeAttestation.observedProcessResultTransport = transport;
  report.runtimeAttestation.expectedResolvedResultTransport = transport;
  report.runtimeAttestation.observedProcessResultTransportEnvironmentValue = transport;
  report.runtimeAttestation.nativeResultTransport.configuredResultTransport = transport;
  report.runtimeAttestation.nativeResultTransport.resolvedResultTransport = transport;
  report.runtimeAttestation.nativeResultTransport.selectedResultTransport = transport;
}

function updateOrchestration(report: TestReport, strategy: PageOrchestrationStrategy): void {
  report.pageOrchestrationStrategy = strategy;
  report.configuration.pageOrchestrationStrategy = strategy;
  report.runtimeAttestation.expectedResolvedPageOrchestrationStrategy = strategy;
  report.runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue = strategy;
}

try {
  const helpResult = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", summarizerPath, "--help"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--full-plan-v1=REPORT/);
  assert.match(helpResult.stdout, /--rank3-bulk-tail-v1=REPORT/);

  const success = createFixtureSet("success");
  writeFixtureSet(success);
  const successResult = execute(success);
  assert.equal(successResult.status, 0, successResult.stderr);
  assert.match(successResult.stdout, /descriptive summary: 40\.00% direct requested assets avoided/);
  const summaryText = readFileSync(success.paths.output, "utf8");
  const summary = parseSuccessSummary(summaryText);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.inputReportSchemaVersion, 6);
  assert.equal(summary.status, "ok");
  assert.ok(
    Object.values(summary.validation).every((value) => value),
    "all summary attestations",
  );
  assert.deepEqual(summary.inputIdentity, {
    ...summary.inputIdentity,
    appName: "Palate.app",
    pageSize: 25,
    requestedResultTransport: "packed-v1",
    resultTransport: "packed-v1",
    pageOrchestrationStrategy: "lookahead",
    classificationStrategy: "pipeline",
    classificationStrategyMode: "native-default",
    classificationStrategyEnvironmentValue: null,
    fixtureCount: 100,
    originalDatabaseSha256,
    standaloneSnapshotSha256,
    preparedVisionStateSha256ByStrategy: {
      fullPlanV1: fullPlanPreparedStateSha256,
      rank3BulkTailV1: rank3PreparedStateSha256,
    },
  });
  assert.equal(summary.fullPlan.strategy, "full-plan-v1");
  assert.equal(summary.rank3BulkTail.strategy, "rank3-bulk-tail-v1");
  assert.equal(summary.fullPlan.sampleCount, 3);
  assert.equal(summary.rank3BulkTail.sampleCount, 3);
  assert.deepEqual(summary.fullPlan.reports, ["full-1.json", "full-2.json", "full-3.json"]);
  assert.deepEqual(summary.rank3BulkTail.reports, ["rank3-1.json", "rank3-2.json", "rank3-3.json"]);
  assert.deepEqual(summary.fullPlan.runIds, ["success-full-1", "success-full-2", "success-full-3"]);
  assert.deepEqual(summary.rank3BulkTail.runIds, ["success-rank3-1", "success-rank3-2", "success-rank3-3"]);
  assert.deepEqual(summary.fullPlan.timing.firstDurableProgressToCompletionSeconds, [12, 10, 14]);
  assert.deepEqual(summary.rank3BulkTail.timing.firstDurableProgressToCompletionSeconds, [9, 8, 10]);
  assert.equal(summary.fullPlan.timing.medianFirstDurableProgressToCompletionSeconds, 12);
  assert.equal(summary.rank3BulkTail.timing.medianFirstDurableProgressToCompletionSeconds, 9);
  assert.equal(summary.fullPlan.timing.medianTriggerToDurableCompletionSeconds, 14);
  assert.equal(summary.rank3BulkTail.timing.medianTriggerToDurableCompletionSeconds, 10);
  assert.equal(summary.fullPlan.timing.medianTriggerToFirstDurableProgressSeconds, 2);
  assert.equal(summary.rank3BulkTail.timing.medianTriggerToFirstDurableProgressSeconds, 1);
  assert.deepEqual(summary.fullPlan.rss.maxRssKiB, [500_000, 510_000, 520_000]);
  assert.deepEqual(summary.rank3BulkTail.rss.maxRssKiB, [450_000, 460_000, 470_000]);
  assert.equal(summary.fullPlan.rss.medianMaxRssKiB, 510_000);
  assert.equal(summary.rank3BulkTail.rss.medianMaxRssKiB, 460_000);
  assert.deepEqual(summary.fullPlan.directWork.requestedAssets, [100, 100, 100]);
  assert.deepEqual(summary.rank3BulkTail.directWork.requestedAssets, [60, 60, 60]);
  assert.equal(summary.fullPlan.directWork.totalRequestedAssets, 300);
  assert.equal(summary.rank3BulkTail.directWork.totalRequestedAssets, 180);
  assert.deepEqual(summary.fullPlan.directWork.nativeBatches, [4, 4, 4]);
  assert.deepEqual(summary.rank3BulkTail.directWork.nativeBatches, [3, 3, 3]);
  assert.equal(summary.fullPlan.directWork.totalNativeBatches, 12);
  assert.equal(summary.rank3BulkTail.directWork.totalNativeBatches, 9);
  assert.equal(summary.comparison.interpretation, "descriptive-only-non-causal");
  assert.deepEqual(summary.comparison.medianDeltas.firstDurableProgressToCompletionSeconds, {
    baseline: 12,
    candidate: 9,
    candidateMinusBaseline: -3,
    candidateMinusBaselinePercent: -25,
  });
  assert.equal(summary.comparison.medianDeltas.maxRssKiB.candidateMinusBaseline, -50_000);
  assert.deepEqual(summary.comparison.aggregateAvoidedWork.requestedAssets, {
    baseline: 300,
    candidate: 180,
    avoided: 120,
    avoidedPercent: 40,
  });
  assert.deepEqual(summary.comparison.aggregateAvoidedWork.nativeBatches, {
    baseline: 12,
    candidate: 9,
    avoided: 3,
    avoidedPercent: 25,
  });
  assert.deepEqual(summary.comparison.medianAvoidedWork.requestedAssets, {
    baseline: 100,
    candidate: 60,
    avoided: 40,
    avoidedPercent: 40,
  });
  assert.deepEqual(summary.comparison.pairwiseWins, { rank3BulkTail: 3, fullPlan: 0, ties: 0 });
  assert.equal(summary.comparison.pairs.length, 3);
  assert.deepEqual(
    summary.comparison.pairs.map((pair) => pair.fasterDurableTail),
    ["rank3-bulk-tail-v1", "rank3-bulk-tail-v1", "rank3-bulk-tail-v1"],
  );
  assert.deepEqual(summary.comparison.pairs[0]!.directWork.requestedAssets, {
    baseline: 100,
    candidate: 60,
    avoided: 40,
    avoidedPercent: 40,
  });
  assert.ok(summary.limitations.some((limitation) => /descriptive, non-causal/i.test(limitation)));
  assert.ok(summary.limitations.some((limitation) => /comma-list position/i.test(limitation)));
  assert.equal(statSync(success.paths.output).mode & 0o777, 0o600, "summary mode");
  assert.equal(summaryText.includes(temporaryDirectory), false, "summary leaked an absolute fixture path");
  assert.equal(summaryText.includes("samples.tsv"), false, "summary leaked a samples path");
  assert.equal(summaryText.includes("snapshot.sqlite"), false, "summary leaked a raw database path");
  assert.equal(
    readdirSync(dirname(success.paths.output)).some(
      (entry) => entry.endsWith("summary.json.tmp") || entry.includes(".tmp-"),
    ),
    false,
    "temporary summary artifact remained",
  );

  expectPathFailure(
    "too-few",
    (fixtureSet) => {
      fixtureSet.paths.fullPlan = fixtureSet.paths.fullPlan.slice(0, 2);
      fixtureSet.paths.rank3BulkTail = fixtureSet.paths.rank3BulkTail.slice(0, 2);
    },
    /full-plan-v1 requires at least three measured reports/,
  );
  expectPathFailure(
    "unequal-groups",
    (fixtureSet) => {
      fixtureSet.paths.rank3BulkTail.pop();
    },
    /A\/B report groups must have equal nonzero sample counts/,
  );
  expectPathFailure(
    "duplicate-path",
    (fixtureSet) => {
      fixtureSet.paths.rank3BulkTail[2] = fixtureSet.paths.rank3BulkTail[1]!;
    },
    /Input report paths must be unique/,
  );
  expectPathFailure(
    "duplicate-inode",
    (fixtureSet) => {
      unlinkSync(fixtureSet.paths.rank3BulkTail[2]!);
      linkSync(fixtureSet.paths.rank3BulkTail[1]!, fixtureSet.paths.rank3BulkTail[2]!);
    },
    /Input report file identities must be unique/,
  );
  expectReportFailure(
    "duplicate-run-id",
    (fixtureSet) => {
      updateRunId(fixtureSet.reports.rank3BulkTail[0]!, fixtureSet.reports.fullPlan[0]!.runtimeAttestation.runId);
    },
    /Runtime run IDs must be distinct/,
  );
  expectReportFailure(
    "wrong-strategy",
    (fixtureSet) => {
      fixtureSet.reports.fullPlan[0]!.visitFoodDetectionStrategy = "rank3-bulk-tail-v1";
    },
    /top-level visit-food strategy/,
  );
  expectReportFailure(
    "schema-one-native-counters",
    (fixtureSet) => {
      fixtureSet.reports.fullPlan[0]!.runtimeAttestation.nativeResultTransport.schemaVersion = 1;
    },
    /native result-transport schema must be exactly 2/,
  );
  expectReportFailure(
    "unbalanced-native-counters",
    (fixtureSet) => {
      fixtureSet.reports.fullPlan[0]!.runtimeAttestation.nativeResultTransport.workCounters.completedBatchCount = 3;
    },
    /completed batch balance/,
  );
  expectReportFailure(
    "direct-asset-mismatch",
    (fixtureSet) => {
      updateRequestedAssetCounters(fixtureSet.reports.fullPlan[0]!, 99);
    },
    /direct requested-asset total/,
  );
  expectReportFailure(
    "direct-batch-mismatch",
    (fixtureSet) => {
      updateBatchCounters(fixtureSet.reports.fullPlan[0]!, 5);
    },
    /direct native-batch total/,
  );
  expectReportFailure(
    "semantic-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.rank3BulkTail[0]!.validation.exactStrategySemanticPhotoParity = false;
    },
    /exact strategy photo parity/,
  );
  expectReportFailure(
    "retryable-confound",
    (fixtureSet) => {
      const report = fixtureSet.reports.rank3BulkTail[0]!;
      report.workload.successfulAttempts = 59;
      report.workload.retryableAttempts = 1;
      report.validation.pendingCount = 41;
    },
    /retryable attempts would confound a completed A\/B/,
  );
  expectReportFailure(
    "adaptive-without-avoided-work",
    (fixtureSet) => {
      const report = fixtureSet.reports.rank3BulkTail[0]!;
      report.workload.attemptedSamples = 100;
      report.workload.successfulAttempts = 100;
      report.workload.skippedSamples = 0;
      report.validation.pendingCount = 0;
      report.validation.exactSemanticPhotoParity = true;
      report.validation.photoMismatchCount = 0;
      report.validation.exactFullReferencePhotoParity = true;
      report.validation.fullReferencePhotoMismatchCount = 0;
      updateRequestedAssetCounters(report, 100);
    },
    /adaptive strategy did not avoid any work/,
  );
  expectReportFailure(
    "signed-build-mismatch",
    (fixtureSet) => {
      const report = fixtureSet.reports.rank3BulkTail[0]!;
      report.buildAttestation.suppliedExecutableSha256 = "4".repeat(64);
      report.buildAttestation.runningExecutableSha256 = "4".repeat(64);
    },
    /A\/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch/,
  );
  expectReportFailure(
    "reference-mismatch",
    (fixtureSet) => {
      const report = fixtureSet.reports.rank3BulkTail[0]!;
      report.semanticReference.sha256 = "5".repeat(64);
      report.semanticReference.components.main.sha256 = "5".repeat(64);
    },
    /A\/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch/,
  );
  expectReportFailure(
    "tuning-mismatch",
    (fixtureSet) => {
      const report = fixtureSet.reports.rank3BulkTail[0]!;
      report.configuration.visionConcurrency = 4;
      report.configuration.visionConcurrencyEnvironmentValue = 4;
      report.runtimeAttestation.expectedResolvedVisionConcurrency = 4;
      report.runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue = 4;
    },
    /A\/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch/,
  );
  expectReportFailure(
    "orchestration-mismatch",
    (fixtureSet) => {
      updateOrchestration(fixtureSet.reports.rank3BulkTail[0]!, "serial");
    },
    /A\/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch/,
  );
  expectReportFailure(
    "transport-mismatch",
    (fixtureSet) => {
      updateTransport(fixtureSet.reports.rank3BulkTail[0]!, "legacy");
    },
    /A\/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch/,
  );
  expectReportFailure(
    "classification-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.rank3BulkTail[0]!.configuration.classificationStrategy = "baseline";
    },
    /classification strategy/,
  );
  expectReportFailure(
    "fixture-mismatch",
    (fixtureSet) => {
      const report = fixtureSet.reports.fullPlan[0]!;
      report.triggerBoundary.preparedVisionStateSha256 = "6".repeat(64);
      report.triggerBoundary.preTriggerVisionStateSha256 = "6".repeat(64);
    },
    /full-plan-v1: prepared fixture identity mismatch/,
  );
  expectReportFailure(
    "stale-trigger-freshness-flag",
    (fixtureSet) => {
      fixtureSet.reports.rank3BulkTail[0]!.triggerBoundary.maxTriggerAgeSeconds = 0.01;
    },
    /trigger age exceeds its maximum/,
  );
  expectReportFailure(
    "restoration-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.rank3BulkTail[0]!.restoration.exactMainAndSidecarSetRestored = false;
    },
    /exact database restoration/,
  );
  expectReportFailure(
    "raw-path",
    (fixtureSet) => {
      Object.assign(fixtureSet.reports.rank3BulkTail[0]!.rawDatabases, {
        snapshotPath: "private-snapshot.sqlite",
      });
    },
    /raw snapshot path must be null/,
  );

  const existingOutput = createFixtureSet("preexisting-output");
  writeFixtureSet(existingOutput);
  writeFileSync(existingOutput.paths.output, "user-owned-summary\n", { mode: 0o600 });
  const existingOutputResult = execute(existingOutput);
  assert.notEqual(existingOutputResult.status, 0, "preexisting output unexpectedly succeeded");
  assert.match(existingOutputResult.stderr, /Refusing to overwrite existing output/);
  assert.equal(readFileSync(existingOutput.paths.output, "utf8"), "user-owned-summary\n");

  const temporaryCollision = createFixtureSet("temporary-collision");
  writeFixtureSet(temporaryCollision);
  const collidingTemporaryPath = `${temporaryCollision.paths.output}.tmp`;
  writeFileSync(collidingTemporaryPath, "user-owned-temporary-file\n", { mode: 0o600 });
  const temporaryCollisionResult = execute(temporaryCollision);
  assert.notEqual(temporaryCollisionResult.status, 0, "temporary collision unexpectedly succeeded");
  assert.match(temporaryCollisionResult.stderr, /EEXIST/);
  assert.equal(pathExists(temporaryCollision.paths.output), false, "temporary collision published an output");
  assert.equal(
    readFileSync(collidingTemporaryPath, "utf8"),
    "user-owned-temporary-file\n",
    "temporary collision deleted or changed a pre-existing file",
  );

  console.log("macOS Vision visit-food strategy A/B summary tests passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
