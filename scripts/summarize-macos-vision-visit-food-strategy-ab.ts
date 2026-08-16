#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

type Strategy = "full-plan-v1" | "rank3-bulk-tail-v1";
type ResultTransport = "legacy" | "packed-v1";
type PageOrchestrationStrategy = "serial" | "lookahead";
type TuningMode = "native-default" | "override";

interface Configuration {
  fullPlanPaths: string[];
  rank3BulkTailPaths: string[];
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
  visitFoodDetectionStrategy: Strategy;
  pageOrchestrationStrategy: PageOrchestrationStrategy;
  configuration: {
    resultPageSize: number;
    resultTransport: ResultTransport;
    requestedResultTransport: ResultTransport;
    expectedResolvedResultTransport: ResultTransport;
    classificationStrategy: string;
    classificationStrategyMode: string;
    classificationStrategyEnvironmentValue: string | null;
    visitFoodDetectionStrategy: Strategy;
    pageOrchestrationStrategy: PageOrchestrationStrategy;
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
  actualFoodCount: number;
  expectedFoodVisitCount: number;
  actualFoodVisitCount: number;
  workload: {
    visitFoodDetectionStrategy: Strategy;
    plannedSamples: number;
    attemptedSamples: number;
    successfulAttempts: number;
    retryableAttempts: number;
    skippedSamples: number;
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
    expectedResolvedClassificationStrategy: string;
    observedProcessClassificationStrategyEnvironmentValue: string | null;
    classificationStrategyEnvironmentPresent: boolean;
    classificationStrategyAttestationSource: string;
    expectedResolvedVisitFoodDetectionStrategy: Strategy;
    observedProcessVisitFoodDetectionStrategyEnvironmentValue: Strategy;
    visitFoodDetectionStrategyEnvironmentPresent: boolean;
    visitFoodDetectionStrategyAttestationSource: string;
    expectedResolvedPageOrchestrationStrategy: PageOrchestrationStrategy;
    observedProcessPageOrchestrationStrategyEnvironmentValue: PageOrchestrationStrategy;
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
    exactStrategySemanticPhotoParity: boolean;
    strategyPhotoMismatchCount: number;
    exactFullReferencePhotoParity: boolean;
    fullReferencePhotoMismatchCount: number;
    successfulAttemptMismatchCount: number;
    retryablePartialStateCount: number;
    skippedWriteCount: number;
    photoIdMismatchCount: number;
    unplannedPendingCount: number;
    exactVisitFoodParity: boolean;
    visitMismatchCount: number;
    exactPositiveVisitSet: boolean;
    positiveVisitIdMismatchCount: number;
    invalidVisitFoodCount: number;
    pendingCount: number;
    pendingRowsAreExpected: boolean;
    workloadAccountingExact: boolean;
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
    source: string;
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
  fileIdentity: string;
  report: VisionReport;
  runId: string;
  strategy: Strategy;
  identity: string;
  strategyFixtureIdentity: string;
  requestedAssets: number;
  nativeBatches: number;
}

process.umask(0o077);

function usage(): string {
  return "Usage: summarize-macos-vision-visit-food-strategy-ab.ts --full-plan-v1=REPORT[,REPORT...] --rank3-bulk-tail-v1=REPORT[,REPORT...] --output=PATH";
}

function parsePaths(value: string, option: string): string[] {
  const paths = value.split(",").map((path) => path.trim());
  assert.ok(paths.length > 0 && paths.every(Boolean), `${option} requires a comma-separated report list`);
  return paths.map((path) => resolve(path));
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let fullPlanPaths: string[] | undefined;
  let rank3BulkTailPaths: string[] | undefined;
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
      case "--full-plan-v1":
        assert.equal(fullPlanPaths, undefined, "--full-plan-v1 may be supplied only once");
        fullPlanPaths = parsePaths(value, option);
        break;
      case "--rank3-bulk-tail-v1":
        assert.equal(rank3BulkTailPaths, undefined, "--rank3-bulk-tail-v1 may be supplied only once");
        rank3BulkTailPaths = parsePaths(value, option);
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
  if (!fullPlanPaths || !rank3BulkTailPaths || !outputPath) {
    throw new Error(usage());
  }
  return { fullPlanPaths, rank3BulkTailPaths, outputPath };
}

type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;
type JsonNode = JsonValue | undefined;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

function isJsonObject(value: JsonNode): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function isJsonBoolean(value: JsonNode): value is boolean {
  return typeof value === "boolean";
}

function isJsonNumber(value: JsonNode): value is number {
  return typeof value === "number";
}

function isJsonString(value: JsonNode): value is string {
  return typeof value === "string";
}

function parseJsonValue(source: string): JsonValue {
  // JSON.parse either throws or returns exactly the recursive JSON domain represented by JsonValue.
  return JSON.parse(source);
}

function jsonObject(value: JsonNode, label: string): JsonObject {
  assert.ok(isJsonObject(value), `${label} must be an object`);
  return value;
}

function jsonBoolean(value: JsonNode, label: string): boolean {
  assert.ok(isJsonBoolean(value), `${label} must be a boolean`);
  return value;
}

function jsonNumber(value: JsonNode, label: string): number {
  assert.ok(isJsonNumber(value), `${label} must be a number`);
  return value;
}

function jsonString(value: JsonNode, label: string): string {
  assert.ok(isJsonString(value), `${label} must be a string`);
  return value;
}

function jsonNullableBoolean(value: JsonNode, label: string): boolean | null {
  return value === null ? null : jsonBoolean(value, label);
}

function jsonNullableNumber(value: JsonNode, label: string): number | null {
  return value === null ? null : jsonNumber(value, label);
}

function jsonNullableString(value: JsonNode, label: string): string | null {
  return value === null ? null : jsonString(value, label);
}

function jsonResultTransport(value: JsonNode, label: string): ResultTransport {
  assert.ok(value === "legacy" || value === "packed-v1", `${label} must be legacy or packed-v1`);
  return value;
}

function jsonStrategy(value: JsonNode, label: string): Strategy {
  assert.ok(value === "full-plan-v1" || value === "rank3-bulk-tail-v1", `${label} must be a visit-food strategy`);
  return value;
}

function jsonPageOrchestrationStrategy(value: JsonNode, label: string): PageOrchestrationStrategy {
  assert.ok(value === "serial" || value === "lookahead", `${label} must be serial or lookahead`);
  return value;
}

function jsonTuningMode(value: JsonNode, label: string): TuningMode {
  assert.ok(value === "native-default" || value === "override", `${label} must be a tuning mode`);
  return value;
}

function parseDatabaseComponent(value: JsonNode, label: string): DatabaseComponent {
  const component = jsonObject(value, label);
  return {
    present: jsonBoolean(component.present, `${label}.present`),
    sha256: jsonNullableString(component.sha256, `${label}.sha256`),
    mode: jsonNullableString(component.mode, `${label}.mode`),
  };
}

function parseSemanticReferenceComponent(value: JsonNode, label: string): SemanticReferenceComponent {
  const component = jsonObject(value, label);
  return {
    ...parseDatabaseComponent(value, label),
    bytes: jsonNullableNumber(component.bytes, `${label}.bytes`),
  };
}

function parseNativeWorkCounters(value: JsonNode, label: string): NativeWorkCounters {
  const counters = jsonObject(value, label);
  return {
    startedBatchCount: jsonNumber(counters.startedBatchCount, `${label}.startedBatchCount`),
    startedRequestedAssetCount: jsonNumber(counters.startedRequestedAssetCount, `${label}.startedRequestedAssetCount`),
    completedBatchCount: jsonNumber(counters.completedBatchCount, `${label}.completedBatchCount`),
    completedRequestedAssetCount: jsonNumber(
      counters.completedRequestedAssetCount,
      `${label}.completedRequestedAssetCount`,
    ),
    resolvedBatchCount: jsonNumber(counters.resolvedBatchCount, `${label}.resolvedBatchCount`),
    resolvedRequestedAssetCount: jsonNumber(
      counters.resolvedRequestedAssetCount,
      `${label}.resolvedRequestedAssetCount`,
    ),
    rejectedBatchCount: jsonNumber(counters.rejectedBatchCount, `${label}.rejectedBatchCount`),
    rejectedRequestedAssetCount: jsonNumber(
      counters.rejectedRequestedAssetCount,
      `${label}.rejectedRequestedAssetCount`,
    ),
    cancelledBatchCount: jsonNumber(counters.cancelledBatchCount, `${label}.cancelledBatchCount`),
    cancelledRequestedAssetCount: jsonNumber(
      counters.cancelledRequestedAssetCount,
      `${label}.cancelledRequestedAssetCount`,
    ),
    inFlightBatchCount: jsonNumber(counters.inFlightBatchCount, `${label}.inFlightBatchCount`),
    inFlightRequestedAssetCount: jsonNumber(
      counters.inFlightRequestedAssetCount,
      `${label}.inFlightRequestedAssetCount`,
    ),
  };
}

function parseNullableNativeWorkCounters(value: JsonNode, label: string): NativeWorkCounters | null {
  return value === null ? null : parseNativeWorkCounters(value, label);
}

function nonemptyString(value: string, label: string): void {
  assert.ok(value.trim().length > 0, `${label} must be a nonempty string`);
}

function safeToken(value: string, label: string): void {
  nonemptyString(value, label);
  assert.match(value, /^[A-Za-z0-9._-]+$/, `${label} must be a path-free token`);
}

function sha256(value: string, label: string): void {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}$/i, `${label} must be a SHA-256 digest`);
}

