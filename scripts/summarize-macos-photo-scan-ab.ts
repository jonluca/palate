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

function nonemptyString(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && value.trim().length > 0, `${label} must be a nonempty string`);
}

function validateSha256(value: unknown, label: string): asserts value is string {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}$/i, `${label} must be a SHA-256 digest`);
}

function validateLogicalDigest(value: unknown, label: string): asserts value is string {
  nonemptyString(value, label);
  assert.match(value, /^[0-9a-f]{64}(?::[0-9a-f]{64}){3}$/i, `${label} must contain the four logical SHA-256 digests`);
}

function normalizedRestorationIdentity(report: RunReport): string | undefined {
  if (report.schemaVersion !== 6) {
    return undefined;
  }
  const restoration = report.restoration!;
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
  assert.ok(component && typeof component === "object", `${label} must be an object`);
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
  assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture), `${path}: fixture object`);
  assert.ok(Object.keys(fixture).length > 0, `${path}: fixture must not be empty`);
  for (const [name, value] of Object.entries(fixture)) {
    assert.ok(Number.isInteger(value) && value >= 0, `${path}: fixture.${name} must be a nonnegative integer`);
  }
}

function loadAndValidate(path: string, strategy: Strategy): LoadedRun {
  const report = JSON.parse(readFileSync(path, "utf8")) as RunReport;
  assert.ok(report.schemaVersion === 5 || report.schemaVersion === 6, `${path}: report schema must be 5 or 6`);
  if (report.schemaVersion === 6) {
    assert.equal(report.restoration?.exactMainAndSidecarSetRestored, true, `${path}: exact database restoration`);
    assert.equal(
      typeof report.restoration?.sensitiveDatabaseCopiesRetained,
      "boolean",
      `${path}: sensitive database copy retention attestation`,
    );
    assert.equal(
      validateRestorationComponent(report.restoration!.originalMain, `${path}: restoration.originalMain`),
      true,
      `${path}: original main database must be present`,
    );
    validateRestorationComponent(report.restoration!.originalWal, `${path}: restoration.originalWal`);
    validateRestorationComponent(report.restoration!.originalShm, `${path}: restoration.originalShm`);
    validateRestorationComponent(report.restoration!.originalJournal, `${path}: restoration.originalJournal`);
    validateSha256(report.restoration!.restoredMainSha256, `${path}: restored main SHA-256`);
    assert.equal(
      report.restoration!.restoredMainSha256,
      report.restoration!.originalMain.sha256,
      `${path}: restored main identity`,
    );
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
