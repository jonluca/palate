#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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

type ResultTransport = "legacy" | "packed-v1";
type Strategy = "serial" | "lookahead";
type TuningMode = "native-default" | "override";

interface DatabaseComponent {
  present: boolean;
  sha256: string | null;
  mode: string | null;
}

interface SemanticReferenceComponent extends DatabaseComponent {
  bytes: number | null;
}

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

interface SemanticReference {
  source: "live-original-snapshot" | "external-current-control";
  sha256: string;
  components: {
    main: SemanticReferenceComponent;
    wal: SemanticReferenceComponent;
    shm: SemanticReferenceComponent;
    journal: SemanticReferenceComponent;
  };
}

interface TestReport {
  schemaVersion: number;
  schemaCompatibility: {
    previousSchemaVersion: number;
    semanticFieldsPreserved: boolean;
  };
  status: string;
  pageSize: number;
  resultTransport: ResultTransport;
  requestedResultTransport: ResultTransport;
  pageOrchestrationStrategy: Strategy;
  configuration: {
    resultPageSize: number;
    resultTransport: ResultTransport;
    requestedResultTransport: ResultTransport;
    expectedResolvedResultTransport: ResultTransport;
    pageOrchestrationStrategy: Strategy;
    visionConcurrency: number;
    visionConcurrencyMode: TuningMode;
    visionConcurrencyOverridden: boolean;
    visionConcurrencyEnvironmentValue: number | null;
    pipelineDepth: number;
    pipelineDepthMode: TuningMode;
    pipelineDepthOverridden: boolean;
    pipelineDepthEnvironmentValue: number | null;
  };
  fixtureCount: number;
  expectedFoodCount: number;
  expectedFoodVisitCount: number;
  workload: {
    attemptedSamples: number;
    expectedNativeBatchCount: number;
    directNativeCountersRequired: boolean;
    directNativeCountersAvailable: boolean;
    attemptAccountingSource: string;
    nativeDispatch: NativeWorkCounters | null;
  };
  wallSeconds: number;
  timing: {
    firstDurableProgressToCompletionSeconds: number;
    triggerToDurableCompletionSeconds: number;
    triggerToFirstDurableProgressSeconds: number;
    samplingIntervalSeconds: number;
  };
  maxRssKiB: number;
  runtimeAttestation: {
    runId: string;
    observedProcessPageSize: number;
    requestedResultTransport: ResultTransport;
    observedProcessResultTransport: ResultTransport;
    expectedResolvedResultTransport: ResultTransport;
    observedProcessResultTransportEnvironmentValue: ResultTransport;
    resultTransportEnvironmentPresent: boolean;
    expectedResolvedPageOrchestrationStrategy: Strategy;
    observedProcessPageOrchestrationStrategyEnvironmentValue: Strategy;
    pageOrchestrationStrategyEnvironmentPresent: boolean;
    expectedResolvedVisionConcurrency: number;
    observedProcessVisionConcurrencyEnvironmentValue: number | null;
    visionConcurrencyEnvironmentPresent: boolean;
    expectedResolvedPipelineDepth: number;
    observedProcessPipelineDepthEnvironmentValue: number | null;
    pipelineDepthEnvironmentPresent: boolean;
    observedAtEpochSeconds: number;
    processEnvironmentObservedAtEpochSeconds: number;
    nativeResultTransport: {
      schemaVersion: number;
      runId: string;
      configuredResultTransport: ResultTransport;
      resolvedResultTransport: ResultTransport;
      selectedResultTransport: ResultTransport;
      observedAtEpochSeconds: number;
      lastObservedAtEpochSeconds: number | null;
      workCountersAvailable: boolean;
      workCounters: NativeWorkCounters | null;
    };
    source: string;
  };
  triggerBoundary: {
    preparedVisionStateSha256: string;
    preTriggerVisionStateSha256: string;
    unchangedBeforeTrigger: boolean;
    preTriggerObservedAtEpochSeconds: number;
    triggerEpochSeconds: number;
    triggerObservedAtEpochSeconds: number;
    durableCompletionObservedAtEpochSeconds: number;
    maxTriggerAgeSeconds: number;
    triggerFollowedPreTriggerAttestation: boolean;
    triggerWasNotFutureDated: boolean;
    triggerWasFresh: boolean;
  };
  buildAttestation: {
    strictCodeSignatureVerified: boolean;
    suppliedAppName: string;
    runningAppName: string;
    suppliedExecutableSha256: string;
    runningExecutableSha256: string;
    suppliedMainJsBundleSha256: string;
    runningMainJsBundleSha256: string;
    exactExecutableMatch: boolean;
    exactMainJsBundleMatch: boolean;
  };
  validation: {
    exactSemanticPhotoParity: boolean;
    photoMismatchCount: number;
    exactVisitFoodParity: boolean;
    visitMismatchCount: number;
    pendingCount: number;
    nativeWorkCountersRequired: boolean;
    nativeWorkCountersAvailable: boolean;
    nativeWorkLifecycleBalanced: boolean | null;
    nativeRequestedAssetCountMatchesAttempts: boolean | null;
    nativeBatchCountMatchesPlan: boolean | null;
    integrity: string;
    foreignKeyViolationCount: number;
  };
  originalDatabaseSha256: string;
  originalDatabase: {
    main: DatabaseComponent;
    wal: DatabaseComponent;
    shm: DatabaseComponent;
    journal: DatabaseComponent;
  };
  standaloneSnapshotSha256: string;
  semanticReference: SemanticReference;
  resultDatabase: {
    sha256: string;
    retained: boolean;
    path: string | null;
  };
  rawDatabases: {
    retained: boolean;
    snapshotPath: string | null;
  };
  restoration: {
    exactMainAndSidecarSetRestored: boolean;
    launchEnvironmentRestored: boolean;
    rawDatabasePolicyApplied: boolean;
    reportPublishedAfterRestoration: boolean;
    restoredDatabaseSha256: string;
  };
  samplesPath: string;
}

