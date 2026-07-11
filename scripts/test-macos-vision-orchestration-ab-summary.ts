#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Strategy = "serial" | "lookahead";
type TuningMode = "native-default" | "override";
type ResultTransport = "legacy" | "packed-v1";
type SemanticReferenceSource = "live-original-snapshot" | "external-current-control";

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
  source: SemanticReferenceSource;
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
    serialA: TestReport;
    serialB: TestReport;
    lookaheadA: TestReport;
    lookaheadB: TestReport;
  };
  paths: {
    serial: string[];
    lookahead: string[];
    output: string;
  };
}

interface SuccessSummary {
  schemaVersion: number;
  inputReportSchemaVersion: number;
  status: string;
  validation: Record<string, boolean>;
  inputIdentity: {
    appName: string;
    pageSize: number;
    resultTransport: ResultTransport;
    fixtureCount: number;
    visionConcurrency: number;
    visionConcurrencyMode: TuningMode;
    pipelineDepth: number;
    pipelineDepthMode: TuningMode;
    semanticReference: SemanticReference;
  };
  serial: {
    reports: string[];
    runIds: string[];
    sampleCount: number;
    wallSeconds: number[];
    medianWallSeconds: number;
    medianTriggerToDurableCompletionSeconds: number;
    medianTriggerToFirstDurableProgressSeconds: number;
    medianMaxRssKiB: number;
  };
  lookahead: {
    reports: string[];
    runIds: string[];
    sampleCount: number;
    wallSeconds: number[];
    medianWallSeconds: number;
    medianTriggerToDurableCompletionSeconds: number;
    medianTriggerToFirstDurableProgressSeconds: number;
    medianMaxRssKiB: number;
  };
  comparison: {
    interpretation: string;
    primaryMetric: string;
    medianWallSecondsDelta: number;
    medianWallSecondsPercentDelta: number;
    medianWallSecondsSaved: number;
    medianTriggerToDurableCompletionSecondsDelta: number;
    medianTriggerToFirstDurableProgressSecondsDelta: number;
    medianMaxRssDeltaKiB: number;
    pairedWins: { lookahead: number; serial: number; ties: number };
    pairs: Array<{ winner: Strategy | "tie"; lookaheadMinusSerialSeconds: number }>;
  };
  limitations: string[];
}

const summarizerPath = fileURLToPath(new URL("./summarize-macos-vision-orchestration-ab.ts", import.meta.url));
const repositoryRoot = dirname(dirname(summarizerPath));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-vision-orchestration-ab-"));
const executableSha256 = "a".repeat(64);
const bundleSha256 = "b".repeat(64);
const originalDatabaseSha256 = "c".repeat(64);
const walSha256 = "d".repeat(64);
const shmSha256 = "e".repeat(64);
const standaloneSnapshotSha256 = "f".repeat(64);
const preparedVisionStateSha256 = "1".repeat(64);
const resultDatabaseSha256 = "2".repeat(64);
const externalSemanticReferenceSha256 = "4".repeat(64);

