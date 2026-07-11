#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

type ResultTransport = "legacy" | "packed-v1";
type Strategy = "serial" | "lookahead";
type TuningMode = "native-default" | "override";
type SemanticReferenceSource = "live-original-snapshot" | "external-current-control";

interface Configuration {
  legacyPaths: string[];
  packedV1Paths: string[];
  outputPath: string;
}

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

interface VisionReport {
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
  semanticReference: {
    source: SemanticReferenceSource;
    sha256: string;
    components: {
      main: SemanticReferenceComponent;
      wal: SemanticReferenceComponent;
      shm: SemanticReferenceComponent;
      journal: SemanticReferenceComponent;
    };
  };
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

interface LoadedRun {
  path: string;
  report: VisionReport;
  runId: string;
  transport: ResultTransport;
  originalDatabaseIdentity: string;
}

interface GroupSummary {
  transport: ResultTransport;
  reports: string[];
  runIds: string[];
  sampleCount: number;
  wallSeconds: number[];
  medianWallSeconds: number;
  firstDurableProgressToCompletionSeconds: number[];
  medianFirstDurableProgressToCompletionSeconds: number;
  triggerToDurableCompletionSeconds: number[];
  medianTriggerToDurableCompletionSeconds: number;
  triggerToFirstDurableProgressSeconds: number[];
  medianTriggerToFirstDurableProgressSeconds: number;
  maxRssKiB: number[];
  medianMaxRssKiB: number;
}

process.umask(0o077);

function usage(): string {
  return "Usage: summarize-macos-vision-transport-ab.ts --legacy=REPORT[,REPORT...] --packed-v1=REPORT[,REPORT...] --output=PATH";
}

function parsePaths(value: string, option: string): string[] {
  const pieces = value.split(",").map((path) => path.trim());
  assert.ok(pieces.length > 0 && pieces.every(Boolean), `${option} requires a comma-separated report list`);
  return pieces.map((path) => resolve(path));
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let legacyPaths: string[] | undefined;
  let packedV1Paths: string[] | undefined;
  let outputPath: string | undefined;
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 0) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--legacy":
        assert.equal(legacyPaths, undefined, "--legacy may be supplied only once");
        legacyPaths = parsePaths(value, option);
        break;
      case "--packed-v1":
        assert.equal(packedV1Paths, undefined, "--packed-v1 may be supplied only once");
        packedV1Paths = parsePaths(value, option);
        break;
      case "--output":
        assert.equal(outputPath, undefined, "--output may be supplied only once");
        assert.ok(value.trim().length > 0, "--output cannot be empty");
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!legacyPaths || !packedV1Paths || !outputPath) {
    throw new Error(usage());
  }
  return { legacyPaths, packedV1Paths, outputPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
}

function nonemptyString(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && value.trim().length > 0, `${label} must be a nonempty string`);
}

function safeToken(value: unknown, label: string): asserts value is string {
  nonemptyString(value, label);
  assert.match(value, /^[A-Za-z0-9._-]+$/, `${label} must be a path-free token`);
}

function sha256(value: unknown, label: string): asserts value is string {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}$/i, `${label} must be a SHA-256 digest`);
}

function finiteNonnegative(value: unknown, label: string): asserts value is number {
  assert.ok(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} must be finite and nonnegative`,
  );
}

function finitePositive(value: unknown, label: string): asserts value is number {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} must be finite and positive`);
}

function nonnegativeInteger(value: unknown, label: string): asserts value is number {
  assert.ok(Number.isInteger(value) && (value as number) >= 0, `${label} must be a nonnegative integer`);
}

function positiveIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  assert.ok(
    Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`,
  );
}

function validateDatabaseComponent(component: DatabaseComponent, label: string, required: boolean): void {
  requireRecord(component, label);
  assert.equal(typeof component.present, "boolean", `${label}.present must be boolean`);
  if (required) {
    assert.equal(component.present, true, `${label} must be present`);
  }
  if (component.present) {
    sha256(component.sha256, `${label}.sha256`);
    assert.ok(typeof component.mode === "string", `${label}.mode must be a string`);
    assert.match(component.mode, /^[0-7]{3,4}$/, `${label}.mode must be an octal file mode`);
  } else {
    assert.equal(component.sha256, null, `${label}.sha256 must be null when absent`);
    assert.equal(component.mode, null, `${label}.mode must be null when absent`);
  }
}

function validateSemanticReferenceComponent(
  component: SemanticReferenceComponent,
  label: string,
  required: boolean,
  mustBeEmpty: boolean,
): void {
  validateDatabaseComponent(component, label, required);
  if (component.present) {
    nonnegativeInteger(component.bytes, `${label}.bytes`);
    if (required) {
      assert.ok(component.bytes > 0, `${label}.bytes must be positive`);
    }
    if (mustBeEmpty) {
      assert.equal(component.bytes, 0, `${label} must be empty`);
    }
  } else {
    assert.equal(component.bytes, null, `${label}.bytes must be null when absent`);
  }
}

function normalizedOriginalDatabase(report: VisionReport): string {
  return JSON.stringify(report.originalDatabase);
}

function validateTuning(
  value: number,
  mode: TuningMode,
  overridden: boolean,
  environmentValue: number | null,
  runtimeValue: number,
  runtimeEnvironmentValue: number | null,
  runtimeEnvironmentPresent: boolean,
  minimum: number,
  maximum: number,
  label: string,
): void {
  positiveIntegerInRange(value, minimum, maximum, `${label} value`);
  assert.ok(mode === "native-default" || mode === "override", `${label} mode must be native-default or override`);
  assert.equal(overridden, mode === "override", `${label} override mode`);
  assert.equal(runtimeValue, value, `${label} runtime resolution`);
  assert.equal(runtimeEnvironmentPresent, overridden, `${label} runtime environment presence`);
  if (overridden) {
    assert.equal(environmentValue, value, `${label} configuration environment value`);
    assert.equal(runtimeEnvironmentValue, value, `${label} runtime environment value`);
  } else {
    assert.equal(environmentValue, null, `${label} configuration environment value must be null by default`);
    assert.equal(runtimeEnvironmentValue, null, `${label} runtime environment value must be null by default`);
  }
}

function validateResultTransportAttestation(
  report: VisionReport,
  path: string,
  expectedTransport: ResultTransport,
): void {
  assert.equal(report.resultTransport, expectedTransport, `${path}: top-level selected result transport`);
  assert.equal(report.requestedResultTransport, expectedTransport, `${path}: top-level requested result transport`);
  assert.equal(
    report.configuration.resultTransport,
    expectedTransport,
    `${path}: configured selected result transport`,
  );
  assert.equal(
    report.configuration.requestedResultTransport,
    expectedTransport,
    `${path}: configured requested result transport`,
  );
  assert.equal(
    report.configuration.expectedResolvedResultTransport,
    expectedTransport,
    `${path}: configured resolved result transport`,
  );

  const runtime = report.runtimeAttestation;
  assert.equal(runtime.requestedResultTransport, expectedTransport, `${path}: runtime requested result transport`);
  assert.equal(runtime.observedProcessResultTransport, expectedTransport, `${path}: runtime selected result transport`);
  assert.equal(
    runtime.expectedResolvedResultTransport,
    expectedTransport,
    `${path}: runtime resolved result transport`,
  );
  assert.equal(
    runtime.observedProcessResultTransportEnvironmentValue,
    expectedTransport,
    `${path}: process result-transport environment value`,
  );
  assert.equal(runtime.resultTransportEnvironmentPresent, true, `${path}: result-transport environment presence`);
  assert.equal(
    runtime.source,
    "process-environment-plus-native-result-transport-attestation",
    `${path}: runtime attestation source`,
  );
  finiteNonnegative(runtime.processEnvironmentObservedAtEpochSeconds, `${path}: process-environment observation epoch`);

  requireRecord(runtime.nativeResultTransport, `${path}: native result-transport attestation`);
  const native = runtime.nativeResultTransport;
  assert.equal(native.schemaVersion, 2, `${path}: native result-transport schema must be exactly 2`);
  safeToken(native.runId, `${path}: native result-transport run ID`);
  assert.equal(native.runId, runtime.runId, `${path}: native result-transport run ID`);
  assert.equal(native.configuredResultTransport, expectedTransport, `${path}: native configured result transport`);
  assert.equal(native.resolvedResultTransport, expectedTransport, `${path}: native resolved result transport`);
  assert.equal(native.selectedResultTransport, expectedTransport, `${path}: native selected result transport`);
  finiteNonnegative(native.observedAtEpochSeconds, `${path}: native result-transport observation epoch`);
  finiteNonnegative(runtime.observedAtEpochSeconds, `${path}: runtime attestation epoch`);
  assert.equal(
    runtime.observedAtEpochSeconds,
    native.observedAtEpochSeconds,
    `${path}: runtime observation must mirror native result-transport attestation`,
  );
  finiteNonnegative(native.lastObservedAtEpochSeconds, `${path}: native final observation epoch`);
  assert.ok(
    native.lastObservedAtEpochSeconds >= native.observedAtEpochSeconds,
    `${path}: native final observation must not precede dispatch start`,
  );
  assert.equal(native.workCountersAvailable, true, `${path}: native work-counter availability`);
  requireRecord(native.workCounters, `${path}: native work counters`);
  const workCounters = native.workCounters as unknown as NativeWorkCounters;
  for (const key of [
    "startedBatchCount",
    "startedRequestedAssetCount",
    "completedBatchCount",
    "completedRequestedAssetCount",
    "resolvedBatchCount",
    "resolvedRequestedAssetCount",
    "rejectedBatchCount",
    "rejectedRequestedAssetCount",
    "cancelledBatchCount",
    "cancelledRequestedAssetCount",
    "inFlightBatchCount",
    "inFlightRequestedAssetCount",
  ] as const) {
    nonnegativeInteger(workCounters[key], `${path}: native work counters.${key}`);
  }
  assert.equal(workCounters.startedBatchCount, workCounters.completedBatchCount, `${path}: completed batch balance`);
  assert.equal(workCounters.completedBatchCount, workCounters.resolvedBatchCount, `${path}: resolved batch balance`);
  assert.equal(
    workCounters.startedRequestedAssetCount,
    workCounters.completedRequestedAssetCount,
    `${path}: completed requested-asset balance`,
  );
  assert.equal(
    workCounters.completedRequestedAssetCount,
    workCounters.resolvedRequestedAssetCount,
    `${path}: resolved requested-asset balance`,
  );
  for (const key of [
    "rejectedBatchCount",
    "rejectedRequestedAssetCount",
    "cancelledBatchCount",
    "cancelledRequestedAssetCount",
    "inFlightBatchCount",
    "inFlightRequestedAssetCount",
  ] as const) {
    assert.equal(workCounters[key], 0, `${path}: native work counters.${key}`);
  }
  requireRecord(report.workload, `${path}: workload`);
  nonnegativeInteger(report.workload.attemptedSamples, `${path}: attempted samples`);
  nonnegativeInteger(report.workload.expectedNativeBatchCount, `${path}: expected native batch count`);
  assert.equal(report.workload.directNativeCountersRequired, true, `${path}: direct native counters required`);
  assert.equal(report.workload.directNativeCountersAvailable, true, `${path}: direct native counters available`);
  assert.equal(
    report.workload.attemptAccountingSource,
    "native-dispatch-counters-plus-rank-plan-plus-durable-result-state",
    `${path}: attempt accounting source`,
  );
  assert.deepEqual(report.workload.nativeDispatch, workCounters, `${path}: native dispatch counter report`);
  assert.equal(
    workCounters.startedRequestedAssetCount,
    report.workload.attemptedSamples,
    `${path}: direct requested assets must match attempts`,
  );
  assert.equal(
    workCounters.startedBatchCount,
    report.workload.expectedNativeBatchCount,
    `${path}: direct batches must match the plan`,
  );
  requireRecord(report.validation, `${path}: validation`);
  assert.equal(report.validation.nativeWorkCountersRequired, true, `${path}: validation required native counters`);
  assert.equal(report.validation.nativeWorkCountersAvailable, true, `${path}: validation observed native counters`);
  assert.equal(report.validation.nativeWorkLifecycleBalanced, true, `${path}: validation balanced native lifecycle`);
  assert.equal(
    report.validation.nativeRequestedAssetCountMatchesAttempts,
    true,
    `${path}: validation requested-asset match`,
  );
  assert.equal(report.validation.nativeBatchCountMatchesPlan, true, `${path}: validation native batch match`);
}

function validateTiming(report: VisionReport, path: string): void {
  requireRecord(report.timing, `${path}: timing`);
  finiteNonnegative(report.wallSeconds, `${path}: wallSeconds`);
  finiteNonnegative(
    report.timing.firstDurableProgressToCompletionSeconds,
    `${path}: first-durable-progress-to-completion timing`,
  );
  finiteNonnegative(report.timing.triggerToDurableCompletionSeconds, `${path}: trigger-to-completion timing`);
  finiteNonnegative(report.timing.triggerToFirstDurableProgressSeconds, `${path}: trigger-to-first-progress timing`);
  finitePositive(report.timing.samplingIntervalSeconds, `${path}: sampling interval`);
  finitePositive(report.maxRssKiB, `${path}: max RSS`);
  assert.equal(
    report.wallSeconds,
    report.timing.firstDurableProgressToCompletionSeconds,
    `${path}: wallSeconds must equal the durable-tail timing`,
  );
  const reconstructedCompletion =
    report.timing.triggerToFirstDurableProgressSeconds + report.timing.firstDurableProgressToCompletionSeconds;
  assert.ok(
    Math.abs(reconstructedCompletion - report.timing.triggerToDurableCompletionSeconds) <= 0.000_01,
    `${path}: trigger timing components are inconsistent`,
  );
}

function validateTriggerBoundary(report: VisionReport, path: string): void {
  requireRecord(report.triggerBoundary, `${path}: triggerBoundary`);
  const trigger = report.triggerBoundary;
  sha256(trigger.preparedVisionStateSha256, `${path}: prepared Vision state`);
  sha256(trigger.preTriggerVisionStateSha256, `${path}: pre-trigger Vision state`);
  assert.equal(
    trigger.preTriggerVisionStateSha256,
    trigger.preparedVisionStateSha256,
    `${path}: pre-trigger Vision state changed`,
  );
  assert.equal(trigger.unchangedBeforeTrigger, true, `${path}: unchanged-before-trigger attestation`);
  finiteNonnegative(trigger.preTriggerObservedAtEpochSeconds, `${path}: pre-trigger observation epoch`);
  finiteNonnegative(trigger.triggerEpochSeconds, `${path}: trigger epoch`);
  finiteNonnegative(trigger.triggerObservedAtEpochSeconds, `${path}: trigger observation epoch`);
  finiteNonnegative(trigger.durableCompletionObservedAtEpochSeconds, `${path}: durable-completion observation epoch`);
  finitePositive(trigger.maxTriggerAgeSeconds, `${path}: maximum trigger age`);
  assert.ok(
    trigger.preTriggerObservedAtEpochSeconds >= report.runtimeAttestation.processEnvironmentObservedAtEpochSeconds,
    `${path}: pre-trigger observation must follow process-environment attestation`,
  );
  assert.ok(
    trigger.triggerEpochSeconds >= trigger.preTriggerObservedAtEpochSeconds,
    `${path}: trigger must follow pre-trigger attestation`,
  );
  assert.ok(
    trigger.triggerObservedAtEpochSeconds >= trigger.triggerEpochSeconds,
    `${path}: trigger observation must not precede trigger`,
  );
  assert.ok(
    trigger.triggerObservedAtEpochSeconds - trigger.triggerEpochSeconds <= trigger.maxTriggerAgeSeconds,
    `${path}: trigger evidence is stale`,
  );
  assert.ok(
    trigger.durableCompletionObservedAtEpochSeconds >= trigger.triggerObservedAtEpochSeconds,
    `${path}: durable completion must follow trigger observation`,
  );
  const nativeTimestamp = report.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds;
  assert.ok(
    nativeTimestamp >= trigger.triggerEpochSeconds,
    `${path}: native result-transport attestation must not precede the trigger`,
  );
  assert.ok(
    nativeTimestamp <= trigger.durableCompletionObservedAtEpochSeconds,
    `${path}: native result-transport attestation must not follow durable completion`,
  );
  assert.ok(
    report.runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds! <=
      trigger.durableCompletionObservedAtEpochSeconds,
    `${path}: native final observation must not follow durable completion`,
  );
  const observedTriggerToCompletion = trigger.durableCompletionObservedAtEpochSeconds - trigger.triggerEpochSeconds;
  assert.ok(
    Math.abs(observedTriggerToCompletion - report.timing.triggerToDurableCompletionSeconds) <= 0.000_01,
    `${path}: durable-completion epoch is inconsistent with trigger timing`,
  );
  assert.equal(trigger.triggerFollowedPreTriggerAttestation, true, `${path}: trigger-followed-attestation flag`);
  assert.equal(trigger.triggerWasNotFutureDated, true, `${path}: nonfuture trigger flag`);
  assert.equal(trigger.triggerWasFresh, true, `${path}: trigger freshness flag`);
}

function loadAndValidate(path: string, expectedTransport: ResultTransport): LoadedRun {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  requireRecord(parsed, `${path}: report`);
  const report = parsed as unknown as VisionReport;
  assert.equal(report.schemaVersion, 6, `${path}: report schema must be exactly 6`);
  requireRecord(report.schemaCompatibility, `${path}: schemaCompatibility`);
  assert.equal(report.schemaCompatibility.previousSchemaVersion, 5, `${path}: previous schema version must be 5`);
  assert.equal(report.schemaCompatibility.semanticFieldsPreserved, true, `${path}: schema semantic compatibility`);
  assert.equal(report.status, "ok", `${path}: status`);

  positiveIntegerInRange(report.pageSize, 1, 2_000, `${path}: page size`);
  assert.ok(
    report.pageOrchestrationStrategy === "serial" || report.pageOrchestrationStrategy === "lookahead",
    `${path}: page orchestration strategy`,
  );
  requireRecord(report.configuration, `${path}: configuration`);
  assert.equal(report.configuration.resultPageSize, report.pageSize, `${path}: configured page size`);
  assert.equal(
    report.configuration.pageOrchestrationStrategy,
    report.pageOrchestrationStrategy,
    `${path}: configured page orchestration strategy`,
  );

  requireRecord(report.runtimeAttestation, `${path}: runtimeAttestation`);
  safeToken(report.runtimeAttestation.runId, `${path}: runtime run ID`);
  requireRecord(report.runtimeAttestation.nativeResultTransport, `${path}: native result-transport attestation`);
  validateResultTransportAttestation(report, path, expectedTransport);
  assert.equal(report.runtimeAttestation.observedProcessPageSize, report.pageSize, `${path}: runtime page size`);
  assert.equal(
    report.runtimeAttestation.expectedResolvedPageOrchestrationStrategy,
    report.pageOrchestrationStrategy,
    `${path}: expected runtime orchestration strategy`,
  );
  assert.equal(
    report.runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue,
    report.pageOrchestrationStrategy,
    `${path}: observed runtime orchestration strategy`,
  );
  assert.equal(
    report.runtimeAttestation.pageOrchestrationStrategyEnvironmentPresent,
    true,
    `${path}: orchestration environment presence`,
  );
  validateTuning(
    report.configuration.visionConcurrency,
    report.configuration.visionConcurrencyMode,
    report.configuration.visionConcurrencyOverridden,
    report.configuration.visionConcurrencyEnvironmentValue,
    report.runtimeAttestation.expectedResolvedVisionConcurrency,
    report.runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue,
    report.runtimeAttestation.visionConcurrencyEnvironmentPresent,
    1,
    16,
    `${path}: Vision concurrency`,
  );
  validateTuning(
    report.configuration.pipelineDepth,
    report.configuration.pipelineDepthMode,
    report.configuration.pipelineDepthOverridden,
    report.configuration.pipelineDepthEnvironmentValue,
    report.runtimeAttestation.expectedResolvedPipelineDepth,
    report.runtimeAttestation.observedProcessPipelineDepthEnvironmentValue,
    report.runtimeAttestation.pipelineDepthEnvironmentPresent,
    1,
    64,
    `${path}: pipeline depth`,
  );

  nonnegativeInteger(report.fixtureCount, `${path}: fixture count`);
  nonnegativeInteger(report.expectedFoodCount, `${path}: expected food count`);
  nonnegativeInteger(report.expectedFoodVisitCount, `${path}: expected food-visit count`);
  assert.ok(report.fixtureCount > 0, `${path}: fixture count must be positive`);
  assert.ok(report.expectedFoodCount <= report.fixtureCount, `${path}: food count exceeds fixture count`);

  validateTiming(report, path);
  validateTriggerBoundary(report, path);

  requireRecord(report.buildAttestation, `${path}: buildAttestation`);
  nonemptyString(report.buildAttestation.suppliedAppName, `${path}: supplied app name`);
  nonemptyString(report.buildAttestation.runningAppName, `${path}: running app name`);
  assert.equal(
    basename(report.buildAttestation.suppliedAppName),
    report.buildAttestation.suppliedAppName,
    `${path}: supplied app identity must be a basename`,
  );
  assert.equal(
    report.buildAttestation.runningAppName,
    report.buildAttestation.suppliedAppName,
    `${path}: supplied and running app identity`,
  );
  sha256(report.buildAttestation.suppliedExecutableSha256, `${path}: supplied executable SHA-256`);
  sha256(report.buildAttestation.runningExecutableSha256, `${path}: running executable SHA-256`);
  sha256(report.buildAttestation.suppliedMainJsBundleSha256, `${path}: supplied main.jsbundle SHA-256`);
  sha256(report.buildAttestation.runningMainJsBundleSha256, `${path}: running main.jsbundle SHA-256`);
  assert.equal(report.buildAttestation.strictCodeSignatureVerified, true, `${path}: strict code signature`);
  assert.equal(report.buildAttestation.exactExecutableMatch, true, `${path}: executable match attestation`);
  assert.equal(report.buildAttestation.exactMainJsBundleMatch, true, `${path}: bundle match attestation`);
  assert.equal(
    report.buildAttestation.runningExecutableSha256,
    report.buildAttestation.suppliedExecutableSha256,
    `${path}: supplied and running executable identity`,
  );
  assert.equal(
    report.buildAttestation.runningMainJsBundleSha256,
    report.buildAttestation.suppliedMainJsBundleSha256,
    `${path}: supplied and running bundle identity`,
  );

  requireRecord(report.validation, `${path}: validation`);
  assert.equal(report.validation.exactSemanticPhotoParity, true, `${path}: exact semantic photo parity`);
  assert.equal(report.validation.photoMismatchCount, 0, `${path}: photo mismatch count`);
  assert.equal(report.validation.exactVisitFoodParity, true, `${path}: exact visit-food parity`);
  assert.equal(report.validation.visitMismatchCount, 0, `${path}: visit mismatch count`);
  assert.equal(report.validation.pendingCount, 0, `${path}: pending count`);
  assert.equal(report.validation.integrity, "ok", `${path}: SQLite integrity`);
  assert.equal(report.validation.foreignKeyViolationCount, 0, `${path}: foreign-key violations`);

  sha256(report.originalDatabaseSha256, `${path}: original database SHA-256`);
  requireRecord(report.originalDatabase, `${path}: originalDatabase`);
  validateDatabaseComponent(report.originalDatabase.main, `${path}: original main`, true);
  validateDatabaseComponent(report.originalDatabase.wal, `${path}: original WAL`, false);
  validateDatabaseComponent(report.originalDatabase.shm, `${path}: original SHM`, false);
  validateDatabaseComponent(report.originalDatabase.journal, `${path}: original journal`, false);
  assert.equal(report.originalDatabase.main.sha256, report.originalDatabaseSha256, `${path}: original main identity`);
  sha256(report.standaloneSnapshotSha256, `${path}: standalone snapshot SHA-256`);

  requireRecord(report.semanticReference, `${path}: semanticReference`);
  assert.ok(
    report.semanticReference.source === "live-original-snapshot" ||
      report.semanticReference.source === "external-current-control",
    `${path}: semantic reference source must be live-original-snapshot or external-current-control`,
  );
  sha256(report.semanticReference.sha256, `${path}: semantic reference SHA-256`);
  requireRecord(report.semanticReference.components, `${path}: semantic reference components`);
  validateSemanticReferenceComponent(
    report.semanticReference.components.main,
    `${path}: semantic reference main`,
    true,
    false,
  );
  validateSemanticReferenceComponent(
    report.semanticReference.components.wal,
    `${path}: semantic reference WAL`,
    false,
    true,
  );
  validateSemanticReferenceComponent(
    report.semanticReference.components.shm,
    `${path}: semantic reference SHM`,
    false,
    false,
  );
  validateSemanticReferenceComponent(
    report.semanticReference.components.journal,
    `${path}: semantic reference journal`,
    false,
    true,
  );
  assert.equal(
    report.semanticReference.components.main.sha256,
    report.semanticReference.sha256,
    `${path}: semantic reference main identity`,
  );
  if (report.semanticReference.source === "live-original-snapshot") {
    assert.equal(
      report.semanticReference.sha256,
      report.standaloneSnapshotSha256,
      `${path}: live-original semantic reference must match the standalone snapshot`,
    );
    assert.equal(report.semanticReference.components.wal.present, false, `${path}: live reference WAL must be absent`);
    assert.equal(report.semanticReference.components.shm.present, false, `${path}: live reference SHM must be absent`);
    assert.equal(
      report.semanticReference.components.journal.present,
      false,
      `${path}: live reference journal must be absent`,
    );
  }

  requireRecord(report.resultDatabase, `${path}: resultDatabase`);
  sha256(report.resultDatabase.sha256, `${path}: result database SHA-256`);
  assert.equal(report.resultDatabase.retained, false, `${path}: result database must not be retained`);
  assert.equal(report.resultDatabase.path, null, `${path}: result database path must be aggregate-only`);
  requireRecord(report.rawDatabases, `${path}: rawDatabases`);
  assert.equal(report.rawDatabases.retained, false, `${path}: raw databases must not be retained`);
  assert.equal(report.rawDatabases.snapshotPath, null, `${path}: raw snapshot path must be aggregate-only`);

  requireRecord(report.restoration, `${path}: restoration`);
  assert.equal(report.restoration.exactMainAndSidecarSetRestored, true, `${path}: exact main/sidecar restoration`);
  assert.equal(report.restoration.launchEnvironmentRestored, true, `${path}: launch environment restoration`);
  assert.equal(report.restoration.rawDatabasePolicyApplied, true, `${path}: raw database policy`);
  assert.equal(report.restoration.reportPublishedAfterRestoration, true, `${path}: report publication ordering`);
  sha256(report.restoration.restoredDatabaseSha256, `${path}: restored database SHA-256`);
  assert.equal(
    report.restoration.restoredDatabaseSha256,
    report.originalDatabaseSha256,
    `${path}: restored database identity`,
  );

  nonemptyString(report.samplesPath, `${path}: samples path`);
  assert.equal(basename(report.samplesPath), report.samplesPath, `${path}: samples path must be aggregate-only`);

  return {
    path,
    report,
    runId: report.runtimeAttestation.runId,
    transport: expectedTransport,
    originalDatabaseIdentity: normalizedOriginalDatabase(report),
  };
}

function pathExistsIncludingDanglingSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validateUniquePaths(configuration: Configuration): void {
  const seenCanonicalPaths = new Map<string, string>();
  const seenFileIdentities = new Map<string, string>();
  for (const [transport, paths] of [
    ["legacy", configuration.legacyPaths],
    ["packed-v1", configuration.packedV1Paths],
  ] as const) {
    for (const path of paths) {
      const canonicalPath = realpathSync(path);
      const metadata = statSync(canonicalPath);
      assert.equal(metadata.isFile(), true, `${path}: input report must be a regular file`);
      const firstPath = seenCanonicalPaths.get(canonicalPath);
      assert.equal(
        firstPath,
        undefined,
        `Duplicate resolved report path: ${path} (${firstPath ?? transport} and ${transport})`,
      );
      seenCanonicalPaths.set(canonicalPath, path);
      const fileIdentity = `${metadata.dev}:${metadata.ino}`;
      const firstIdentityPath = seenFileIdentities.get(fileIdentity);
      assert.equal(
        firstIdentityPath,
        undefined,
        `Duplicate report file identity: ${path} and ${firstIdentityPath ?? path}`,
      );
      seenFileIdentities.set(fileIdentity, path);
    }
  }

  assert.equal(pathExistsIncludingDanglingSymlink(configuration.outputPath), false, "Output path already exists");
  for (const inputPath of [...configuration.legacyPaths, ...configuration.packedV1Paths]) {
    assert.notEqual(resolve(inputPath), configuration.outputPath, "Output path aliases an input report");
  }
}

function sharedConfigurationIdentity(report: VisionReport): unknown {
  return {
    pageSize: report.pageSize,
    pageOrchestrationStrategy: report.pageOrchestrationStrategy,
    configuration: {
      resultPageSize: report.configuration.resultPageSize,
      pageOrchestrationStrategy: report.configuration.pageOrchestrationStrategy,
      visionConcurrency: report.configuration.visionConcurrency,
      visionConcurrencyMode: report.configuration.visionConcurrencyMode,
      visionConcurrencyOverridden: report.configuration.visionConcurrencyOverridden,
      visionConcurrencyEnvironmentValue: report.configuration.visionConcurrencyEnvironmentValue,
      pipelineDepth: report.configuration.pipelineDepth,
      pipelineDepthMode: report.configuration.pipelineDepthMode,
      pipelineDepthOverridden: report.configuration.pipelineDepthOverridden,
      pipelineDepthEnvironmentValue: report.configuration.pipelineDepthEnvironmentValue,
    },
    fixtureCount: report.fixtureCount,
    expectedFoodCount: report.expectedFoodCount,
    expectedFoodVisitCount: report.expectedFoodVisitCount,
    samplingIntervalSeconds: report.timing.samplingIntervalSeconds,
    runtime: {
      observedProcessPageSize: report.runtimeAttestation.observedProcessPageSize,
      expectedResolvedPageOrchestrationStrategy: report.runtimeAttestation.expectedResolvedPageOrchestrationStrategy,
      observedProcessPageOrchestrationStrategyEnvironmentValue:
        report.runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue,
      pageOrchestrationStrategyEnvironmentPresent:
        report.runtimeAttestation.pageOrchestrationStrategyEnvironmentPresent,
      expectedResolvedVisionConcurrency: report.runtimeAttestation.expectedResolvedVisionConcurrency,
      observedProcessVisionConcurrencyEnvironmentValue:
        report.runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue,
      visionConcurrencyEnvironmentPresent: report.runtimeAttestation.visionConcurrencyEnvironmentPresent,
      expectedResolvedPipelineDepth: report.runtimeAttestation.expectedResolvedPipelineDepth,
      observedProcessPipelineDepthEnvironmentValue:
        report.runtimeAttestation.observedProcessPipelineDepthEnvironmentValue,
      pipelineDepthEnvironmentPresent: report.runtimeAttestation.pipelineDepthEnvironmentPresent,
      source: report.runtimeAttestation.source,
    },
    buildAttestation: report.buildAttestation,
    originalDatabaseSha256: report.originalDatabaseSha256,
    originalDatabase: report.originalDatabase,
    standaloneSnapshotSha256: report.standaloneSnapshotSha256,
    semanticReference: report.semanticReference,
    restoredDatabaseSha256: report.restoration.restoredDatabaseSha256,
    preparedVisionStateSha256: report.triggerBoundary.preparedVisionStateSha256,
  };
}

function validateSharedIdentity(runs: readonly LoadedRun[]): void {
  assert.ok(runs.length > 0, "At least one report is required");
  const baseline = runs[0]!;
  const baselineReport = baseline.report;
  const baselineSharedIdentity = sharedConfigurationIdentity(baselineReport);
  const seenRunIds = new Map<string, string>();
  for (const run of runs) {
    const duplicateRunPath = seenRunIds.get(run.runId);
    assert.equal(
      duplicateRunPath,
      undefined,
      `${run.path}: duplicate runtime run ID '${run.runId}' (already used by ${duplicateRunPath ?? run.path})`,
    );
    seenRunIds.set(run.runId, run.path);

    const report = run.report;
    assert.equal(
      report.buildAttestation.suppliedAppName,
      baselineReport.buildAttestation.suppliedAppName,
      `${run.path}: A/B app identity mismatch`,
    );
    assert.equal(
      report.buildAttestation.suppliedExecutableSha256,
      baselineReport.buildAttestation.suppliedExecutableSha256,
      `${run.path}: A/B executable mismatch`,
    );
    assert.equal(
      report.buildAttestation.suppliedMainJsBundleSha256,
      baselineReport.buildAttestation.suppliedMainJsBundleSha256,
      `${run.path}: A/B main.jsbundle mismatch`,
    );
    assert.equal(
      run.originalDatabaseIdentity,
      baseline.originalDatabaseIdentity,
      `${run.path}: A/B original database component mismatch`,
    );
    assert.deepEqual(
      sharedConfigurationIdentity(report),
      baselineSharedIdentity,
      `${run.path}: A/B shared configuration, fixture, database, or reference identity mismatch`,
    );
  }
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0, "Cannot compute a median for an empty group");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summarizeGroup(runs: readonly LoadedRun[], transport: ResultTransport): GroupSummary {
  assert.ok(runs.length > 0);
  for (const run of runs) {
    assert.equal(run.transport, transport);
  }
  const wallSeconds = runs.map((run) => run.report.wallSeconds);
  const durableTail = runs.map((run) => run.report.timing.firstDurableProgressToCompletionSeconds);
  const triggerToCompletion = runs.map((run) => run.report.timing.triggerToDurableCompletionSeconds);
  const triggerToFirstProgress = runs.map((run) => run.report.timing.triggerToFirstDurableProgressSeconds);
  const maxRssKiB = runs.map((run) => run.report.maxRssKiB);
  return {
    transport,
    reports: runs.map((run) => basename(run.path)),
    runIds: runs.map((run) => run.runId),
    sampleCount: runs.length,
    wallSeconds,
    medianWallSeconds: median(wallSeconds),
    firstDurableProgressToCompletionSeconds: durableTail,
    medianFirstDurableProgressToCompletionSeconds: median(durableTail),
    triggerToDurableCompletionSeconds: triggerToCompletion,
    medianTriggerToDurableCompletionSeconds: median(triggerToCompletion),
    triggerToFirstDurableProgressSeconds: triggerToFirstProgress,
    medianTriggerToFirstDurableProgressSeconds: median(triggerToFirstProgress),
    maxRssKiB,
    medianMaxRssKiB: median(maxRssKiB),
  };
}

function deltaAndPercent(
  packedV1: number,
  legacy: number,
): {
  packedV1MinusLegacy: number;
  packedV1MinusLegacyPercent: number;
} {
  assert.ok(legacy > 0, "Legacy metric must be positive to calculate a percent delta");
  const delta = packedV1 - legacy;
  return {
    packedV1MinusLegacy: delta,
    packedV1MinusLegacyPercent: (delta / legacy) * 100,
  };
}

function publishReport(outputPath: string, report: unknown): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    // Publishing an adjacent hard link is atomic and refuses a raced destination.
    linkSync(temporaryPath, outputPath);
  } finally {
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }
  assert.ok(configuration.legacyPaths.length >= 2, "legacy: at least two measured reports are required");
  assert.equal(
    configuration.packedV1Paths.length,
    configuration.legacyPaths.length,
    "A/B report groups must have equal sample counts",
  );
  validateUniquePaths(configuration);

  const legacyRuns = configuration.legacyPaths.map((path) => loadAndValidate(path, "legacy"));
  const packedV1Runs = configuration.packedV1Paths.map((path) => loadAndValidate(path, "packed-v1"));
  const allRuns = [...legacyRuns, ...packedV1Runs];
  validateSharedIdentity(allRuns);

  const legacy = summarizeGroup(legacyRuns, "legacy");
  const packedV1 = summarizeGroup(packedV1Runs, "packed-v1");
  for (const [label, value] of [
    ["legacy median durable-tail timing", legacy.medianFirstDurableProgressToCompletionSeconds],
    ["legacy median trigger-to-completion timing", legacy.medianTriggerToDurableCompletionSeconds],
    ["legacy median trigger-to-first-progress timing", legacy.medianTriggerToFirstDurableProgressSeconds],
    ["legacy median max RSS", legacy.medianMaxRssKiB],
  ] as const) {
    assert.ok(value > 0, `${label} must be positive to calculate a percent delta`);
  }

  const pairs = legacyRuns.map((legacyRun, index) => {
    const packedRun = packedV1Runs[index]!;
    const durableTail = deltaAndPercent(
      packedRun.report.timing.firstDurableProgressToCompletionSeconds,
      legacyRun.report.timing.firstDurableProgressToCompletionSeconds,
    );
    const triggerToCompletion = deltaAndPercent(
      packedRun.report.timing.triggerToDurableCompletionSeconds,
      legacyRun.report.timing.triggerToDurableCompletionSeconds,
    );
    const triggerToFirstProgress = deltaAndPercent(
      packedRun.report.timing.triggerToFirstDurableProgressSeconds,
      legacyRun.report.timing.triggerToFirstDurableProgressSeconds,
    );
    const maxRss = deltaAndPercent(packedRun.report.maxRssKiB, legacyRun.report.maxRssKiB);
    return {
      pairIndex: index + 1,
      legacyRunId: legacyRun.runId,
      packedV1RunId: packedRun.runId,
      firstDurableProgressToCompletionSeconds: {
        legacy: legacyRun.report.timing.firstDurableProgressToCompletionSeconds,
        packedV1: packedRun.report.timing.firstDurableProgressToCompletionSeconds,
        ...durableTail,
      },
      triggerToDurableCompletionSeconds: {
        legacy: legacyRun.report.timing.triggerToDurableCompletionSeconds,
        packedV1: packedRun.report.timing.triggerToDurableCompletionSeconds,
        ...triggerToCompletion,
      },
      triggerToFirstDurableProgressSeconds: {
        legacy: legacyRun.report.timing.triggerToFirstDurableProgressSeconds,
        packedV1: packedRun.report.timing.triggerToFirstDurableProgressSeconds,
        ...triggerToFirstProgress,
      },
      maxRssKiB: {
        legacy: legacyRun.report.maxRssKiB,
        packedV1: packedRun.report.maxRssKiB,
        ...maxRss,
      },
      winner:
        durableTail.packedV1MinusLegacy < 0 ? "packed-v1" : durableTail.packedV1MinusLegacy > 0 ? "legacy" : "tie",
    };
  });
  const packedV1Wins = pairs.filter((pair) => pair.winner === "packed-v1").length;
  const legacyWins = pairs.filter((pair) => pair.winner === "legacy").length;
  const ties = pairs.length - packedV1Wins - legacyWins;

  const baseline = legacyRuns[0]!.report;
  const report = {
    schemaVersion: 1,
    inputReportSchemaVersion: 6,
    status: "ok",
    validation: {
      everyRunSchemaV6AggregateOnly: true,
      everyRunExactSemanticAndVisitParity: true,
      everyRunStrictBuildIdentityAttested: true,
      everyRunTriggerBoundaryAttested: true,
      everyRunNativeResultTransportAttestedWithinTriggerBoundary: true,
      everyRunDirectNativeWorkCountersAttested: true,
      everyRunExactRestorationAttested: true,
      balancedMultiSampleGroups: true,
      uniqueReportPathsFileIdentitiesAndRunIds: true,
      identicalBuildConfigurationFixtureDatabaseAndReferenceIdentityAsideFromTransport: true,
    },
    inputIdentity: {
      appName: baseline.buildAttestation.suppliedAppName,
      executableSha256: baseline.buildAttestation.suppliedExecutableSha256,
      mainJsBundleSha256: baseline.buildAttestation.suppliedMainJsBundleSha256,
      pageSize: baseline.pageSize,
      pageOrchestrationStrategy: baseline.pageOrchestrationStrategy,
      fixtureCount: baseline.fixtureCount,
      expectedFoodCount: baseline.expectedFoodCount,
      expectedFoodVisitCount: baseline.expectedFoodVisitCount,
      visionConcurrency: baseline.configuration.visionConcurrency,
      visionConcurrencyMode: baseline.configuration.visionConcurrencyMode,
      pipelineDepth: baseline.configuration.pipelineDepth,
      pipelineDepthMode: baseline.configuration.pipelineDepthMode,
      samplingIntervalSeconds: baseline.timing.samplingIntervalSeconds,
      originalDatabase: baseline.originalDatabase,
      standaloneSnapshotSha256: baseline.standaloneSnapshotSha256,
      semanticReference: baseline.semanticReference,
      preparedVisionStateSha256: baseline.triggerBoundary.preparedVisionStateSha256,
    },
    legacy,
    packedV1,
    comparison: {
      interpretation: "descriptive-only",
      primaryMetric: "firstDurableProgressToCompletionSeconds",
      medianDeltas: {
        firstDurableProgressToCompletionSeconds: deltaAndPercent(
          packedV1.medianFirstDurableProgressToCompletionSeconds,
          legacy.medianFirstDurableProgressToCompletionSeconds,
        ),
        triggerToDurableCompletionSeconds: deltaAndPercent(
          packedV1.medianTriggerToDurableCompletionSeconds,
          legacy.medianTriggerToDurableCompletionSeconds,
        ),
        triggerToFirstDurableProgressSeconds: deltaAndPercent(
          packedV1.medianTriggerToFirstDurableProgressSeconds,
          legacy.medianTriggerToFirstDurableProgressSeconds,
        ),
        maxRssKiB: deltaAndPercent(packedV1.medianMaxRssKiB, legacy.medianMaxRssKiB),
      },
      pairedWins: {
        packedV1: packedV1Wins,
        legacy: legacyWins,
        ties,
      },
      pairs,
    },
    limitations: [
      "This is a descriptive summary of the supplied positional pairs; it makes no inferential, statistical-significance, or causal claim.",
      "The primary durable-tail metric excludes launch, manual UI trigger latency, and time before the first sampled durable flush.",
      "Signed-app timing includes PhotoKit, Vision, native/JavaScript transfer, and SQLite persistence; it is not isolated result-transport latency.",
      "Max RSS is a sampled process peak and may miss short-lived allocation spikes.",
      "Pairs are defined only by comma-list position; the summary does not attest randomization or control for run-order, thermal, cache, or system-load effects.",
    ],
  };

  publishReport(configuration.outputPath, report);
  const durableTailDelta = report.comparison.medianDeltas.firstDurableProgressToCompletionSeconds;
  console.log(
    `Vision transport A/B descriptive summary: ${durableTailDelta.packedV1MinusLegacyPercent.toFixed(2)}% packed-v1 median durable-tail delta; report=${configuration.outputPath}`,
  );
}

main();