interface FixtureSet {
  reports: {
    legacyA: TestReport;
    legacyB: TestReport;
    packedA: TestReport;
    packedB: TestReport;
  };
  paths: {
    legacy: string[];
    packedV1: string[];
    output: string;
  };
}

interface MetricComparison {
  legacy: number;
  packedV1: number;
  packedV1MinusLegacy: number;
  packedV1MinusLegacyPercent: number;
}

interface TransportMedianDelta {
  packedV1MinusLegacy: number;
  packedV1MinusLegacyPercent: number;
}

interface SuccessSummary {
  schemaVersion: number;
  inputReportSchemaVersion: number;
  status: string;
  validation: TransportSummaryValidation;
  inputIdentity: JsonObject;
  legacy: {
    reports: string[];
    runIds: string[];
    sampleCount: number;
    medianWallSeconds: number;
    medianFirstDurableProgressToCompletionSeconds: number;
    medianTriggerToDurableCompletionSeconds: number;
    medianTriggerToFirstDurableProgressSeconds: number;
    medianMaxRssKiB: number;
  };
  packedV1: {
    reports: string[];
    runIds: string[];
    sampleCount: number;
    medianWallSeconds: number;
    medianFirstDurableProgressToCompletionSeconds: number;
    medianTriggerToDurableCompletionSeconds: number;
    medianTriggerToFirstDurableProgressSeconds: number;
    medianMaxRssKiB: number;
  };
  comparison: {
    interpretation: string;
    primaryMetric: string;
    medianDeltas: {
      firstDurableProgressToCompletionSeconds: TransportMedianDelta;
      triggerToDurableCompletionSeconds: TransportMedianDelta;
      triggerToFirstDurableProgressSeconds: TransportMedianDelta;
      maxRssKiB: TransportMedianDelta;
    };
    pairedWins: { packedV1: number; legacy: number; ties: number };
    pairs: Array<{
      pairIndex: number;
      legacyRunId: string;
      packedV1RunId: string;
      winner: ResultTransport | "tie";
      firstDurableProgressToCompletionSeconds: MetricComparison;
    }>;
  };
  limitations: string[];
}

interface TransportSummaryValidation {
  [attestation: string]: boolean;
}

const summarizerPath = fileURLToPath(new URL("./summarize-macos-vision-transport-ab.ts", import.meta.url));
const repositoryRoot = dirname(dirname(summarizerPath));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-vision-transport-ab-"));
const executableSha256 = "a".repeat(64);
const bundleSha256 = "b".repeat(64);
const originalDatabaseSha256 = "c".repeat(64);
const walSha256 = "d".repeat(64);
const shmSha256 = "e".repeat(64);
const standaloneSnapshotSha256 = "f".repeat(64);
const preparedVisionStateSha256 = "1".repeat(64);

