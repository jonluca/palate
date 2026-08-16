#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

type Strategy = "legacy-js-v1" | "attach-insert-select-v1";

interface TestReport {
  schemaVersion: number;
  status: string;
  runId: string;
  generatedAt: string;
  strategy: Strategy;
  signedBuild: {
    appBundleName: string;
    schemeRunConfiguration: string;
    strictCodeSignatureVerified: boolean;
    runningBundleMatched: boolean;
    executableSha256: string;
    mainJsBundleSha256: string;
    bundledGuideSha256: string;
    bundledGuideDatasetVersion: string;
  };
  materializedSource: {
    schemaVersion: number;
    regularUnaliasedFile: boolean;
    byteIdenticalToSignedBundle: boolean;
    sha256: string;
    byteSize: number;
  };
  sourceGuard: {
    capturedBeforeSQLiteAccess: boolean;
    sharedMutationLock: boolean;
    durableStaleRecovery: boolean;
    components: {
      main: SourceComponent;
      wal: SourceComponent;
      shm: SourceComponent;
      journal: SourceComponent;
    };
  };
  fixture: {
    installedDisposableCopyOnly: boolean;
    validationRequestSchemaVersion: number;
    staleDatasetMarkerPrimed: boolean;
    previousAttestationRemoved: boolean;
    requestExpirySeconds: number;
  };
  runtimeAttestation: {
    schemaVersion: number;
    runIdMatched: boolean;
    requestedStrategy: Strategy;
    resolvedStrategy: Strategy;
    selectedStrategy: Strategy;
    fallbackReason: null;
    datasetVersionMatched: boolean;
    sourceRows: number;
    importedRows: number;
    observedAtEpochSeconds: number;
    committedAtomicallyWithDatasetMarker: boolean;
  };
  semanticParity: {
    schemaVersion: number;
    status: string;
    encoding: {
      schema: string;
      stringEncoding: string;
      floatingPointEncoding: string;
      integerEncoding: string;
      rowOrder: string;
    };
    counts: {
      signedGuideSourceRows: number;
      expectedActiveRows: number;
      actualActiveRows: number;
    };
    digests: {
      expectedCanonicalRowsSha256: string;
      actualCanonicalRowsSha256: string;
    };
    mismatches: {
      missingRows: number;
      unexpectedRows: number;
      contentRows: number;
    };
    correctness: {
      exactLegacySemanticRows: boolean;
      exactIdsAndAllPersistedFields: boolean;
      exactFloat64CoordinateBits: boolean;
      exactDatasetVersion: boolean;
    };
  };
  timing: {
    timestampedManualTrigger: boolean;
    triggerEpochSeconds: number;
    completionObservedEpochSeconds: number;
    triggerToImportCommitSeconds: number;
    initialRssKib: number;
    maximumObservedRssKib: number;
  };
  result: {
    databaseSha256: string;
    activeDatasetRows: number;
    totalGuideRows: number;
    integrityCheck: string;
    foreignKeyViolationCount: number;
  };
  restoration: {
    exactMainWalShmJournalBytesAndModes: boolean;
    rawPrivateArtifactsDeleted: boolean;
    aggregateOnlyReport: boolean;
  };
}

interface SourceComponent {
  present: boolean;
  sha256: string | null;
  mode: string | null;
  size: number | null;
}

interface FixtureSet {
  readonly directory: string;
  readonly reports: {
    legacy: TestReport[];
    attach: TestReport[];
  };
  readonly paths: {
    legacy: string[];
    attach: string[];
    output: string;
  };
}

interface SuccessSummary {
  readonly schemaVersion: number;
  readonly status: string;
  readonly validation: MichelinImportSummaryValidation;
  readonly design: {
    sampleCountPerStrategy: number;
    preferredSampleCountPerStrategy: number;
    usesPreferredThreeByThreeDesign: boolean;
    pairCount: number;
    executionOrder: Strategy[];
    firstPositionCounts: Record<Strategy, number>;
  };
  readonly provenance: {
    summarizerSha256: string;
    signedBuild: MichelinImportSignedBuildSummary;
    sourceGuardComponents: MichelinImportSourceGuardSummary;
    workload: MichelinImportWorkloadSummary;
    chronologicalInputs: Array<{
      ordinal: number;
      runId: string;
      strategy: Strategy;
      inputReportSha256: string;
      resultDatabaseSha256: string;
    }>;
  };
  readonly strategies: {
    legacyJsV1: StrategySummary;
    attachInsertSelectV1: StrategySummary;
  };
  readonly comparison: {
    interpretation: string;
    medianDurationSpeedup: number;
    medianDurationReductionPercent: number;
    medianDurationSecondsSaved: number;
    pairedCounterbalanced: {
      speedups: number[];
      reductionsPercent: number[];
      medianSpeedup: number;
      medianReductionPercent: number;
      attachWins: number;
      ties: number;
      legacyWins: number;
    };
    rssDeltaKib: {
      medianInitial: number;
      medianMaximumObserved: number;
      medianObservedGrowth: number;
      pairedObservedGrowth: number[];
      medianPairedObservedGrowth: number;
    };
  };
  readonly privacy: MichelinImportPrivacySummary;
}