function makeSemanticReference(source: SemanticReferenceSource, sha256: string): SemanticReference {
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
  strategy: Strategy,
  runId: string,
  wallSeconds: number,
  triggerToFirstProgressSeconds: number,
  maxRssKiB: number,
): TestReport {
  const processEnvironmentObservedAtEpochSeconds = 1_000;
  const preTriggerObservedAtEpochSeconds = 1_001;
  const triggerEpochSeconds = 1_001.25;
  const triggerObservedAtEpochSeconds = 1_001.3;
  const nativeResultTransportObservedAtEpochSeconds = 1_001.35;
  const durableCompletionObservedAtEpochSeconds = triggerEpochSeconds + triggerToFirstProgressSeconds + wallSeconds;
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
    schemaCompatibility: {
      previousSchemaVersion: 5,
      semanticFieldsPreserved: true,
    },
    status: "ok",
    pageSize: 1_000,
    resultTransport: "legacy",
    requestedResultTransport: "legacy",
    pageOrchestrationStrategy: strategy,
    configuration: {
      resultPageSize: 1_000,
      resultTransport: "legacy",
      requestedResultTransport: "legacy",
      expectedResolvedResultTransport: "legacy",
      pageOrchestrationStrategy: strategy,
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
    wallSeconds,
    timing: {
      firstDurableProgressToCompletionSeconds: wallSeconds,
      triggerToDurableCompletionSeconds: triggerToFirstProgressSeconds + wallSeconds,
      triggerToFirstDurableProgressSeconds: triggerToFirstProgressSeconds,
      samplingIntervalSeconds: 0.2,
    },
    maxRssKiB,
    runtimeAttestation: {
      runId,
      observedProcessPageSize: 1_000,
      requestedResultTransport: "legacy",
      observedProcessResultTransport: "legacy",
      expectedResolvedResultTransport: "legacy",
      observedProcessResultTransportEnvironmentValue: "legacy",
      resultTransportEnvironmentPresent: true,
      expectedResolvedPageOrchestrationStrategy: strategy,
      observedProcessPageOrchestrationStrategyEnvironmentValue: strategy,
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
        configuredResultTransport: "legacy",
        resolvedResultTransport: "legacy",
        selectedResultTransport: "legacy",
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

function createFixtureSet(caseName: string): FixtureSet {
  const directory = join(temporaryDirectory, caseName);
  mkdirSync(directory, { recursive: true });
  return {
    reports: {
      serialA: makeReport("serial", `${caseName}-serial-a`, 10, 2, 500_000),
      serialB: makeReport("serial", `${caseName}-serial-b`, 14, 3, 520_000),
      lookaheadA: makeReport("lookahead", `${caseName}-lookahead-a`, 8, 1.5, 530_000),
      lookaheadB: makeReport("lookahead", `${caseName}-lookahead-b`, 12, 2.5, 510_000),
    },
    paths: {
      serial: [join(directory, "serial-a.json"), join(directory, "serial-b.json")],
      lookahead: [join(directory, "lookahead-a.json"), join(directory, "lookahead-b.json")],
      output: join(directory, "summary.json"),
    },
  };
}

function writeFixtureSet(fixtureSet: FixtureSet): void {
  const reports = [
    fixtureSet.reports.serialA,
    fixtureSet.reports.serialB,
    fixtureSet.reports.lookaheadA,
    fixtureSet.reports.lookaheadB,
  ];
  const paths = [...fixtureSet.paths.serial, ...fixtureSet.paths.lookahead];
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
      `--serial=${fixtureSet.paths.serial.join(",")}`,
      `--lookahead=${fixtureSet.paths.lookahead.join(",")}`,
      `--output=${fixtureSet.paths.output}`,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function expectFailure(caseName: string, mutate: (fixtureSet: FixtureSet) => void, expectedMessage: string): void {
  const fixtureSet = createFixtureSet(caseName);
  mutate(fixtureSet);
  writeFixtureSet(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(result.stderr, new RegExp(expectedMessage), `${caseName} failure message`);
  assert.equal(statelessPathExists(fixtureSet.paths.output), false, `${caseName} published a partial summary`);
}

function expectPathFailure(caseName: string, mutate: (fixtureSet: FixtureSet) => void, expectedMessage: string): void {
  const fixtureSet = createFixtureSet(caseName);
  writeFixtureSet(fixtureSet);
  mutate(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(result.stderr, new RegExp(expectedMessage), `${caseName} failure message`);
}

function statelessPathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function updatePageSize(report: TestReport, pageSize: number): void {
  report.pageSize = pageSize;
  report.configuration.resultPageSize = pageSize;
  report.runtimeAttestation.observedProcessPageSize = pageSize;
}

function updateVisionConcurrency(report: TestReport, concurrency: number): void {
  report.configuration.visionConcurrency = concurrency;
  report.configuration.visionConcurrencyEnvironmentValue = concurrency;
  report.runtimeAttestation.expectedResolvedVisionConcurrency = concurrency;
  report.runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue = concurrency;
}

function updatePipelineDepth(report: TestReport, pipelineDepth: number): void {
  report.configuration.pipelineDepth = pipelineDepth;
  report.runtimeAttestation.expectedResolvedPipelineDepth = pipelineDepth;
}

function updateRunId(report: TestReport, runId: string): void {
  report.runtimeAttestation.runId = runId;
  report.runtimeAttestation.nativeResultTransport.runId = runId;
}

function updateResultTransport(report: TestReport, transport: ResultTransport): void {
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

function updateNativeResultTransportObservation(report: TestReport, observedAtEpochSeconds: number): void {
  report.runtimeAttestation.observedAtEpochSeconds = observedAtEpochSeconds;
  report.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds = observedAtEpochSeconds;
  report.runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds = observedAtEpochSeconds;
}

function setExternalSemanticReference(fixtureSet: FixtureSet): void {
  for (const report of Object.values(fixtureSet.reports)) {
    report.semanticReference = {
      ...makeSemanticReference("external-current-control", externalSemanticReferenceSha256),
    };
  }
}

try {
  const helpResult = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", summarizerPath, "--help"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--serial=REPORT/);
  assert.match(helpResult.stdout, /--lookahead=REPORT/);

  const success = createFixtureSet("success");
  writeFixtureSet(success);
  const successResult = execute(success);
  assert.equal(successResult.status, 0, successResult.stderr);
  assert.match(successResult.stdout, /descriptive summary/);
  const summaryText = readFileSync(success.paths.output, "utf8");
  const summary = JSON.parse(summaryText) as SuccessSummary;
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.inputReportSchemaVersion, 6);
  assert.equal(summary.status, "ok");
  assert.equal(summary.serial.sampleCount, 2);
  assert.equal(summary.lookahead.sampleCount, 2);
  assert.deepEqual(summary.serial.reports, ["serial-a.json", "serial-b.json"]);
  assert.deepEqual(summary.lookahead.reports, ["lookahead-a.json", "lookahead-b.json"]);
  assert.deepEqual(summary.serial.runIds, ["success-serial-a", "success-serial-b"]);
  assert.deepEqual(summary.lookahead.runIds, ["success-lookahead-a", "success-lookahead-b"]);
  assert.deepEqual(summary.serial.wallSeconds, [10, 14]);
  assert.deepEqual(summary.lookahead.wallSeconds, [8, 12]);
  assert.equal(summary.serial.medianWallSeconds, 12);
  assert.equal(summary.lookahead.medianWallSeconds, 10);
  assert.equal(summary.serial.medianTriggerToDurableCompletionSeconds, 14.5);
  assert.equal(summary.lookahead.medianTriggerToDurableCompletionSeconds, 12);
  assert.equal(summary.serial.medianTriggerToFirstDurableProgressSeconds, 2.5);
  assert.equal(summary.lookahead.medianTriggerToFirstDurableProgressSeconds, 2);
  assert.equal(summary.serial.medianMaxRssKiB, 510_000);
  assert.equal(summary.lookahead.medianMaxRssKiB, 520_000);
  assert.equal(summary.comparison.interpretation, "descriptive-only");
  assert.equal(summary.comparison.primaryMetric, "firstDurableProgressToCompletionSeconds");
  assert.equal(summary.comparison.medianWallSecondsDelta, -2);
  assert.ok(Math.abs(summary.comparison.medianWallSecondsPercentDelta - -16.666_666_666_666_664) < 1e-12);
  assert.equal(summary.comparison.medianWallSecondsSaved, 2);
  assert.equal(summary.comparison.medianTriggerToDurableCompletionSecondsDelta, -2.5);
  assert.equal(summary.comparison.medianTriggerToFirstDurableProgressSecondsDelta, -0.5);
  assert.equal(summary.comparison.medianMaxRssDeltaKiB, 10_000);
  assert.deepEqual(summary.comparison.pairedWins, { lookahead: 2, serial: 0, ties: 0 });
  assert.deepEqual(
    summary.comparison.pairs.map((pair) => pair.winner),
    ["lookahead", "lookahead"],
  );
  assert.ok(summary.limitations.some((limitation) => limitation.includes("no inferential")));
  assert.equal(summary.inputIdentity.appName, "Palate.app");
  assert.equal(summary.inputIdentity.pageSize, 1_000);
  assert.equal(summary.inputIdentity.resultTransport, "legacy");
  assert.equal(summary.inputIdentity.fixtureCount, 10);
  assert.equal(summary.inputIdentity.visionConcurrency, 3);
  assert.equal(summary.inputIdentity.visionConcurrencyMode, "override");
  assert.equal(summary.inputIdentity.pipelineDepth, 4);
  assert.equal(summary.inputIdentity.pipelineDepthMode, "native-default");
  assert.deepEqual(
    summary.inputIdentity.semanticReference,
    makeSemanticReference("live-original-snapshot", standaloneSnapshotSha256),
  );
  assert.equal(summary.validation.everyRunSchemaV6AggregateOnly, true);
  assert.equal(summary.validation.everyRunNativeResultTransportAttestedWithinTriggerBoundary, true);
  assert.equal(summary.validation.everyRunSchemaV5AggregateOnly, undefined);
  assert.ok(summary.limitations.some((limitation) => limitation.includes("same attested result transport")));
  assert.ok(Object.values(summary.validation).every(Boolean));
  assert.equal(summaryText.includes(temporaryDirectory), false, "summary leaked an absolute fixture path");
  assert.equal(statSync(success.paths.output).mode & 0o777, 0o600, "summary mode");

  const externalSuccess = createFixtureSet("external-success");
  setExternalSemanticReference(externalSuccess);
  writeFixtureSet(externalSuccess);
  const externalSuccessResult = execute(externalSuccess);
  assert.equal(externalSuccessResult.status, 0, externalSuccessResult.stderr);
  const externalSummary = JSON.parse(readFileSync(externalSuccess.paths.output, "utf8")) as SuccessSummary;
  assert.deepEqual(
    externalSummary.inputIdentity.semanticReference,
    makeSemanticReference("external-current-control", externalSemanticReferenceSha256),
  );

  expectFailure(
    "wrong-schema",
    ({ reports }) => {
      reports.lookaheadB.schemaVersion = 4;
    },
    "report schema must be exactly 6",
  );
  expectFailure(
    "wrong-previous-schema",
    ({ reports }) => {
      reports.lookaheadB.schemaCompatibility.previousSchemaVersion = 4;
    },
    "previous schema version",
  );
  expectFailure(
    "missing-native-result-transport-attestation",
    ({ reports }) => {
      delete (
        reports.lookaheadB.runtimeAttestation as unknown as {
          nativeResultTransport?: TestReport["runtimeAttestation"]["nativeResultTransport"];
        }
      ).nativeResultTransport;
    },
    "nativeResultTransport must be an object",
  );
  expectFailure(
    "wrong-native-result-transport-schema",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.schemaVersion = 1;
    },
    "native result-transport schema version",
  );
  expectFailure(
    "unbalanced-native-work-counters",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.workCounters!.completedBatchCount = 0;
    },
    "completed batch balance",
  );
  expectFailure(
    "native-requested-asset-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.workCounters!.startedRequestedAssetCount = 9;
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.workCounters!.completedRequestedAssetCount = 9;
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.workCounters!.resolvedRequestedAssetCount = 9;
      reports.lookaheadB.workload.nativeDispatch!.startedRequestedAssetCount = 9;
      reports.lookaheadB.workload.nativeDispatch!.completedRequestedAssetCount = 9;
      reports.lookaheadB.workload.nativeDispatch!.resolvedRequestedAssetCount = 9;
    },
    "direct requested assets must match attempts",
  );
  expectFailure(
    "native-batch-count-mismatch",
    ({ reports }) => {
      reports.lookaheadB.workload.expectedNativeBatchCount = 2;
    },
    "direct batches must match the plan",
  );
  expectFailure(
    "native-result-transport-run-id-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.runId = "different-run";
    },
    "native result-transport run ID",
  );
  expectFailure(
    "native-configured-result-transport-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.configuredResultTransport = "packed-v1";
    },
    "native configured result transport",
  );
  expectFailure(
    "native-resolved-result-transport-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.resolvedResultTransport = "packed-v1";
    },
    "native resolved result transport",
  );
  expectFailure(
    "native-selected-result-transport-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.selectedResultTransport = "packed-v1";
    },
    "native selected result transport",
  );
  expectFailure(
    "runtime-native-observation-mismatch",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds += 0.1;
    },
    "runtime observation must mirror native result-transport attestation",
  );
  expectFailure(
    "invalid-result-transport-attestation-source",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.source = "process-environment-only";
    },
    "runtime attestation source",
  );
  expectFailure(
    "missing-result-transport-environment",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.resultTransportEnvironmentPresent = false;
    },
    "result-transport environment presence",
  );
  expectFailure(
    "configured-selected-result-transport-mismatch",
    ({ reports }) => {
      reports.lookaheadB.configuration.resultTransport = "packed-v1";
    },
    "configured selected result transport",
  );
  expectFailure(
    "missing-trigger-boundary",
    ({ reports }) => {
      delete (reports.lookaheadB as unknown as { triggerBoundary?: TestReport["triggerBoundary"] }).triggerBoundary;
    },
    "triggerBoundary must be an object",
  );
  expectFailure(
    "trigger-digest-mismatch",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.preTriggerVisionStateSha256 = "3".repeat(64);
    },
    "pre-trigger Vision state changed",
  );
  expectFailure(
    "malformed-trigger-digest",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.preparedVisionStateSha256 = "not-a-digest";
    },
    "prepared Vision state must be a SHA-256 digest",
  );
  expectFailure(
    "false-trigger-unchanged",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.unchangedBeforeTrigger = false;
    },
    "unchanged-before-trigger attestation",
  );
  expectFailure(
    "process-environment-observed-after-pretrigger",
    ({ reports }) => {
      reports.lookaheadB.runtimeAttestation.processEnvironmentObservedAtEpochSeconds = 1_001.1;
    },
    "pre-trigger observation must follow process-environment attestation",
  );
  expectFailure(
    "trigger-precedes-attestation",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerEpochSeconds = 1_000.5;
    },
    "trigger must follow pre-trigger attestation",
  );
  expectFailure(
    "future-trigger",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerObservedAtEpochSeconds = 1_001.2;
    },
    "trigger observation must not precede trigger",
  );
  expectFailure(
    "stale-trigger",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerObservedAtEpochSeconds = 1_100;
    },
    "trigger evidence is stale",
  );
  expectFailure(
    "durable-completion-precedes-trigger-observation",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.durableCompletionObservedAtEpochSeconds = 1_001.29;
    },
    "durable completion must follow trigger observation",
  );
  expectFailure(
    "native-result-transport-precedes-trigger",
    ({ reports }) => {
      updateNativeResultTransportObservation(reports.lookaheadB, 1_001.2);
    },
    "native result-transport attestation must not precede the trigger",
  );
  expectFailure(
    "native-result-transport-follows-completion",
    ({ reports }) => {
      updateNativeResultTransportObservation(
        reports.lookaheadB,
        reports.lookaheadB.triggerBoundary.durableCompletionObservedAtEpochSeconds + 0.1,
      );
    },
    "native result-transport attestation must not follow durable completion",
  );
  expectFailure(
    "durable-completion-timing-mismatch",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.durableCompletionObservedAtEpochSeconds += 1;
    },
    "durable-completion epoch is inconsistent with trigger timing",
  );
  expectFailure(
    "false-trigger-freshness",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerWasFresh = false;
    },
    "trigger freshness flag",
  );
  expectFailure(
    "false-trigger-followed-attestation",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerFollowedPreTriggerAttestation = false;
    },
    "trigger-followed-attestation flag",
  );
  expectFailure(
    "false-trigger-nonfuture",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.triggerWasNotFutureDated = false;
    },
    "nonfuture trigger flag",
  );
  expectPathFailure(
    "single-sample",
    ({ paths }) => {
      paths.serial = paths.serial.slice(0, 1);
      paths.lookahead = paths.lookahead.slice(0, 1);
    },
    "at least two measured reports",
  );
  expectPathFailure(
    "unbalanced-groups",
    ({ paths }) => {
      paths.lookahead = paths.lookahead.slice(0, 1);
    },
    "equal sample counts",
  );
  expectPathFailure(
    "duplicate-path",
    ({ paths }) => {
      paths.lookahead[1] = paths.serial[0]!;
    },
    "Duplicate resolved report path",
  );
  expectFailure(
    "duplicate-run-id",
    ({ reports }) => {
      updateRunId(reports.lookaheadB, reports.serialA.runtimeAttestation.runId);
    },
    "duplicate runtime run ID",
  );
  expectFailure(
    "wrong-arm-strategy",
    ({ reports }) => {
      reports.lookaheadB.pageOrchestrationStrategy = "serial";
    },
    "top-level orchestration strategy",
  );
  expectFailure(
    "build-hash-mismatch",
    ({ reports }) => {
      reports.lookaheadB.buildAttestation.suppliedExecutableSha256 = "3".repeat(64);
      reports.lookaheadB.buildAttestation.runningExecutableSha256 = "3".repeat(64);
    },
    "A/B executable mismatch",
  );
  expectFailure(
    "bundle-hash-mismatch",
    ({ reports }) => {
      reports.lookaheadB.buildAttestation.suppliedMainJsBundleSha256 = "3".repeat(64);
      reports.lookaheadB.buildAttestation.runningMainJsBundleSha256 = "3".repeat(64);
    },
    "A/B main.jsbundle mismatch",
  );
  expectFailure(
    "app-identity-mismatch",
    ({ reports }) => {
      reports.lookaheadB.buildAttestation.suppliedAppName = "Other.app";
      reports.lookaheadB.buildAttestation.runningAppName = "Other.app";
    },
    "A/B app identity mismatch",
  );
  expectFailure(
    "page-size-mismatch",
    ({ reports }) => {
      updatePageSize(reports.lookaheadB, 500);
    },
    "A/B page-size mismatch",
  );
  expectFailure(
    "selected-result-transport-mismatch",
    ({ reports }) => {
      updateResultTransport(reports.lookaheadB, "packed-v1");
    },
    "A/B selected result-transport mismatch",
  );
  expectFailure(
    "fixture-count-mismatch",
    ({ reports }) => {
      reports.lookaheadB.fixtureCount = 11;
    },
    "A/B fixture-count mismatch",
  );
  expectFailure(
    "food-count-mismatch",
    ({ reports }) => {
      reports.lookaheadB.expectedFoodCount = 4;
    },
    "A/B expected-food-count mismatch",
  );
  expectFailure(
    "food-visit-count-mismatch",
    ({ reports }) => {
      reports.lookaheadB.expectedFoodVisitCount = 3;
    },
    "A/B expected-food-visit-count mismatch",
  );
  expectFailure(
    "concurrency-mismatch",
    ({ reports }) => {
      updateVisionConcurrency(reports.lookaheadB, 4);
    },
    "A/B Vision-concurrency mismatch",
  );
  expectFailure(
    "concurrency-mode-mismatch",
    ({ reports }) => {
      reports.lookaheadB.configuration.visionConcurrencyMode = "native-default";
      reports.lookaheadB.configuration.visionConcurrencyOverridden = false;
      reports.lookaheadB.configuration.visionConcurrencyEnvironmentValue = null;
      reports.lookaheadB.runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue = null;
      reports.lookaheadB.runtimeAttestation.visionConcurrencyEnvironmentPresent = false;
    },
    "A/B Vision-concurrency mode mismatch",
  );
  expectFailure(
    "pipeline-depth-mismatch",
    ({ reports }) => {
      updatePipelineDepth(reports.lookaheadB, 5);
    },
    "A/B pipeline-depth mismatch",
  );
  expectFailure(
    "pipeline-mode-mismatch",
    ({ reports }) => {
      reports.lookaheadB.configuration.pipelineDepthMode = "override";
      reports.lookaheadB.configuration.pipelineDepthOverridden = true;
      reports.lookaheadB.configuration.pipelineDepthEnvironmentValue = 4;
      reports.lookaheadB.runtimeAttestation.observedProcessPipelineDepthEnvironmentValue = 4;
      reports.lookaheadB.runtimeAttestation.pipelineDepthEnvironmentPresent = true;
    },
    "A/B pipeline-depth mode mismatch",
  );
  expectFailure(
    "component-identity-mismatch",
    ({ reports }) => {
      reports.lookaheadB.originalDatabase.wal.sha256 = "3".repeat(64);
    },
    "A/B original database component mismatch",
  );
  expectFailure(
    "standalone-snapshot-mismatch",
    ({ reports }) => {
      reports.lookaheadB.standaloneSnapshotSha256 = "3".repeat(64);
      reports.lookaheadB.semanticReference.sha256 = "3".repeat(64);
      reports.lookaheadB.semanticReference.components.main.sha256 = "3".repeat(64);
    },
    "A/B standalone snapshot mismatch",
  );
  expectFailure(
    "missing-semantic-reference",
    ({ reports }) => {
      delete (reports.lookaheadB as unknown as { semanticReference?: TestReport["semanticReference"] })
        .semanticReference;
    },
    "semanticReference must be an object",
  );
  expectFailure(
    "missing-semantic-reference-components",
    ({ reports }) => {
      delete (
        reports.lookaheadB.semanticReference as unknown as {
          components?: SemanticReference["components"];
        }
      ).components;
    },
    "semantic reference components must be an object",
  );
  expectFailure(
    "nonempty-semantic-reference-wal",
    ({ reports }) => {
      reports.lookaheadB.semanticReference = makeSemanticReference(
        "external-current-control",
        externalSemanticReferenceSha256,
      );
      reports.lookaheadB.semanticReference.components.wal = {
        present: true,
        sha256: "5".repeat(64),
        mode: "600",
        bytes: 4_096,
      };
    },
    "semantic reference WAL must be empty",
  );
  expectFailure(
    "invalid-semantic-reference-source",
    ({ reports }) => {
      reports.lookaheadB.semanticReference.source = "unsupported" as SemanticReferenceSource;
    },
    "semantic reference source must be live-original-snapshot or external-current-control",
  );
  expectFailure(
    "invalid-semantic-reference-hash",
    ({ reports }) => {
      reports.lookaheadB.semanticReference.sha256 = "not-a-digest";
    },
    "semantic reference SHA-256 must be a SHA-256 digest",
  );
  expectFailure(
    "live-semantic-reference-snapshot-mismatch",
    ({ reports }) => {
      reports.lookaheadB.semanticReference.sha256 = externalSemanticReferenceSha256;
      reports.lookaheadB.semanticReference.components.main.sha256 = externalSemanticReferenceSha256;
    },
    "live-original semantic reference must match the standalone snapshot",
  );
  expectFailure(
    "semantic-reference-source-mismatch",
    (fixtureSet) => {
      fixtureSet.reports.lookaheadB.semanticReference = {
        ...makeSemanticReference("external-current-control", externalSemanticReferenceSha256),
      };
    },
    "A/B semantic-reference source mismatch",
  );
  expectFailure(
    "semantic-reference-hash-mismatch",
    (fixtureSet) => {
      setExternalSemanticReference(fixtureSet);
      fixtureSet.reports.lookaheadB.semanticReference.sha256 = "3".repeat(64);
      fixtureSet.reports.lookaheadB.semanticReference.components.main.sha256 = "3".repeat(64);
    },
    "A/B semantic-reference SHA-256 mismatch",
  );
  expectFailure(
    "semantic-reference-component-mismatch",
    (fixtureSet) => {
      setExternalSemanticReference(fixtureSet);
      fixtureSet.reports.lookaheadB.semanticReference.components.shm = {
        present: true,
        sha256: "6".repeat(64),
        mode: "600",
        bytes: 32_768,
      };
    },
    "A/B semantic-reference component mismatch",
  );
  expectFailure(
    "prepared-state-mismatch",
    ({ reports }) => {
      reports.lookaheadB.triggerBoundary.preparedVisionStateSha256 = "3".repeat(64);
      reports.lookaheadB.triggerBoundary.preTriggerVisionStateSha256 = "3".repeat(64);
    },
    "A/B prepared Vision-state mismatch",
  );
  expectFailure(
    "semantic-photo-parity",
    ({ reports }) => {
      reports.lookaheadB.validation.exactSemanticPhotoParity = false;
    },
    "exact semantic photo parity",
  );
  expectFailure(
    "photo-mismatch-count",
    ({ reports }) => {
      reports.lookaheadB.validation.photoMismatchCount = 1;
    },
    "photo mismatch count",
  );
  expectFailure(
    "visit-parity",
    ({ reports }) => {
      reports.lookaheadB.validation.exactVisitFoodParity = false;
    },
    "exact visit-food parity",
  );
  expectFailure(
    "visit-mismatch-count",
    ({ reports }) => {
      reports.lookaheadB.validation.visitMismatchCount = 1;
    },
    "visit mismatch count",
  );
  expectFailure(
    "integrity-failure",
    ({ reports }) => {
      reports.lookaheadB.validation.integrity = "corrupt";
    },
    "SQLite integrity",
  );
  expectFailure(
    "foreign-key-failure",
    ({ reports }) => {
      reports.lookaheadB.validation.foreignKeyViolationCount = 1;
    },
    "foreign-key violations",
  );
  expectFailure(
    "pending-rows",
    ({ reports }) => {
      reports.lookaheadB.validation.pendingCount = 1;
    },
    "pending count",
  );
  expectFailure(
    "restoration-failure",
    ({ reports }) => {
      reports.lookaheadB.restoration.exactMainAndSidecarSetRestored = false;
    },
    "exact main/sidecar restoration",
  );
  expectFailure(
    "environment-restoration-failure",
    ({ reports }) => {
      reports.lookaheadB.restoration.launchEnvironmentRestored = false;
    },
    "launch environment restoration",
  );
  expectFailure(
    "raw-policy-restoration-failure",
    ({ reports }) => {
      reports.lookaheadB.restoration.rawDatabasePolicyApplied = false;
    },
    "raw database policy",
  );
  expectFailure(
    "publication-order-failure",
    ({ reports }) => {
      reports.lookaheadB.restoration.reportPublishedAfterRestoration = false;
    },
    "report publication ordering",
  );
  expectFailure(
    "restored-hash-mismatch",
    ({ reports }) => {
      reports.lookaheadB.restoration.restoredDatabaseSha256 = "3".repeat(64);
    },
    "restored database identity",
  );
  expectFailure(
    "raw-retained",
    ({ reports }) => {
      reports.lookaheadB.rawDatabases.retained = true;
      reports.lookaheadB.rawDatabases.snapshotPath = "private.original.db";
    },
    "raw databases must not be retained",
  );
  expectFailure(
    "raw-path-present",
    ({ reports }) => {
      reports.lookaheadB.rawDatabases.snapshotPath = "private.original.db";
    },
    "raw snapshot path must be aggregate-only",
  );
  expectFailure(
    "result-retained",
    ({ reports }) => {
      reports.lookaheadB.resultDatabase.retained = true;
      reports.lookaheadB.resultDatabase.path = "private.result.db";
    },
    "result database must not be retained",
  );
  expectFailure(
    "negative-timing",
    ({ reports }) => {
      reports.lookaheadB.wallSeconds = -1;
      reports.lookaheadB.timing.firstDurableProgressToCompletionSeconds = -1;
    },
    "wallSeconds must be finite and nonnegative",
  );
  expectFailure(
    "inconsistent-timing",
    ({ reports }) => {
      reports.lookaheadB.timing.triggerToDurableCompletionSeconds += 1;
    },
    "trigger timing components are inconsistent",
  );
  expectFailure(
    "strict-signature-failure",
    ({ reports }) => {
      reports.lookaheadB.buildAttestation.strictCodeSignatureVerified = false;
    },
    "strict code signature",
  );
  expectFailure(
    "running-executable-mismatch",
    ({ reports }) => {
      reports.lookaheadB.buildAttestation.runningExecutableSha256 = "3".repeat(64);
    },
    "supplied and running executable identity",
  );
  expectFailure(
    "sampling-interval-mismatch",
    ({ reports }) => {
      reports.lookaheadB.timing.samplingIntervalSeconds = 0.1;
    },
    "A/B sampling-interval mismatch",
  );
  expectFailure(
    "absolute-samples-path",
    ({ reports }) => {
      reports.lookaheadB.samplesPath = "/private/result.samples.tsv";
    },
    "samples path must be aggregate-only",
  );
  expectFailure(
    "invalid-absent-component",
    ({ reports }) => {
      reports.lookaheadB.originalDatabase.journal.sha256 = "3".repeat(64);
    },
    "original journal.sha256 must be null when absent",
  );
  expectFailure(
    "zero-serial-median",
    ({ reports }) => {
      for (const report of [reports.serialA, reports.serialB]) {
        report.wallSeconds = 0;
        report.timing.firstDurableProgressToCompletionSeconds = 0;
        report.timing.triggerToDurableCompletionSeconds = report.timing.triggerToFirstDurableProgressSeconds;
        report.triggerBoundary.durableCompletionObservedAtEpochSeconds =
          report.triggerBoundary.triggerEpochSeconds + report.timing.triggerToDurableCompletionSeconds;
      }
    },
    "serial median durable-tail timing must be positive",
  );

  const outputCollision = createFixtureSet("output-collision");
  writeFixtureSet(outputCollision);
  writeFileSync(outputCollision.paths.output, "user-owned-summary\n", { mode: 0o600 });
  const collisionResult = execute(outputCollision);
  assert.notEqual(collisionResult.status, 0, "output collision unexpectedly succeeded");
  assert.match(collisionResult.stderr, /Output path already exists/);
  assert.equal(readFileSync(outputCollision.paths.output, "utf8"), "user-owned-summary\n");

  console.log(
    "macOS Vision orchestration A/B summary contract passed: strict schema-v6 aggregate, schema-2 native work counters, balanced pairing, stable build/workload/database/transport identity, trigger-to-completion timeline, restoration, and descriptive-only output.",
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
