#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

type Strategy = "legacy" | "incremental";

interface Configuration {
  legacyPaths: string[];
  incrementalPaths: string[];
  outputPath: string;
}

interface RunReport {
  schemaVersion: number;
  status: string;
  configuration: {
    calendarQueryStrategy: string;
    sparseCoalescingGapDays: number;
    requestedPhotoScanStrategy: Strategy | null;
    expectedPhotoScanImplementation: string | null;
  };
  fixture: Record<string, number>;
  timing: { wallSeconds: number; triggerEpochSeconds: number };
  maxRssKiB: number;
  runtimeAttestation: {
    runId: string;
    expectedPhotoScanImplementation: string;
    photoScan: {
      schemaVersion: number;
      runId: string;
      selectedScanKind: Strategy;
      selectedScanImplementation: string;
      resolvedPhotoScanStrategy: Strategy;
      libraryTotalCount: number;
      unknownVisibleCount: number;
      excludedVisibleCount: number;
      observedAtEpochSeconds: number;
    };
  };
  buildAttestation: {
    suppliedExecutableSha256: string;
    suppliedMainBundleSha256: string;
    exactExecutableMatch: boolean;
    exactMainBundleMatch: boolean;
    strictCodeSignatureVerified: boolean;
  };
  triggerBoundary: {
    preparedLogicalDigest: string;
    pretriggerLogicalDigest: string;
    unchangedBeforeTrigger: boolean;
  };
  liveOriginalDatabase: {
    sha256: string;
    preparedStandaloneSnapshotSha256: string;
  };
  parityReferenceDatabase: {
    sha256: string;
  };
  validation: {
    exactVisitParityExcludingUpdatedAt: boolean;
    exactPhotoParity: boolean;
    exactVisitSuggestedRestaurantParity: boolean;
    exactAppMetadataParity: boolean;
    integrity: string;
    foreignKeyViolationCount: number;
  };
  restoration?: {
    exactMainAndSidecarSetRestored: boolean;
    sensitiveDatabaseCopiesRetained: boolean;
    originalMain: RestorationComponent;
    originalWal: RestorationComponent;
    originalShm: RestorationComponent;
    originalJournal: RestorationComponent;
    restoredMainSha256: string;
  };
}

interface RestorationComponent {
  present: boolean | number;
  sha256: string;
  mode: string;
}