interface MichelinImportSummaryValidation {
  [attestation: string]: boolean;
}

interface MichelinImportSignedBuildSummary {
  [field: string]: string | number;
}

interface MichelinImportSourceGuardSummary {
  main: SourceComponent;
  wal: SourceComponent;
  shm: SourceComponent;
  journal: SourceComponent;
}

interface MichelinImportWorkloadSummary {
  [field: string]: number | string;
}

interface MichelinImportPrivacySummary {
  [attestation: string]: boolean | string;
}

interface StrategySummary {
  readonly strategy: Strategy;
  readonly sampleCount: number;
  readonly runIds: string[];
  readonly inputReportSha256: string[];
  readonly triggerToImportCommitSeconds: NumericSummary;
  readonly initialRssKib: NumericSummary;
  readonly maximumObservedRssKib: NumericSummary;
  readonly observedRssGrowthKib: NumericSummary;
}

interface NumericSummary {
  readonly samples: number[];
  readonly minimum: number;
  readonly median: number;
  readonly maximum: number;
}

const summarizerPath = fileURLToPath(new URL("./summarize-macos-michelin-import-ab.ts", import.meta.url));
const repositoryRoot = dirname(dirname(summarizerPath));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-michelin-import-ab-summary-"));
const executableSha256 = "a".repeat(64);
const bundleSha256 = "b".repeat(64);
const guideSha256 = "c".repeat(64);
const datasetVersion = "d".repeat(32);
const mainSha256 = "e".repeat(64);
const walSha256 = createHash("sha256").update("").digest("hex");
const shmSha256 = "f".repeat(64);
const canonicalRowsSha256 = "9".repeat(64);
const privateSentinel = "PRIVATE_ROW_SENTINEL_雪";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoSeconds(epochSeconds: number): string {
  return new Date(Math.floor(epochSeconds) * 1000).toISOString().replace(".000Z", "Z");
}

function makeReport(
  strategy: Strategy,
  index: number,
  triggerEpochSeconds: number,
  durationSeconds: number,
  initialRssKib: number,
  maximumObservedRssKib: number,
  caseName: string,
): TestReport {
  const completionObservedEpochSeconds = triggerEpochSeconds + durationSeconds;
  return {
    schemaVersion: 1,
    status: "ok",
    runId: `${caseName}-${strategy}-${index + 1}`,
    generatedAt: isoSeconds(completionObservedEpochSeconds + 10),
    strategy,
    signedBuild: {
      appBundleName: `Palate-${privateSentinel}.app`,
      schemeRunConfiguration: "Release",
      strictCodeSignatureVerified: true,
      runningBundleMatched: true,
      executableSha256,
      mainJsBundleSha256: bundleSha256,
      bundledGuideSha256: guideSha256,
      bundledGuideDatasetVersion: datasetVersion,
    },
    materializedSource: {
      schemaVersion: 1,
      regularUnaliasedFile: true,
      byteIdenticalToSignedBundle: true,
      sha256: guideSha256,
      byteSize: 59_490_304,
    },
    sourceGuard: {
      capturedBeforeSQLiteAccess: true,
      sharedMutationLock: true,
      durableStaleRecovery: true,
      components: {
        main: { present: true, sha256: mainSha256, mode: "644", size: 4096 },
        wal: { present: true, sha256: walSha256, mode: "644", size: 0 },
        shm: { present: true, sha256: shmSha256, mode: "644", size: 32768 },
        journal: { present: false, sha256: null, mode: null, size: null },
      },
    },
    fixture: {
      installedDisposableCopyOnly: true,
      validationRequestSchemaVersion: 1,
      staleDatasetMarkerPrimed: true,
      previousAttestationRemoved: true,
      requestExpirySeconds: 600,
    },
    runtimeAttestation: {
      schemaVersion: 1,
      runIdMatched: true,
      requestedStrategy: strategy,
      resolvedStrategy: strategy,
      selectedStrategy: strategy,
      fallbackReason: null,
      datasetVersionMatched: true,
      sourceRows: 100,
      importedRows: 98,
      observedAtEpochSeconds: Math.floor(triggerEpochSeconds + durationSeconds / 2),
      committedAtomicallyWithDatasetMarker: true,
    },
    semanticParity: {
      schemaVersion: 1,
      status: "ok",
      encoding: {
        schema: "length-prefixed-v1",
        stringEncoding: "utf8",
        floatingPointEncoding: "ieee754-binary64-be",
        integerEncoding: "signed-64-be",
        rowOrder: "id-utf8-binary",
      },
      counts: {
        signedGuideSourceRows: 100,
        expectedActiveRows: 98,
        actualActiveRows: 98,
      },
      digests: {
        expectedCanonicalRowsSha256: canonicalRowsSha256,
        actualCanonicalRowsSha256: canonicalRowsSha256,
      },
      mismatches: {
        missingRows: 0,
        unexpectedRows: 0,
        contentRows: 0,
      },
      correctness: {
        exactLegacySemanticRows: true,
        exactIdsAndAllPersistedFields: true,
        exactFloat64CoordinateBits: true,
        exactDatasetVersion: true,
      },
    },
    timing: {
      timestampedManualTrigger: true,
      triggerEpochSeconds,
      completionObservedEpochSeconds,
      triggerToImportCommitSeconds: durationSeconds,
      initialRssKib,
      maximumObservedRssKib,
    },
    result: {
      databaseSha256: sha256(`${caseName}:${strategy}:${index}`),
      activeDatasetRows: 98,
      totalGuideRows: 100,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
    },
    restoration: {
      exactMainWalShmJournalBytesAndModes: true,
      rawPrivateArtifactsDeleted: true,
      aggregateOnlyReport: true,
    },
  };
}

