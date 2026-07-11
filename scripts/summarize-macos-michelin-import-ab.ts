#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Strategy = "legacy-js-v1" | "attach-insert-select-v1";

interface Configuration {
  readonly attachPaths: readonly string[];
  readonly legacyPaths: readonly string[];
  readonly outputPath: string;
}

interface SourceComponent {
  readonly present: boolean;
  readonly sha256: string | null;
  readonly mode: string | null;
  readonly size: number | null;
}

interface ValidatorReport {
  readonly schemaVersion: 1;
  readonly status: "ok";
  readonly runId: string;
  readonly generatedAt: string;
  readonly strategy: Strategy;
  readonly signedBuild: {
    readonly appBundleName: string;
    readonly schemeRunConfiguration: string;
    readonly strictCodeSignatureVerified: boolean;
    readonly runningBundleMatched: boolean;
    readonly executableSha256: string;
    readonly mainJsBundleSha256: string;
    readonly bundledGuideSha256: string;
    readonly bundledGuideDatasetVersion: string;
  };
  readonly materializedSource: {
    readonly schemaVersion: 1;
    readonly regularUnaliasedFile: true;
    readonly byteIdenticalToSignedBundle: true;
    readonly sha256: string;
    readonly byteSize: number;
  };
  readonly sourceGuard: {
    readonly capturedBeforeSQLiteAccess: boolean;
    readonly sharedMutationLock: boolean;
    readonly durableStaleRecovery: boolean;
    readonly components: {
      readonly main: SourceComponent;
      readonly wal: SourceComponent;
      readonly shm: SourceComponent;
      readonly journal: SourceComponent;
    };
  };
  readonly fixture: {
    readonly installedDisposableCopyOnly: boolean;
    readonly validationRequestSchemaVersion: number;
    readonly staleDatasetMarkerPrimed: boolean;
    readonly previousAttestationRemoved: boolean;
    readonly requestExpirySeconds: number;
  };
  readonly runtimeAttestation: {
    readonly schemaVersion: number;
    readonly runIdMatched: boolean;
    readonly requestedStrategy: Strategy;
    readonly resolvedStrategy: Strategy;
    readonly selectedStrategy: Strategy;
    readonly fallbackReason: null;
    readonly datasetVersionMatched: boolean;
    readonly sourceRows: number;
    readonly importedRows: number;
    readonly observedAtEpochSeconds: number;
    readonly committedAtomicallyWithDatasetMarker: boolean;
  };
  readonly semanticParity: {
    readonly schemaVersion: 1;
    readonly status: "ok";
    readonly encoding: {
      readonly schema: "length-prefixed-v1";
      readonly stringEncoding: "utf8";
      readonly floatingPointEncoding: "ieee754-binary64-be";
      readonly integerEncoding: "signed-64-be";
      readonly rowOrder: "id-utf8-binary";
    };
    readonly counts: {
      readonly signedGuideSourceRows: number;
      readonly expectedActiveRows: number;
      readonly actualActiveRows: number;
    };
    readonly digests: {
      readonly expectedCanonicalRowsSha256: string;
      readonly actualCanonicalRowsSha256: string;
    };
    readonly mismatches: {
      readonly missingRows: 0;
      readonly unexpectedRows: 0;
      readonly contentRows: 0;
    };
    readonly correctness: {
      readonly exactLegacySemanticRows: true;
      readonly exactIdsAndAllPersistedFields: true;
      readonly exactFloat64CoordinateBits: true;
      readonly exactDatasetVersion: true;
    };
  };
  readonly timing: {
    readonly timestampedManualTrigger: boolean;
    readonly triggerEpochSeconds: number;
    readonly completionObservedEpochSeconds: number;
    readonly triggerToImportCommitSeconds: number;
    readonly initialRssKib: number;
    readonly maximumObservedRssKib: number;
  };
  readonly result: {
    readonly databaseSha256: string;
    readonly activeDatasetRows: number;
    readonly totalGuideRows: number;
    readonly integrityCheck: string;
    readonly foreignKeyViolationCount: number;
  };
  readonly restoration: {
    readonly exactMainWalShmJournalBytesAndModes: boolean;
    readonly rawPrivateArtifactsDeleted: boolean;
    readonly aggregateOnlyReport: boolean;
  };
}

interface LoadedRun {
  readonly path: string;
  readonly report: ValidatorReport;
  readonly reportSha256: string;
}

interface NumericSummary {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly samples: readonly number[];
}