function nonnegativeInteger(value: number | null, label: string): asserts value is number {
  assert.ok(value !== null && Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
}

function positiveInteger(value: number, label: string): void {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function finiteNonnegative(value: number | null, label: string): asserts value is number {
  assert.ok(value !== null && Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
}

function finitePositive(value: number, label: string): void {
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be finite and positive`);
}

function resultTransport(value: ResultTransport, label: string): void {
  assert.ok(value === "legacy" || value === "packed-v1", `${label} must be legacy or packed-v1`);
}

function pageOrchestrationStrategy(value: PageOrchestrationStrategy, label: string): void {
  assert.ok(value === "serial" || value === "lookahead", `${label} must be serial or lookahead`);
}

function parseVisionReport(value: JsonValue, path: string): VisionReport {
  const report = jsonObject(value, `${path}: report`);
  const schemaCompatibility = jsonObject(report.schemaCompatibility, `${path}: schemaCompatibility`);
  const configuration = jsonObject(report.configuration, `${path}: configuration`);
  const workload = jsonObject(report.workload, `${path}: workload`);
  const timing = jsonObject(report.timing, `${path}: timing`);
  const runtimeAttestation = jsonObject(report.runtimeAttestation, `${path}: runtimeAttestation`);
  const nativeResultTransport = jsonObject(
    runtimeAttestation.nativeResultTransport,
    `${path}: runtimeAttestation.nativeResultTransport`,
  );
  const triggerBoundary = jsonObject(report.triggerBoundary, `${path}: triggerBoundary`);
  const buildAttestation = jsonObject(report.buildAttestation, `${path}: buildAttestation`);
  const validation = jsonObject(report.validation, `${path}: validation`);
  const originalDatabase = jsonObject(report.originalDatabase, `${path}: originalDatabase`);
  const semanticReference = jsonObject(report.semanticReference, `${path}: semanticReference`);
  const semanticComponents = jsonObject(semanticReference.components, `${path}: semanticReference.components`);
  const resultDatabase = jsonObject(report.resultDatabase, `${path}: resultDatabase`);
  const rawDatabases = jsonObject(report.rawDatabases, `${path}: rawDatabases`);
  const restoration = jsonObject(report.restoration, `${path}: restoration`);

  return {
    schemaVersion: jsonNumber(report.schemaVersion, `${path}: schemaVersion`),
    schemaCompatibility: {
      previousSchemaVersion: jsonNumber(
        schemaCompatibility.previousSchemaVersion,
        `${path}: schemaCompatibility.previousSchemaVersion`,
      ),
      semanticFieldsPreserved: jsonBoolean(
        schemaCompatibility.semanticFieldsPreserved,
        `${path}: schemaCompatibility.semanticFieldsPreserved`,
      ),
    },
    status: jsonString(report.status, `${path}: status`),
    pageSize: jsonNumber(report.pageSize, `${path}: pageSize`),
    resultTransport: jsonResultTransport(report.resultTransport, `${path}: resultTransport`),
    requestedResultTransport: jsonResultTransport(report.requestedResultTransport, `${path}: requestedResultTransport`),
    visitFoodDetectionStrategy: jsonStrategy(report.visitFoodDetectionStrategy, `${path}: visitFoodDetectionStrategy`),
    pageOrchestrationStrategy: jsonPageOrchestrationStrategy(
      report.pageOrchestrationStrategy,
      `${path}: pageOrchestrationStrategy`,
    ),
    configuration: {
      resultPageSize: jsonNumber(configuration.resultPageSize, `${path}: configuration.resultPageSize`),
      resultTransport: jsonResultTransport(configuration.resultTransport, `${path}: configuration.resultTransport`),
      requestedResultTransport: jsonResultTransport(
        configuration.requestedResultTransport,
        `${path}: configuration.requestedResultTransport`,
      ),
      expectedResolvedResultTransport: jsonResultTransport(
        configuration.expectedResolvedResultTransport,
        `${path}: configuration.expectedResolvedResultTransport`,
      ),
      classificationStrategy: jsonString(
        configuration.classificationStrategy,
        `${path}: configuration.classificationStrategy`,
      ),
      classificationStrategyMode: jsonString(
        configuration.classificationStrategyMode,
        `${path}: configuration.classificationStrategyMode`,
      ),
      classificationStrategyEnvironmentValue: jsonNullableString(
        configuration.classificationStrategyEnvironmentValue,
        `${path}: configuration.classificationStrategyEnvironmentValue`,
      ),
      visitFoodDetectionStrategy: jsonStrategy(
        configuration.visitFoodDetectionStrategy,
        `${path}: configuration.visitFoodDetectionStrategy`,
      ),
      pageOrchestrationStrategy: jsonPageOrchestrationStrategy(
        configuration.pageOrchestrationStrategy,
        `${path}: configuration.pageOrchestrationStrategy`,
      ),
      visionConcurrency: jsonNumber(configuration.visionConcurrency, `${path}: configuration.visionConcurrency`),
      visionConcurrencyMode: jsonTuningMode(
        configuration.visionConcurrencyMode,
        `${path}: configuration.visionConcurrencyMode`,
      ),
      visionConcurrencyOverridden: jsonBoolean(
        configuration.visionConcurrencyOverridden,
        `${path}: configuration.visionConcurrencyOverridden`,
      ),
      visionConcurrencyEnvironmentValue: jsonNullableNumber(
        configuration.visionConcurrencyEnvironmentValue,
        `${path}: configuration.visionConcurrencyEnvironmentValue`,
      ),
      pipelineDepth: jsonNumber(configuration.pipelineDepth, `${path}: configuration.pipelineDepth`),
      pipelineDepthMode: jsonTuningMode(configuration.pipelineDepthMode, `${path}: configuration.pipelineDepthMode`),
      pipelineDepthOverridden: jsonBoolean(
        configuration.pipelineDepthOverridden,
        `${path}: configuration.pipelineDepthOverridden`,
      ),
      pipelineDepthEnvironmentValue: jsonNullableNumber(
        configuration.pipelineDepthEnvironmentValue,
        `${path}: configuration.pipelineDepthEnvironmentValue`,
      ),
    },
    fixtureCount: jsonNumber(report.fixtureCount, `${path}: fixtureCount`),
    expectedFoodCount: jsonNumber(report.expectedFoodCount, `${path}: expectedFoodCount`),
    actualFoodCount: jsonNumber(report.actualFoodCount, `${path}: actualFoodCount`),
    expectedFoodVisitCount: jsonNumber(report.expectedFoodVisitCount, `${path}: expectedFoodVisitCount`),
    actualFoodVisitCount: jsonNumber(report.actualFoodVisitCount, `${path}: actualFoodVisitCount`),
    workload: {
      visitFoodDetectionStrategy: jsonStrategy(
        workload.visitFoodDetectionStrategy,
        `${path}: workload.visitFoodDetectionStrategy`,
      ),
      plannedSamples: jsonNumber(workload.plannedSamples, `${path}: workload.plannedSamples`),
      attemptedSamples: jsonNumber(workload.attemptedSamples, `${path}: workload.attemptedSamples`),
      successfulAttempts: jsonNumber(workload.successfulAttempts, `${path}: workload.successfulAttempts`),
      retryableAttempts: jsonNumber(workload.retryableAttempts, `${path}: workload.retryableAttempts`),
      skippedSamples: jsonNumber(workload.skippedSamples, `${path}: workload.skippedSamples`),
      expectedNativeBatchCount: jsonNumber(
        workload.expectedNativeBatchCount,
        `${path}: workload.expectedNativeBatchCount`,
      ),
      directNativeCountersRequired: jsonBoolean(
        workload.directNativeCountersRequired,
        `${path}: workload.directNativeCountersRequired`,
      ),
      directNativeCountersAvailable: jsonBoolean(
        workload.directNativeCountersAvailable,
        `${path}: workload.directNativeCountersAvailable`,
      ),
      attemptAccountingSource: jsonString(
        workload.attemptAccountingSource,
        `${path}: workload.attemptAccountingSource`,
      ),
      nativeDispatch: parseNullableNativeWorkCounters(workload.nativeDispatch, `${path}: workload.nativeDispatch`),
    },
    wallSeconds: jsonNumber(report.wallSeconds, `${path}: wallSeconds`),
    timing: {
      firstDurableProgressToCompletionSeconds: jsonNumber(
        timing.firstDurableProgressToCompletionSeconds,
        `${path}: timing.firstDurableProgressToCompletionSeconds`,
      ),
      triggerToDurableCompletionSeconds: jsonNumber(
        timing.triggerToDurableCompletionSeconds,
        `${path}: timing.triggerToDurableCompletionSeconds`,
      ),
      triggerToFirstDurableProgressSeconds: jsonNumber(
        timing.triggerToFirstDurableProgressSeconds,
        `${path}: timing.triggerToFirstDurableProgressSeconds`,
      ),
      samplingIntervalSeconds: jsonNumber(timing.samplingIntervalSeconds, `${path}: timing.samplingIntervalSeconds`),
    },
    maxRssKiB: jsonNumber(report.maxRssKiB, `${path}: maxRssKiB`),
    runtimeAttestation: {
      runId: jsonString(runtimeAttestation.runId, `${path}: runtimeAttestation.runId`),
      observedProcessPageSize: jsonNumber(
        runtimeAttestation.observedProcessPageSize,
        `${path}: runtimeAttestation.observedProcessPageSize`,
      ),
      requestedResultTransport: jsonResultTransport(
        runtimeAttestation.requestedResultTransport,
        `${path}: runtimeAttestation.requestedResultTransport`,
      ),
      observedProcessResultTransport: jsonResultTransport(
        runtimeAttestation.observedProcessResultTransport,
        `${path}: runtimeAttestation.observedProcessResultTransport`,
      ),
      expectedResolvedResultTransport: jsonResultTransport(
        runtimeAttestation.expectedResolvedResultTransport,
        `${path}: runtimeAttestation.expectedResolvedResultTransport`,
      ),
      observedProcessResultTransportEnvironmentValue: jsonResultTransport(
        runtimeAttestation.observedProcessResultTransportEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessResultTransportEnvironmentValue`,
      ),
      resultTransportEnvironmentPresent: jsonBoolean(
        runtimeAttestation.resultTransportEnvironmentPresent,
        `${path}: runtimeAttestation.resultTransportEnvironmentPresent`,
      ),
      expectedResolvedClassificationStrategy: jsonString(
        runtimeAttestation.expectedResolvedClassificationStrategy,
        `${path}: runtimeAttestation.expectedResolvedClassificationStrategy`,
      ),
      observedProcessClassificationStrategyEnvironmentValue: jsonNullableString(
        runtimeAttestation.observedProcessClassificationStrategyEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessClassificationStrategyEnvironmentValue`,
      ),
      classificationStrategyEnvironmentPresent: jsonBoolean(
        runtimeAttestation.classificationStrategyEnvironmentPresent,
        `${path}: runtimeAttestation.classificationStrategyEnvironmentPresent`,
      ),
      classificationStrategyAttestationSource: jsonString(
        runtimeAttestation.classificationStrategyAttestationSource,
        `${path}: runtimeAttestation.classificationStrategyAttestationSource`,
      ),
      expectedResolvedVisitFoodDetectionStrategy: jsonStrategy(
        runtimeAttestation.expectedResolvedVisitFoodDetectionStrategy,
        `${path}: runtimeAttestation.expectedResolvedVisitFoodDetectionStrategy`,
      ),
      observedProcessVisitFoodDetectionStrategyEnvironmentValue: jsonStrategy(
        runtimeAttestation.observedProcessVisitFoodDetectionStrategyEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessVisitFoodDetectionStrategyEnvironmentValue`,
      ),
      visitFoodDetectionStrategyEnvironmentPresent: jsonBoolean(
        runtimeAttestation.visitFoodDetectionStrategyEnvironmentPresent,
        `${path}: runtimeAttestation.visitFoodDetectionStrategyEnvironmentPresent`,
      ),
      visitFoodDetectionStrategyAttestationSource: jsonString(
        runtimeAttestation.visitFoodDetectionStrategyAttestationSource,
        `${path}: runtimeAttestation.visitFoodDetectionStrategyAttestationSource`,
      ),
      expectedResolvedPageOrchestrationStrategy: jsonPageOrchestrationStrategy(
        runtimeAttestation.expectedResolvedPageOrchestrationStrategy,
        `${path}: runtimeAttestation.expectedResolvedPageOrchestrationStrategy`,
      ),
      observedProcessPageOrchestrationStrategyEnvironmentValue: jsonPageOrchestrationStrategy(
        runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue`,
      ),
      pageOrchestrationStrategyEnvironmentPresent: jsonBoolean(
        runtimeAttestation.pageOrchestrationStrategyEnvironmentPresent,
        `${path}: runtimeAttestation.pageOrchestrationStrategyEnvironmentPresent`,
      ),
      expectedResolvedVisionConcurrency: jsonNumber(
        runtimeAttestation.expectedResolvedVisionConcurrency,
        `${path}: runtimeAttestation.expectedResolvedVisionConcurrency`,
      ),
      observedProcessVisionConcurrencyEnvironmentValue: jsonNullableNumber(
        runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue`,
      ),
      visionConcurrencyEnvironmentPresent: jsonBoolean(
        runtimeAttestation.visionConcurrencyEnvironmentPresent,
        `${path}: runtimeAttestation.visionConcurrencyEnvironmentPresent`,
      ),
      expectedResolvedPipelineDepth: jsonNumber(
        runtimeAttestation.expectedResolvedPipelineDepth,
        `${path}: runtimeAttestation.expectedResolvedPipelineDepth`,
      ),
      observedProcessPipelineDepthEnvironmentValue: jsonNullableNumber(
        runtimeAttestation.observedProcessPipelineDepthEnvironmentValue,
        `${path}: runtimeAttestation.observedProcessPipelineDepthEnvironmentValue`,
      ),
      pipelineDepthEnvironmentPresent: jsonBoolean(
        runtimeAttestation.pipelineDepthEnvironmentPresent,
        `${path}: runtimeAttestation.pipelineDepthEnvironmentPresent`,
      ),
      observedAtEpochSeconds: jsonNumber(
        runtimeAttestation.observedAtEpochSeconds,
        `${path}: runtimeAttestation.observedAtEpochSeconds`,
      ),
      processEnvironmentObservedAtEpochSeconds: jsonNumber(
        runtimeAttestation.processEnvironmentObservedAtEpochSeconds,
        `${path}: runtimeAttestation.processEnvironmentObservedAtEpochSeconds`,
      ),
      nativeResultTransport: {
        schemaVersion: jsonNumber(
          nativeResultTransport.schemaVersion,
          `${path}: runtimeAttestation.nativeResultTransport.schemaVersion`,
        ),
        runId: jsonString(nativeResultTransport.runId, `${path}: runtimeAttestation.nativeResultTransport.runId`),
        configuredResultTransport: jsonResultTransport(
          nativeResultTransport.configuredResultTransport,
          `${path}: runtimeAttestation.nativeResultTransport.configuredResultTransport`,
        ),
        resolvedResultTransport: jsonResultTransport(
          nativeResultTransport.resolvedResultTransport,
          `${path}: runtimeAttestation.nativeResultTransport.resolvedResultTransport`,
        ),
        selectedResultTransport: jsonResultTransport(
          nativeResultTransport.selectedResultTransport,
          `${path}: runtimeAttestation.nativeResultTransport.selectedResultTransport`,
        ),
        observedAtEpochSeconds: jsonNumber(
          nativeResultTransport.observedAtEpochSeconds,
          `${path}: runtimeAttestation.nativeResultTransport.observedAtEpochSeconds`,
        ),
        lastObservedAtEpochSeconds: jsonNullableNumber(
          nativeResultTransport.lastObservedAtEpochSeconds,
          `${path}: runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds`,
        ),
        workCountersAvailable: jsonBoolean(
          nativeResultTransport.workCountersAvailable,
          `${path}: runtimeAttestation.nativeResultTransport.workCountersAvailable`,
        ),
        workCounters: parseNullableNativeWorkCounters(
          nativeResultTransport.workCounters,
          `${path}: runtimeAttestation.nativeResultTransport.workCounters`,
        ),
      },
      source: jsonString(runtimeAttestation.source, `${path}: runtimeAttestation.source`),
    },
    triggerBoundary: {
      preparedVisionStateSha256: jsonString(
        triggerBoundary.preparedVisionStateSha256,
        `${path}: triggerBoundary.preparedVisionStateSha256`,
      ),
      preTriggerVisionStateSha256: jsonString(
        triggerBoundary.preTriggerVisionStateSha256,
        `${path}: triggerBoundary.preTriggerVisionStateSha256`,
      ),
      unchangedBeforeTrigger: jsonBoolean(
        triggerBoundary.unchangedBeforeTrigger,
        `${path}: triggerBoundary.unchangedBeforeTrigger`,
      ),
      preTriggerObservedAtEpochSeconds: jsonNumber(
        triggerBoundary.preTriggerObservedAtEpochSeconds,
        `${path}: triggerBoundary.preTriggerObservedAtEpochSeconds`,
      ),
      triggerEpochSeconds: jsonNumber(
        triggerBoundary.triggerEpochSeconds,
        `${path}: triggerBoundary.triggerEpochSeconds`,
      ),
      triggerObservedAtEpochSeconds: jsonNumber(
        triggerBoundary.triggerObservedAtEpochSeconds,
        `${path}: triggerBoundary.triggerObservedAtEpochSeconds`,
      ),
      durableCompletionObservedAtEpochSeconds: jsonNumber(
        triggerBoundary.durableCompletionObservedAtEpochSeconds,
        `${path}: triggerBoundary.durableCompletionObservedAtEpochSeconds`,
      ),
      maxTriggerAgeSeconds: jsonNumber(
        triggerBoundary.maxTriggerAgeSeconds,
        `${path}: triggerBoundary.maxTriggerAgeSeconds`,
      ),
      triggerFollowedPreTriggerAttestation: jsonBoolean(
        triggerBoundary.triggerFollowedPreTriggerAttestation,
        `${path}: triggerBoundary.triggerFollowedPreTriggerAttestation`,
      ),
      triggerWasNotFutureDated: jsonBoolean(
        triggerBoundary.triggerWasNotFutureDated,
        `${path}: triggerBoundary.triggerWasNotFutureDated`,
      ),
      triggerWasFresh: jsonBoolean(triggerBoundary.triggerWasFresh, `${path}: triggerBoundary.triggerWasFresh`),
    },
    buildAttestation: {
      strictCodeSignatureVerified: jsonBoolean(
        buildAttestation.strictCodeSignatureVerified,
        `${path}: buildAttestation.strictCodeSignatureVerified`,
      ),
      suppliedAppName: jsonString(buildAttestation.suppliedAppName, `${path}: buildAttestation.suppliedAppName`),
      runningAppName: jsonString(buildAttestation.runningAppName, `${path}: buildAttestation.runningAppName`),
      suppliedExecutableSha256: jsonString(
        buildAttestation.suppliedExecutableSha256,
        `${path}: buildAttestation.suppliedExecutableSha256`,
      ),
      runningExecutableSha256: jsonString(
        buildAttestation.runningExecutableSha256,
        `${path}: buildAttestation.runningExecutableSha256`,
      ),
      suppliedMainJsBundleSha256: jsonString(
        buildAttestation.suppliedMainJsBundleSha256,
        `${path}: buildAttestation.suppliedMainJsBundleSha256`,
      ),
      runningMainJsBundleSha256: jsonString(
        buildAttestation.runningMainJsBundleSha256,
        `${path}: buildAttestation.runningMainJsBundleSha256`,
      ),
      exactExecutableMatch: jsonBoolean(
        buildAttestation.exactExecutableMatch,
        `${path}: buildAttestation.exactExecutableMatch`,
      ),
      exactMainJsBundleMatch: jsonBoolean(
        buildAttestation.exactMainJsBundleMatch,
        `${path}: buildAttestation.exactMainJsBundleMatch`,
      ),
    },
    validation: {
      exactSemanticPhotoParity: jsonBoolean(
        validation.exactSemanticPhotoParity,
        `${path}: validation.exactSemanticPhotoParity`,
      ),
      photoMismatchCount: jsonNumber(validation.photoMismatchCount, `${path}: validation.photoMismatchCount`),
      exactStrategySemanticPhotoParity: jsonBoolean(
        validation.exactStrategySemanticPhotoParity,
        `${path}: validation.exactStrategySemanticPhotoParity`,
      ),
      strategyPhotoMismatchCount: jsonNumber(
        validation.strategyPhotoMismatchCount,
        `${path}: validation.strategyPhotoMismatchCount`,
      ),
      exactFullReferencePhotoParity: jsonBoolean(
        validation.exactFullReferencePhotoParity,
        `${path}: validation.exactFullReferencePhotoParity`,
      ),
      fullReferencePhotoMismatchCount: jsonNumber(
        validation.fullReferencePhotoMismatchCount,
        `${path}: validation.fullReferencePhotoMismatchCount`,
      ),
      successfulAttemptMismatchCount: jsonNumber(
        validation.successfulAttemptMismatchCount,
        `${path}: validation.successfulAttemptMismatchCount`,
      ),
      retryablePartialStateCount: jsonNumber(
        validation.retryablePartialStateCount,
        `${path}: validation.retryablePartialStateCount`,
      ),
      skippedWriteCount: jsonNumber(validation.skippedWriteCount, `${path}: validation.skippedWriteCount`),
      photoIdMismatchCount: jsonNumber(validation.photoIdMismatchCount, `${path}: validation.photoIdMismatchCount`),
      unplannedPendingCount: jsonNumber(validation.unplannedPendingCount, `${path}: validation.unplannedPendingCount`),
      exactVisitFoodParity: jsonBoolean(validation.exactVisitFoodParity, `${path}: validation.exactVisitFoodParity`),
      visitMismatchCount: jsonNumber(validation.visitMismatchCount, `${path}: validation.visitMismatchCount`),
      exactPositiveVisitSet: jsonBoolean(validation.exactPositiveVisitSet, `${path}: validation.exactPositiveVisitSet`),
      positiveVisitIdMismatchCount: jsonNumber(
        validation.positiveVisitIdMismatchCount,
        `${path}: validation.positiveVisitIdMismatchCount`,
      ),
      invalidVisitFoodCount: jsonNumber(validation.invalidVisitFoodCount, `${path}: validation.invalidVisitFoodCount`),
      pendingCount: jsonNumber(validation.pendingCount, `${path}: validation.pendingCount`),
      pendingRowsAreExpected: jsonBoolean(
        validation.pendingRowsAreExpected,
        `${path}: validation.pendingRowsAreExpected`,
      ),
      workloadAccountingExact: jsonBoolean(
        validation.workloadAccountingExact,
        `${path}: validation.workloadAccountingExact`,
      ),
      nativeWorkCountersRequired: jsonBoolean(
        validation.nativeWorkCountersRequired,
        `${path}: validation.nativeWorkCountersRequired`,
      ),
      nativeWorkCountersAvailable: jsonBoolean(
        validation.nativeWorkCountersAvailable,
        `${path}: validation.nativeWorkCountersAvailable`,
      ),
      nativeWorkLifecycleBalanced: jsonNullableBoolean(
        validation.nativeWorkLifecycleBalanced,
        `${path}: validation.nativeWorkLifecycleBalanced`,
      ),
      nativeRequestedAssetCountMatchesAttempts: jsonNullableBoolean(
        validation.nativeRequestedAssetCountMatchesAttempts,
        `${path}: validation.nativeRequestedAssetCountMatchesAttempts`,
      ),
      nativeBatchCountMatchesPlan: jsonNullableBoolean(
        validation.nativeBatchCountMatchesPlan,
        `${path}: validation.nativeBatchCountMatchesPlan`,
      ),
      integrity: jsonString(validation.integrity, `${path}: validation.integrity`),
      foreignKeyViolationCount: jsonNumber(
        validation.foreignKeyViolationCount,
        `${path}: validation.foreignKeyViolationCount`,
      ),
    },
    originalDatabaseSha256: jsonString(report.originalDatabaseSha256, `${path}: originalDatabaseSha256`),
    originalDatabase: {
      main: parseDatabaseComponent(originalDatabase.main, `${path}: originalDatabase.main`),
      wal: parseDatabaseComponent(originalDatabase.wal, `${path}: originalDatabase.wal`),
      shm: parseDatabaseComponent(originalDatabase.shm, `${path}: originalDatabase.shm`),
      journal: parseDatabaseComponent(originalDatabase.journal, `${path}: originalDatabase.journal`),
    },
    standaloneSnapshotSha256: jsonString(report.standaloneSnapshotSha256, `${path}: standaloneSnapshotSha256`),
    semanticReference: {
      source: jsonString(semanticReference.source, `${path}: semanticReference.source`),
      sha256: jsonString(semanticReference.sha256, `${path}: semanticReference.sha256`),
      components: {
        main: parseSemanticReferenceComponent(semanticComponents.main, `${path}: semanticReference.components.main`),
        wal: parseSemanticReferenceComponent(semanticComponents.wal, `${path}: semanticReference.components.wal`),
        shm: parseSemanticReferenceComponent(semanticComponents.shm, `${path}: semanticReference.components.shm`),
        journal: parseSemanticReferenceComponent(
          semanticComponents.journal,
          `${path}: semanticReference.components.journal`,
        ),
      },
    },
    resultDatabase: {
      sha256: jsonString(resultDatabase.sha256, `${path}: resultDatabase.sha256`),
      retained: jsonBoolean(resultDatabase.retained, `${path}: resultDatabase.retained`),
      path: jsonNullableString(resultDatabase.path, `${path}: resultDatabase.path`),
    },
    rawDatabases: {
      retained: jsonBoolean(rawDatabases.retained, `${path}: rawDatabases.retained`),
      snapshotPath: jsonNullableString(rawDatabases.snapshotPath, `${path}: rawDatabases.snapshotPath`),
    },
    restoration: {
      exactMainAndSidecarSetRestored: jsonBoolean(
        restoration.exactMainAndSidecarSetRestored,
        `${path}: restoration.exactMainAndSidecarSetRestored`,
      ),
      launchEnvironmentRestored: jsonBoolean(
        restoration.launchEnvironmentRestored,
        `${path}: restoration.launchEnvironmentRestored`,
      ),
      rawDatabasePolicyApplied: jsonBoolean(
        restoration.rawDatabasePolicyApplied,
        `${path}: restoration.rawDatabasePolicyApplied`,
      ),
      reportPublishedAfterRestoration: jsonBoolean(
        restoration.reportPublishedAfterRestoration,
        `${path}: restoration.reportPublishedAfterRestoration`,
      ),
      restoredDatabaseSha256: jsonString(
        restoration.restoredDatabaseSha256,
        `${path}: restoration.restoredDatabaseSha256`,
      ),
    },
    samplesPath: jsonString(report.samplesPath, `${path}: samplesPath`),
  };
}
function validateDatabaseComponent(component: DatabaseComponent, label: string, required: boolean): void {
  if (required) {
    assert.equal(component.present, true, `${label} must be present`);
  }
  if (component.present) {
    assert.ok(component.sha256 !== null, `${label}.sha256 must be present`);
    sha256(component.sha256, `${label}.sha256`);
    assert.ok(component.mode !== null, `${label}.mode must be a string`);
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
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${label} value is out of range`);
  assert.ok(mode === "native-default" || mode === "override", `${label} mode is invalid`);
  assert.equal(overridden, mode === "override", `${label} override mode`);
  assert.equal(runtimeValue, value, `${label} runtime resolution`);
  assert.equal(runtimeEnvironmentPresent, overridden, `${label} runtime environment presence`);
  assert.equal(environmentValue, overridden ? value : null, `${label} configuration environment value`);
  assert.equal(runtimeEnvironmentValue, overridden ? value : null, `${label} runtime environment value`);
}

function validateNativeWorkCounters(report: VisionReport, path: string): NativeWorkCounters {
  const native = report.runtimeAttestation.nativeResultTransport;
  assert.equal(native.schemaVersion, 2, `${path}: native result-transport schema must be exactly 2`);
  assert.equal(native.workCountersAvailable, true, `${path}: native work counters must be available`);
  const counters = native.workCounters;
  assert.ok(counters, `${path}: native work counters`);
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
    nonnegativeInteger(counters[key], `${path}: native work counters.${key}`);
  }
  assert.equal(counters.startedBatchCount, counters.completedBatchCount, `${path}: completed batch balance`);
  assert.equal(counters.completedBatchCount, counters.resolvedBatchCount, `${path}: resolved batch balance`);
  assert.equal(
    counters.startedRequestedAssetCount,
    counters.completedRequestedAssetCount,
    `${path}: completed requested-asset balance`,
  );
  assert.equal(
    counters.completedRequestedAssetCount,
    counters.resolvedRequestedAssetCount,
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
    assert.equal(counters[key], 0, `${path}: native work counters.${key} must be zero`);
  }
  positiveInteger(counters.startedBatchCount, `${path}: direct native batch count`);
  positiveInteger(counters.startedRequestedAssetCount, `${path}: direct requested-asset count`);
  return counters;
}

function validateReport(path: string, expectedStrategy: Strategy): LoadedRun {
  const pathStat = lstatSync(path);
  assert.ok(pathStat.isFile() && !pathStat.isSymbolicLink(), `${path}: report must be a regular non-symlinked file`);
  const report = parseVisionReport(parseJsonValue(readFileSync(path, "utf8")), path);
  assert.equal(report.schemaVersion, 6, `${path}: report schema must be exactly 6`);
  assert.equal(report.schemaCompatibility.previousSchemaVersion, 5, `${path}: previous schema version`);
  assert.equal(report.schemaCompatibility.semanticFieldsPreserved, true, `${path}: schema compatibility`);
  assert.equal(report.status, "ok", `${path}: status`);
  assert.equal(report.visitFoodDetectionStrategy, expectedStrategy, `${path}: top-level visit-food strategy`);

  positiveInteger(report.pageSize, `${path}: page size`);
  assert.ok(report.pageSize <= 2_000, `${path}: page size exceeds 2,000`);
  assert.equal(report.configuration.resultPageSize, report.pageSize, `${path}: configured page size`);
  resultTransport(report.resultTransport, `${path}: selected result transport`);
  resultTransport(report.requestedResultTransport, `${path}: requested result transport`);
  assert.equal(report.resultTransport, report.requestedResultTransport, `${path}: result transport request`);
  assert.equal(report.configuration.resultTransport, report.resultTransport, `${path}: configured result transport`);
  assert.equal(
    report.configuration.requestedResultTransport,
    report.requestedResultTransport,
    `${path}: configured requested result transport`,
  );
  assert.equal(
    report.configuration.expectedResolvedResultTransport,
    report.requestedResultTransport,
    `${path}: configured resolved result transport`,
  );
  assert.equal(
    report.configuration.visitFoodDetectionStrategy,
    expectedStrategy,
    `${path}: configured visit-food strategy`,
  );
  pageOrchestrationStrategy(report.pageOrchestrationStrategy, `${path}: page orchestration strategy`);
  assert.equal(
    report.configuration.pageOrchestrationStrategy,
    report.pageOrchestrationStrategy,
    `${path}: configured page orchestration strategy`,
  );
  assert.equal(report.configuration.classificationStrategy, "pipeline", `${path}: classification strategy`);
  assert.equal(report.configuration.classificationStrategyMode, "native-default", `${path}: classification mode`);
  assert.equal(
    report.configuration.classificationStrategyEnvironmentValue,
    null,
    `${path}: classification environment value`,
  );

  const runtime = report.runtimeAttestation;
  safeToken(runtime.runId, `${path}: runtime run ID`);
  assert.equal(runtime.observedProcessPageSize, report.pageSize, `${path}: runtime page size`);
  assert.equal(
    runtime.requestedResultTransport,
    report.requestedResultTransport,
    `${path}: runtime requested transport`,
  );
  assert.equal(runtime.observedProcessResultTransport, report.resultTransport, `${path}: runtime selected transport`);
  assert.equal(runtime.expectedResolvedResultTransport, report.resultTransport, `${path}: runtime resolved transport`);
  assert.equal(
    runtime.observedProcessResultTransportEnvironmentValue,
    report.resultTransport,
    `${path}: process result-transport environment`,
  );
  assert.equal(runtime.resultTransportEnvironmentPresent, true, `${path}: result-transport environment presence`);
  assert.equal(runtime.expectedResolvedClassificationStrategy, "pipeline", `${path}: runtime classification strategy`);
  assert.equal(
    runtime.observedProcessClassificationStrategyEnvironmentValue,
    null,
    `${path}: runtime classification environment value`,
  );
  assert.equal(runtime.classificationStrategyEnvironmentPresent, false, `${path}: classification environment presence`);
  assert.equal(
    runtime.classificationStrategyAttestationSource,
    "validated-environment-absence-plus-native-default",
    `${path}: classification attestation source`,
  );
  assert.equal(
    runtime.expectedResolvedVisitFoodDetectionStrategy,
    expectedStrategy,
    `${path}: runtime visit-food strategy`,
  );
  assert.equal(
    runtime.observedProcessVisitFoodDetectionStrategyEnvironmentValue,
    expectedStrategy,
    `${path}: process visit-food strategy`,
  );
  assert.equal(runtime.visitFoodDetectionStrategyEnvironmentPresent, true, `${path}: visit-food environment presence`);
  assert.equal(
    runtime.visitFoodDetectionStrategyAttestationSource,
    "process-environment-plus-strategy-aware-semantic-oracle",
    `${path}: visit-food strategy attestation source`,
  );
  assert.equal(
    runtime.expectedResolvedPageOrchestrationStrategy,
    report.pageOrchestrationStrategy,
    `${path}: runtime page orchestration strategy`,
  );
  assert.equal(
    runtime.observedProcessPageOrchestrationStrategyEnvironmentValue,
    report.pageOrchestrationStrategy,
    `${path}: process page orchestration strategy`,
  );
  assert.equal(
    runtime.pageOrchestrationStrategyEnvironmentPresent,
    true,
    `${path}: orchestration environment presence`,
  );
  validateTuning(
    report.configuration.visionConcurrency,
    report.configuration.visionConcurrencyMode,
    report.configuration.visionConcurrencyOverridden,
    report.configuration.visionConcurrencyEnvironmentValue,
    runtime.expectedResolvedVisionConcurrency,
    runtime.observedProcessVisionConcurrencyEnvironmentValue,
    runtime.visionConcurrencyEnvironmentPresent,
    1,
    16,
    `${path}: Vision concurrency`,
  );
  validateTuning(
    report.configuration.pipelineDepth,
    report.configuration.pipelineDepthMode,
    report.configuration.pipelineDepthOverridden,
    report.configuration.pipelineDepthEnvironmentValue,
    runtime.expectedResolvedPipelineDepth,
    runtime.observedProcessPipelineDepthEnvironmentValue,
    runtime.pipelineDepthEnvironmentPresent,
    1,
    64,
    `${path}: pipeline depth`,
  );
  assert.equal(
    runtime.source,
    "process-environment-plus-native-result-transport-attestation",
    `${path}: runtime attestation source`,
  );

  const native = runtime.nativeResultTransport;
  safeToken(native.runId, `${path}: native run ID`);
  assert.equal(native.runId, runtime.runId, `${path}: native run ID`);
  assert.equal(native.configuredResultTransport, report.resultTransport, `${path}: native configured transport`);
  assert.equal(native.resolvedResultTransport, report.resultTransport, `${path}: native resolved transport`);
  assert.equal(native.selectedResultTransport, report.resultTransport, `${path}: native selected transport`);
  finiteNonnegative(native.observedAtEpochSeconds, `${path}: native first observation`);
  finiteNonnegative(native.lastObservedAtEpochSeconds, `${path}: native final observation`);
  assert.ok(
    native.lastObservedAtEpochSeconds >= native.observedAtEpochSeconds,
    `${path}: native final observation precedes its first observation`,
  );
  finiteNonnegative(runtime.observedAtEpochSeconds, `${path}: runtime observation`);
  assert.equal(runtime.observedAtEpochSeconds, native.observedAtEpochSeconds, `${path}: mirrored native observation`);
  finiteNonnegative(runtime.processEnvironmentObservedAtEpochSeconds, `${path}: process-environment observation`);
  const counters = validateNativeWorkCounters(report, path);

  const workload = report.workload;
  assert.equal(workload.visitFoodDetectionStrategy, expectedStrategy, `${path}: workload visit-food strategy`);
  for (const key of [
    "plannedSamples",
    "attemptedSamples",
    "successfulAttempts",
    "retryableAttempts",
    "skippedSamples",
    "expectedNativeBatchCount",
  ] as const) {
    nonnegativeInteger(workload[key], `${path}: workload.${key}`);
  }
  positiveInteger(report.fixtureCount, `${path}: fixture count`);
  assert.equal(workload.plannedSamples, report.fixtureCount, `${path}: planned sample count`);
  assert.equal(
    workload.attemptedSamples + workload.skippedSamples,
    workload.plannedSamples,
    `${path}: planned work balance`,
  );
  assert.equal(
    workload.successfulAttempts + workload.retryableAttempts,
    workload.attemptedSamples,
    `${path}: attempted work balance`,
  );
  assert.equal(workload.directNativeCountersRequired, true, `${path}: direct counters required`);
  assert.equal(workload.directNativeCountersAvailable, true, `${path}: direct counters available`);
  assert.equal(
    workload.attemptAccountingSource,
    "native-dispatch-counters-plus-rank-plan-plus-durable-result-state",
    `${path}: attempt accounting source`,
  );
  assert.deepEqual(workload.nativeDispatch, counters, `${path}: native dispatch counter mirror`);
  assert.equal(counters.startedRequestedAssetCount, workload.attemptedSamples, `${path}: direct requested-asset total`);
  assert.equal(counters.startedBatchCount, workload.expectedNativeBatchCount, `${path}: direct native-batch total`);

  const validation = report.validation;
  assert.equal(validation.exactStrategySemanticPhotoParity, true, `${path}: exact strategy photo parity`);
  assert.equal(validation.strategyPhotoMismatchCount, 0, `${path}: strategy photo mismatch count`);
  assert.equal(validation.successfulAttemptMismatchCount, 0, `${path}: successful attempt mismatch count`);
  assert.equal(validation.retryablePartialStateCount, 0, `${path}: retryable partial-state count`);
  assert.equal(validation.skippedWriteCount, 0, `${path}: skipped write count`);
  assert.equal(validation.photoIdMismatchCount, 0, `${path}: photo ID mismatch count`);
  assert.equal(validation.unplannedPendingCount, 0, `${path}: unplanned pending count`);
  assert.equal(validation.exactVisitFoodParity, true, `${path}: exact visit-food parity`);
  assert.equal(validation.visitMismatchCount, 0, `${path}: visit mismatch count`);
  assert.equal(validation.exactPositiveVisitSet, true, `${path}: exact positive-visit set`);
  assert.equal(validation.positiveVisitIdMismatchCount, 0, `${path}: positive-visit mismatch count`);
  assert.equal(validation.invalidVisitFoodCount, 0, `${path}: invalid visit-food count`);
  assert.equal(validation.pendingRowsAreExpected, true, `${path}: expected pending rows`);
  assert.equal(validation.workloadAccountingExact, true, `${path}: exact workload accounting`);
  assert.equal(
    validation.pendingCount,
    workload.retryableAttempts + workload.skippedSamples,
    `${path}: pending workload balance`,
  );
  assert.equal(validation.nativeWorkCountersRequired, true, `${path}: validation required direct counters`);
  assert.equal(validation.nativeWorkCountersAvailable, true, `${path}: validation observed direct counters`);
  assert.equal(validation.nativeWorkLifecycleBalanced, true, `${path}: balanced native lifecycle`);
  assert.equal(validation.nativeRequestedAssetCountMatchesAttempts, true, `${path}: native requested-asset match`);
  assert.equal(validation.nativeBatchCountMatchesPlan, true, `${path}: native batch match`);
  assert.equal(validation.integrity, "ok", `${path}: SQLite integrity`);
  assert.equal(validation.foreignKeyViolationCount, 0, `${path}: foreign-key violations`);
  assert.equal(workload.retryableAttempts, 0, `${path}: retryable attempts would confound a completed A/B`);

  nonnegativeInteger(report.expectedFoodCount, `${path}: expected food count`);
  nonnegativeInteger(report.actualFoodCount, `${path}: actual food count`);
  nonnegativeInteger(report.expectedFoodVisitCount, `${path}: expected food-visit count`);
  nonnegativeInteger(report.actualFoodVisitCount, `${path}: actual food-visit count`);
  assert.equal(report.actualFoodVisitCount, report.expectedFoodVisitCount, `${path}: food-visit count parity`);
  if (expectedStrategy === "full-plan-v1") {
    assert.equal(workload.attemptedSamples, report.fixtureCount, `${path}: full-plan attempts`);
    assert.equal(workload.skippedSamples, 0, `${path}: full-plan skipped samples`);
    assert.equal(workload.retryableAttempts, 0, `${path}: full-plan retryable attempts`);
    assert.equal(validation.pendingCount, 0, `${path}: full-plan pending rows`);
    assert.equal(validation.exactSemanticPhotoParity, true, `${path}: full-plan semantic photo parity`);
    assert.equal(validation.photoMismatchCount, 0, `${path}: full-plan photo mismatch count`);
    assert.equal(validation.exactFullReferencePhotoParity, true, `${path}: full-reference photo parity`);
    assert.equal(validation.fullReferencePhotoMismatchCount, 0, `${path}: full-reference photo mismatches`);
    assert.equal(report.actualFoodCount, report.expectedFoodCount, `${path}: full-plan food count parity`);
    assert.equal(
      workload.expectedNativeBatchCount,
      Math.ceil(workload.attemptedSamples / report.pageSize),
      `${path}: full-plan native batch planning`,
    );
  } else {
    assert.ok(workload.attemptedSamples < report.fixtureCount, `${path}: adaptive strategy did not avoid any work`);
    assert.ok(workload.skippedSamples > 0, `${path}: adaptive strategy did not skip any planned work`);
    assert.equal(validation.pendingCount, workload.skippedSamples, `${path}: adaptive pending rows`);
    assert.equal(validation.exactSemanticPhotoParity, false, `${path}: adaptive full-reference photo parity`);
    assert.equal(validation.photoMismatchCount, workload.skippedSamples, `${path}: adaptive full-reference mismatches`);
    assert.equal(validation.exactFullReferencePhotoParity, false, `${path}: adaptive full-reference parity flag`);
    assert.equal(
      validation.fullReferencePhotoMismatchCount,
      workload.skippedSamples,
      `${path}: adaptive full-reference mismatch count`,
    );
  }

  const trigger = report.triggerBoundary;
  sha256(trigger.preparedVisionStateSha256, `${path}: prepared Vision state`);
  sha256(trigger.preTriggerVisionStateSha256, `${path}: pre-trigger Vision state`);
  assert.equal(
    trigger.preTriggerVisionStateSha256,
    trigger.preparedVisionStateSha256,
    `${path}: pre-trigger state changed`,
  );
  assert.equal(trigger.unchangedBeforeTrigger, true, `${path}: unchanged-before-trigger flag`);
  for (const [label, value] of [
    ["pre-trigger observation", trigger.preTriggerObservedAtEpochSeconds],
    ["trigger epoch", trigger.triggerEpochSeconds],
    ["trigger observation", trigger.triggerObservedAtEpochSeconds],
    ["durable completion", trigger.durableCompletionObservedAtEpochSeconds],
  ] as const) {
    finiteNonnegative(value, `${path}: ${label}`);
  }
  finitePositive(trigger.maxTriggerAgeSeconds, `${path}: trigger maximum age`);
  assert.ok(trigger.triggerEpochSeconds >= trigger.preTriggerObservedAtEpochSeconds, `${path}: trigger ordering`);
  assert.ok(
    trigger.triggerObservedAtEpochSeconds >= trigger.triggerEpochSeconds,
    `${path}: trigger observation ordering`,
  );
  assert.ok(
    trigger.durableCompletionObservedAtEpochSeconds >= trigger.triggerObservedAtEpochSeconds,
    `${path}: completion ordering`,
  );
  assert.ok(native.observedAtEpochSeconds >= trigger.triggerEpochSeconds, `${path}: native dispatch preceded trigger`);
  assert.ok(
    native.lastObservedAtEpochSeconds <= trigger.durableCompletionObservedAtEpochSeconds,
    `${path}: native completion followed durable completion`,
  );
  assert.equal(trigger.triggerFollowedPreTriggerAttestation, true, `${path}: trigger-followed-attestation flag`);
  assert.equal(trigger.triggerWasNotFutureDated, true, `${path}: nonfuture trigger flag`);
  assert.equal(trigger.triggerWasFresh, true, `${path}: trigger freshness flag`);
  assert.ok(
    trigger.triggerObservedAtEpochSeconds - trigger.triggerEpochSeconds <= trigger.maxTriggerAgeSeconds,
    `${path}: trigger age exceeds its maximum`,
  );

  finitePositive(report.wallSeconds, `${path}: wallSeconds`);
  finitePositive(report.timing.firstDurableProgressToCompletionSeconds, `${path}: durable-tail timing`);
  finitePositive(report.timing.triggerToDurableCompletionSeconds, `${path}: trigger-to-completion timing`);
  finiteNonnegative(report.timing.triggerToFirstDurableProgressSeconds, `${path}: trigger-to-first-progress timing`);
  finitePositive(report.timing.samplingIntervalSeconds, `${path}: sampling interval`);
  finitePositive(report.maxRssKiB, `${path}: max RSS`);
  assert.equal(
    report.wallSeconds,
    report.timing.firstDurableProgressToCompletionSeconds,
    `${path}: wall timing mirror`,
  );
  assert.ok(
    Math.abs(
      report.timing.triggerToFirstDurableProgressSeconds +
        report.timing.firstDurableProgressToCompletionSeconds -
        report.timing.triggerToDurableCompletionSeconds,
    ) <= 0.000_01,
    `${path}: timing components are inconsistent`,
  );
  assert.ok(
    Math.abs(
      trigger.durableCompletionObservedAtEpochSeconds -
        trigger.triggerEpochSeconds -
        report.timing.triggerToDurableCompletionSeconds,
    ) <= 0.000_01,
    `${path}: trigger timestamps do not match timing`,
  );

  const build = report.buildAttestation;
  assert.equal(build.strictCodeSignatureVerified, true, `${path}: strict code-signature verification`);
  nonemptyString(build.suppliedAppName, `${path}: supplied app name`);
  nonemptyString(build.runningAppName, `${path}: running app name`);
  assert.equal(basename(build.suppliedAppName), build.suppliedAppName, `${path}: supplied app basename`);
  assert.equal(basename(build.runningAppName), build.runningAppName, `${path}: running app basename`);
  assert.equal(build.suppliedAppName, build.runningAppName, `${path}: running app identity`);
  sha256(build.suppliedExecutableSha256, `${path}: supplied executable`);
  sha256(build.runningExecutableSha256, `${path}: running executable`);
  sha256(build.suppliedMainJsBundleSha256, `${path}: supplied bundle`);
  sha256(build.runningMainJsBundleSha256, `${path}: running bundle`);
  assert.equal(build.exactExecutableMatch, true, `${path}: exact executable match`);
  assert.equal(build.exactMainJsBundleMatch, true, `${path}: exact bundle match`);
  assert.equal(build.suppliedExecutableSha256, build.runningExecutableSha256, `${path}: executable identity`);
  assert.equal(build.suppliedMainJsBundleSha256, build.runningMainJsBundleSha256, `${path}: bundle identity`);

  sha256(report.originalDatabaseSha256, `${path}: original database`);
  validateDatabaseComponent(report.originalDatabase.main, `${path}: original main`, true);
  validateDatabaseComponent(report.originalDatabase.wal, `${path}: original WAL`, false);
  validateDatabaseComponent(report.originalDatabase.shm, `${path}: original SHM`, false);
  validateDatabaseComponent(report.originalDatabase.journal, `${path}: original journal`, false);
  assert.equal(report.originalDatabase.main.sha256, report.originalDatabaseSha256, `${path}: original main identity`);
  sha256(report.standaloneSnapshotSha256, `${path}: standalone snapshot`);
  assert.ok(
    report.semanticReference.source === "live-original-snapshot" ||
      report.semanticReference.source === "external-current-control",
    `${path}: semantic reference source`,
  );
  sha256(report.semanticReference.sha256, `${path}: semantic reference`);
  validateSemanticReferenceComponent(report.semanticReference.components.main, `${path}: reference main`, true, false);
  validateSemanticReferenceComponent(report.semanticReference.components.wal, `${path}: reference WAL`, false, true);
  validateSemanticReferenceComponent(report.semanticReference.components.shm, `${path}: reference SHM`, false, false);
  validateSemanticReferenceComponent(
    report.semanticReference.components.journal,
    `${path}: reference journal`,
    false,
    true,
  );
  assert.equal(
    report.semanticReference.components.main.sha256,
    report.semanticReference.sha256,
    `${path}: semantic reference main identity`,
  );

  assert.equal(report.restoration.exactMainAndSidecarSetRestored, true, `${path}: exact database restoration`);
  assert.equal(report.restoration.launchEnvironmentRestored, true, `${path}: launch-environment restoration`);
  assert.equal(report.restoration.rawDatabasePolicyApplied, true, `${path}: raw database policy`);
  assert.equal(report.restoration.reportPublishedAfterRestoration, true, `${path}: report publication ordering`);
  assert.equal(report.restoration.restoredDatabaseSha256, report.originalDatabaseSha256, `${path}: restored database`);
  assert.equal(report.rawDatabases.retained, false, `${path}: raw snapshots must not be retained`);
  assert.equal(report.rawDatabases.snapshotPath, null, `${path}: raw snapshot path must be null`);
  assert.equal(report.resultDatabase.retained, false, `${path}: result database must not be retained`);
  assert.equal(report.resultDatabase.path, null, `${path}: result database path must be null`);
  sha256(report.resultDatabase.sha256, `${path}: result database`);
  nonemptyString(report.samplesPath, `${path}: samples path`);
  assert.equal(report.samplesPath, basename(report.samplesPath), `${path}: samples path must be a basename`);

  const identity = JSON.stringify({
    pageSize: report.pageSize,
    resultTransport: report.resultTransport,
    requestedResultTransport: report.requestedResultTransport,
    pageOrchestrationStrategy: report.pageOrchestrationStrategy,
    classificationStrategy: report.configuration.classificationStrategy,
    classificationStrategyMode: report.configuration.classificationStrategyMode,
    classificationStrategyEnvironmentValue: report.configuration.classificationStrategyEnvironmentValue,
    visionConcurrency: report.configuration.visionConcurrency,
    visionConcurrencyMode: report.configuration.visionConcurrencyMode,
    visionConcurrencyOverridden: report.configuration.visionConcurrencyOverridden,
    visionConcurrencyEnvironmentValue: report.configuration.visionConcurrencyEnvironmentValue,
    pipelineDepth: report.configuration.pipelineDepth,
    pipelineDepthMode: report.configuration.pipelineDepthMode,
    pipelineDepthOverridden: report.configuration.pipelineDepthOverridden,
    pipelineDepthEnvironmentValue: report.configuration.pipelineDepthEnvironmentValue,
    fixtureCount: report.fixtureCount,
    expectedFoodCount: report.expectedFoodCount,
    expectedFoodVisitCount: report.expectedFoodVisitCount,
    samplingIntervalSeconds: report.timing.samplingIntervalSeconds,
    buildAttestation: report.buildAttestation,
    originalDatabaseSha256: report.originalDatabaseSha256,
    originalDatabase: report.originalDatabase,
    standaloneSnapshotSha256: report.standaloneSnapshotSha256,
    semanticReference: report.semanticReference,
    runtimeConfiguration: {
      resultTransportSource: runtime.source,
      classificationStrategy: runtime.expectedResolvedClassificationStrategy,
      classificationStrategyEnvironmentPresent: runtime.classificationStrategyEnvironmentPresent,
      classificationStrategyAttestationSource: runtime.classificationStrategyAttestationSource,
      pageOrchestrationStrategy: runtime.expectedResolvedPageOrchestrationStrategy,
    },
  });
  const strategyFixtureIdentity = JSON.stringify({
    strategy: expectedStrategy,
    preparedVisionStateSha256: trigger.preparedVisionStateSha256,
  });
  return {
    path,
    fileIdentity: `${pathStat.dev}:${pathStat.ino}`,
    report,
    runId: runtime.runId,
    strategy: expectedStrategy,
    identity,
    strategyFixtureIdentity,
    requestedAssets: counters.startedRequestedAssetCount,
    nativeBatches: counters.startedBatchCount,
  };
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0, "Cannot compute a median of no values");
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint]!;
  }
  const lower = sorted[midpoint - 1]!;
  const upper = sorted[midpoint]!;
  return lower + (upper - lower) / 2;
}

function sum(values: readonly number[]): number {
  const total = values.reduce((runningTotal, value) => runningTotal + value, 0);
  assert.ok(Number.isSafeInteger(total), "Aggregated direct-work total exceeds the safe integer range");
  return total;
}

function delta(candidate: number, baseline: number) {
  const candidateMinusBaseline = candidate - baseline;
  const candidateMinusBaselinePercent = baseline === 0 ? null : (candidateMinusBaseline / baseline) * 100;
  assert.ok(Number.isFinite(candidateMinusBaseline), "Descriptive delta must be finite");
  assert.ok(
    candidateMinusBaselinePercent === null || Number.isFinite(candidateMinusBaselinePercent),
    "Descriptive percentage delta must be finite",
  );
  return {
    baseline,
    candidate,
    candidateMinusBaseline,
    candidateMinusBaselinePercent,
  };
}

function avoided(candidate: number, baseline: number) {
  assert.ok(baseline > 0, "Full-plan work must be positive to calculate avoided work");
  return {
    baseline,
    candidate,
    avoided: baseline - candidate,
    avoidedPercent: ((baseline - candidate) / baseline) * 100,
  };
}

function summarizeGroup(runs: readonly LoadedRun[], strategy: Strategy) {
  const durableTailSeconds = runs.map((run) => run.report.timing.firstDurableProgressToCompletionSeconds);
  const triggerToDurableCompletionSeconds = runs.map((run) => run.report.timing.triggerToDurableCompletionSeconds);
  const triggerToFirstDurableProgressSeconds = runs.map(
    (run) => run.report.timing.triggerToFirstDurableProgressSeconds,
  );
  const maxRssKiB = runs.map((run) => run.report.maxRssKiB);
  const directRequestedAssets = runs.map((run) => run.requestedAssets);
  const directNativeBatches = runs.map((run) => run.nativeBatches);
  return {
    strategy,
    reports: runs.map((run) => basename(run.path)),
    runIds: runs.map((run) => run.runId),
    sampleCount: runs.length,
    timing: {
      firstDurableProgressToCompletionSeconds: durableTailSeconds,
      medianFirstDurableProgressToCompletionSeconds: median(durableTailSeconds),
      triggerToDurableCompletionSeconds,
      medianTriggerToDurableCompletionSeconds: median(triggerToDurableCompletionSeconds),
      triggerToFirstDurableProgressSeconds,
      medianTriggerToFirstDurableProgressSeconds: median(triggerToFirstDurableProgressSeconds),
    },
    rss: {
      maxRssKiB,
      medianMaxRssKiB: median(maxRssKiB),
    },
    directWork: {
      requestedAssets: directRequestedAssets,
      totalRequestedAssets: sum(directRequestedAssets),
      medianRequestedAssets: median(directRequestedAssets),
      nativeBatches: directNativeBatches,
      totalNativeBatches: sum(directNativeBatches),
      medianNativeBatches: median(directNativeBatches),
    },
  };
}

function validateUniqueInputs(configuration: Configuration, runs: readonly LoadedRun[]): void {
  const inputPaths = [...configuration.fullPlanPaths, ...configuration.rank3BulkTailPaths];
  assert.equal(new Set(inputPaths).size, inputPaths.length, "Input report paths must be unique");
  assert.equal(
    new Set(runs.map((run) => run.fileIdentity)).size,
    runs.length,
    "Input report file identities must be unique",
  );
  assert.equal(new Set(runs.map((run) => run.runId)).size, runs.length, "Runtime run IDs must be distinct");
  assert.equal(
    new Set(runs.map((run) => run.identity)).size,
    1,
    "A/B build, reference, tuning, orchestration, transport, classification, or fixture identity mismatch",
  );
  for (const strategy of ["full-plan-v1", "rank3-bulk-tail-v1"] as const) {
    const strategyRuns = runs.filter((run) => run.strategy === strategy);
    assert.equal(
      new Set(strategyRuns.map((run) => run.strategyFixtureIdentity)).size,
      1,
      `${strategy}: prepared fixture identity mismatch`,
    );
  }
  const outputPath = resolve(configuration.outputPath);
  assert.ok(!inputPaths.includes(outputPath), "Output path must not alias an input report path");
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  }
  const outputParent = dirname(outputPath);
  mkdirSync(outputParent, { recursive: true });
  const canonicalOutputParent = realpathSync(outputParent);
  for (const run of runs) {
    const canonicalInput = realpathSync(run.path);
    assert.notEqual(
      resolve(canonicalOutputParent, basename(outputPath)),
      canonicalInput,
      "Output path aliases an input report",
    );
  }
}

function publishReport<Report extends object>(outputPath: string, report: Report): void {
  const temporaryPath = `${outputPath}.tmp`;
  let temporaryFileDescriptor: number | undefined;
  let temporaryFileCreated = false;
  try {
    temporaryFileDescriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryFileCreated = true;
    writeFileSync(temporaryFileDescriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    closeSync(temporaryFileDescriptor);
    temporaryFileDescriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    linkSync(temporaryPath, outputPath);
  } finally {
    if (temporaryFileDescriptor !== undefined) {
      try {
        closeSync(temporaryFileDescriptor);
      } catch {
        // Preserve the original publication error while still removing only
        // the temporary file that this process successfully created.
      }
    }
    if (temporaryFileCreated && existsSync(temporaryPath)) {
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
  assert.ok(configuration.fullPlanPaths.length >= 3, "full-plan-v1 requires at least three measured reports");
  assert.equal(
    configuration.rank3BulkTailPaths.length,
    configuration.fullPlanPaths.length,
    "A/B report groups must have equal nonzero sample counts",
  );

  const fullPlanRuns = configuration.fullPlanPaths.map((path) => validateReport(path, "full-plan-v1"));
  const rank3BulkTailRuns = configuration.rank3BulkTailPaths.map((path) => validateReport(path, "rank3-bulk-tail-v1"));
  const allRuns = [...fullPlanRuns, ...rank3BulkTailRuns];
  validateUniqueInputs(configuration, allRuns);

  const fullPlan = summarizeGroup(fullPlanRuns, "full-plan-v1");
  const rank3BulkTail = summarizeGroup(rank3BulkTailRuns, "rank3-bulk-tail-v1");
  const pairs = fullPlanRuns.map((fullPlanRun, index) => {
    const rank3Run = rank3BulkTailRuns[index]!;
    const durableTail = delta(
      rank3Run.report.timing.firstDurableProgressToCompletionSeconds,
      fullPlanRun.report.timing.firstDurableProgressToCompletionSeconds,
    );
    return {
      pairIndex: index + 1,
      fullPlanRunId: fullPlanRun.runId,
      rank3BulkTailRunId: rank3Run.runId,
      timing: {
        firstDurableProgressToCompletionSeconds: durableTail,
        triggerToDurableCompletionSeconds: delta(
          rank3Run.report.timing.triggerToDurableCompletionSeconds,
          fullPlanRun.report.timing.triggerToDurableCompletionSeconds,
        ),
        triggerToFirstDurableProgressSeconds: delta(
          rank3Run.report.timing.triggerToFirstDurableProgressSeconds,
          fullPlanRun.report.timing.triggerToFirstDurableProgressSeconds,
        ),
      },
      maxRssKiB: delta(rank3Run.report.maxRssKiB, fullPlanRun.report.maxRssKiB),
      directWork: {
        requestedAssets: avoided(rank3Run.requestedAssets, fullPlanRun.requestedAssets),
        nativeBatches: avoided(rank3Run.nativeBatches, fullPlanRun.nativeBatches),
      },
      fasterDurableTail:
        durableTail.candidateMinusBaseline < 0
          ? "rank3-bulk-tail-v1"
          : durableTail.candidateMinusBaseline > 0
            ? "full-plan-v1"
            : "tie",
    };
  });
  const baseline = fullPlanRuns[0]!.report;
  const comparison = {
    interpretation: "descriptive-only-non-causal",
    baselineStrategy: "full-plan-v1",
    candidateStrategy: "rank3-bulk-tail-v1",
    medianDeltas: {
      firstDurableProgressToCompletionSeconds: delta(
        rank3BulkTail.timing.medianFirstDurableProgressToCompletionSeconds,
        fullPlan.timing.medianFirstDurableProgressToCompletionSeconds,
      ),
      triggerToDurableCompletionSeconds: delta(
        rank3BulkTail.timing.medianTriggerToDurableCompletionSeconds,
        fullPlan.timing.medianTriggerToDurableCompletionSeconds,
      ),
      triggerToFirstDurableProgressSeconds: delta(
        rank3BulkTail.timing.medianTriggerToFirstDurableProgressSeconds,
        fullPlan.timing.medianTriggerToFirstDurableProgressSeconds,
      ),
      maxRssKiB: delta(rank3BulkTail.rss.medianMaxRssKiB, fullPlan.rss.medianMaxRssKiB),
    },
    aggregateAvoidedWork: {
      requestedAssets: avoided(rank3BulkTail.directWork.totalRequestedAssets, fullPlan.directWork.totalRequestedAssets),
      nativeBatches: avoided(rank3BulkTail.directWork.totalNativeBatches, fullPlan.directWork.totalNativeBatches),
    },
    medianAvoidedWork: {
      requestedAssets: avoided(
        rank3BulkTail.directWork.medianRequestedAssets,
        fullPlan.directWork.medianRequestedAssets,
      ),
      nativeBatches: avoided(rank3BulkTail.directWork.medianNativeBatches, fullPlan.directWork.medianNativeBatches),
    },
    pairwiseWins: {
      rank3BulkTail: pairs.filter((pair) => pair.fasterDurableTail === "rank3-bulk-tail-v1").length,
      fullPlan: pairs.filter((pair) => pair.fasterDurableTail === "full-plan-v1").length,
      ties: pairs.filter((pair) => pair.fasterDurableTail === "tie").length,
    },
    pairs,
  };
  const report = {
    schemaVersion: 1,
    inputReportSchemaVersion: 6,
    status: "ok",
    validation: {
      everyRunStrictSchema2DirectWorkAttested: true,
      everyRunBalancedNativeLifecycle: true,
      everyRunExactStrategySemanticAndVisitParity: true,
      everyRunStrictSignedBuildIdentityAttested: true,
      everyRunTriggerBoundaryAttested: true,
      everyRunExactRestorationAttested: true,
      identicalBuildReferenceTuningOrchestrationTransportClassificationAndFixtureIdentity: true,
      distinctRunIdsAndReportFiles: true,
      equalGroupsWithAtLeastThreeSamplesPerStrategy: true,
      aggregateOnlyOutput: true,
    },
    inputIdentity: {
      appName: baseline.buildAttestation.suppliedAppName,
      executableSha256: baseline.buildAttestation.suppliedExecutableSha256,
      mainJsBundleSha256: baseline.buildAttestation.suppliedMainJsBundleSha256,
      pageSize: baseline.pageSize,
      requestedResultTransport: baseline.requestedResultTransport,
      resultTransport: baseline.resultTransport,
      pageOrchestrationStrategy: baseline.pageOrchestrationStrategy,
      classificationStrategy: baseline.configuration.classificationStrategy,
      classificationStrategyMode: baseline.configuration.classificationStrategyMode,
      classificationStrategyEnvironmentValue: baseline.configuration.classificationStrategyEnvironmentValue,
      visionConcurrency: baseline.configuration.visionConcurrency,
      visionConcurrencyMode: baseline.configuration.visionConcurrencyMode,
      visionConcurrencyOverridden: baseline.configuration.visionConcurrencyOverridden,
      visionConcurrencyEnvironmentValue: baseline.configuration.visionConcurrencyEnvironmentValue,
      pipelineDepth: baseline.configuration.pipelineDepth,
      pipelineDepthMode: baseline.configuration.pipelineDepthMode,
      pipelineDepthOverridden: baseline.configuration.pipelineDepthOverridden,
      pipelineDepthEnvironmentValue: baseline.configuration.pipelineDepthEnvironmentValue,
      fixtureCount: baseline.fixtureCount,
      expectedFoodCount: baseline.expectedFoodCount,
      expectedFoodVisitCount: baseline.expectedFoodVisitCount,
      samplingIntervalSeconds: baseline.timing.samplingIntervalSeconds,
      originalDatabaseSha256: baseline.originalDatabaseSha256,
      originalDatabase: baseline.originalDatabase,
      standaloneSnapshotSha256: baseline.standaloneSnapshotSha256,
      semanticReference: baseline.semanticReference,
      preparedVisionStateSha256ByStrategy: {
        fullPlanV1: fullPlanRuns[0]!.report.triggerBoundary.preparedVisionStateSha256,
        rank3BulkTailV1: rank3BulkTailRuns[0]!.report.triggerBoundary.preparedVisionStateSha256,
      },
    },
    fullPlan,
    rank3BulkTail,
    comparison,
    limitations: [
      "This is a descriptive, non-causal summary of the supplied positional pairs; it makes no statistical-significance or causal performance claim.",
      "Pairs are defined only by comma-list position and do not attest randomization, thermal state, cache state, background load, or run-order control.",
      "The primary durable-tail timing excludes launch, manual trigger latency, and work before the first sampled durable database progress.",
      "Signed-app timings include PhotoKit, Vision, native/JavaScript transfer, orchestration, and SQLite persistence; they do not isolate one subsystem.",
      "Native batch counts can increase even when requested assets decrease because rank3-bulk-tail-v1 uses separately checkpointed rank waves.",
      "Max RSS is sampled and can miss short-lived allocation peaks.",
    ],
  };
  publishReport(configuration.outputPath, report);
  console.log(
    `Vision visit-food strategy A/B descriptive summary: ${comparison.aggregateAvoidedWork.requestedAssets.avoidedPercent.toFixed(2)}% direct requested assets avoided; report=${configuration.outputPath}`,
  );
}

main();