function createFixtureSet(caseName: string): FixtureSet {
  const directory = join(temporaryDirectory, caseName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const legacy = [
    makeReport("legacy-js-v1", 0, 1_000, 10, 100, 150, caseName),
    makeReport("legacy-js-v1", 1, 1_060, 12, 110, 170, caseName),
    makeReport("legacy-js-v1", 2, 1_080, 14, 120, 190, caseName),
  ];
  const attach = [
    makeReport("attach-insert-select-v1", 0, 1_020, 5, 90, 120, caseName),
    makeReport("attach-insert-select-v1", 1, 1_040, 6, 100, 135, caseName),
    makeReport("attach-insert-select-v1", 2, 1_100, 7, 110, 150, caseName),
  ];
  return {
    directory,
    reports: { legacy, attach },
    paths: {
      legacy: legacy.map((_, index) => join(directory, `legacy-${index + 1}.json`)),
      attach: attach.map((_, index) => join(directory, `attach-${index + 1}.json`)),
      output: join(directory, "summary.json"),
    },
  };
}

function writeFixtureSet(fixtureSet: FixtureSet): void {
  for (const [reports, paths] of [
    [fixtureSet.reports.legacy, fixtureSet.paths.legacy],
    [fixtureSet.reports.attach, fixtureSet.paths.attach],
  ] as const) {
    for (let index = 0; index < paths.length; index += 1) {
      writeFileSync(paths[index]!, `${JSON.stringify(reports[index], null, 2)}\n`, { mode: 0o600 });
      chmodSync(paths[index]!, 0o600);
    }
  }
}

function execute(fixtureSet: FixtureSet): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      summarizerPath,
      `--legacy-js-v1=${fixtureSet.paths.legacy.join(",")}`,
      `--attach-insert-select-v1=${fixtureSet.paths.attach.join(",")}`,
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

function parseStrategy(value: JsonValue | undefined, label: string): Strategy {
  if (value === "legacy-js-v1" || value === "attach-insert-select-v1") {
    return value;
  }
  throw new TypeError(`${label} is unsupported.`);
}

function parseSummaryValidation(value: JsonValue | undefined): MichelinImportSummaryValidation {
  const object = requiredJsonObject(value, "summary.validation");
  const validation: MichelinImportSummaryValidation = {};
  for (const [key, entry] of Object.entries(object)) {
    validation[key] = requiredJsonBoolean(entry, `summary.validation.${key}`);
  }
  return validation;
}

function parseStringOrNumber(value: JsonValue, label: string): string | number {
  if (isJsonString(value) || isJsonNumber(value)) {
    return value;
  }
  throw new TypeError(`${label} must be a string or number.`);
}

function parseSignedBuildSummary(value: JsonValue | undefined): MichelinImportSignedBuildSummary {
  const object = requiredJsonObject(value, "summary.provenance.signedBuild");
  const summary: MichelinImportSignedBuildSummary = {};
  for (const [key, entry] of Object.entries(object)) {
    summary[key] = parseStringOrNumber(entry, `summary.provenance.signedBuild.${key}`);
  }
  return summary;
}

function parseWorkloadSummary(value: JsonValue | undefined): MichelinImportWorkloadSummary {
  const object = requiredJsonObject(value, "summary.provenance.workload");
  const summary: MichelinImportWorkloadSummary = {};
  for (const [key, entry] of Object.entries(object)) {
    summary[key] = parseStringOrNumber(entry, `summary.provenance.workload.${key}`);
  }
  return summary;
}

function parsePrivacySummary(value: JsonValue | undefined): MichelinImportPrivacySummary {
  const object = requiredJsonObject(value, "summary.privacy");
  const summary: MichelinImportPrivacySummary = {};
  for (const [key, entry] of Object.entries(object)) {
    if (isJsonString(entry) || isJsonBoolean(entry)) {
      summary[key] = entry;
    } else {
      throw new TypeError(`summary.privacy.${key} must be a string or boolean.`);
    }
  }
  return summary;
}

function parseSourceComponent(value: JsonValue | undefined, label: string): SourceComponent {
  const object = requiredJsonObject(value, label);
  return {
    present: requiredJsonBoolean(object.present, `${label}.present`),
    sha256: requiredNullableJsonString(object.sha256, `${label}.sha256`),
    mode: requiredNullableJsonString(object.mode, `${label}.mode`),
    size: requiredNullableJsonNumber(object.size, `${label}.size`),
  };
}

function parseSourceGuardSummary(value: JsonValue | undefined): MichelinImportSourceGuardSummary {
  const object = requiredJsonObject(value, "summary.provenance.sourceGuardComponents");
  return {
    main: parseSourceComponent(object.main, "summary.provenance.sourceGuardComponents.main"),
    wal: parseSourceComponent(object.wal, "summary.provenance.sourceGuardComponents.wal"),
    shm: parseSourceComponent(object.shm, "summary.provenance.sourceGuardComponents.shm"),
    journal: parseSourceComponent(object.journal, "summary.provenance.sourceGuardComponents.journal"),
  };
}

function parseNumericSummary(value: JsonValue | undefined, label: string): NumericSummary {
  const object = requiredJsonObject(value, label);
  return {
    samples: requiredJsonNumberArray(object.samples, `${label}.samples`),
    minimum: requiredJsonNumber(object.minimum, `${label}.minimum`),
    median: requiredJsonNumber(object.median, `${label}.median`),
    maximum: requiredJsonNumber(object.maximum, `${label}.maximum`),
  };
}

function parseStrategySummary(value: JsonValue | undefined, label: string): StrategySummary {
  const object = requiredJsonObject(value, label);
  return {
    strategy: parseStrategy(object.strategy, `${label}.strategy`),
    sampleCount: requiredJsonNumber(object.sampleCount, `${label}.sampleCount`),
    runIds: requiredJsonStringArray(object.runIds, `${label}.runIds`),
    inputReportSha256: requiredJsonStringArray(object.inputReportSha256, `${label}.inputReportSha256`),
    triggerToImportCommitSeconds: parseNumericSummary(
      object.triggerToImportCommitSeconds,
      `${label}.triggerToImportCommitSeconds`,
    ),
    initialRssKib: parseNumericSummary(object.initialRssKib, `${label}.initialRssKib`),
    maximumObservedRssKib: parseNumericSummary(object.maximumObservedRssKib, `${label}.maximumObservedRssKib`),
    observedRssGrowthKib: parseNumericSummary(object.observedRssGrowthKib, `${label}.observedRssGrowthKib`),
  };
}

function parseChronologicalInput(
  value: JsonValue,
  index: number,
): SuccessSummary["provenance"]["chronologicalInputs"][number] {
  const label = `summary.provenance.chronologicalInputs[${index}]`;
  const object = requiredJsonObject(value, label);
  return {
    ordinal: requiredJsonNumber(object.ordinal, `${label}.ordinal`),
    runId: requiredJsonString(object.runId, `${label}.runId`),
    strategy: parseStrategy(object.strategy, `${label}.strategy`),
    inputReportSha256: requiredJsonString(object.inputReportSha256, `${label}.inputReportSha256`),
    resultDatabaseSha256: requiredJsonString(object.resultDatabaseSha256, `${label}.resultDatabaseSha256`),
  };
}

function parseSuccessSummaryValue(value: JsonValue): SuccessSummary {
  const object = requiredJsonObject(value, "summary");
  const design = requiredJsonObject(object.design, "summary.design");
  const firstPositionCounts = requiredJsonObject(design.firstPositionCounts, "summary.design.firstPositionCounts");
  const provenance = requiredJsonObject(object.provenance, "summary.provenance");
  if (!Array.isArray(provenance.chronologicalInputs)) {
    throw new TypeError("summary.provenance.chronologicalInputs must be an array.");
  }
  const strategies = requiredJsonObject(object.strategies, "summary.strategies");
  const comparison = requiredJsonObject(object.comparison, "summary.comparison");
  const pairedCounterbalanced = requiredJsonObject(
    comparison.pairedCounterbalanced,
    "summary.comparison.pairedCounterbalanced",
  );
  const rssDeltaKib = requiredJsonObject(comparison.rssDeltaKib, "summary.comparison.rssDeltaKib");
  return {
    schemaVersion: requiredJsonNumber(object.schemaVersion, "summary.schemaVersion"),
    status: requiredJsonString(object.status, "summary.status"),
    validation: parseSummaryValidation(object.validation),
    design: {
      sampleCountPerStrategy: requiredJsonNumber(
        design.sampleCountPerStrategy,
        "summary.design.sampleCountPerStrategy",
      ),
      preferredSampleCountPerStrategy: requiredJsonNumber(
        design.preferredSampleCountPerStrategy,
        "summary.design.preferredSampleCountPerStrategy",
      ),
      usesPreferredThreeByThreeDesign: requiredJsonBoolean(
        design.usesPreferredThreeByThreeDesign,
        "summary.design.usesPreferredThreeByThreeDesign",
      ),
      pairCount: requiredJsonNumber(design.pairCount, "summary.design.pairCount"),
      executionOrder: requiredJsonStringArray(design.executionOrder, "summary.design.executionOrder").map(
        (entry, index) => parseStrategy(entry, `summary.design.executionOrder[${index}]`),
      ),
      firstPositionCounts: {
        "legacy-js-v1": requiredJsonNumber(
          firstPositionCounts["legacy-js-v1"],
          "summary.design.firstPositionCounts.legacy-js-v1",
        ),
        "attach-insert-select-v1": requiredJsonNumber(
          firstPositionCounts["attach-insert-select-v1"],
          "summary.design.firstPositionCounts.attach-insert-select-v1",
        ),
      },
    },
    provenance: {
      summarizerSha256: requiredJsonString(provenance.summarizerSha256, "summary.provenance.summarizerSha256"),
      signedBuild: parseSignedBuildSummary(provenance.signedBuild),
      sourceGuardComponents: parseSourceGuardSummary(provenance.sourceGuardComponents),
      workload: parseWorkloadSummary(provenance.workload),
      chronologicalInputs: provenance.chronologicalInputs.map(parseChronologicalInput),
    },
    strategies: {
      legacyJsV1: parseStrategySummary(strategies.legacyJsV1, "summary.strategies.legacyJsV1"),
      attachInsertSelectV1: parseStrategySummary(
        strategies.attachInsertSelectV1,
        "summary.strategies.attachInsertSelectV1",
      ),
    },
    comparison: {
      interpretation: requiredJsonString(comparison.interpretation, "summary.comparison.interpretation"),
      medianDurationSpeedup: requiredJsonNumber(
        comparison.medianDurationSpeedup,
        "summary.comparison.medianDurationSpeedup",
      ),
      medianDurationReductionPercent: requiredJsonNumber(
        comparison.medianDurationReductionPercent,
        "summary.comparison.medianDurationReductionPercent",
      ),
      medianDurationSecondsSaved: requiredJsonNumber(
        comparison.medianDurationSecondsSaved,
        "summary.comparison.medianDurationSecondsSaved",
      ),
      pairedCounterbalanced: {
        speedups: requiredJsonNumberArray(
          pairedCounterbalanced.speedups,
          "summary.comparison.pairedCounterbalanced.speedups",
        ),
        reductionsPercent: requiredJsonNumberArray(
          pairedCounterbalanced.reductionsPercent,
          "summary.comparison.pairedCounterbalanced.reductionsPercent",
        ),
        medianSpeedup: requiredJsonNumber(
          pairedCounterbalanced.medianSpeedup,
          "summary.comparison.pairedCounterbalanced.medianSpeedup",
        ),
        medianReductionPercent: requiredJsonNumber(
          pairedCounterbalanced.medianReductionPercent,
          "summary.comparison.pairedCounterbalanced.medianReductionPercent",
        ),
        attachWins: requiredJsonNumber(
          pairedCounterbalanced.attachWins,
          "summary.comparison.pairedCounterbalanced.attachWins",
        ),
        ties: requiredJsonNumber(pairedCounterbalanced.ties, "summary.comparison.pairedCounterbalanced.ties"),
        legacyWins: requiredJsonNumber(
          pairedCounterbalanced.legacyWins,
          "summary.comparison.pairedCounterbalanced.legacyWins",
        ),
      },
      rssDeltaKib: {
        medianInitial: requiredJsonNumber(rssDeltaKib.medianInitial, "summary.comparison.rssDeltaKib.medianInitial"),
        medianMaximumObserved: requiredJsonNumber(
          rssDeltaKib.medianMaximumObserved,
          "summary.comparison.rssDeltaKib.medianMaximumObserved",
        ),
        medianObservedGrowth: requiredJsonNumber(
          rssDeltaKib.medianObservedGrowth,
          "summary.comparison.rssDeltaKib.medianObservedGrowth",
        ),
        pairedObservedGrowth: requiredJsonNumberArray(
          rssDeltaKib.pairedObservedGrowth,
          "summary.comparison.rssDeltaKib.pairedObservedGrowth",
        ),
        medianPairedObservedGrowth: requiredJsonNumber(
          rssDeltaKib.medianPairedObservedGrowth,
          "summary.comparison.rssDeltaKib.medianPairedObservedGrowth",
        ),
      },
    },
    privacy: parsePrivacySummary(object.privacy),
  };
}

function expectFailure(
  caseName: string,
  mutate: (fixtureSet: FixtureSet) => void,
  expectedMessage: string,
  afterWrite?: (fixtureSet: FixtureSet) => void,
  outputMayAlreadyExist = false,
): void {
  const fixtureSet = createFixtureSet(caseName);
  mutate(fixtureSet);
  writeFixtureSet(fixtureSet);
  afterWrite?.(fixtureSet);
  const result = execute(fixtureSet);
  assert.notEqual(result.status, 0, `${caseName} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(expectedMessage), `${caseName} failure message`);
  if (!outputMayAlreadyExist) {
    assert.ok(!statIfPresent(fixtureSet.paths.output), `${caseName} unexpectedly published an output report`);
  }
}

function statIfPresent(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (cause) {
    if (cause instanceof Error && hasErrorCode(cause) && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
}

function setTiming(report: TestReport, triggerEpochSeconds: number, durationSeconds: number): void {
  report.timing.triggerEpochSeconds = triggerEpochSeconds;
  report.timing.completionObservedEpochSeconds = triggerEpochSeconds + durationSeconds;
  report.timing.triggerToImportCommitSeconds = durationSeconds;
  report.runtimeAttestation.observedAtEpochSeconds = Math.floor(triggerEpochSeconds + durationSeconds / 2);
  report.generatedAt = isoSeconds(triggerEpochSeconds + durationSeconds + 10);
}

function collectKeys(value: JsonValue, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectKeys(child, keys);
    }
  } else if (isJsonObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

process.umask(0o077);
try {
  const help = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", summarizerPath, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /legacy-js-v1/);
  assert.match(help.stdout, /regular 0600 files/);

  const success = createFixtureSet("success");
  writeFixtureSet(success);
  const successResult = execute(success);
  assert.equal(successResult.status, 0, successResult.stderr);
  assert.doesNotMatch(successResult.stdout, new RegExp(temporaryDirectory));
  const outputText = readFileSync(success.paths.output, "utf8");
  assert.equal(statSync(success.paths.output).mode & 0o777, 0o600);
  assert.ok(!outputText.includes(temporaryDirectory), "Summary leaked a filesystem path");
  assert.ok(!outputText.includes(privateSentinel), "Summary leaked an aggregate-input private sentinel");
  for (const inputPath of [...success.paths.legacy, ...success.paths.attach]) {
    assert.ok(!outputText.includes(inputPath), "Summary leaked an input report path");
  }
  const summaryValue = parseJsonValue(outputText);
  const summary = parseSuccessSummaryValue(summaryValue);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.status, "ok");
  assert.equal(summary.design.sampleCountPerStrategy, 3);
  assert.equal(summary.design.preferredSampleCountPerStrategy, 3);
  assert.equal(summary.design.usesPreferredThreeByThreeDesign, true);
  assert.equal(summary.design.pairCount, 3);
  assert.deepEqual(summary.design.executionOrder, [
    "legacy-js-v1",
    "attach-insert-select-v1",
    "attach-insert-select-v1",
    "legacy-js-v1",
    "legacy-js-v1",
    "attach-insert-select-v1",
  ]);
  assert.deepEqual(summary.design.firstPositionCounts, {
    "legacy-js-v1": 2,
    "attach-insert-select-v1": 1,
  });
  assert.equal(summary.strategies.legacyJsV1.sampleCount, 3);
  assert.equal(summary.strategies.attachInsertSelectV1.sampleCount, 3);
  assert.deepEqual(summary.strategies.legacyJsV1.triggerToImportCommitSeconds.samples, [10, 12, 14]);
  assert.deepEqual(summary.strategies.attachInsertSelectV1.triggerToImportCommitSeconds.samples, [5, 6, 7]);
  assert.equal(summary.strategies.legacyJsV1.triggerToImportCommitSeconds.median, 12);
  assert.equal(summary.strategies.attachInsertSelectV1.triggerToImportCommitSeconds.median, 6);
  assert.equal(summary.comparison.medianDurationSpeedup, 2);
  assert.equal(summary.comparison.medianDurationReductionPercent, 50);
  assert.equal(summary.comparison.medianDurationSecondsSaved, 6);
  assert.deepEqual(summary.comparison.pairedCounterbalanced.speedups, [2, 2, 2]);
  assert.deepEqual(summary.comparison.pairedCounterbalanced.reductionsPercent, [50, 50, 50]);
  assert.equal(summary.comparison.pairedCounterbalanced.medianSpeedup, 2);
  assert.equal(summary.comparison.pairedCounterbalanced.medianReductionPercent, 50);
  assert.equal(summary.comparison.pairedCounterbalanced.attachWins, 3);
  assert.equal(summary.comparison.pairedCounterbalanced.ties, 0);
  assert.equal(summary.comparison.pairedCounterbalanced.legacyWins, 0);
  assert.equal(summary.comparison.rssDeltaKib.medianInitial, -10);
  assert.equal(summary.comparison.rssDeltaKib.medianMaximumObserved, -35);
  assert.equal(summary.comparison.rssDeltaKib.medianObservedGrowth, -25);
  assert.deepEqual(summary.comparison.rssDeltaKib.pairedObservedGrowth, [-20, -25, -30]);
  assert.equal(summary.comparison.rssDeltaKib.medianPairedObservedGrowth, -25);
  assert.equal(summary.provenance.chronologicalInputs.length, 6);
  assert.deepEqual(
    summary.provenance.chronologicalInputs.map(({ strategy }) => strategy),
    summary.design.executionOrder,
  );
  for (const input of summary.provenance.chronologicalInputs) {
    assert.match(input.inputReportSha256, /^[0-9a-f]{64}$/);
    assert.match(input.resultDatabaseSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(summary.provenance.summarizerSha256, sha256(readFileSync(summarizerPath)));
  assert.equal(summary.provenance.signedBuild.executableSha256, executableSha256);
  assert.equal(summary.provenance.signedBuild.materializedGuideSha256, guideSha256);
  assert.equal(summary.provenance.sourceGuardComponents.main.sha256, mainSha256);
  assert.equal(summary.provenance.workload.sourceRows, 100);
  assert.equal(summary.provenance.workload.importedRows, 98);
  assert.equal(summary.provenance.workload.canonicalActiveRowsSha256, canonicalRowsSha256);
  assert.equal(summary.validation.everyRunMaterializedSourceByteIdenticalToSignedGuide, true);
  assert.equal(summary.validation.everyRunCanonicalRowsMatchIndependentLegacySemanticsOracle, true);
  assert.equal(summary.validation.identicalCanonicalActiveRowDigestAcrossInputs, true);
  assert.equal(summary.privacy.aggregateOnly, true);
  assert.equal(summary.privacy.containsFilesystemPaths, false);
  const forbiddenKeys = new Set([
    "path",
    "filePath",
    "restaurant",
    "restaurantId",
    "name",
    "latitude",
    "longitude",
    "address",
    "location",
    "cuisine",
  ]);
  for (const key of collectKeys(summaryValue)) {
    assert.ok(!forbiddenKeys.has(key), `Summary contains forbidden private/path key: ${key}`);
  }

  expectFailure(
    "schema-mismatch",
    ({ reports }) => {
      reports.attach[2]!.schemaVersion = 2;
    },
    "report schemaVersion",
  );
  expectFailure(
    "status-mismatch",
    ({ reports }) => {
      reports.attach[2]!.status = "failed";
    },
    "report status",
  );
  expectFailure(
    "root-strategy-mismatch",
    ({ reports }) => {
      reports.attach[2]!.strategy = "legacy-js-v1";
    },
    "report strategy",
  );
  expectFailure(
    "selected-strategy-mismatch",
    ({ reports }) => {
      reports.attach[2]!.runtimeAttestation.selectedStrategy = "legacy-js-v1";
    },
    "selected strategy",
  );
  expectFailure(
    "fallback-tampering",
    ({ reports }) => {
      Object.defineProperty(reports.attach[2]!.runtimeAttestation, "fallbackReason", {
        configurable: true,
        enumerable: true,
        value: "sqlite-uri-unavailable",
        writable: true,
      });
    },
    "fallback reason",
  );
  expectFailure(
    "duplicate-run-id",
    ({ reports }) => {
      reports.attach[2]!.runId = reports.legacy[0]!.runId;
    },
    "duplicate run ID",
  );
  expectFailure(
    "executable-mismatch",
    ({ reports }) => {
      reports.attach[2]!.signedBuild.executableSha256 = "1".repeat(64);
    },
    "signed build or bundled guide mismatch",
  );
  expectFailure(
    "bundle-mismatch",
    ({ reports }) => {
      reports.legacy[2]!.signedBuild.mainJsBundleSha256 = "1".repeat(64);
    },
    "signed build or bundled guide mismatch",
  );
  expectFailure(
    "guide-mismatch",
    ({ reports }) => {
      reports.attach[1]!.signedBuild.bundledGuideSha256 = "1".repeat(64);
      reports.attach[1]!.materializedSource.sha256 = "1".repeat(64);
    },
    "signed build or bundled guide mismatch",
  );
  expectFailure(
    "materialized-source-not-identical",
    ({ reports }) => {
      reports.attach[1]!.materializedSource.byteIdenticalToSignedBundle = false;
    },
    "materialized source byte identity",
  );
  expectFailure(
    "materialized-source-hash-mismatch",
    ({ reports }) => {
      reports.attach[1]!.materializedSource.sha256 = "1".repeat(64);
    },
    "materialized source differs from signed guide",
  );
  expectFailure(
    "semantic-parity-failed",
    ({ reports }) => {
      reports.attach[1]!.semanticParity.status = "failed";
    },
    "semantic parity status",
  );
  expectFailure(
    "semantic-content-mismatch",
    ({ reports }) => {
      reports.attach[1]!.semanticParity.mismatches.contentRows = 1;
      reports.attach[1]!.semanticParity.correctness.exactLegacySemanticRows = false;
    },
    "semantic row mismatches",
  );
  expectFailure(
    "semantic-digest-mismatch",
    ({ reports }) => {
      reports.attach[1]!.semanticParity.digests.actualCanonicalRowsSha256 = "1".repeat(64);
    },
    "canonical Michelin row digest mismatch",
  );
  expectFailure(
    "canonical-digest-cross-run-mismatch",
    ({ reports }) => {
      reports.attach[1]!.semanticParity.digests.expectedCanonicalRowsSha256 = "1".repeat(64);
      reports.attach[1]!.semanticParity.digests.actualCanonicalRowsSha256 = "1".repeat(64);
    },
    "canonical digest mismatch",
  );
  expectFailure(
    "dataset-version-mismatch",
    ({ reports }) => {
      reports.attach[1]!.signedBuild.bundledGuideDatasetVersion = "1".repeat(32);
    },
    "signed build or bundled guide mismatch",
  );
  expectFailure(
    "source-hash-mismatch",
    ({ reports }) => {
      reports.legacy[1]!.sourceGuard.components.main.sha256 = "1".repeat(64);
    },
    "source guard component mismatch",
  );
  expectFailure(
    "source-mode-mismatch",
    ({ reports }) => {
      reports.attach[1]!.sourceGuard.components.shm.mode = "600";
    },
    "source guard component mismatch",
  );
  expectFailure(
    "source-size-mismatch",
    ({ reports }) => {
      reports.attach[1]!.sourceGuard.components.shm.size = 65536;
    },
    "source guard component mismatch",
  );
  expectFailure(
    "row-count-mismatch",
    ({ reports }) => {
      reports.attach[1]!.runtimeAttestation.sourceRows = 101;
      reports.attach[1]!.semanticParity.counts.signedGuideSourceRows = 101;
    },
    "dataset version or row-count mismatch",
  );
  expectFailure(
    "active-row-tampering",
    ({ reports }) => {
      reports.attach[1]!.result.activeDatasetRows = 97;
    },
    "active/imported row count mismatch",
  );
  expectFailure(
    "unequal-groups",
    ({ paths }) => {
      paths.attach.pop();
    },
    "equal sample counts",
  );
  expectFailure(
    "even-groups",
    ({ paths }) => {
      paths.attach.pop();
      paths.legacy.pop();
    },
    "at least three signed reports|odd sample count",
  );
  expectFailure(
    "non-counterbalanced-order",
    ({ reports }) => {
      setTiming(reports.legacy[1]!, 1_040, 12);
      setTiming(reports.attach[1]!, 1_060, 6);
    },
    "alternate which strategy executes first",
  );
  expectFailure(
    "non-adjacent-pairs",
    ({ reports }) => {
      [reports.attach[1], reports.attach[2]] = [reports.attach[2]!, reports.attach[1]!];
    },
    "adjacent chronological positions",
  );
  expectFailure(
    "input-mode",
    () => {},
    "input report mode must be 0600",
    ({ paths }) => chmodSync(paths.attach[1]!, 0o644),
  );
  expectFailure(
    "symlink-input",
    ({ paths }) => {
      paths.attach[1] = join(dirname(paths.attach[1]!), "attach-symlink.json");
    },
    "regular non-symlink file",
    ({ paths }) => {
      rmSync(paths.attach[1]!);
      symlinkSync(paths.attach[0]!, paths.attach[1]!);
    },
  );
  expectFailure(
    "source-guard-disabled",
    ({ reports }) => {
      reports.attach[1]!.sourceGuard.capturedBeforeSQLiteAccess = false;
    },
    "pre-SQLite source capture",
  );
  expectFailure(
    "privacy-attestation-disabled",
    ({ reports }) => {
      reports.attach[1]!.restoration.aggregateOnlyReport = false;
    },
    "aggregate-only input report",
  );
  expectFailure(
    "raw-private-cleanup-disabled",
    ({ reports }) => {
      reports.attach[1]!.restoration.rawPrivateArtifactsDeleted = false;
    },
    "raw private artifact cleanup",
  );
  expectFailure(
    "private-extra-field",
    ({ reports }) => {
      Object.defineProperty(reports.attach[1]!, "privateRestaurantRows", {
        configurable: true,
        enumerable: true,
        value: [privateSentinel],
        writable: true,
      });
    },
    "unexpected schema",
  );
  expectFailure(
    "duration-tampering",
    ({ reports }) => {
      reports.attach[1]!.timing.triggerToImportCommitSeconds += 1;
    },
    "duration must match",
  );
  expectFailure(
    "rss-tampering",
    ({ reports }) => {
      reports.attach[1]!.timing.maximumObservedRssKib = reports.attach[1]!.timing.initialRssKib - 1;
    },
    "maximum RSS below initial RSS",
  );
  expectFailure(
    "output-exists",
    () => {},
    "already exists",
    ({ paths }) => {
      writeFileSync(paths.output, "reserved", { mode: 0o600 });
      chmodSync(paths.output, 0o600);
    },
    true,
  );

  console.log(
    "macOS Michelin import A/B summary contract passed: strict signed schema, materialized-guide identity, canonical semantic parity, private 0600 inputs/output, 3x3 alternating counterbalance, exact provenance, paired speedup/RSS, tamper rejection, and aggregate privacy.",
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