const MAX_REPORT_BYTES = 1024 * 1024;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATASET_VERSION_PATTERN = /^[0-9a-f]{32}$/;
const MODE_PATTERN = /^[0-7]{3,4}$/;
function usage(): string {
  return `Usage: summarize-macos-michelin-import-ab.ts \\
  --legacy-js-v1=REPORT[,REPORT...] \\
  --attach-insert-select-v1=REPORT[,REPORT...] \\
  --output=PATH

Each strategy requires the same odd number of reports, with at least three per
strategy. Pair reports by list position and execute adjacent pairs in alternating
order (for three pairs: legacy/attach, attach/legacy, legacy/attach). Inputs must
be regular 0600 files created by the signed macOS Michelin import validator.`;
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
  let attachPaths: string[] = [];
  let outputPath = "";
  const seenOptions = new Set<string>();

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
    assert.ok(!seenOptions.has(option), `${option} may be specified only once`);
    seenOptions.add(option);
    switch (option) {
      case "--legacy-js-v1":
        legacyPaths = parsePaths(value, option);
        break;
      case "--attach-insert-select-v1":
        attachPaths = parsePaths(value, option);
        break;
      case "--output":
        assert.ok(value.length > 0, "--output cannot be empty");
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (legacyPaths.length === 0 || attachPaths.length === 0 || outputPath.length === 0) {
    throw new Error(usage());
  }
  assert.equal(attachPaths.length, legacyPaths.length, "A/B report groups must have equal sample counts");
  assert.ok(legacyPaths.length >= 3, "Each strategy requires at least three signed reports");
  assert.equal(legacyPaths.length % 2, 1, "Each strategy requires an odd sample count");
  return { legacyPaths, attachPaths, outputPath };
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  assert.deepEqual(Object.keys(record).sort(), [...expected].sort(), `${label} has an unexpected schema`);
}

function requireTrue(value: unknown, label: string): void {
  assert.equal(value, true, `${label} must be true`);
}

function requireSafeRunId(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && SAFE_RUN_ID_PATTERN.test(value), `${label} must be a safe run ID`);
}

function requireSha256(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && SHA256_PATTERN.test(value), `${label} must be a lowercase SHA-256`);
}

function requireInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  assert.ok(Number.isSafeInteger(value) && (value as number) >= minimum, `${label} must be an integer >= ${minimum}`);
}

function requireFinite(value: unknown, label: string, minimum = 0): asserts value is number {
  assert.ok(Number.isFinite(value) && (value as number) >= minimum, `${label} must be finite and >= ${minimum}`);
}

function validateSourceComponent(value: unknown, label: string, required: boolean): SourceComponent {
  requireRecord(value, label);
  requireExactKeys(value, ["present", "sha256", "mode", "size"], label);
  assert.equal(typeof value.present, "boolean", `${label}.present must be boolean`);
  if (required) {
    assert.equal(value.present, true, `${label} must be present`);
  }
  if (value.present) {
    requireSha256(value.sha256, `${label}.sha256`);
    assert.ok(typeof value.mode === "string" && MODE_PATTERN.test(value.mode), `${label}.mode must be octal`);
    requireInteger(value.size, `${label}.size`);
    if (required) {
      assert.ok(value.size > 0, `${label}.size must be positive`);
    }
  } else {
    assert.equal(value.sha256, null, `${label}.sha256 must be null when absent`);
    assert.equal(value.mode, null, `${label}.mode must be null when absent`);
    assert.equal(value.size, null, `${label}.size must be null when absent`);
  }
  return value as unknown as SourceComponent;
}

