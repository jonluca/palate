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

type Strategy = "serial" | "lookahead";
type TuningMode = "native-default" | "override";
type ResultTransport = "legacy" | "packed-v1";
type SemanticReferenceSource = "live-original-snapshot" | "external-current-control";

interface Configuration {
  serialPaths: string[];
  lookaheadPaths: string[];
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
  strategy: Strategy;
  originalDatabaseIdentity: string;
}

interface GroupSummary {
  strategy: Strategy;
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
  return "Usage: summarize-macos-vision-orchestration-ab.ts --serial=REPORT[,REPORT...] --lookahead=REPORT[,REPORT...] --output=PATH";
}

function parsePaths(value: string, option: string): string[] {
  const pieces = value.split(",").map((path) => path.trim());
  assert.ok(pieces.length > 0 && pieces.every(Boolean), `${option} requires a comma-separated report list`);
  return pieces.map((path) => resolve(path));
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let serialPaths: string[] | undefined;
  let lookaheadPaths: string[] | undefined;
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
      case "--serial":
        assert.equal(serialPaths, undefined, "--serial may be supplied only once");
        serialPaths = parsePaths(value, option);
        break;
      case "--lookahead":
        assert.equal(lookaheadPaths, undefined, "--lookahead may be supplied only once");
        lookaheadPaths = parsePaths(value, option);
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
  if (!serialPaths || !lookaheadPaths || !outputPath) {
    throw new Error(usage());
  }
  return { serialPaths, lookaheadPaths, outputPath };
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

function nonnegativeInteger(value: unknown, label: string): asserts value is number {
  assert.ok(Number.isInteger(value) && (value as number) >= 0, `${label} must be a nonnegative integer`);
}

function resultTransport(value: unknown, label: string): asserts value is ResultTransport {
  assert.ok(value === "legacy" || value === "packed-v1", `${label} must be legacy or packed-v1`);
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
  return JSON.stringify({
    main: report.originalDatabase.main,
    wal: report.originalDatabase.wal,
    shm: report.originalDatabase.shm,
    journal: report.originalDatabase.journal,
  });
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

function validateResultTransportAttestation(report: VisionReport, path: string): void {
  resultTransport(report.resultTransport, `${path}: selected result transport`);
  resultTransport(report.requestedResultTransport, `${path}: requested result transport`);
  resultTransport(report.configuration.resultTransport, `${path}: configured selected result transport`);
  resultTransport(report.configuration.requestedResultTransport, `${path}: configured requested result transport`);
  resultTransport(
    report.configuration.expectedResolvedResultTransport,
    `${path}: configured expected result transport`,
  );
  assert.equal(
    report.configuration.resultTransport,
    report.resultTransport,
    `${path}: configured selected result transport`,
  );
  assert.equal(
    report.configuration.requestedResultTransport,
    report.requestedResultTransport,
    `${path}: configured requested result transport`,
  );
  assert.equal(
    report.configuration.expectedResolvedResultTransport,
    report.requestedResultTransport,
    `${path}: configured expected result transport`,
  );

  const runtime = report.runtimeAttestation;
  resultTransport(runtime.requestedResultTransport, `${path}: runtime requested result transport`);
  resultTransport(runtime.observedProcessResultTransport, `${path}: runtime selected result transport`);
  resultTransport(runtime.expectedResolvedResultTransport, `${path}: runtime expected result transport`);
  resultTransport(
    runtime.observedProcessResultTransportEnvironmentValue,
    `${path}: runtime result-transport environment value`,
  );
  assert.equal(runtime.requestedResultTransport, report.requestedResultTransport, `${path}: runtime transport request`);
  assert.equal(runtime.observedProcessResultTransport, report.resultTransport, `${path}: runtime transport selection`);
  assert.equal(
    runtime.expectedResolvedResultTransport,
    report.requestedResultTransport,
    `${path}: runtime expected transport resolution`,
  );
  assert.equal(
    runtime.observedProcessResultTransportEnvironmentValue,
    report.requestedResultTransport,
    `${path}: runtime transport environment value`,
  );
  assert.equal(runtime.resultTransportEnvironmentPresent, true, `${path}: result-transport environment presence`);
  assert.equal(
    runtime.source,
    "process-environment-plus-native-result-transport-attestation",
    `${path}: runtime attestation source`,
  );
  finiteNonnegative(runtime.processEnvironmentObservedAtEpochSeconds, `${path}: process-environment observation epoch`);

  const native = runtime.nativeResultTransport;
  requireRecord(native, `${path}: nativeResultTransport`);
  assert.equal(native.schemaVersion, 2, `${path}: native result-transport schema version`);
  safeToken(native.runId, `${path}: native result-transport run ID`);
  assert.equal(native.runId, runtime.runId, `${path}: native result-transport run ID`);
  resultTransport(native.configuredResultTransport, `${path}: native configured result transport`);
  resultTransport(native.resolvedResultTransport, `${path}: native resolved result transport`);
  resultTransport(native.selectedResultTransport, `${path}: native selected result transport`);
  assert.equal(
    native.configuredResultTransport,
    report.requestedResultTransport,
    `${path}: native configured result transport`,
  );
  assert.equal(
    native.resolvedResultTransport,
    report.requestedResultTransport,
    `${path}: native resolved result transport`,
  );
  assert.equal(native.selectedResultTransport, report.resultTransport, `${path}: native selected result transport`);
  assert.equal(
    report.resultTransport,
    report.requestedResultTransport,
    `${path}: selected result transport must match the requested transport`,
  );
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

function validateTriggerBoundary(report: VisionReport, path: string): void {
  const trigger = report.triggerBoundary;
  requireRecord(trigger, `${path}: triggerBoundary`);
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
  finiteNonnegative(trigger.maxTriggerAgeSeconds, `${path}: maximum trigger age`);
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
  assert.ok(
    report.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds >= trigger.triggerEpochSeconds,
    `${path}: native result-transport attestation must not precede the trigger`,
  );
  assert.ok(
    report.runtimeAttestation.nativeResultTransport.observedAtEpochSeconds <=
      trigger.durableCompletionObservedAtEpochSeconds,
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

function validateTiming(report: VisionReport, path: string): void {
  requireRecord(report.timing, `${path}: timing`);
  finiteNonnegative(report.wallSeconds, `${path}: wallSeconds`);
  finiteNonnegative(
    report.timing.firstDurableProgressToCompletionSeconds,
    `${path}: first-durable-progress-to-completion timing`,
  );
  finiteNonnegative(report.timing.triggerToDurableCompletionSeconds, `${path}: trigger-to-completion timing`);
  finiteNonnegative(report.timing.triggerToFirstDurableProgressSeconds, `${path}: trigger-to-first-progress timing`);
  finiteNonnegative(report.timing.samplingIntervalSeconds, `${path}: sampling interval`);
  finiteNonnegative(report.maxRssKiB, `${path}: max RSS`);
  assert.equal(
    report.wallSeconds,
    report.timing.firstDurableProgressToCompletionSeconds,
    `${path}: wallSeconds must equal the durable-tail timing`,
  );
  assert.ok(
    report.timing.triggerToDurableCompletionSeconds >= report.timing.triggerToFirstDurableProgressSeconds,
    `${path}: completion timing must not precede first progress`,
  );
  const reconstructedCompletion =
    report.timing.triggerToFirstDurableProgressSeconds + report.timing.firstDurableProgressToCompletionSeconds;
  assert.ok(
    Math.abs(reconstructedCompletion - report.timing.triggerToDurableCompletionSeconds) <= 0.000_01,
    `${path}: trigger timing components are inconsistent`,
  );
}

function loadAndValidate(path: string, expectedStrategy: Strategy): LoadedRun {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  requireRecord(parsed, `${path}: report`);
  const report = parsed as unknown as VisionReport;
  assert.equal(report.schemaVersion, 6, `${path}: report schema must be exactly 6`);
  requireRecord(report.schemaCompatibility, `${path}: schemaCompatibility`);
  assert.equal(report.schemaCompatibility.previousSchemaVersion, 5, `${path}: previous schema version`);
  assert.equal(report.schemaCompatibility.semanticFieldsPreserved, true, `${path}: schema semantic compatibility`);
  assert.equal(report.status, "ok", `${path}: status`);

  positiveIntegerInRange(report.pageSize, 1, 2_000, `${path}: page size`);
  assert.equal(report.pageOrchestrationStrategy, expectedStrategy, `${path}: top-level orchestration strategy`);
  requireRecord(report.configuration, `${path}: configuration`);
  assert.equal(report.configuration.resultPageSize, report.pageSize, `${path}: configured page size`);
  assert.equal(
    report.configuration.pageOrchestrationStrategy,
    expectedStrategy,
    `${path}: configured orchestration strategy`,
  );

  requireRecord(report.runtimeAttestation, `${path}: runtimeAttestation`);
  safeToken(report.runtimeAttestation.runId, `${path}: runtime run ID`);
  validateResultTransportAttestation(report, path);
  assert.equal(report.runtimeAttestation.observedProcessPageSize, report.pageSize, `${path}: runtime page size`);
  assert.equal(
    report.runtimeAttestation.expectedResolvedPageOrchestrationStrategy,
    expectedStrategy,
    `${path}: expected runtime orchestration strategy`,
  );
  assert.equal(
    report.runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue,
    expectedStrategy,
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
    basename(report.buildAttestation.runningAppName),
    report.buildAttestation.runningAppName,
    `${path}: running app identity must be a basename`,
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
    strategy: expectedStrategy,
    originalDatabaseIdentity: normalizedOriginalDatabase(report),
  };
}

function pathExistsIncludingDanglingSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validateUniquePaths(configuration: Configuration): void {
  const seenCanonicalPaths = new Map<string, string>();
  const seenFileIdentities = new Map<string, string>();
  for (const [strategy, paths] of [
    ["serial", configuration.serialPaths],
    ["lookahead", configuration.lookaheadPaths],
  ] as const) {
    for (const path of paths) {
      const canonicalPath = realpathSync(path);
      const firstPath = seenCanonicalPaths.get(canonicalPath);
      assert.equal(
        firstPath,
        undefined,
        `Duplicate resolved report path: ${path} (${firstPath ?? strategy} and ${strategy})`,
      );
      seenCanonicalPaths.set(canonicalPath, path);
      const metadata = statSync(canonicalPath);
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
  for (const inputPath of [...configuration.serialPaths, ...configuration.lookaheadPaths]) {
    assert.notEqual(resolve(inputPath), configuration.outputPath, "Output path aliases an input report");
  }
}

function validateSharedIdentity(runs: readonly LoadedRun[]): void {
  assert.ok(runs.length > 0, "At least one report is required");
  const baseline = runs[0]!;
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
    const baselineReport = baseline.report;
    assert.equal(report.pageSize, baselineReport.pageSize, `${run.path}: A/B page-size mismatch`);
    assert.equal(
      report.resultTransport,
      baselineReport.resultTransport,
      `${run.path}: A/B selected result-transport mismatch`,
    );
    assert.equal(report.fixtureCount, baselineReport.fixtureCount, `${run.path}: A/B fixture-count mismatch`);
    assert.equal(
      report.expectedFoodCount,
      baselineReport.expectedFoodCount,
      `${run.path}: A/B expected-food-count mismatch`,
    );
    assert.equal(
      report.expectedFoodVisitCount,
      baselineReport.expectedFoodVisitCount,
      `${run.path}: A/B expected-food-visit-count mismatch`,
    );
    assert.equal(
      report.configuration.visionConcurrency,
      baselineReport.configuration.visionConcurrency,
      `${run.path}: A/B Vision-concurrency mismatch`,
    );
    assert.equal(
      report.configuration.visionConcurrencyMode,
      baselineReport.configuration.visionConcurrencyMode,
      `${run.path}: A/B Vision-concurrency mode mismatch`,
    );
    assert.equal(
      report.configuration.pipelineDepth,
      baselineReport.configuration.pipelineDepth,
      `${run.path}: A/B pipeline-depth mismatch`,
    );
    assert.equal(
      report.configuration.pipelineDepthMode,
      baselineReport.configuration.pipelineDepthMode,
      `${run.path}: A/B pipeline-depth mode mismatch`,
    );
    assert.equal(
      report.timing.samplingIntervalSeconds,
      baselineReport.timing.samplingIntervalSeconds,
      `${run.path}: A/B sampling-interval mismatch`,
    );
    assert.equal(
      report.runtimeAttestation.source,
      baselineReport.runtimeAttestation.source,
      `${run.path}: A/B runtime-attestation source mismatch`,
    );
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
    assert.equal(
      report.standaloneSnapshotSha256,
      baselineReport.standaloneSnapshotSha256,
      `${run.path}: A/B standalone snapshot mismatch`,
    );
    assert.equal(
      report.semanticReference.source,
      baselineReport.semanticReference.source,
      `${run.path}: A/B semantic-reference source mismatch`,
    );
    assert.equal(
      report.semanticReference.sha256,
      baselineReport.semanticReference.sha256,
      `${run.path}: A/B semantic-reference SHA-256 mismatch`,
    );
    assert.deepEqual(
      report.semanticReference.components,
      baselineReport.semanticReference.components,
      `${run.path}: A/B semantic-reference component mismatch`,
    );
    assert.equal(
      report.triggerBoundary.preparedVisionStateSha256,
      baselineReport.triggerBoundary.preparedVisionStateSha256,
      `${run.path}: A/B prepared Vision-state mismatch`,
    );
  }
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0, "Cannot compute a median for an empty group");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summarizeGroup(runs: readonly LoadedRun[], strategy: Strategy): GroupSummary {
  assert.ok(runs.length > 0);
  for (const run of runs) {
    assert.equal(run.strategy, strategy);
  }
  const wallSeconds = runs.map((run) => run.report.wallSeconds);
  const durableTail = runs.map((run) => run.report.timing.firstDurableProgressToCompletionSeconds);
  const triggerToCompletion = runs.map((run) => run.report.timing.triggerToDurableCompletionSeconds);
  const triggerToFirstProgress = runs.map((run) => run.report.timing.triggerToFirstDurableProgressSeconds);
  const maxRssKiB = runs.map((run) => run.report.maxRssKiB);
  return {
    strategy,
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

function publishReport(outputPath: string, report: unknown): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    // An adjacent hard-link publication is atomic and refuses a raced destination.
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
  assert.ok(configuration.serialPaths.length >= 2, "serial: at least two measured reports are required");
  assert.equal(
    configuration.lookaheadPaths.length,
    configuration.serialPaths.length,
    "A/B report groups must have equal sample counts",
  );
  validateUniquePaths(configuration);

  const serialRuns = configuration.serialPaths.map((path) => loadAndValidate(path, "serial"));
  const lookaheadRuns = configuration.lookaheadPaths.map((path) => loadAndValidate(path, "lookahead"));
  const allRuns = [...serialRuns, ...lookaheadRuns];
  validateSharedIdentity(allRuns);

  const serial = summarizeGroup(serialRuns, "serial");
  const lookahead = summarizeGroup(lookaheadRuns, "lookahead");
  assert.ok(
    serial.medianWallSeconds > 0,
    "serial median durable-tail timing must be positive to calculate a percent delta",
  );

  const pairedWallSeconds = serialRuns.map((serialRun, index) => {
    const lookaheadRun = lookaheadRuns[index]!;
    const deltaSeconds = lookaheadRun.report.wallSeconds - serialRun.report.wallSeconds;
    return {
      pairIndex: index + 1,
      serialRunId: serialRun.runId,
      lookaheadRunId: lookaheadRun.runId,
      serialWallSeconds: serialRun.report.wallSeconds,
      lookaheadWallSeconds: lookaheadRun.report.wallSeconds,
      lookaheadMinusSerialSeconds: deltaSeconds,
      winner: deltaSeconds < 0 ? "lookahead" : deltaSeconds > 0 ? "serial" : "tie",
    };
  });
  const lookaheadWins = pairedWallSeconds.filter((pair) => pair.winner === "lookahead").length;
  const serialWins = pairedWallSeconds.filter((pair) => pair.winner === "serial").length;
  const ties = pairedWallSeconds.length - lookaheadWins - serialWins;
  const medianWallSecondsDelta = lookahead.medianWallSeconds - serial.medianWallSeconds;
  const medianWallSecondsPercentDelta = (medianWallSecondsDelta / serial.medianWallSeconds) * 100;

  const baselineReport = serialRuns[0]!.report;
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
      uniqueReportPathsAndRunIds: true,
      identicalBuildConfigurationFixtureDatabaseAndResultTransportIdentityAcrossInputs: true,
    },
    inputIdentity: {
      appName: baselineReport.buildAttestation.suppliedAppName,
      executableSha256: baselineReport.buildAttestation.suppliedExecutableSha256,
      mainJsBundleSha256: baselineReport.buildAttestation.suppliedMainJsBundleSha256,
      pageSize: baselineReport.pageSize,
      resultTransport: baselineReport.resultTransport,
      fixtureCount: baselineReport.fixtureCount,
      expectedFoodCount: baselineReport.expectedFoodCount,
      expectedFoodVisitCount: baselineReport.expectedFoodVisitCount,
      visionConcurrency: baselineReport.configuration.visionConcurrency,
      visionConcurrencyMode: baselineReport.configuration.visionConcurrencyMode,
      pipelineDepth: baselineReport.configuration.pipelineDepth,
      pipelineDepthMode: baselineReport.configuration.pipelineDepthMode,
      samplingIntervalSeconds: baselineReport.timing.samplingIntervalSeconds,
      originalDatabase: baselineReport.originalDatabase,
      standaloneSnapshotSha256: baselineReport.standaloneSnapshotSha256,
      semanticReference: baselineReport.semanticReference,
      preparedVisionStateSha256: baselineReport.triggerBoundary.preparedVisionStateSha256,
    },
    serial,
    lookahead,
    comparison: {
      interpretation: "descriptive-only",
      primaryMetric: "firstDurableProgressToCompletionSeconds",
      medianWallSecondsDelta,
      medianWallSecondsPercentDelta,
      medianWallSecondsSaved: serial.medianWallSeconds - lookahead.medianWallSeconds,
      medianTriggerToDurableCompletionSecondsDelta:
        lookahead.medianTriggerToDurableCompletionSeconds - serial.medianTriggerToDurableCompletionSeconds,
      medianTriggerToFirstDurableProgressSecondsDelta:
        lookahead.medianTriggerToFirstDurableProgressSeconds - serial.medianTriggerToFirstDurableProgressSeconds,
      medianMaxRssDeltaKiB: lookahead.medianMaxRssKiB - serial.medianMaxRssKiB,
      pairedWins: {
        lookahead: lookaheadWins,
        serial: serialWins,
        ties,
      },
      pairs: pairedWallSeconds,
    },
    limitations: [
      "This is a descriptive summary of the supplied paired samples; it makes no inferential, statistical-significance, or causal claim.",
      "The primary durable-tail metric excludes launch, manual UI trigger latency, and time before the first sampled durable flush.",
      "The signed app timing includes PhotoKit, Vision, native/JavaScript transfer, and SQLite persistence; it is not isolated orchestration latency.",
      "Every input must select the same attested result transport, so this summary compares orchestration only and does not compare result-transport implementations.",
      "Pairs are defined only by comma-list position; the summary does not attest randomization or control for run-order effects.",
    ],
  };

  publishReport(configuration.outputPath, report);
  console.log(
    `Vision orchestration A/B descriptive summary: ${medianWallSecondsPercentDelta.toFixed(2)}% median durable-tail delta; report=${configuration.outputPath}`,
  );
}

main();