function makeSemanticReference(source: SemanticReference["source"], sha256: string): SemanticReference {
  return {
    source,
    sha256,
    components: {
      main: { present: true, sha256, mode: "600", bytes: 52_000_000 },
      wal: { present: false, sha256: null, mode: null, bytes: null },
      shm: { present: false, sha256: null, mode: null, bytes: null },
      journal: { present: false, sha256: null, mode: null, bytes: null },
    },
  };
}

function makeReport(
  transport: ResultTransport,
  runId: string,
  durableTailSeconds: number,
  triggerToFirstProgressSeconds: number,
  maxRssKiB: number,
  resultDatabaseSha256: string,
): TestReport {
  const processEnvironmentObservedAtEpochSeconds = 1_000;
  const preTriggerObservedAtEpochSeconds = 1_001;
  const triggerEpochSeconds = 1_001.25;
  const triggerObservedAtEpochSeconds = 1_001.3;
  const nativeResultTransportObservedAtEpochSeconds = 1_001.35;
  const triggerToDurableCompletionSeconds = triggerToFirstProgressSeconds + durableTailSeconds;
  const nativeWorkCounters: NativeWorkCounters = {
    startedBatchCount: 1,
    startedRequestedAssetCount: 10,
    completedBatchCount: 1,
    completedRequestedAssetCount: 10,
    resolvedBatchCount: 1,
    resolvedRequestedAssetCount: 10,
    rejectedBatchCount: 0,
    rejectedRequestedAssetCount: 0,
    cancelledBatchCount: 0,
    cancelledRequestedAssetCount: 0,
    inFlightBatchCount: 0,
    inFlightRequestedAssetCount: 0,
  };
  return {
    schemaVersion: 6,
    schemaCompatibility: { previousSchemaVersion: 5, semanticFieldsPreserved: true },
    status: "ok",
    pageSize: 1_000,
    resultTransport: transport,
    requestedResultTransport: transport,
    pageOrchestrationStrategy: "lookahead",
    configuration: {
      resultPageSize: 1_000,
      resultTransport: transport,
      requestedResultTransport: transport,
      expectedResolvedResultTransport: transport,
      pageOrchestrationStrategy: "lookahead",
      visionConcurrency: 3,
      visionConcurrencyMode: "override",
      visionConcurrencyOverridden: true,
      visionConcurrencyEnvironmentValue: 3,
      pipelineDepth: 4,
      pipelineDepthMode: "native-default",
      pipelineDepthOverridden: false,
      pipelineDepthEnvironmentValue: null,
    },
    fixtureCount: 10,
    expectedFoodCount: 3,
    expectedFoodVisitCount: 2,
    workload: {
      attemptedSamples: 10,
      expectedNativeBatchCount: 1,
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
      observedProcessPageSize: 1_000,
      requestedResultTransport: transport,
      observedProcessResultTransport: transport,
      expectedResolvedResultTransport: transport,
      observedProcessResultTransportEnvironmentValue: transport,
      resultTransportEnvironmentPresent: true,
      expectedResolvedPageOrchestrationStrategy: "lookahead",
      observedProcessPageOrchestrationStrategyEnvironmentValue: "lookahead",
      pageOrchestrationStrategyEnvironmentPresent: true,
      expectedResolvedVisionConcurrency: 3,
      observedProcessVisionConcurrencyEnvironmentValue: 3,
      visionConcurrencyEnvironmentPresent: true,
      expectedResolvedPipelineDepth: 4,
      observedProcessPipelineDepthEnvironmentValue: null,
      pipelineDepthEnvironmentPresent: false,
      observedAtEpochSeconds: nativeResultTransportObservedAtEpochSeconds,
      processEnvironmentObservedAtEpochSeconds,
      nativeResultTransport: {
        schemaVersion: 2,
        runId,
        configuredResultTransport: transport,
        resolvedResultTransport: transport,
        selectedResultTransport: transport,
        observedAtEpochSeconds: nativeResultTransportObservedAtEpochSeconds,
        lastObservedAtEpochSeconds: nativeResultTransportObservedAtEpochSeconds + 0.1,
        workCountersAvailable: true,
        workCounters: { ...nativeWorkCounters },
      },
      source: "process-environment-plus-native-result-transport-attestation",
    },
    triggerBoundary: {
      preparedVisionStateSha256,
      preTriggerVisionStateSha256: preparedVisionStateSha256,
      unchangedBeforeTrigger: true,
      preTriggerObservedAtEpochSeconds,
      triggerEpochSeconds,
      triggerObservedAtEpochSeconds,
      durableCompletionObservedAtEpochSeconds: triggerEpochSeconds + triggerToDurableCompletionSeconds,
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
      exactSemanticPhotoParity: true,
      photoMismatchCount: 0,
      exactVisitFoodParity: true,
      visitMismatchCount: 0,
      pendingCount: 0,
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
    semanticReference: makeSemanticReference("live-original-snapshot", standaloneSnapshotSha256),
    resultDatabase: { sha256: resultDatabaseSha256, retained: false, path: null },
    rawDatabases: { retained: false, snapshotPath: null },
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

function createFixtureSet(caseName: string): FixtureSet {
  const directory = join(temporaryDirectory, caseName);
  mkdirSync(directory, { recursive: true });
  return {
    reports: {
      legacyA: makeReport("legacy", `${caseName}-legacy-a`, 10, 2, 500_000, "2".repeat(64)),
      legacyB: makeReport("legacy", `${caseName}-legacy-b`, 14, 3, 520_000, "3".repeat(64)),
      packedA: makeReport("packed-v1", `${caseName}-packed-a`, 8, 1.5, 490_000, "4".repeat(64)),
      packedB: makeReport("packed-v1", `${caseName}-packed-b`, 12, 2.5, 500_000, "5".repeat(64)),
    },
    paths: {
      legacy: [join(directory, "legacy-a.json"), join(directory, "legacy-b.json")],
      packedV1: [join(directory, "packed-a.json"), join(directory, "packed-b.json")],
      output: join(directory, "summary.json"),
    },
  };
}

function writeFixtureSet(fixtureSet: FixtureSet): void {
  const reports = [
    fixtureSet.reports.legacyA,
    fixtureSet.reports.legacyB,
    fixtureSet.reports.packedA,
    fixtureSet.reports.packedB,
  ];
  const paths = [...fixtureSet.paths.legacy, ...fixtureSet.paths.packedV1];
  for (let index = 0; index < reports.length; index += 1) {
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
      `--legacy=${fixtureSet.paths.legacy.join(",")}`,
      `--packed-v1=${fixtureSet.paths.packedV1.join(",")}`,
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

function requiredJsonString(value: JsonValue | undefined, label: string): string {
  if (!isJsonString(value)) {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function requiredJsonBoolean(value: JsonValue | undefined, label: string): boolean {
  if (!isJsonBoolean(value)) {
    throw new TypeError(`${label} must be a boolean.`);
  }
  return value;
}

function requiredJsonStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return value.map((entry, index) => requiredJsonString(entry, `${label}[${index}]`));
}

function parseTransportSummaryValidation(value: JsonValue | undefined): TransportSummaryValidation {
  const object = requiredJsonObject(value, "summary.validation");
  const validation: TransportSummaryValidation = {};
  for (const [key, entry] of Object.entries(object)) {
    validation[key] = requiredJsonBoolean(entry, `summary.validation.${key}`);
  }
  return validation;
}

function parseTransportGroup(value: JsonValue | undefined, label: string): SuccessSummary["legacy"] {
  const object = requiredJsonObject(value, label);
  return {
    reports: requiredJsonStringArray(object.reports, `${label}.reports`),
    runIds: requiredJsonStringArray(object.runIds, `${label}.runIds`),
    sampleCount: requiredJsonNumber(object.sampleCount, `${label}.sampleCount`),
    medianWallSeconds: requiredJsonNumber(object.medianWallSeconds, `${label}.medianWallSeconds`),
    medianFirstDurableProgressToCompletionSeconds: requiredJsonNumber(
      object.medianFirstDurableProgressToCompletionSeconds,
      `${label}.medianFirstDurableProgressToCompletionSeconds`,
    ),
    medianTriggerToDurableCompletionSeconds: requiredJsonNumber(
      object.medianTriggerToDurableCompletionSeconds,
      `${label}.medianTriggerToDurableCompletionSeconds`,
    ),
    medianTriggerToFirstDurableProgressSeconds: requiredJsonNumber(
      object.medianTriggerToFirstDurableProgressSeconds,
      `${label}.medianTriggerToFirstDurableProgressSeconds`,
    ),
    medianMaxRssKiB: requiredJsonNumber(object.medianMaxRssKiB, `${label}.medianMaxRssKiB`),
  };
}

function parseMetricComparison(value: JsonValue | undefined, label: string): MetricComparison {
  const object = requiredJsonObject(value, label);
  return {
    legacy: requiredJsonNumber(object.legacy, `${label}.legacy`),
    packedV1: requiredJsonNumber(object.packedV1, `${label}.packedV1`),
    packedV1MinusLegacy: requiredJsonNumber(object.packedV1MinusLegacy, `${label}.packedV1MinusLegacy`),
    packedV1MinusLegacyPercent: requiredJsonNumber(
      object.packedV1MinusLegacyPercent,
      `${label}.packedV1MinusLegacyPercent`,
    ),
  };
}

function parseResultTransportOrTie(value: JsonValue | undefined, label: string): ResultTransport | "tie" {
  if (value === "legacy" || value === "packed-v1" || value === "tie") {
    return value;
  }
  throw new TypeError(`${label} is unsupported.`);
}

function parseTransportPair(value: JsonValue, index: number): SuccessSummary["comparison"]["pairs"][number] {
  const label = `summary.comparison.pairs[${index}]`;
  const object = requiredJsonObject(value, label);
  return {
    pairIndex: requiredJsonNumber(object.pairIndex, `${label}.pairIndex`),
    legacyRunId: requiredJsonString(object.legacyRunId, `${label}.legacyRunId`),
    packedV1RunId: requiredJsonString(object.packedV1RunId, `${label}.packedV1RunId`),
    winner: parseResultTransportOrTie(object.winner, `${label}.winner`),
    firstDurableProgressToCompletionSeconds: parseMetricComparison(
      object.firstDurableProgressToCompletionSeconds,
      `${label}.firstDurableProgressToCompletionSeconds`,
    ),
  };
}

function parseMedianDelta(value: JsonValue | undefined, label: string): TransportMedianDelta {
  const object = requiredJsonObject(value, label);
  return {
    packedV1MinusLegacy: requiredJsonNumber(object.packedV1MinusLegacy, `${label}.packedV1MinusLegacy`),
    packedV1MinusLegacyPercent: requiredJsonNumber(
      object.packedV1MinusLegacyPercent,
      `${label}.packedV1MinusLegacyPercent`,
    ),
  };
}

function parseSuccessSummary(source: string): SuccessSummary {
  const object = requiredJsonObject(parseJsonValue(source), "summary");
  const comparison = requiredJsonObject(object.comparison, "summary.comparison");
  const medianDeltas = requiredJsonObject(comparison.medianDeltas, "summary.comparison.medianDeltas");
  const pairedWins = requiredJsonObject(comparison.pairedWins, "summary.comparison.pairedWins");
  if (!Array.isArray(comparison.pairs)) {
    throw new TypeError("summary.comparison.pairs must be an array.");
  }
  return {
    schemaVersion: requiredJsonNumber(object.schemaVersion, "summary.schemaVersion"),
    inputReportSchemaVersion: requiredJsonNumber(object.inputReportSchemaVersion, "summary.inputReportSchemaVersion"),
    status: requiredJsonString(object.status, "summary.status"),
    validation: parseTransportSummaryValidation(object.validation),
    inputIdentity: requiredJsonObject(object.inputIdentity, "summary.inputIdentity"),
    legacy: parseTransportGroup(object.legacy, "summary.legacy"),
    packedV1: parseTransportGroup(object.packedV1, "summary.packedV1"),
    comparison: {
      interpretation: requiredJsonString(comparison.interpretation, "summary.comparison.interpretation"),
      primaryMetric: requiredJsonString(comparison.primaryMetric, "summary.comparison.primaryMetric"),
      medianDeltas: {
        firstDurableProgressToCompletionSeconds: parseMedianDelta(
          medianDeltas.firstDurableProgressToCompletionSeconds,
          "summary.comparison.medianDeltas.firstDurableProgressToCompletionSeconds",
        ),
        triggerToDurableCompletionSeconds: parseMedianDelta(
          medianDeltas.triggerToDurableCompletionSeconds,
          "summary.comparison.medianDeltas.triggerToDurableCompletionSeconds",
        ),
        triggerToFirstDurableProgressSeconds: parseMedianDelta(
          medianDeltas.triggerToFirstDurableProgressSeconds,
          "summary.comparison.medianDeltas.triggerToFirstDurableProgressSeconds",
        ),
        maxRssKiB: parseMedianDelta(medianDeltas.maxRssKiB, "summary.comparison.medianDeltas.maxRssKiB"),
      },
      pairedWins: {
        packedV1: requiredJsonNumber(pairedWins.packedV1, "summary.comparison.pairedWins.packedV1"),
        legacy: requiredJsonNumber(pairedWins.legacy, "summary.comparison.pairedWins.legacy"),
        ties: requiredJsonNumber(pairedWins.ties, "summary.comparison.pairedWins.ties"),
      },
      pairs: comparison.pairs.map(parseTransportPair),
    },
    limitations: requiredJsonStringArray(object.limitations, "summary.limitations"),
  };
}

function pathExistsIncludingDanglingSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && hasErrorCode(cause) && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function expectReportFailure(
  caseName: string,
  mutate: (fixtureSet: FixtureSet) => void,
  expectedMessage: string,
): void {
  const fixtureSet = createFixtureSet(caseName);
  mutate(fixtureSet);
  writeFixtureSet(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(result.stderr, new RegExp(expectedMessage), `${caseName} failure message`);
  assert.equal(pathExistsIncludingDanglingSymlink(fixtureSet.paths.output), false, `${caseName} published output`);
}

function expectPathFailure(caseName: string, mutate: (fixtureSet: FixtureSet) => void, expectedMessage: string): void {
  const fixtureSet = createFixtureSet(caseName);
  writeFixtureSet(fixtureSet);
  mutate(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(result.stderr, new RegExp(expectedMessage), `${caseName} failure message`);
}

try {
  const helpResult = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", summarizerPath, "--help"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--legacy=.*--packed-v1=.*--output=/);

  const success = createFixtureSet("success");
  writeFixtureSet(success);
  const successResult = execute(success);
  assert.equal(successResult.status, 0, successResult.stderr);
  assert.match(successResult.stdout, /transport A\/B descriptive summary/);
  const summary = parseSuccessSummary(readFileSync(success.paths.output, "utf8"));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.inputReportSchemaVersion, 6);
  assert.equal(summary.status, "ok");
  assert.ok(Object.values(summary.validation).every(Boolean));
  assert.equal("resultDatabaseSha256" in summary.inputIdentity, false);
  assert.equal(statSync(success.paths.output).mode & 0o777, 0o600);
  assert.equal(summary.legacy.sampleCount, 2);
  assert.equal(summary.packedV1.sampleCount, 2);
  assert.deepEqual(summary.legacy.reports, ["legacy-a.json", "legacy-b.json"]);
  assert.deepEqual(summary.packedV1.reports, ["packed-a.json", "packed-b.json"]);
  assert.deepEqual(summary.legacy.runIds, ["success-legacy-a", "success-legacy-b"]);
  assert.deepEqual(summary.packedV1.runIds, ["success-packed-a", "success-packed-b"]);
  assert.equal(summary.legacy.medianWallSeconds, 12);
  assert.equal(summary.packedV1.medianWallSeconds, 10);
  assert.equal(summary.legacy.medianFirstDurableProgressToCompletionSeconds, 12);
  assert.equal(summary.packedV1.medianFirstDurableProgressToCompletionSeconds, 10);
  assert.equal(summary.legacy.medianTriggerToDurableCompletionSeconds, 14.5);
  assert.equal(summary.packedV1.medianTriggerToDurableCompletionSeconds, 12);
  assert.equal(summary.legacy.medianTriggerToFirstDurableProgressSeconds, 2.5);
  assert.equal(summary.packedV1.medianTriggerToFirstDurableProgressSeconds, 2);
  assert.equal(summary.legacy.medianMaxRssKiB, 510_000);
  assert.equal(summary.packedV1.medianMaxRssKiB, 495_000);
  assert.equal(summary.comparison.interpretation, "descriptive-only");
  assert.equal(summary.comparison.primaryMetric, "firstDurableProgressToCompletionSeconds");
  assert.equal(summary.comparison.medianDeltas.firstDurableProgressToCompletionSeconds.packedV1MinusLegacy, -2);
  assert.ok(
    Math.abs(
      summary.comparison.medianDeltas.firstDurableProgressToCompletionSeconds.packedV1MinusLegacyPercent -
        -16.666_666_666_666_664,
    ) < 1e-12,
  );
  assert.equal(summary.comparison.medianDeltas.triggerToDurableCompletionSeconds.packedV1MinusLegacy, -2.5);
  assert.equal(summary.comparison.medianDeltas.triggerToFirstDurableProgressSeconds.packedV1MinusLegacy, -0.5);
  assert.equal(summary.comparison.medianDeltas.maxRssKiB.packedV1MinusLegacy, -15_000);
  assert.deepEqual(summary.comparison.pairedWins, { packedV1: 2, legacy: 0, ties: 0 });
  assert.equal(summary.comparison.pairs.length, 2);
  assert.deepEqual(
    summary.comparison.pairs.map((pair) => pair.pairIndex),
    [1, 2],
  );
  assert.ok(summary.comparison.pairs.every((pair) => pair.winner === "packed-v1"));
  assert.equal(summary.comparison.pairs[0]!.firstDurableProgressToCompletionSeconds.packedV1MinusLegacy, -2);
  assert.ok(summary.limitations.some((limitation) => limitation.includes("descriptive summary")));
  assert.ok(summary.limitations.some((limitation) => limitation.includes("comma-list position")));

  expectReportFailure(
    "missing-native-attestation",
    (fixtureSet) => {
      Object.defineProperty(fixtureSet.reports.packedA.runtimeAttestation, "nativeResultTransport", {
        configurable: true,
        enumerable: true,
        value: undefined,
        writable: true,
      });
    },
    "native result-transport attestation must be an object",
  );
  expectReportFailure(
    "legacy-native-attestation-schema",
    (fixtureSet) => {
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.schemaVersion = 1;
    },
    "native result-transport schema must be exactly 2",
  );
  expectReportFailure(
    "unbalanced-native-work-counters",
    (fixtureSet) => {
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.workCounters!.completedBatchCount = 0;
    },
    "completed batch balance",
  );
  expectReportFailure(
    "native-requested-asset-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.workCounters!.startedRequestedAssetCount = 9;
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.workCounters!.completedRequestedAssetCount = 9;
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.workCounters!.resolvedRequestedAssetCount = 9;
      fixtureSet.reports.packedA.workload.nativeDispatch!.startedRequestedAssetCount = 9;
      fixtureSet.reports.packedA.workload.nativeDispatch!.completedRequestedAssetCount = 9;
      fixtureSet.reports.packedA.workload.nativeDispatch!.resolvedRequestedAssetCount = 9;
    },
    "direct requested assets must match attempts",
  );
  expectReportFailure(
    "native-batch-count-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.packedA.workload.expectedNativeBatchCount = 2;
    },
    "direct batches must match the plan",
  );
  expectReportFailure(
    "spoofed-native-attestation",
    (fixtureSet) => {
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.selectedResultTransport = "legacy";
    },
    "native selected result transport",
  );
  expectReportFailure(
    "native-attestation-before-trigger",
    (fixtureSet) => {
      fixtureSet.reports.packedA.runtimeAttestation.observedAtEpochSeconds = 1_001.2;
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds = 1_001.2;
    },
    "native result-transport attestation must not precede the trigger",
  );
  expectReportFailure(
    "build-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.packedB.buildAttestation.suppliedExecutableSha256 = "9".repeat(64);
      fixtureSet.reports.packedB.buildAttestation.runningExecutableSha256 = "9".repeat(64);
    },
    "A/B executable mismatch",
  );
  expectReportFailure(
    "duplicate-run-id",
    (fixtureSet) => {
      const duplicateRunId = fixtureSet.reports.legacyA.runtimeAttestation.runId;
      fixtureSet.reports.packedA.runtimeAttestation.runId = duplicateRunId;
      fixtureSet.reports.packedA.runtimeAttestation.nativeResultTransport.runId = duplicateRunId;
    },
    "duplicate runtime run ID",
  );
  expectReportFailure(
    "fixture-identity-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.packedB.fixtureCount += 1;
    },
    "shared configuration, fixture, database, or reference identity mismatch",
  );
  expectReportFailure(
    "reference-identity-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.packedA.semanticReference = {
        ...makeSemanticReference("external-current-control", "8".repeat(64)),
      };
    },
    "shared configuration, fixture, database, or reference identity mismatch",
  );
  expectReportFailure(
    "missing-reference-components",
    (fixtureSet) => {
      Object.defineProperty(fixtureSet.reports.packedA.semanticReference, "components", {
        configurable: true,
        enumerable: true,
        value: undefined,
        writable: true,
      });
    },
    "semantic reference components must be an object",
  );
  expectReportFailure(
    "nonempty-reference-wal",
    (fixtureSet) => {
      fixtureSet.reports.packedA.semanticReference = makeSemanticReference("external-current-control", "8".repeat(64));
      fixtureSet.reports.packedA.semanticReference.components.wal = {
        present: true,
        sha256: "7".repeat(64),
        mode: "600",
        bytes: 4_096,
      };
    },
    "semantic reference WAL must be empty",
  );
  expectReportFailure(
    "validator-schema-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.legacyA.schemaVersion = 5;
    },
    "report schema must be exactly 6",
  );
  expectReportFailure(
    "raw-database-retained",
    (fixtureSet) => {
      fixtureSet.reports.legacyB.rawDatabases.retained = true;
      fixtureSet.reports.legacyB.rawDatabases.snapshotPath = "retained.sqlite";
    },
    "raw databases must not be retained",
  );
  expectReportFailure(
    "semantic-failure",
    (fixtureSet) => {
      fixtureSet.reports.packedB.validation.exactSemanticPhotoParity = false;
    },
    "exact semantic photo parity",
  );
  expectReportFailure(
    "restoration-failure",
    (fixtureSet) => {
      fixtureSet.reports.packedA.restoration.reportPublishedAfterRestoration = false;
    },
    "report publication ordering",
  );

  expectPathFailure(
    "too-few-reports",
    (fixtureSet) => {
      fixtureSet.paths.legacy = fixtureSet.paths.legacy.slice(0, 1);
      fixtureSet.paths.packedV1 = fixtureSet.paths.packedV1.slice(0, 1);
    },
    "at least two measured reports are required",
  );
  expectPathFailure(
    "unequal-groups",
    (fixtureSet) => {
      fixtureSet.paths.packedV1 = fixtureSet.paths.packedV1.slice(0, 1);
    },
    "groups must have equal sample counts",
  );
  expectPathFailure(
    "duplicate-path",
    (fixtureSet) => {
      fixtureSet.paths.packedV1[1] = fixtureSet.paths.legacy[0]!;
    },
    "Duplicate resolved report path",
  );
  expectPathFailure(
    "hardlink-input",
    (fixtureSet) => {
      unlinkSync(fixtureSet.paths.packedV1[1]!);
      linkSync(fixtureSet.paths.legacy[0]!, fixtureSet.paths.packedV1[1]!);
    },
    "Duplicate report file identity",
  );

  const preexistingOutput = createFixtureSet("preexisting-output");
  writeFixtureSet(preexistingOutput);
  writeFileSync(preexistingOutput.paths.output, "sentinel\n", { mode: 0o600 });
  const preexistingResult = execute(preexistingOutput);
  assert.notEqual(preexistingResult.status, 0);
  assert.match(preexistingResult.stderr, /Output path already exists/);
  assert.equal(readFileSync(preexistingOutput.paths.output, "utf8"), "sentinel\n");

  const symlinkOutput = createFixtureSet("symlink-output");
  writeFixtureSet(symlinkOutput);
  const symlinkTarget = join(dirname(symlinkOutput.paths.output), "target.json");
  writeFileSync(symlinkTarget, "target-sentinel\n", { mode: 0o600 });
  symlinkSync(symlinkTarget, symlinkOutput.paths.output);
  const symlinkResult = execute(symlinkOutput);
  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /Output path already exists/);
  assert.equal(lstatSync(symlinkOutput.paths.output).isSymbolicLink(), true);
  assert.equal(readFileSync(symlinkTarget, "utf8"), "target-sentinel\n");

  console.log("macOS Vision transport A/B summarizer tests passed: strict schema-2 native work counters");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