function validateReportSchema(parsed: unknown, expectedStrategy: Strategy, label: string): ValidatorReport {
  requireRecord(parsed, label);
  requireExactKeys(
    parsed,
    [
      "schemaVersion",
      "status",
      "runId",
      "generatedAt",
      "strategy",
      "signedBuild",
      "materializedSource",
      "sourceGuard",
      "fixture",
      "runtimeAttestation",
      "semanticParity",
      "timing",
      "result",
      "restoration",
    ],
    label,
  );
  assert.equal(parsed.schemaVersion, 1, `${label}: report schemaVersion`);
  assert.equal(parsed.status, "ok", `${label}: report status`);
  requireSafeRunId(parsed.runId, `${label}: runId`);
  assert.equal(parsed.strategy, expectedStrategy, `${label}: report strategy`);
  assert.ok(
    typeof parsed.generatedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.generatedAt) &&
      Number.isFinite(Date.parse(parsed.generatedAt)),
    `${label}: generatedAt must be an ISO UTC timestamp`,
  );

  requireRecord(parsed.signedBuild, `${label}: signedBuild`);
  const signedBuild = parsed.signedBuild;
  requireExactKeys(
    signedBuild,
    [
      "appBundleName",
      "schemeRunConfiguration",
      "strictCodeSignatureVerified",
      "runningBundleMatched",
      "executableSha256",
      "mainJsBundleSha256",
      "bundledGuideSha256",
      "bundledGuideDatasetVersion",
    ],
    `${label}: signedBuild`,
  );
  assert.ok(
    typeof signedBuild.appBundleName === "string" && /^[^/\\\0]{1,255}$/.test(signedBuild.appBundleName),
    `${label}: app bundle name`,
  );
  assert.equal(signedBuild.schemeRunConfiguration, "Release", `${label}: signed Release configuration`);
  requireTrue(signedBuild.strictCodeSignatureVerified, `${label}: strict code signature`);
  requireTrue(signedBuild.runningBundleMatched, `${label}: running bundle identity`);
  requireSha256(signedBuild.executableSha256, `${label}: executable SHA-256`);
  requireSha256(signedBuild.mainJsBundleSha256, `${label}: JS bundle SHA-256`);
  requireSha256(signedBuild.bundledGuideSha256, `${label}: bundled guide SHA-256`);
  assert.ok(
    typeof signedBuild.bundledGuideDatasetVersion === "string" &&
      DATASET_VERSION_PATTERN.test(signedBuild.bundledGuideDatasetVersion),
    `${label}: bundled guide dataset version`,
  );

  requireRecord(parsed.materializedSource, `${label}: materializedSource`);
  const materializedSource = parsed.materializedSource;
  requireExactKeys(
    materializedSource,
    ["schemaVersion", "regularUnaliasedFile", "byteIdenticalToSignedBundle", "sha256", "byteSize"],
    `${label}: materializedSource`,
  );
  assert.equal(materializedSource.schemaVersion, 1, `${label}: materialized source schema`);
  requireTrue(materializedSource.regularUnaliasedFile, `${label}: materialized source file`);
  requireTrue(materializedSource.byteIdenticalToSignedBundle, `${label}: materialized source byte identity`);
  requireSha256(materializedSource.sha256, `${label}: materialized source SHA-256`);
  assert.equal(
    materializedSource.sha256,
    signedBuild.bundledGuideSha256,
    `${label}: materialized source differs from signed guide`,
  );
  requireInteger(materializedSource.byteSize, `${label}: materialized source bytes`, 1);

  requireRecord(parsed.sourceGuard, `${label}: sourceGuard`);
  const sourceGuard = parsed.sourceGuard;
  requireExactKeys(
    sourceGuard,
    ["capturedBeforeSQLiteAccess", "sharedMutationLock", "durableStaleRecovery", "components"],
    `${label}: sourceGuard`,
  );
  requireTrue(sourceGuard.capturedBeforeSQLiteAccess, `${label}: pre-SQLite source capture`);
  requireTrue(sourceGuard.sharedMutationLock, `${label}: shared mutation lock`);
  requireTrue(sourceGuard.durableStaleRecovery, `${label}: durable stale recovery`);
  requireRecord(sourceGuard.components, `${label}: sourceGuard.components`);
  const components = sourceGuard.components;
  requireExactKeys(components, ["main", "wal", "shm", "journal"], `${label}: sourceGuard.components`);
  validateSourceComponent(components.main, `${label}: source main`, true);
  validateSourceComponent(components.wal, `${label}: source WAL`, false);
  validateSourceComponent(components.shm, `${label}: source SHM`, false);
  validateSourceComponent(components.journal, `${label}: source journal`, false);

  requireRecord(parsed.fixture, `${label}: fixture`);
  const fixture = parsed.fixture;
  requireExactKeys(
    fixture,
    [
      "installedDisposableCopyOnly",
      "validationRequestSchemaVersion",
      "staleDatasetMarkerPrimed",
      "previousAttestationRemoved",
      "requestExpirySeconds",
    ],
    `${label}: fixture`,
  );
  requireTrue(fixture.installedDisposableCopyOnly, `${label}: disposable fixture`);
  assert.equal(fixture.validationRequestSchemaVersion, 1, `${label}: validation request schema`);
  requireTrue(fixture.staleDatasetMarkerPrimed, `${label}: stale dataset marker`);
  requireTrue(fixture.previousAttestationRemoved, `${label}: previous attestation removal`);
  requireInteger(fixture.requestExpirySeconds, `${label}: request expiry`, 1);

  requireRecord(parsed.runtimeAttestation, `${label}: runtimeAttestation`);
  const runtime = parsed.runtimeAttestation;
  requireExactKeys(
    runtime,
    [
      "schemaVersion",
      "runIdMatched",
      "requestedStrategy",
      "resolvedStrategy",
      "selectedStrategy",
      "fallbackReason",
      "datasetVersionMatched",
      "sourceRows",
      "importedRows",
      "observedAtEpochSeconds",
      "committedAtomicallyWithDatasetMarker",
    ],
    `${label}: runtimeAttestation`,
  );
  assert.equal(runtime.schemaVersion, 1, `${label}: runtime attestation schema`);
  requireTrue(runtime.runIdMatched, `${label}: runtime run ID`);
  assert.equal(runtime.requestedStrategy, expectedStrategy, `${label}: requested strategy`);
  assert.equal(runtime.resolvedStrategy, expectedStrategy, `${label}: resolved strategy`);
  assert.equal(runtime.selectedStrategy, expectedStrategy, `${label}: selected strategy`);
  assert.equal(runtime.fallbackReason, null, `${label}: fallback reason`);
  requireTrue(runtime.datasetVersionMatched, `${label}: runtime dataset version`);
  requireInteger(runtime.sourceRows, `${label}: source rows`, 1);
  requireInteger(runtime.importedRows, `${label}: imported rows`, 1);
  assert.ok(runtime.importedRows <= runtime.sourceRows, `${label}: imported rows cannot exceed source rows`);
  requireInteger(runtime.observedAtEpochSeconds, `${label}: attestation epoch`, 1);
  requireTrue(runtime.committedAtomicallyWithDatasetMarker, `${label}: atomic dataset marker`);

  requireRecord(parsed.semanticParity, `${label}: semanticParity`);
  const semanticParity = parsed.semanticParity;
  requireExactKeys(
    semanticParity,
    ["schemaVersion", "status", "encoding", "counts", "digests", "mismatches", "correctness"],
    `${label}: semanticParity`,
  );
  assert.equal(semanticParity.schemaVersion, 1, `${label}: semantic parity schema`);
  assert.equal(semanticParity.status, "ok", `${label}: semantic parity status`);
  requireRecord(semanticParity.encoding, `${label}: semanticParity.encoding`);
  requireExactKeys(
    semanticParity.encoding,
    ["schema", "stringEncoding", "floatingPointEncoding", "integerEncoding", "rowOrder"],
    `${label}: semanticParity.encoding`,
  );
  assert.deepEqual(
    semanticParity.encoding,
    {
      schema: "length-prefixed-v1",
      stringEncoding: "utf8",
      floatingPointEncoding: "ieee754-binary64-be",
      integerEncoding: "signed-64-be",
      rowOrder: "id-utf8-binary",
    },
    `${label}: semantic parity encoding`,
  );
  requireRecord(semanticParity.counts, `${label}: semanticParity.counts`);
  requireExactKeys(
    semanticParity.counts,
    ["signedGuideSourceRows", "expectedActiveRows", "actualActiveRows"],
    `${label}: semanticParity.counts`,
  );
  requireInteger(semanticParity.counts.signedGuideSourceRows, `${label}: semantic source rows`, 1);
  requireInteger(semanticParity.counts.expectedActiveRows, `${label}: semantic expected rows`, 1);
  requireInteger(semanticParity.counts.actualActiveRows, `${label}: semantic actual rows`, 1);
  assert.equal(
    semanticParity.counts.signedGuideSourceRows,
    runtime.sourceRows,
    `${label}: semantic/source attestation row mismatch`,
  );
  assert.equal(
    semanticParity.counts.expectedActiveRows,
    runtime.importedRows,
    `${label}: semantic/imported attestation row mismatch`,
  );
  assert.equal(
    semanticParity.counts.actualActiveRows,
    runtime.importedRows,
    `${label}: semantic actual/imported row mismatch`,
  );
  requireRecord(semanticParity.digests, `${label}: semanticParity.digests`);
  requireExactKeys(
    semanticParity.digests,
    ["expectedCanonicalRowsSha256", "actualCanonicalRowsSha256"],
    `${label}: semanticParity.digests`,
  );
  requireSha256(semanticParity.digests.expectedCanonicalRowsSha256, `${label}: expected canonical row SHA-256`);
  requireSha256(semanticParity.digests.actualCanonicalRowsSha256, `${label}: actual canonical row SHA-256`);
  assert.equal(
    semanticParity.digests.actualCanonicalRowsSha256,
    semanticParity.digests.expectedCanonicalRowsSha256,
    `${label}: canonical Michelin row digest mismatch`,
  );
  requireRecord(semanticParity.mismatches, `${label}: semanticParity.mismatches`);
  requireExactKeys(
    semanticParity.mismatches,
    ["missingRows", "unexpectedRows", "contentRows"],
    `${label}: semanticParity.mismatches`,
  );
  assert.deepEqual(
    semanticParity.mismatches,
    { missingRows: 0, unexpectedRows: 0, contentRows: 0 },
    `${label}: semantic row mismatches`,
  );
  requireRecord(semanticParity.correctness, `${label}: semanticParity.correctness`);
  requireExactKeys(
    semanticParity.correctness,
    ["exactLegacySemanticRows", "exactIdsAndAllPersistedFields", "exactFloat64CoordinateBits", "exactDatasetVersion"],
    `${label}: semanticParity.correctness`,
  );
  for (const [check, value] of Object.entries(semanticParity.correctness)) {
    requireTrue(value, `${label}: semantic correctness ${check}`);
  }

  requireRecord(parsed.timing, `${label}: timing`);
  const timing = parsed.timing;
  requireExactKeys(
    timing,
    [
      "timestampedManualTrigger",
      "triggerEpochSeconds",
      "completionObservedEpochSeconds",
      "triggerToImportCommitSeconds",
      "initialRssKib",
      "maximumObservedRssKib",
    ],
    `${label}: timing`,
  );
  requireTrue(timing.timestampedManualTrigger, `${label}: manual trigger`);
  requireFinite(timing.triggerEpochSeconds, `${label}: trigger epoch`, 1);
  requireFinite(timing.completionObservedEpochSeconds, `${label}: completion epoch`, 1);
  requireFinite(timing.triggerToImportCommitSeconds, `${label}: import duration`, Number.EPSILON);
  assert.ok(timing.completionObservedEpochSeconds > timing.triggerEpochSeconds, `${label}: completion after trigger`);
  assert.ok(
    Math.abs(
      timing.completionObservedEpochSeconds - timing.triggerEpochSeconds - timing.triggerToImportCommitSeconds,
    ) <= 1e-6,
    `${label}: import duration must match trigger/completion timestamps`,
  );
  requireInteger(timing.initialRssKib, `${label}: initial RSS`);
  requireInteger(timing.maximumObservedRssKib, `${label}: maximum RSS`);
  assert.ok(timing.maximumObservedRssKib >= timing.initialRssKib, `${label}: maximum RSS below initial RSS`);
  assert.ok(
    runtime.observedAtEpochSeconds >= Math.floor(timing.triggerEpochSeconds) &&
      runtime.observedAtEpochSeconds <= Math.floor(timing.completionObservedEpochSeconds),
    `${label}: runtime attestation outside trigger/completion boundary`,
  );

  requireRecord(parsed.result, `${label}: result`);
  const result = parsed.result;
  requireExactKeys(
    result,
    ["databaseSha256", "activeDatasetRows", "totalGuideRows", "integrityCheck", "foreignKeyViolationCount"],
    `${label}: result`,
  );
  requireSha256(result.databaseSha256, `${label}: result database SHA-256`);
  requireInteger(result.activeDatasetRows, `${label}: active dataset rows`, 1);
  requireInteger(result.totalGuideRows, `${label}: total guide rows`, 1);
  assert.equal(result.activeDatasetRows, runtime.importedRows, `${label}: active/imported row count mismatch`);
  assert.equal(
    result.activeDatasetRows,
    semanticParity.counts.actualActiveRows,
    `${label}: active/semantic row count mismatch`,
  );
  assert.ok(result.totalGuideRows >= result.activeDatasetRows, `${label}: total rows below active rows`);
  assert.equal(result.integrityCheck, "ok", `${label}: SQLite integrity`);
  assert.equal(result.foreignKeyViolationCount, 0, `${label}: foreign key violations`);

  requireRecord(parsed.restoration, `${label}: restoration`);
  const restoration = parsed.restoration;
  requireExactKeys(
    restoration,
    ["exactMainWalShmJournalBytesAndModes", "rawPrivateArtifactsDeleted", "aggregateOnlyReport"],
    `${label}: restoration`,
  );
  requireTrue(restoration.exactMainWalShmJournalBytesAndModes, `${label}: exact restoration`);
  requireTrue(restoration.rawPrivateArtifactsDeleted, `${label}: raw private artifact cleanup`);
  requireTrue(restoration.aggregateOnlyReport, `${label}: aggregate-only input report`);

  return parsed as unknown as ValidatorReport;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadAndValidate(path: string, expectedStrategy: Strategy): LoadedRun {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink(), `${path}: input must be a regular non-symlink file`);
  assert.equal(before.nlink, 1, `${path}: input must not have hard-link aliases`);
  assert.equal(before.mode & 0o7777, 0o600, `${path}: input report mode must be 0600`);
  assert.ok(before.size > 0 && before.size <= MAX_REPORT_BYTES, `${path}: input report size is invalid`);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  assert.deepEqual(
    [after.dev, after.ino, after.size, after.mtimeMs, after.mode & 0o7777],
    [before.dev, before.ino, before.size, before.mtimeMs, before.mode & 0o7777],
    `${path}: input report changed while reading`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON`, { cause: error });
  }
  return {
    path,
    report: validateReportSchema(parsed, expectedStrategy, path),
    reportSha256: sha256(bytes),
  };
}

function sourceIdentity(report: ValidatorReport): string {
  const normalize = ({ present, sha256, mode, size }: SourceComponent) => ({ present, sha256, mode, size });
  return JSON.stringify({
    main: normalize(report.sourceGuard.components.main),
    wal: normalize(report.sourceGuard.components.wal),
    shm: normalize(report.sourceGuard.components.shm),
    journal: normalize(report.sourceGuard.components.journal),
  });
}

function buildIdentity(report: ValidatorReport): string {
  return JSON.stringify({
    executableSha256: report.signedBuild.executableSha256,
    mainJsBundleSha256: report.signedBuild.mainJsBundleSha256,
    bundledGuideSha256: report.signedBuild.bundledGuideSha256,
    bundledGuideDatasetVersion: report.signedBuild.bundledGuideDatasetVersion,
    materializedGuideSha256: report.materializedSource.sha256,
    materializedGuideByteSize: report.materializedSource.byteSize,
  });
}

function workloadIdentity(report: ValidatorReport): string {
  return JSON.stringify({
    datasetVersion: report.signedBuild.bundledGuideDatasetVersion,
    sourceRows: report.runtimeAttestation.sourceRows,
    importedRows: report.runtimeAttestation.importedRows,
    activeDatasetRows: report.result.activeDatasetRows,
    totalGuideRows: report.result.totalGuideRows,
    canonicalActiveRowsSha256: report.semanticParity.digests.actualCanonicalRowsSha256,
  });
}

function validateSharedIdentity(runs: readonly LoadedRun[]): void {
  assert.ok(runs.length > 0);
  const baseline = runs[0]!.report;
  const expectedBuild = buildIdentity(baseline);
  const expectedSource = sourceIdentity(baseline);
  const expectedWorkload = workloadIdentity(baseline);
  const runIds = new Set<string>();
  for (const run of runs) {
    assert.ok(!runIds.has(run.report.runId), `${run.path}: duplicate run ID '${run.report.runId}'`);
    runIds.add(run.report.runId);
    assert.equal(buildIdentity(run.report), expectedBuild, `${run.path}: signed build or bundled guide mismatch`);
    assert.equal(sourceIdentity(run.report), expectedSource, `${run.path}: source guard component mismatch`);
    assert.equal(
      workloadIdentity(run.report),
      expectedWorkload,
      `${run.path}: dataset version or row-count mismatch, or canonical digest mismatch`,
    );
  }
}

function validateUniquePaths(configuration: Configuration): void {
  const inputPaths = [...configuration.legacyPaths, ...configuration.attachPaths];
  assert.equal(new Set(inputPaths).size, inputPaths.length, "Every input report path must be distinct");
  assert.ok(!inputPaths.includes(configuration.outputPath), "Output path must not alias an input report");
  assert.ok(!existsSync(configuration.outputPath), "Output report already exists; refusing to overwrite it");
}

function validateCounterbalance(
  legacyRuns: readonly LoadedRun[],
  attachRuns: readonly LoadedRun[],
): {
  readonly chronologicalRuns: readonly LoadedRun[];
  readonly executionOrder: readonly Strategy[];
  readonly firstPositionCounts: Readonly<Record<Strategy, number>>;
} {
  const chronologicalRuns = [...legacyRuns, ...attachRuns].sort(
    (left, right) => left.report.timing.triggerEpochSeconds - right.report.timing.triggerEpochSeconds,
  );
  for (let index = 1; index < chronologicalRuns.length; index += 1) {
    const previous = chronologicalRuns[index - 1]!.report;
    const current = chronologicalRuns[index]!.report;
    assert.ok(
      previous.timing.completionObservedEpochSeconds <= current.timing.triggerEpochSeconds,
      "Signed runs must be chronologically distinct and non-overlapping",
    );
  }

  let previousFirstStrategy: Strategy | null = null;
  const firstPositionCounts: Record<Strategy, number> = {
    "legacy-js-v1": 0,
    "attach-insert-select-v1": 0,
  };
  for (let pairIndex = 0; pairIndex < legacyRuns.length; pairIndex += 1) {
    const pair = [legacyRuns[pairIndex]!, attachRuns[pairIndex]!].sort(
      (left, right) => left.report.timing.triggerEpochSeconds - right.report.timing.triggerEpochSeconds,
    );
    assert.equal(
      chronologicalRuns[pairIndex * 2]!.report.runId,
      pair[0]!.report.runId,
      `Pair ${pairIndex + 1} must occupy adjacent chronological positions`,
    );
    assert.equal(
      chronologicalRuns[pairIndex * 2 + 1]!.report.runId,
      pair[1]!.report.runId,
      `Pair ${pairIndex + 1} must occupy adjacent chronological positions`,
    );
    const firstStrategy = pair[0]!.report.strategy;
    assert.notEqual(
      firstStrategy,
      previousFirstStrategy,
      `Pair ${pairIndex + 1} must alternate which strategy executes first`,
    );
    firstPositionCounts[firstStrategy] += 1;
    previousFirstStrategy = firstStrategy;
  }
  assert.equal(
    Math.abs(firstPositionCounts["legacy-js-v1"] - firstPositionCounts["attach-insert-select-v1"]),
    1,
    "Odd counterbalanced groups must differ by exactly one first-position execution",
  );
  return {
    chronologicalRuns,
    executionOrder: chronologicalRuns.map(({ report }) => report.strategy),
    firstPositionCounts,
  };
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summarizeNumbers(values: readonly number[]): NumericSummary {
  assert.ok(values.length > 0);
  return {
    samples: [...values],
    minimum: Math.min(...values),
    median: median(values),
    maximum: Math.max(...values),
  };
}

function summarizeStrategy(runs: readonly LoadedRun[]) {
  const durations = runs.map(({ report }) => report.timing.triggerToImportCommitSeconds);
  const initialRss = runs.map(({ report }) => report.timing.initialRssKib);
  const maximumRss = runs.map(({ report }) => report.timing.maximumObservedRssKib);
  const observedRssGrowth = runs.map(({ report }) => report.timing.maximumObservedRssKib - report.timing.initialRssKib);
  return {
    strategy: runs[0]!.report.strategy,
    sampleCount: runs.length,
    runIds: runs.map(({ report }) => report.runId),
    inputReportSha256: runs.map(({ reportSha256 }) => reportSha256),
    triggerToImportCommitSeconds: summarizeNumbers(durations),
    initialRssKib: summarizeNumbers(initialRss),
    maximumObservedRssKib: summarizeNumbers(maximumRss),
    observedRssGrowthKib: summarizeNumbers(observedRssGrowth),
  };
}

function writePrivateOutput(outputPath: string, contents: string, forbiddenPaths: readonly string[]): void {
  for (const path of [...forbiddenPaths, outputPath]) {
    assert.ok(!contents.includes(path), "Aggregate summary must not contain filesystem paths");
  }
  const directory = dirname(outputPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    const descriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o600);
    assert.equal(statSync(outputPath).mode & 0o7777, 0o600, "Output report mode must be 0600");
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function main(): void {
  process.umask(0o077);
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
    return;
  }
  validateUniquePaths(configuration);
  const legacyRuns = configuration.legacyPaths.map((path) => loadAndValidate(path, "legacy-js-v1"));
  const attachRuns = configuration.attachPaths.map((path) => loadAndValidate(path, "attach-insert-select-v1"));
  const allRuns = [...legacyRuns, ...attachRuns];
  validateSharedIdentity(allRuns);
  const counterbalance = validateCounterbalance(legacyRuns, attachRuns);

  const legacy = summarizeStrategy(legacyRuns);
  const attach = summarizeStrategy(attachRuns);
  const legacyDurations = legacy.triggerToImportCommitSeconds.samples;
  const attachDurations = attach.triggerToImportCommitSeconds.samples;
  const pairedSpeedups = legacyDurations.map((duration, index) => duration / attachDurations[index]!);
  const pairedReductions = legacyDurations.map(
    (duration, index) => ((duration - attachDurations[index]!) / duration) * 100,
  );
  const pairedRssGrowthDeltas = legacyRuns.map(
    ({ report }, index) =>
      attachRuns[index]!.report.timing.maximumObservedRssKib -
      attachRuns[index]!.report.timing.initialRssKib -
      (report.timing.maximumObservedRssKib - report.timing.initialRssKib),
  );
  const attachWins = legacyDurations.filter((duration, index) => attachDurations[index]! < duration).length;
  const ties = legacyDurations.filter((duration, index) => attachDurations[index] === duration).length;
  const baseline = legacyRuns[0]!.report;
  const summarizerSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));

  const report = {
    schemaVersion: 1,
    status: "ok",
    benchmark: "signed-macos-michelin-import-ab",
    generatedAt: new Date().toISOString(),
    validation: {
      everyInputSchema1StatusOkAndStrategyAttested: true,
      everyInputRegularPrivate0600File: true,
      everyRunSignedReleaseAndRunningBundleMatched: true,
      everyRunMaterializedSourceByteIdenticalToSignedGuide: true,
      everyRunCanonicalRowsMatchIndependentLegacySemanticsOracle: true,
      everyRunAggregateOnlyWithRawPrivateArtifactsDeleted: true,
      everyRunExactlyRestoredMainWalShmJournalBytesAndModes: true,
      identicalExecutableBundleGuideAndDatasetVersionAcrossInputs: true,
      identicalSourceGuardComponentHashesModesAndSizesAcrossInputs: true,
      identicalSourceImportedActiveAndTotalRowCountsAcrossInputs: true,
      identicalCanonicalActiveRowDigestAcrossInputs: true,
      distinctReportPathsAndRunIds: true,
      equalOddSampleGroupsAtLeastThree: true,
      adjacentAlternatingCounterbalancedPairs: true,
    },
    design: {
      sampleCountPerStrategy: legacyRuns.length,
      preferredSampleCountPerStrategy: 3,
      usesPreferredThreeByThreeDesign: legacyRuns.length === 3,
      pairCount: legacyRuns.length,
      executionOrder: counterbalance.executionOrder,
      firstPositionCounts: counterbalance.firstPositionCounts,
    },
    provenance: {
      summarizerSha256,
      signedBuild: {
        executableSha256: baseline.signedBuild.executableSha256,
        mainJsBundleSha256: baseline.signedBuild.mainJsBundleSha256,
        bundledGuideSha256: baseline.signedBuild.bundledGuideSha256,
        bundledGuideDatasetVersion: baseline.signedBuild.bundledGuideDatasetVersion,
        materializedGuideSha256: baseline.materializedSource.sha256,
        materializedGuideByteSize: baseline.materializedSource.byteSize,
      },
      sourceGuardComponents: baseline.sourceGuard.components,
      workload: {
        sourceRows: baseline.runtimeAttestation.sourceRows,
        importedRows: baseline.runtimeAttestation.importedRows,
        activeDatasetRows: baseline.result.activeDatasetRows,
        totalGuideRows: baseline.result.totalGuideRows,
        canonicalActiveRowsSha256: baseline.semanticParity.digests.actualCanonicalRowsSha256,
      },
      chronologicalInputs: counterbalance.chronologicalRuns.map(({ report: input, reportSha256 }, index) => ({
        ordinal: index + 1,
        runId: input.runId,
        strategy: input.strategy,
        inputReportSha256: reportSha256,
        resultDatabaseSha256: input.result.databaseSha256,
      })),
    },
    strategies: {
      legacyJsV1: legacy,
      attachInsertSelectV1: attach,
    },
    comparison: {
      interpretation: "descriptive-signed-counterbalanced-sample-summary",
      medianDurationSpeedup: legacy.triggerToImportCommitSeconds.median / attach.triggerToImportCommitSeconds.median,
      medianDurationReductionPercent:
        ((legacy.triggerToImportCommitSeconds.median - attach.triggerToImportCommitSeconds.median) /
          legacy.triggerToImportCommitSeconds.median) *
        100,
      medianDurationSecondsSaved:
        legacy.triggerToImportCommitSeconds.median - attach.triggerToImportCommitSeconds.median,
      pairedCounterbalanced: {
        speedups: pairedSpeedups,
        reductionsPercent: pairedReductions,
        medianSpeedup: median(pairedSpeedups),
        medianReductionPercent: median(pairedReductions),
        attachWins,
        ties,
        legacyWins: legacyRuns.length - attachWins - ties,
      },
      rssDeltaKib: {
        medianInitial: attach.initialRssKib.median - legacy.initialRssKib.median,
        medianMaximumObserved: attach.maximumObservedRssKib.median - legacy.maximumObservedRssKib.median,
        medianObservedGrowth: attach.observedRssGrowthKib.median - legacy.observedRssGrowthKib.median,
        pairedObservedGrowth: pairedRssGrowthDeltas,
        medianPairedObservedGrowth: median(pairedRssGrowthDeltas),
      },
    },
    privacy: {
      aggregateOnly: true,
      containsFilesystemPaths: false,
      containsRestaurantRows: false,
      containsRestaurantIdsNamesCoordinatesOrAddresses: false,
      containsOnlyAggregateCountsTimingsRssAndCryptographicProvenance: true,
      outputMode: "0600",
    },
    limitations: [
      "Manual trigger-to-commit timing includes UI scheduling and polling observation latency around the production import.",
      "RSS is sampled process RSS; brief peaks between samples may not be observed.",
      "Results are descriptive for this signed build, bundled guide, restored database identity, and sample set.",
    ],
  };
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  writePrivateOutput(
    configuration.outputPath,
    contents,
    allRuns.map(({ path }) => path),
  );
  console.log(
    JSON.stringify({
      status: "ok",
      sampleCountPerStrategy: legacyRuns.length,
      medianDurationSpeedup: report.comparison.medianDurationSpeedup,
      medianDurationReductionPercent: report.comparison.medianDurationReductionPercent,
      attachWins,
    }),
  );
}

main();
