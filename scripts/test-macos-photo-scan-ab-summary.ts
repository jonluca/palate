#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Strategy = "legacy" | "incremental";

interface TestReport {
  schemaVersion: number;
  status: string;
  configuration: {
    calendarQueryStrategy: string;
    sparseCoalescingGapDays: number;
    requestedPhotoScanStrategy: Strategy;
    expectedPhotoScanImplementation: string;
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
    originalMain: { present: boolean | number; sha256: string; mode: string };
    originalWal: { present: boolean | number; sha256: string; mode: string };
    originalShm: { present: boolean | number; sha256: string; mode: string };
    originalJournal: { present: boolean | number; sha256: string; mode: string };
    restoredMainSha256: string;
  };
}

interface FixtureSet {
  reports: {
    legacyA: TestReport;
    legacyB: TestReport;
    incrementalA: TestReport;
    incrementalB: TestReport;
  };
  paths: {
    legacy: string[];
    incremental: string[];
    output: string;
  };
}

interface SuccessSummary {
  schemaVersion: number;
  status: string;
  validation: Record<string, boolean>;
  legacy: {
    sampleCount: number;
    runIds: string[];
    scanImplementation: string;
    scanPreparationCompleteSeconds: number[];
    medianScanPreparationCompleteSeconds: number;
    scanBeginSeconds?: number[];
  };
  incremental: {
    sampleCount: number;
    runIds: string[];
    scanImplementation: string;
    scanPreparationCompleteSeconds: number[];
    medianScanPreparationCompleteSeconds: number;
  };
  comparison: {
    interpretation: string;
    medianScanPreparationCompleteSecondsDelta: number;
    medianScanBeginSecondsDelta?: number;
  };
}

const summarizerPath = fileURLToPath(new URL("./summarize-macos-photo-scan-ab.ts", import.meta.url));
const repositoryRoot = dirname(dirname(summarizerPath));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-photo-ab-summary-"));
const executableSha256 = "a".repeat(64);
const mainBundleSha256 = "b".repeat(64);
const databaseSha256 = "c".repeat(64);
const walSha256 = "d".repeat(64);
const shmSha256 = "e".repeat(64);
const logicalDigest = ["1", "2", "3", "4"].map((character) => character.repeat(64)).join(":");

function makeReport(
  strategy: Strategy,
  implementation: string,
  runId: string,
  wallSeconds: number,
  preparationCompleteSeconds: number,
): TestReport {
  const libraryTotalCount = 100;
  return {
    schemaVersion: 5,
    status: "ok",
    configuration: {
      calendarQueryStrategy: "broad",
      sparseCoalescingGapDays: 7,
      requestedPhotoScanStrategy: strategy,
      expectedPhotoScanImplementation: implementation,
    },
    fixture: { visits: 12, photos: libraryTotalCount, appMetadata: 2 },
    timing: { wallSeconds, triggerEpochSeconds: 1_000 },
    maxRssKiB: strategy === "legacy" ? 500_000 : 450_000,
    runtimeAttestation: {
      runId,
      expectedPhotoScanImplementation: implementation,
      photoScan: {
        schemaVersion: 2,
        runId,
        selectedScanKind: strategy,
        selectedScanImplementation: implementation,
        resolvedPhotoScanStrategy: strategy,
        libraryTotalCount,
        unknownVisibleCount: strategy === "legacy" ? libraryTotalCount : 0,
        excludedVisibleCount: strategy === "legacy" ? 0 : libraryTotalCount,
        observedAtEpochSeconds: 1_000 + preparationCompleteSeconds,
      },
    },
    buildAttestation: {
      suppliedExecutableSha256: executableSha256,
      suppliedMainBundleSha256: mainBundleSha256,
      exactExecutableMatch: true,
      exactMainBundleMatch: true,
      strictCodeSignatureVerified: true,
    },
    triggerBoundary: {
      preparedLogicalDigest: logicalDigest,
      pretriggerLogicalDigest: logicalDigest,
      unchangedBeforeTrigger: true,
    },
    liveOriginalDatabase: {
      sha256: databaseSha256,
      preparedStandaloneSnapshotSha256: databaseSha256,
    },
    parityReferenceDatabase: { sha256: databaseSha256 },
    validation: {
      exactVisitParityExcludingUpdatedAt: true,
      exactPhotoParity: true,
      exactVisitSuggestedRestaurantParity: true,
      exactAppMetadataParity: true,
      integrity: "ok",
      foreignKeyViolationCount: 0,
    },
  };
}