interface LoadedRun {
  path: string;
  report: RunReport;
  runId: string;
  scanImplementation: string;
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

function jsonNullableString(value: JsonNode, label: string): string | null {
  return value === null ? null : jsonString(value, label);
}

function jsonStrategy(value: JsonNode, label: string): Strategy {
  assert.ok(value === "legacy" || value === "incremental", `${label} must be a photo scan strategy`);
  return value;
}

function jsonNullableStrategy(value: JsonNode, label: string): Strategy | null {
  return value === null ? null : jsonStrategy(value, label);
}

function parseFixture(value: JsonNode, label: string): RunReport["fixture"] {
  const record = jsonObject(value, label);
  const fixture: Record<string, number> = {};
  for (const [name, count] of Object.entries(record)) {
    fixture[name] = jsonNumber(count, `${label}.${name}`);
  }
  return fixture;
}

function parseRestorationComponent(value: JsonNode, label: string): RestorationComponent {
  const component = jsonObject(value, label);
  const presentValue = component.present;
  assert.ok(
    presentValue === true || presentValue === false || presentValue === 1 || presentValue === 0,
    `${label}.present must be boolean-like`,
  );
  return {
    present: presentValue,
    sha256: jsonString(component.sha256, `${label}.sha256`),
    mode: jsonString(component.mode, `${label}.mode`),
  };
}

function parseRestoration(value: JsonNode, label: string): RunReport["restoration"] {
  if (value === undefined) {
    return undefined;
  }
  const restoration = jsonObject(value, label);
  return {
    exactMainAndSidecarSetRestored: jsonBoolean(
      restoration.exactMainAndSidecarSetRestored,
      `${label}.exactMainAndSidecarSetRestored`,
    ),
    sensitiveDatabaseCopiesRetained: jsonBoolean(
      restoration.sensitiveDatabaseCopiesRetained,
      `${label}.sensitiveDatabaseCopiesRetained`,
    ),
    originalMain: parseRestorationComponent(restoration.originalMain, `${label}.originalMain`),
    originalWal: parseRestorationComponent(restoration.originalWal, `${label}.originalWal`),
    originalShm: parseRestorationComponent(restoration.originalShm, `${label}.originalShm`),
    originalJournal: parseRestorationComponent(restoration.originalJournal, `${label}.originalJournal`),
    restoredMainSha256: jsonString(restoration.restoredMainSha256, `${label}.restoredMainSha256`),
  };
}

function parseRunReport(value: JsonValue, path: string): RunReport {
  const report = jsonObject(value, `${path}: report`);
  const configuration = jsonObject(report.configuration, `${path}: configuration`);
  const timing = jsonObject(report.timing, `${path}: timing`);
  const runtimeAttestation = jsonObject(report.runtimeAttestation, `${path}: runtimeAttestation`);
  const photoScan = jsonObject(runtimeAttestation.photoScan, `${path}: runtimeAttestation.photoScan`);
  const buildAttestation = jsonObject(report.buildAttestation, `${path}: buildAttestation`);
  const triggerBoundary = jsonObject(report.triggerBoundary, `${path}: triggerBoundary`);
  const liveOriginalDatabase = jsonObject(report.liveOriginalDatabase, `${path}: liveOriginalDatabase`);
  const parityReferenceDatabase = jsonObject(report.parityReferenceDatabase, `${path}: parityReferenceDatabase`);
  const validation = jsonObject(report.validation, `${path}: validation`);
  return {
    schemaVersion: jsonNumber(report.schemaVersion, `${path}: schemaVersion`),
    status: jsonString(report.status, `${path}: status`),
    configuration: {
      calendarQueryStrategy: jsonString(
        configuration.calendarQueryStrategy,
        `${path}: configuration.calendarQueryStrategy`,
      ),
      sparseCoalescingGapDays: jsonNumber(
        configuration.sparseCoalescingGapDays,
        `${path}: configuration.sparseCoalescingGapDays`,
      ),
      requestedPhotoScanStrategy: jsonNullableStrategy(
        configuration.requestedPhotoScanStrategy,
        `${path}: configuration.requestedPhotoScanStrategy`,
      ),
      expectedPhotoScanImplementation: jsonNullableString(
        configuration.expectedPhotoScanImplementation,
        `${path}: configuration.expectedPhotoScanImplementation`,
      ),
    },
    fixture: parseFixture(report.fixture, `${path}: fixture`),
    timing: {
      wallSeconds: jsonNumber(timing.wallSeconds, `${path}: timing.wallSeconds`),
      triggerEpochSeconds: jsonNumber(timing.triggerEpochSeconds, `${path}: timing.triggerEpochSeconds`),
    },
    maxRssKiB: jsonNumber(report.maxRssKiB, `${path}: maxRssKiB`),
    runtimeAttestation: {
      runId: jsonString(runtimeAttestation.runId, `${path}: runtimeAttestation.runId`),
      expectedPhotoScanImplementation: jsonString(
        runtimeAttestation.expectedPhotoScanImplementation,
        `${path}: runtimeAttestation.expectedPhotoScanImplementation`,
      ),
      photoScan: {
        schemaVersion: jsonNumber(photoScan.schemaVersion, `${path}: runtimeAttestation.photoScan.schemaVersion`),
        runId: jsonString(photoScan.runId, `${path}: runtimeAttestation.photoScan.runId`),
        selectedScanKind: jsonStrategy(
          photoScan.selectedScanKind,
          `${path}: runtimeAttestation.photoScan.selectedScanKind`,
        ),
        selectedScanImplementation: jsonString(
          photoScan.selectedScanImplementation,
          `${path}: runtimeAttestation.photoScan.selectedScanImplementation`,
        ),
        resolvedPhotoScanStrategy: jsonStrategy(
          photoScan.resolvedPhotoScanStrategy,
          `${path}: runtimeAttestation.photoScan.resolvedPhotoScanStrategy`,
        ),
        libraryTotalCount: jsonNumber(
          photoScan.libraryTotalCount,
          `${path}: runtimeAttestation.photoScan.libraryTotalCount`,
        ),
        unknownVisibleCount: jsonNumber(
          photoScan.unknownVisibleCount,
          `${path}: runtimeAttestation.photoScan.unknownVisibleCount`,
        ),
        excludedVisibleCount: jsonNumber(
          photoScan.excludedVisibleCount,
          `${path}: runtimeAttestation.photoScan.excludedVisibleCount`,
        ),
        observedAtEpochSeconds: jsonNumber(
          photoScan.observedAtEpochSeconds,
          `${path}: runtimeAttestation.photoScan.observedAtEpochSeconds`,
        ),
      },
    },
    buildAttestation: {
      suppliedExecutableSha256: jsonString(
        buildAttestation.suppliedExecutableSha256,
        `${path}: buildAttestation.suppliedExecutableSha256`,
      ),
      suppliedMainBundleSha256: jsonString(
        buildAttestation.suppliedMainBundleSha256,
        `${path}: buildAttestation.suppliedMainBundleSha256`,
      ),
      exactExecutableMatch: jsonBoolean(
        buildAttestation.exactExecutableMatch,
        `${path}: buildAttestation.exactExecutableMatch`,
      ),
      exactMainBundleMatch: jsonBoolean(
        buildAttestation.exactMainBundleMatch,
        `${path}: buildAttestation.exactMainBundleMatch`,
      ),
      strictCodeSignatureVerified: jsonBoolean(
        buildAttestation.strictCodeSignatureVerified,
        `${path}: buildAttestation.strictCodeSignatureVerified`,
      ),
    },
    triggerBoundary: {
      preparedLogicalDigest: jsonString(
        triggerBoundary.preparedLogicalDigest,
        `${path}: triggerBoundary.preparedLogicalDigest`,
      ),
      pretriggerLogicalDigest: jsonString(
        triggerBoundary.pretriggerLogicalDigest,
        `${path}: triggerBoundary.pretriggerLogicalDigest`,
      ),
      unchangedBeforeTrigger: jsonBoolean(
        triggerBoundary.unchangedBeforeTrigger,
        `${path}: triggerBoundary.unchangedBeforeTrigger`,
      ),
    },
    liveOriginalDatabase: {
      sha256: jsonString(liveOriginalDatabase.sha256, `${path}: liveOriginalDatabase.sha256`),
      preparedStandaloneSnapshotSha256: jsonString(
        liveOriginalDatabase.preparedStandaloneSnapshotSha256,
        `${path}: liveOriginalDatabase.preparedStandaloneSnapshotSha256`,
      ),
    },
    parityReferenceDatabase: {
      sha256: jsonString(parityReferenceDatabase.sha256, `${path}: parityReferenceDatabase.sha256`),
    },
    validation: {
      exactVisitParityExcludingUpdatedAt: jsonBoolean(
        validation.exactVisitParityExcludingUpdatedAt,
        `${path}: validation.exactVisitParityExcludingUpdatedAt`,
      ),
      exactPhotoParity: jsonBoolean(validation.exactPhotoParity, `${path}: validation.exactPhotoParity`),
      exactVisitSuggestedRestaurantParity: jsonBoolean(
        validation.exactVisitSuggestedRestaurantParity,
        `${path}: validation.exactVisitSuggestedRestaurantParity`,
      ),
      exactAppMetadataParity: jsonBoolean(
        validation.exactAppMetadataParity,
        `${path}: validation.exactAppMetadataParity`,
      ),
      integrity: jsonString(validation.integrity, `${path}: validation.integrity`),
      foreignKeyViolationCount: jsonNumber(
        validation.foreignKeyViolationCount,
        `${path}: validation.foreignKeyViolationCount`,
      ),
    },
    restoration: parseRestoration(report.restoration, `${path}: restoration`),
  };
}

function usage(): string {
  return `Usage: summarize-macos-photo-scan-ab.ts --legacy=REPORT[,REPORT...] --incremental=REPORT[,REPORT...] --output=PATH`;
}

function parsePaths(value: string, option: string): string[] {
  const paths = value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(path));
  if (paths.length === 0) {
    throw new Error(`${option} requires at least one report path`);
  }
  return paths;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let legacyPaths: string[] = [];
  let incrementalPaths: string[] = [];
  let outputPath = "";
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
        legacyPaths = parsePaths(value, option);
        break;
      case "--incremental":
        incrementalPaths = parsePaths(value, option);
        break;
      case "--output":
        if (!value) {
          throw new Error("--output cannot be empty");
        }
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  if (legacyPaths.length === 0 || incrementalPaths.length === 0 || !outputPath) {
    throw new Error(usage());
  }
  return { legacyPaths, incrementalPaths, outputPath };
}