function createFixtureSet(caseName: string): FixtureSet {
  const directory = join(temporaryDirectory, caseName);
  mkdirSync(directory, { recursive: true });
  return {
    reports: {
      legacyA: makeReport("legacy", "legacy", `${caseName}-legacy-a`, 20, 4),
      legacyB: makeReport("legacy", "legacy", `${caseName}-legacy-b`, 24, 6),
      incrementalA: makeReport("incremental", "database-backed", `${caseName}-incremental-a`, 16, 2),
      incrementalB: makeReport("incremental", "database-backed", `${caseName}-incremental-b`, 18, 4),
    },
    paths: {
      legacy: [join(directory, "legacy-a.json"), join(directory, "legacy-b.json")],
      incremental: [join(directory, "incremental-a.json"), join(directory, "incremental-b.json")],
      output: join(directory, "summary.json"),
    },
  };
}

function writeFixtureSet(fixtureSet: FixtureSet): void {
  const reports = [
    fixtureSet.reports.legacyA,
    fixtureSet.reports.legacyB,
    fixtureSet.reports.incrementalA,
    fixtureSet.reports.incrementalB,
  ];
  const paths = [...fixtureSet.paths.legacy, ...fixtureSet.paths.incremental];
  for (let index = 0; index < paths.length; index += 1) {
    writeFileSync(paths[index]!, `${JSON.stringify(reports[index], null, 2)}\n`);
  }
}

function attestSchema6Restoration(report: TestReport): void {
  report.schemaVersion = 6;
  report.restoration = {
    exactMainAndSidecarSetRestored: true,
    sensitiveDatabaseCopiesRetained: false,
    originalMain: { present: true, sha256: databaseSha256, mode: "644" },
    originalWal: { present: 1, sha256: walSha256, mode: "644" },
    originalShm: { present: 1, sha256: shmSha256, mode: "644" },
    originalJournal: { present: 0, sha256: "", mode: "" },
    restoredMainSha256: databaseSha256,
  };
}

function execute(fixtureSet: FixtureSet): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      summarizerPath,
      `--legacy=${fixtureSet.paths.legacy.join(",")}`,
      `--incremental=${fixtureSet.paths.incremental.join(",")}`,
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
}

function expectPathShapeFailure(
  caseName: string,
  mutate: (fixtureSet: FixtureSet) => void,
  expectedMessage: string,
): void {
  const fixtureSet = createFixtureSet(caseName);
  writeFixtureSet(fixtureSet);
  mutate(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(result.stderr, new RegExp(expectedMessage), `${caseName} failure message`);
}

try {
  const success = createFixtureSet("success");
  writeFixtureSet(success);
  const successResult = execute(success);
  assert.equal(successResult.status, 0, successResult.stderr);
  const summary = JSON.parse(readFileSync(success.paths.output, "utf8")) as SuccessSummary;
  assert.equal(summary.schemaVersion, 3);
  assert.equal(summary.status, "ok");
  assert.equal(summary.legacy.sampleCount, 2);
  assert.equal(summary.incremental.sampleCount, 2);
  assert.deepEqual(summary.legacy.runIds, ["success-legacy-a", "success-legacy-b"]);
  assert.deepEqual(summary.incremental.runIds, ["success-incremental-a", "success-incremental-b"]);
  assert.equal(summary.legacy.scanImplementation, "legacy");
  assert.equal(summary.incremental.scanImplementation, "database-backed");
  assert.deepEqual(summary.legacy.scanPreparationCompleteSeconds, [4, 6]);
  assert.deepEqual(summary.incremental.scanPreparationCompleteSeconds, [2, 4]);
  assert.equal(summary.legacy.medianScanPreparationCompleteSeconds, 5);
  assert.equal(summary.incremental.medianScanPreparationCompleteSeconds, 3);
  assert.equal(summary.comparison.medianScanPreparationCompleteSecondsDelta, -2);
  assert.equal(summary.comparison.interpretation, "descriptive-sample-summary");
  assert.equal(summary.legacy.scanBeginSeconds, undefined);
  assert.equal(summary.comparison.medianScanBeginSecondsDelta, undefined);
  assert.equal(summary.validation.stableFixtureAndPhotoKitCount, undefined);
  assert.equal(summary.validation.identicalFixtureBuildAndPhotoKitCountAcrossInputs, undefined);
  assert.equal(summary.validation.balancedMultiSampleGroups, true);
  assert.equal(summary.validation.identicalLogicalDatabaseCalendarConfigurationBuildAndPhotoKitCountAcrossInputs, true);
  assert.equal(summary.validation.identicalKnownUnknownWorkloadWithinEachStrategy, true);
  assert.equal(summary.validation.everyRunSchemaV2ImplementationAttested, true);
  assert.equal(summary.validation.everySchema6RunExactRestorationAttested, true);
  assert.equal(summary.validation.uniqueReportPathsAndRunIds, true);

  const schema6Success = createFixtureSet("schema6-success");
  for (const report of Object.values(schema6Success.reports)) {
    attestSchema6Restoration(report);
  }
  writeFixtureSet(schema6Success);
  const schema6SuccessResult = execute(schema6Success);
  assert.equal(schema6SuccessResult.status, 0, schema6SuccessResult.stderr);
  const schema6Summary = JSON.parse(readFileSync(schema6Success.paths.output, "utf8")) as SuccessSummary;
  assert.equal(schema6Summary.status, "ok");
  assert.equal(schema6Summary.validation.everySchema6RunExactRestorationAttested, true);

  expectFailure(
    "schema6-missing-restoration",
    ({ reports }) => {
      reports.incrementalB.schemaVersion = 6;
    },
    "exact database restoration",
  );
  expectFailure(
    "schema6-false-restoration",
    ({ reports }) => {
      attestSchema6Restoration(reports.incrementalB);
      reports.incrementalB.restoration!.exactMainAndSidecarSetRestored = false;
    },
    "exact database restoration",
  );
  expectFailure(
    "duplicate-path",
    (fixtureSet) => {
      fixtureSet.paths.incremental[1] = fixtureSet.paths.legacy[0]!;
    },
    "Duplicate resolved report path",
  );
  expectFailure(
    "duplicate-run-id",
    ({ reports }) => {
      reports.incrementalB.runtimeAttestation.runId = reports.legacyA.runtimeAttestation.runId;
      reports.incrementalB.runtimeAttestation.photoScan.runId = reports.legacyA.runtimeAttestation.runId;
    },
    "duplicate runtime run ID",
  );
  expectFailure(
    "fixture-mismatch",
    ({ reports }) => {
      reports.legacyB.fixture.photos += 1;
    },
    "A/B fixture mismatch",
  );
  expectFailure(
    "executable-mismatch",
    ({ reports }) => {
      reports.incrementalB.buildAttestation.suppliedExecutableSha256 = "c".repeat(64);
    },
    "A/B executable mismatch",
  );
  expectFailure(
    "bundle-mismatch",
    ({ reports }) => {
      reports.legacyB.buildAttestation.suppliedMainBundleSha256 = "c".repeat(64);
    },
    "A/B JS bundle mismatch",
  );
  expectFailure(
    "photokit-mismatch",
    ({ reports }) => {
      reports.incrementalB.runtimeAttestation.photoScan.libraryTotalCount += 1;
      reports.incrementalB.runtimeAttestation.photoScan.excludedVisibleCount += 1;
    },
    "A/B PhotoKit count mismatch",
  );
  expectPathShapeFailure(
    "single-sample-groups",
    ({ paths }) => {
      paths.legacy = paths.legacy.slice(0, 1);
      paths.incremental = paths.incremental.slice(0, 1);
    },
    "at least two measured reports",
  );
  expectPathShapeFailure(
    "unequal-sample-groups",
    ({ paths }) => {
      paths.incremental = paths.incremental.slice(0, 1);
    },
    "equal sample counts",
  );
  expectFailure(
    "calendar-strategy-mismatch",
    ({ reports }) => {
      reports.incrementalB.configuration.calendarQueryStrategy = "sparse";
    },
    "A/B Calendar query strategy mismatch",
  );
  expectFailure(
    "calendar-gap-mismatch",
    ({ reports }) => {
      reports.incrementalB.configuration.sparseCoalescingGapDays = 30;
    },
    "A/B Calendar query gap mismatch",
  );
  expectFailure(
    "logical-digest-mismatch",
    ({ reports }) => {
      reports.incrementalB.triggerBoundary.preparedLogicalDigest = ["1", "2", "3", "5"]
        .map((character) => character.repeat(64))
        .join(":");
      reports.incrementalB.triggerBoundary.pretriggerLogicalDigest =
        reports.incrementalB.triggerBoundary.preparedLogicalDigest;
    },
    "A/B prepared logical digest mismatch",
  );
  expectFailure(
    "live-original-mismatch",
    ({ reports }) => {
      reports.incrementalB.liveOriginalDatabase.sha256 = "f".repeat(64);
      reports.incrementalB.liveOriginalDatabase.preparedStandaloneSnapshotSha256 = "f".repeat(64);
    },
    "A/B live original database mismatch",
  );
  expectFailure(
    "parity-reference-mismatch",
    ({ reports }) => {
      reports.incrementalB.parityReferenceDatabase.sha256 = "f".repeat(64);
    },
    "A/B parity reference mismatch",
  );
  expectFailure(
    "incremental-known-unknown-mismatch",
    ({ reports }) => {
      reports.incrementalB.runtimeAttestation.photoScan.unknownVisibleCount = 1;
      reports.incrementalB.runtimeAttestation.photoScan.excludedVisibleCount = 99;
    },
    "incremental unknown-visible workload mismatch",
  );
  expectFailure(
    "zero-rss",
    ({ reports }) => {
      reports.incrementalB.maxRssKiB = 0;
    },
    "max RSS must be finite and positive",
  );
  expectFailure(
    "schema6-restored-file-set-mismatch",
    ({ reports }) => {
      for (const report of Object.values(reports)) {
        attestSchema6Restoration(report);
      }
      reports.incrementalB.restoration!.originalShm.sha256 = "f".repeat(64);
    },
    "A/B restored original file-set mismatch",
  );
  expectFailure(
    "old-photo-schema",
    ({ reports }) => {
      reports.incrementalB.runtimeAttestation.photoScan.schemaVersion = 1;
    },
    "photo attestation schema",
  );
  expectFailure(
    "empty-implementation",
    ({ reports }) => {
      reports.incrementalB.configuration.expectedPhotoScanImplementation = "";
      reports.incrementalB.runtimeAttestation.expectedPhotoScanImplementation = "";
      reports.incrementalB.runtimeAttestation.photoScan.selectedScanImplementation = "";
    },
    "expected scan implementation must be a nonempty string",
  );
  expectFailure(
    "implementation-mismatch",
    ({ reports }) => {
      reports.incrementalB.runtimeAttestation.photoScan.selectedScanImplementation = "identifier-list";
    },
    "selected scan implementation",
  );
  expectFailure(
    "nonuniform-implementation",
    ({ reports }) => {
      reports.incrementalB.configuration.expectedPhotoScanImplementation = "identifier-list";
      reports.incrementalB.runtimeAttestation.expectedPhotoScanImplementation = "identifier-list";
      reports.incrementalB.runtimeAttestation.photoScan.selectedScanImplementation = "identifier-list";
    },
    "scan implementation differs within strategy",
  );

  console.log(
    "macOS Photo scan A/B summary contract passed: balanced multi-sample groups, schema-5 compatibility, schema-6 file-set restoration, logical workload identity, uniqueness, and truthful timing fields.",
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