function finiteNonnegative(value: number, label: string): void {
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
}

function finitePositive(value: number, label: string): void {
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be finite and positive`);
}

function nonemptyString(value: string | null, label: string): asserts value is string {
  assert.ok(value !== null && value.trim().length > 0, `${label} must be a nonempty string`);
}

function validateSha256(value: string, label: string): void {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}$/i, `${label} must be a SHA-256 digest`);
}

function validateLogicalDigest(value: string, label: string): void {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}(?::[0-9a-f]{64}){3}$/i, `${label} must contain the four logical SHA-256 digests`);
}

function normalizedRestorationIdentity(report: RunReport): string | undefined {
  if (report.schemaVersion !== 6) {
    return undefined;
  }
  const restoration = report.restoration;
  assert.ok(restoration, "Schema 6 reports must include restoration details");
  const normalize = (component: RestorationComponent) => ({
    present: component.present === true || component.present === 1,
    sha256: component.sha256,
    mode: component.mode,
  });
  return JSON.stringify({
    originalMain: normalize(restoration.originalMain),
    originalWal: normalize(restoration.originalWal),
    originalShm: normalize(restoration.originalShm),
    originalJournal: normalize(restoration.originalJournal),
    restoredMainSha256: restoration.restoredMainSha256,
  });
}

function validateRestorationComponent(component: RestorationComponent, label: string): boolean {
  assert.ok(
    component.present === true || component.present === false || component.present === 1 || component.present === 0,
    `${label}.present must be boolean-like`,
  );
  const present = component.present === true || component.present === 1;
  if (present) {
    validateSha256(component.sha256, `${label}.sha256`);
    assert.match(component.mode, /^[0-7]{3,4}$/, `${label}.mode must be an octal file mode`);
  } else {
    assert.equal(component.sha256, "", `${label}.sha256 must be empty when absent`);
    assert.equal(component.mode, "", `${label}.mode must be empty when absent`);
  }
  return present;
}

function validateFixture(fixture: Record<string, number>, path: string): void {
  assert.ok(Object.keys(fixture).length > 0, `${path}: fixture must not be empty`);
  for (const [name, value] of Object.entries(fixture)) {
    assert.ok(Number.isInteger(value) && value >= 0, `${path}: fixture.${name} must be a nonnegative integer`);
  }
}

function loadAndValidate(path: string, strategy: Strategy): LoadedRun {
  const report = parseRunReport(parseJsonValue(readFileSync(path, "utf8")), path);
  assert.ok(report.schemaVersion === 5 || report.schemaVersion === 6, `${path}: report schema must be 5 or 6`);
  if (report.schemaVersion === 6) {
    const restoration = report.restoration;
    assert.ok(restoration, `${path}: exact database restoration`);
    assert.equal(restoration.exactMainAndSidecarSetRestored, true, `${path}: exact database restoration`);
    assert.equal(
      validateRestorationComponent(restoration.originalMain, `${path}: restoration.originalMain`),
      true,
      `${path}: original main database must be present`,
    );
    validateRestorationComponent(restoration.originalWal, `${path}: restoration.originalWal`);
    validateRestorationComponent(restoration.originalShm, `${path}: restoration.originalShm`);
    validateRestorationComponent(restoration.originalJournal, `${path}: restoration.originalJournal`);
    validateSha256(restoration.restoredMainSha256, `${path}: restored main SHA-256`);
    assert.equal(restoration.restoredMainSha256, restoration.originalMain.sha256, `${path}: restored main identity`);
  }
  assert.equal(report.status, "ok", `${path}: status`);
  nonemptyString(report.configuration.calendarQueryStrategy, `${path}: Calendar query strategy`);
  assert.ok(
    Number.isFinite(report.configuration.sparseCoalescingGapDays) &&
      report.configuration.sparseCoalescingGapDays >= 0 &&
      report.configuration.sparseCoalescingGapDays <= 365,
    `${path}: sparse coalescing gap`,
  );
  assert.equal(report.configuration.requestedPhotoScanStrategy, strategy, `${path}: requested strategy`);
  nonemptyString(report.runtimeAttestation.runId, `${path}: runtime run ID`);
  nonemptyString(report.configuration.expectedPhotoScanImplementation, `${path}: expected scan implementation`);
  nonemptyString(
    report.runtimeAttestation.expectedPhotoScanImplementation,
    `${path}: runtime expected scan implementation`,
  );
  assert.equal(
    report.runtimeAttestation.expectedPhotoScanImplementation,
    report.configuration.expectedPhotoScanImplementation,
    `${path}: runtime expected scan implementation`,
  );
  assert.equal(report.runtimeAttestation.photoScan.schemaVersion, 2, `${path}: photo attestation schema`);
  assert.equal(report.runtimeAttestation.photoScan.runId, report.runtimeAttestation.runId, `${path}: photo run ID`);
  assert.equal(report.runtimeAttestation.photoScan.selectedScanKind, strategy, `${path}: selected scan kind`);
  nonemptyString(
    report.runtimeAttestation.photoScan.selectedScanImplementation,
    `${path}: selected scan implementation`,
  );
  assert.equal(
    report.runtimeAttestation.photoScan.selectedScanImplementation,
    report.configuration.expectedPhotoScanImplementation,
    `${path}: selected scan implementation`,
  );
  assert.equal(
    report.runtimeAttestation.photoScan.resolvedPhotoScanStrategy,
    strategy,
    `${path}: resolved scan strategy`,
  );
  const photoScan = report.runtimeAttestation.photoScan;
  assert.ok(
    Number.isInteger(photoScan.libraryTotalCount) && photoScan.libraryTotalCount >= 0,
    `${path}: PhotoKit count`,
  );
  assert.ok(
    Number.isInteger(photoScan.unknownVisibleCount) && photoScan.unknownVisibleCount >= 0,
    `${path}: unknown PhotoKit count`,
  );
  assert.ok(
    Number.isInteger(photoScan.excludedVisibleCount) && photoScan.excludedVisibleCount >= 0,
    `${path}: excluded PhotoKit count`,
  );
  assert.equal(
    photoScan.unknownVisibleCount + photoScan.excludedVisibleCount,
    photoScan.libraryTotalCount,
    `${path}: balanced PhotoKit counters`,
  );
  assert.ok(
    Number.isFinite(report.timing.wallSeconds) && report.timing.wallSeconds > 0,
    `${path}: positive wall seconds`,
  );
  finitePositive(report.maxRssKiB, `${path}: max RSS`);
  finiteNonnegative(report.timing.triggerEpochSeconds, `${path}: trigger epoch`);
  finiteNonnegative(photoScan.observedAtEpochSeconds, `${path}: photo attestation epoch`);
  assert.ok(photoScan.observedAtEpochSeconds >= report.timing.triggerEpochSeconds, `${path}: attestation timing`);
  validateFixture(report.fixture, path);
  validateSha256(report.buildAttestation.suppliedExecutableSha256, `${path}: supplied executable SHA-256`);
  validateSha256(report.buildAttestation.suppliedMainBundleSha256, `${path}: supplied bundle SHA-256`);
  assert.equal(report.buildAttestation.strictCodeSignatureVerified, true, `${path}: code signature`);
  assert.equal(report.buildAttestation.exactExecutableMatch, true, `${path}: executable identity`);
  assert.equal(report.buildAttestation.exactMainBundleMatch, true, `${path}: bundle identity`);
  validateLogicalDigest(report.triggerBoundary.preparedLogicalDigest, `${path}: prepared logical digest`);
  validateLogicalDigest(report.triggerBoundary.pretriggerLogicalDigest, `${path}: pretrigger logical digest`);
  assert.equal(report.triggerBoundary.unchangedBeforeTrigger, true, `${path}: trigger boundary`);
  assert.equal(
    report.triggerBoundary.pretriggerLogicalDigest,
    report.triggerBoundary.preparedLogicalDigest,
    `${path}: unchanged trigger digest`,
  );
  validateSha256(report.liveOriginalDatabase.sha256, `${path}: live original database SHA-256`);
  validateSha256(
    report.liveOriginalDatabase.preparedStandaloneSnapshotSha256,
    `${path}: prepared standalone snapshot SHA-256`,
  );
  assert.equal(
    report.liveOriginalDatabase.preparedStandaloneSnapshotSha256,
    report.liveOriginalDatabase.sha256,
    `${path}: prepared standalone snapshot identity`,
  );
  validateSha256(report.parityReferenceDatabase.sha256, `${path}: parity reference SHA-256`);
  assert.equal(report.validation.exactVisitParityExcludingUpdatedAt, true, `${path}: visit parity`);
  assert.equal(report.validation.exactPhotoParity, true, `${path}: photo parity`);
  assert.equal(report.validation.exactVisitSuggestedRestaurantParity, true, `${path}: suggestion parity`);
  assert.equal(report.validation.exactAppMetadataParity, true, `${path}: metadata parity`);
  assert.equal(report.validation.integrity, "ok", `${path}: SQLite integrity`);
  assert.equal(report.validation.foreignKeyViolationCount, 0, `${path}: foreign keys`);
  return {
    path,
    report,
    runId: report.runtimeAttestation.runId,
    scanImplementation: report.runtimeAttestation.photoScan.selectedScanImplementation,
  };
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function assertUniqueResolvedPaths(configuration: Configuration): void {
  const firstStrategyByPath = new Map<string, Strategy>();
  for (const [strategy, paths] of [
    ["legacy", configuration.legacyPaths],
    ["incremental", configuration.incrementalPaths],
  ] as const) {
    for (const path of paths) {
      const firstStrategy = firstStrategyByPath.get(path);
      assert.equal(
        firstStrategy,
        undefined,
        `Duplicate resolved report path: ${path} (${firstStrategy ?? strategy} and ${strategy})`,
      );
      firstStrategyByPath.set(path, strategy);
    }
  }
}

function validateSharedInputIdentity(runs: readonly LoadedRun[]): void {
  assert.ok(runs.length > 0, "At least one A/B report is required");
  const baseline = runs[0]!;
  const seenRunIds = new Map<string, string>();
  let schema6RestorationIdentity: string | undefined;
  for (const run of runs) {
    const duplicatePath = seenRunIds.get(run.runId);
    assert.equal(
      duplicatePath,
      undefined,
      `${run.path}: duplicate runtime run ID '${run.runId}' (already used by ${duplicatePath ?? run.path})`,
    );
    seenRunIds.set(run.runId, run.path);
    assert.deepEqual(run.report.fixture, baseline.report.fixture, `${run.path}: A/B fixture mismatch`);
    assert.equal(
      run.report.buildAttestation.suppliedExecutableSha256,
      baseline.report.buildAttestation.suppliedExecutableSha256,
      `${run.path}: A/B executable mismatch`,
    );
    assert.equal(
      run.report.buildAttestation.suppliedMainBundleSha256,
      baseline.report.buildAttestation.suppliedMainBundleSha256,
      `${run.path}: A/B JS bundle mismatch`,
    );
    assert.equal(
      run.report.runtimeAttestation.photoScan.libraryTotalCount,
      baseline.report.runtimeAttestation.photoScan.libraryTotalCount,
      `${run.path}: A/B PhotoKit count mismatch`,
    );
    assert.equal(
      run.report.configuration.calendarQueryStrategy,
      baseline.report.configuration.calendarQueryStrategy,
      `${run.path}: A/B Calendar query strategy mismatch`,
    );
    assert.equal(
      run.report.configuration.sparseCoalescingGapDays,
      baseline.report.configuration.sparseCoalescingGapDays,
      `${run.path}: A/B Calendar query gap mismatch`,
    );
    assert.equal(
      run.report.triggerBoundary.preparedLogicalDigest,
      baseline.report.triggerBoundary.preparedLogicalDigest,
      `${run.path}: A/B prepared logical digest mismatch`,
    );
    assert.equal(
      run.report.liveOriginalDatabase.sha256,
      baseline.report.liveOriginalDatabase.sha256,
      `${run.path}: A/B live original database mismatch`,
    );
    assert.equal(
      run.report.liveOriginalDatabase.preparedStandaloneSnapshotSha256,
      baseline.report.liveOriginalDatabase.preparedStandaloneSnapshotSha256,
      `${run.path}: A/B prepared snapshot mismatch`,
    );
    assert.equal(
      run.report.parityReferenceDatabase.sha256,
      baseline.report.parityReferenceDatabase.sha256,
      `${run.path}: A/B parity reference mismatch`,
    );
    const restorationIdentity = normalizedRestorationIdentity(run.report);
    if (restorationIdentity !== undefined) {
      schema6RestorationIdentity ??= restorationIdentity;
      assert.equal(
        restorationIdentity,
        schema6RestorationIdentity,
        `${run.path}: A/B restored original file-set mismatch`,
      );
    }
  }
}

function validatePerStrategyWorkload(runs: readonly LoadedRun[], strategy: Strategy): void {
  assert.ok(runs.length >= 2, `${strategy}: at least two measured reports are required`);
  const baselinePhotoScan = runs[0]!.report.runtimeAttestation.photoScan;
  for (const run of runs) {
    const photoScan = run.report.runtimeAttestation.photoScan;
    assert.equal(
      photoScan.unknownVisibleCount,
      baselinePhotoScan.unknownVisibleCount,
      `${run.path}: ${strategy} unknown-visible workload mismatch`,
    );
    assert.equal(
      photoScan.excludedVisibleCount,
      baselinePhotoScan.excludedVisibleCount,
      `${run.path}: ${strategy} excluded-visible workload mismatch`,
    );
  }
}

function summarize(runs: readonly LoadedRun[]) {
  assert.ok(runs.length > 0);
  const scanImplementation = runs[0]!.scanImplementation;
  for (const run of runs) {
    assert.equal(
      run.scanImplementation,
      scanImplementation,
      `${run.path}: scan implementation differs within strategy`,
    );
  }
  const reports = runs.map((run) => run.report);
  const scanPreparationCompleteSeconds = reports.map(
    (report) => report.runtimeAttestation.photoScan.observedAtEpochSeconds - report.timing.triggerEpochSeconds,
  );
  return {
    reports: runs.map((run) => basename(run.path)),
    runIds: runs.map((run) => run.runId),
    sampleCount: runs.length,
    wallSeconds: reports.map((report) => report.timing.wallSeconds),
    medianWallSeconds: median(reports.map((report) => report.timing.wallSeconds)),
    maxRssKiB: reports.map((report) => report.maxRssKiB),
    medianMaxRssKiB: median(reports.map((report) => report.maxRssKiB)),
    scanPreparationCompleteSeconds,
    medianScanPreparationCompleteSeconds: median(scanPreparationCompleteSeconds),
    fixture: reports[0]!.fixture,
    executableSha256: reports[0]!.buildAttestation.suppliedExecutableSha256,
    mainBundleSha256: reports[0]!.buildAttestation.suppliedMainBundleSha256,
    libraryTotalCount: reports[0]!.runtimeAttestation.photoScan.libraryTotalCount,
    scanImplementation,
  };
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }
  assert.ok(configuration.legacyPaths.length >= 2, "legacy: at least two measured reports are required");
  assert.equal(
    configuration.incrementalPaths.length,
    configuration.legacyPaths.length,
    "A/B report groups must have equal sample counts",
  );
  assertUniqueResolvedPaths(configuration);
  const legacyRuns = configuration.legacyPaths.map((path) => loadAndValidate(path, "legacy"));
  const incrementalRuns = configuration.incrementalPaths.map((path) => loadAndValidate(path, "incremental"));
  validateSharedInputIdentity([...legacyRuns, ...incrementalRuns]);
  validatePerStrategyWorkload(legacyRuns, "legacy");
  validatePerStrategyWorkload(incrementalRuns, "incremental");
  const legacy = summarize(legacyRuns);
  const incremental = summarize(incrementalRuns);

  const medianWallSpeedupPercent =
    ((legacy.medianWallSeconds - incremental.medianWallSeconds) / legacy.medianWallSeconds) * 100;
  const report = {
    schemaVersion: 3,
    status: "ok",
    validation: {
      everyRunExactParity: true,
      everyRunStrictlySignedAndBinaryMatched: true,
      everyRunTriggerBoundaryUnchanged: true,
      everyRunSchemaV2ImplementationAttested: true,
      everySchema6RunExactRestorationAttested: true,
      uniqueReportPathsAndRunIds: true,
      balancedMultiSampleGroups: true,
      identicalLogicalDatabaseCalendarConfigurationBuildAndPhotoKitCountAcrossInputs: true,
      identicalKnownUnknownWorkloadWithinEachStrategy: true,
    },
    inputIdentity: {
      calendarQueryStrategy: legacyRuns[0]!.report.configuration.calendarQueryStrategy,
      sparseCoalescingGapDays: legacyRuns[0]!.report.configuration.sparseCoalescingGapDays,
      preparedLogicalDigest: legacyRuns[0]!.report.triggerBoundary.preparedLogicalDigest,
      liveOriginalDatabaseSha256: legacyRuns[0]!.report.liveOriginalDatabase.sha256,
      parityReferenceDatabaseSha256: legacyRuns[0]!.report.parityReferenceDatabase.sha256,
      photoKitTotalCount: legacyRuns[0]!.report.runtimeAttestation.photoScan.libraryTotalCount,
    },
    legacy,
    incremental,
    comparison: {
      interpretation: "descriptive-sample-summary",
      medianWallSpeedupPercent,
      medianWallSecondsSaved: legacy.medianWallSeconds - incremental.medianWallSeconds,
      medianMaxRssDeltaKiB: incremental.medianMaxRssKiB - legacy.medianMaxRssKiB,
      medianScanPreparationCompleteSecondsDelta:
        incremental.medianScanPreparationCompleteSeconds - legacy.medianScanPreparationCompleteSeconds,
    },
    limitations: [
      "PhotoKit library identity is attested by total count and per-strategy known/unknown counts, not an ordered asset-identifier digest.",
      "The manually triggered timing includes PhotoKit/grouping work through durable Calendar restoration and is not isolated PhotoKit latency.",
    ],
  };
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Photo scan A/B descriptive sample: ${medianWallSpeedupPercent.toFixed(2)}% median wall speedup estimate; report=${configuration.outputPath}`,
  );
}

main();
