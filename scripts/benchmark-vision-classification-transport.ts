#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { DEFAULT_FOOD_KEYWORDS } from "../utils/db/food-keyword-sync-core.ts";
import {
  decodePackedVisionClassificationResults,
  PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION,
  type VisionClassificationLabel,
  type VisionClassificationResult,
} from "../utils/vision-classification-transport-core.ts";
import { encodePackedVisionClassificationResults } from "./vision-classification-transport-oracle.ts";

type Strategy =
  | "legacyNestedJsonEncodeDecodeFood"
  | "packedBinaryEncodeDecodeFood"
  | "legacyNestedJsonDecodeOnly"
  | "packedBinaryDecodeOnly";

type FallbackReason =
  | "database-missing"
  | "database-not-file"
  | "database-unreadable"
  | "nonempty-write-sidecar"
  | "photos-schema-unavailable"
  | "no-analyzed-photos";

interface Configuration {
  readonly databasePath: string;
  readonly databaseSelection: "argument" | "environment" | "default";
  readonly outputPath: string;
  readonly samples: number;
  readonly warmupIterations: number;
}

interface RawPhotoRow {
  readonly assetId: unknown;
  readonly allLabelsJson: unknown;
  readonly foodLabelsJson: unknown;
}

interface ClassificationSourceRow {
  readonly assetId: string;
  readonly labels: VisionClassificationLabel[];
  readonly storedFoodLabels: VisionClassificationLabel[] | null;
}

interface ClassificationPage {
  readonly assetIds: string[];
  readonly results: VisionClassificationResult[];
  readonly storedFoodLabels: readonly (readonly VisionClassificationLabel[] | null)[];
}

interface FoodDetectionResult extends VisionClassificationResult {
  readonly containsFood: boolean;
  readonly foodConfidence: number;
  readonly foodLabels: VisionClassificationLabel[];
}

interface FileSnapshot {
  readonly bytes: number | null;
  readonly present: boolean;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly journal: FileSnapshot;
  readonly main: FileSnapshot;
  readonly shm: FileSnapshot;
  readonly wal: FileSnapshot;
}

interface DatasetMetrics {
  readonly allLabelOccurrences: number;
  readonly analyzedRows: number;
  readonly enabledFoodKeywordCount: number;
  readonly errorResults: number;
  readonly foodLabelOccurrencesFromCurrentTransform: number;
  readonly missingResults: number;
  readonly nonFloat32Confidences: number;
  readonly rawAllLabelsJsonBytes: number;
  readonly rawAssetIdUtf8Bytes: number;
  readonly rawFoodLabelsJsonBytes: number;
  readonly storedFoodLabelOccurrences: number;
  readonly storedFoodRowsMatchingCurrentTransform: number;
}

interface Dataset {
  readonly enabledKeywords: ReadonlySet<string>;
  readonly fallbackReason: FallbackReason | null;
  readonly metrics: DatasetMetrics;
  readonly mode: "immutable-real" | "synthetic";
  readonly pages: ClassificationPage[];
  readonly sourceBefore: SourceSnapshot | null;
}

interface ResultShape {
  readonly errorResults: number;
  readonly foodDetectedResults: number;
  readonly foodLabelOccurrences: number;
  readonly labelOccurrences: number;
  readonly results: number;
}

interface MeasurementSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

const PAGE_SIZE = 1_000;
const FOOD_CONFIDENCE_THRESHOLD = 0.3;
const DEFAULT_DATABASE_PATH = join(
  homedir(),
  "Library/Containers/3043B5A3-30EC-4EDC-9AB4-3AFC61142C73/Data/Documents/SQLite/photo_foodie.db",
);
const DEFAULT_OUTPUT_PATH = ".build/vision-classification-transport-profile.json";
const DEFAULT_SAMPLES = 12;
const DEFAULT_WARMUP_ITERATIONS = 4;
const SQLITE_PROTECTED_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const SYNTHETIC_ROW_COUNT = 13_059;
const SYNTHETIC_LABEL_VOCABULARY_SIZE = 672;
const STRATEGIES: readonly Strategy[] = [
  "legacyNestedJsonEncodeDecodeFood",
  "packedBinaryEncodeDecodeFood",
  "legacyNestedJsonDecodeOnly",
  "packedBinaryDecodeOnly",
];

function usage(): string {
  return `Usage: benchmark-vision-classification-transport.ts [options]

  --database=PATH  Palate SQLite source (default: PALATE_DATABASE_PATH or this Mac's container)
  --samples=N      Counterbalanced measured rounds (default: ${DEFAULT_SAMPLES})
  --warmup=N       Counterbalanced warmup rounds (default: ${DEFAULT_WARMUP_ITERATIONS})
  --output=PATH    Aggregate-only JSON report (default: ${DEFAULT_OUTPUT_PATH})
  --help, -h       Show this help

The real source is opened mode=ro, immutable=1, and query_only. A deterministic
synthetic corpus is used only when a safe real source is unavailable. Reports
never retain photo identifiers, label text, database paths, or raw rows.`;
}

function parseNonNegativeInteger(value: string, option: string, positive: boolean): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${positive ? "a positive" : "a non-negative"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new RangeError(`${option} must be ${positive ? "a positive" : "a non-negative"} integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const environmentDatabase = process.env.PALATE_DATABASE_PATH?.trim();
  let databasePath = environmentDatabase ? resolve(environmentDatabase) : DEFAULT_DATABASE_PATH;
  let databaseSelection: Configuration["databaseSelection"] = environmentDatabase ? "environment" : "default";
  let outputPath = resolve(DEFAULT_OUTPUT_PATH);
  let samples = DEFAULT_SAMPLES;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

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
    if (value.length === 0) {
      throw new RangeError(`${option} cannot be empty`);
    }
    switch (option) {
      case "--database":
        databasePath = resolve(value);
        databaseSelection = "argument";
        break;
      case "--samples":
        samples = parseNonNegativeInteger(value, option, true);
        break;
      case "--warmup":
        warmupIterations = parseNonNegativeInteger(value, option, false);
        break;
      case "--output":
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return { databasePath, databaseSelection, outputPath, samples, warmupIterations };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { bytes: null, present: false, sha256: null };
  }
  const metadata = statSync(path);
  return { bytes: metadata.size, present: true, sha256: sha256File(path) };
}

function snapshotSource(databasePath: string): SourceSnapshot {
  const main = realpathSync(databasePath);
  return {
    journal: snapshotFile(`${main}-journal`),
    main: snapshotFile(main),
    shm: snapshotFile(`${main}-shm`),
    wal: snapshotFile(`${main}-wal`),
  };
}

function snapshotHasPendingWriteData(snapshot: SourceSnapshot): boolean {
  return (snapshot.wal.bytes ?? 0) > 0 || (snapshot.journal.bytes ?? 0) > 0;
}

function canonicalizePotentialPath(path: string, visitedSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missingComponents: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (visitedSymlinks.has(ancestor)) {
          throw new Error("Benchmark path contains a symbolic-link cycle");
        }
        visitedSymlinks.add(ancestor);
        return resolve(
          canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), visitedSymlinks),
          ...missingComponents,
        );
      }
      return resolve(realpathSync(ancestor), ...missingComponents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingComponents.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function protectedSourcePaths(databasePath: string): string[] {
  const bases = [resolve(databasePath)];
  if (existsSync(databasePath)) {
    bases.push(realpathSync(databasePath));
  }
  return [...new Set(bases)].flatMap((base) => [
    base,
    ...SQLITE_PROTECTED_SIDECARS.map((suffix) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const canonicalOutput = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === canonicalOutput) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    if (outputIdentity && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not hard-link the source database or a SQLite sidecar");
      }
    }
  }
}

function sourceFallbackReason(databasePath: string): FallbackReason | null {
  if (!existsSync(databasePath)) {
    return "database-missing";
  }
  try {
    if (!statSync(databasePath).isFile()) {
      return "database-not-file";
    }
    const main = realpathSync(databasePath);
    const descriptor = openSync(main, "r");
    try {
      readSync(descriptor, Buffer.allocUnsafe(16), 0, 16, 0);
    } finally {
      closeSync(descriptor);
    }
    return null;
  } catch {
    return "database-unreadable";
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const url = pathToFileURL(realpathSync(databasePath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

interface OpenedImmutableSource {
  readonly database: DatabaseSync;
  readonly sourceBefore: SourceSnapshot;
}

type ImmutableDatabaseFactory = (databasePath: string) => DatabaseSync;

function defaultImmutableDatabaseFactory(databasePath: string): DatabaseSync {
  return new DatabaseSync(immutableDatabaseUri(databasePath), { readOnly: true });
}

export function openValidatedImmutableSource(
  databasePath: string,
  createDatabase: ImmutableDatabaseFactory = defaultImmutableDatabaseFactory,
): OpenedImmutableSource | FallbackReason {
  let database: DatabaseSync;
  try {
    database = createDatabase(databasePath);
  } catch {
    return "database-unreadable";
  }

  try {
    // Open first, then attest the exact source state. If a writer creates WAL
    // or rollback-journal data while the immutable handle opens, this snapshot
    // observes it before any benchmark query can read a stale main database.
    const sourceBefore = snapshotSource(databasePath);
    if (snapshotHasPendingWriteData(sourceBefore)) {
      database.close();
      return "nonempty-write-sidecar";
    }
    return { database, sourceBefore };
  } catch {
    try {
      database.close();
    } catch {
      // The source is already unusable; preserve the safe fallback result.
    }
    return "database-unreadable";
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseLabels(value: unknown, context: string): VisionClassificationLabel[] | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be stored as JSON text or NULL`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${context} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${context} must contain a JSON array`);
  }
  return parsed.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as { label?: unknown }).label !== "string" ||
      typeof (entry as { confidence?: unknown }).confidence !== "number" ||
      !Number.isFinite((entry as { confidence: number }).confidence)
    ) {
      throw new TypeError(`${context} entry ${index} is malformed`);
    }
    return {
      label: (entry as { label: string }).label,
      confidence: (entry as { confidence: number }).confidence,
    };
  });
}

function canonicalResult(result: VisionClassificationResult): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    assetId: result.assetId,
    labels: result.labels.map((label) => ({ label: label.label, confidence: label.confidence })),
  };
  if (result.error !== undefined) {
    canonical.error = result.error;
  }
  return canonical;
}

function canonicalResultsJson(results: readonly VisionClassificationResult[]): string {
  return JSON.stringify(results.map(canonicalResult));
}

function updateLengthPrefixedString(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function updateLengthPrefixedBytes(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

function isFoodLabel(label: string, enabledKeywords: ReadonlySet<string>): boolean {
  return enabledKeywords.has(label.trim().toLowerCase());
}

function transformFoodDetection(
  results: readonly VisionClassificationResult[],
  enabledKeywords: ReadonlySet<string>,
): FoodDetectionResult[] {
  return results.map((result) => {
    const foodLabels = result.labels.filter(
      (label) => isFoodLabel(label.label, enabledKeywords) && label.confidence >= FOOD_CONFIDENCE_THRESHOLD,
    );
    const foodConfidence = foodLabels.length === 0 ? 0 : Math.max(...foodLabels.map((label) => label.confidence));
    return {
      assetId: result.assetId,
      containsFood: foodLabels.length > 0,
      foodConfidence,
      foodLabels,
      labels: result.labels,
      error: result.error,
    };
  });
}

function canonicalFoodResultsJson(results: readonly FoodDetectionResult[]): string {
  return JSON.stringify(
    results.map((result) => {
      const canonical: Record<string, unknown> = {
        assetId: result.assetId,
        containsFood: result.containsFood,
        foodConfidence: result.foodConfidence,
        foodLabels: result.foodLabels.map((label) => ({ label: label.label, confidence: label.confidence })),
        labels: result.labels.map((label) => ({ label: label.label, confidence: label.confidence })),
      };
      if (result.error !== undefined) {
        canonical.error = result.error;
      }
      return canonical;
    }),
  );
}

function resultShape(results: readonly VisionClassificationResult[]): ResultShape {
  let errorResults = 0;
  let labelOccurrences = 0;
  for (const result of results) {
    errorResults += result.error === undefined ? 0 : 1;
    labelOccurrences += result.labels.length;
  }
  return { errorResults, foodDetectedResults: 0, foodLabelOccurrences: 0, labelOccurrences, results: results.length };
}

function foodResultShape(results: readonly FoodDetectionResult[]): ResultShape {
  let errorResults = 0;
  let foodDetectedResults = 0;
  let foodLabelOccurrences = 0;
  let labelOccurrences = 0;
  for (const result of results) {
    errorResults += result.error === undefined ? 0 : 1;
    foodDetectedResults += result.containsFood ? 1 : 0;
    foodLabelOccurrences += result.foodLabels.length;
    labelOccurrences += result.labels.length;
  }
  return { errorResults, foodDetectedResults, foodLabelOccurrences, labelOccurrences, results: results.length };
}

function addShapes(left: ResultShape, right: ResultShape): ResultShape {
  return {
    errorResults: left.errorResults + right.errorResults,
    foodDetectedResults: left.foodDetectedResults + right.foodDetectedResults,
    foodLabelOccurrences: left.foodLabelOccurrences + right.foodLabelOccurrences,
    labelOccurrences: left.labelOccurrences + right.labelOccurrences,
    results: left.results + right.results,
  };
}

function emptyShape(): ResultShape {
  return { errorResults: 0, foodDetectedResults: 0, foodLabelOccurrences: 0, labelOccurrences: 0, results: 0 };
}

function paginate(rows: readonly ClassificationSourceRow[]): ClassificationPage[] {
  const pages: ClassificationPage[] = [];
  for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
    const pageRows = rows.slice(offset, offset + PAGE_SIZE);
    pages.push({
      assetIds: pageRows.map((row) => row.assetId),
      results: pageRows.map((row) => ({ assetId: row.assetId, labels: row.labels })),
      storedFoodLabels: pageRows.map((row) => row.storedFoodLabels),
    });
  }
  return pages;
}

function readEnabledKeywords(database: DatabaseSync): Set<string> {
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'food_keywords'")
    .get() as { present?: unknown } | undefined;
  if (table?.present !== 1) {
    return new Set(DEFAULT_FOOD_KEYWORDS);
  }
  const rows = database
    .prepare("SELECT keyword FROM food_keywords WHERE enabled = 1 ORDER BY keyword ASC")
    .all() as Array<{ keyword?: unknown }>;
  const keywords = rows
    .map((row) => row.keyword)
    .filter((keyword): keyword is string => typeof keyword === "string")
    .map((keyword) => keyword.trim().toLowerCase());
  return new Set(keywords);
}

function buildDatasetMetrics(
  rows: readonly ClassificationSourceRow[],
  enabledKeywords: ReadonlySet<string>,
  rawAssetIdUtf8Bytes: number,
  rawAllLabelsJsonBytes: number,
  rawFoodLabelsJsonBytes: number,
): DatasetMetrics {
  let allLabelOccurrences = 0;
  let foodLabelOccurrencesFromCurrentTransform = 0;
  let nonFloat32Confidences = 0;
  let storedFoodLabelOccurrences = 0;
  let storedFoodRowsMatchingCurrentTransform = 0;

  for (const row of rows) {
    allLabelOccurrences += row.labels.length;
    nonFloat32Confidences += row.labels.filter(
      (label) => !Object.is(Math.fround(label.confidence), label.confidence),
    ).length;
    const transformed = transformFoodDetection([{ assetId: row.assetId, labels: row.labels }], enabledKeywords)[0]!;
    foodLabelOccurrencesFromCurrentTransform += transformed.foodLabels.length;
    storedFoodLabelOccurrences += row.storedFoodLabels?.length ?? 0;
    if (
      JSON.stringify(row.storedFoodLabels) ===
      JSON.stringify(transformed.foodLabels.map((label) => ({ label: label.label, confidence: label.confidence })))
    ) {
      storedFoodRowsMatchingCurrentTransform++;
    }
  }

  return {
    allLabelOccurrences,
    analyzedRows: rows.length,
    enabledFoodKeywordCount: enabledKeywords.size,
    errorResults: 0,
    foodLabelOccurrencesFromCurrentTransform,
    missingResults: 0,
    nonFloat32Confidences,
    rawAllLabelsJsonBytes,
    rawAssetIdUtf8Bytes,
    rawFoodLabelsJsonBytes,
    storedFoodLabelOccurrences,
    storedFoodRowsMatchingCurrentTransform,
  };
}

function loadRealDataset(databasePath: string): Dataset | FallbackReason {
  const openedSource = openValidatedImmutableSource(databasePath);
  if (typeof openedSource === "string") {
    return openedSource;
  }
  const { database, sourceBefore } = openedSource;
  let outcome: Dataset | FallbackReason;
  let transactionActive = false;

  try {
    database.exec("PRAGMA query_only = ON; BEGIN");
    transactionActive = true;
    const queryOnly = database.prepare("PRAGMA query_only").get() as { query_only?: unknown } | undefined;
    assert.equal(queryOnly?.query_only, 1, "SQLite query_only must be enabled");
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('photos') WHERE name IN ('id', 'allLabels', 'foodLabels')")
      .all() as Array<{ name?: unknown }>;
    if (new Set(columns.map((row) => row.name)).size !== 3) {
      outcome = "photos-schema-unavailable";
    } else {
      const enabledKeywords = readEnabledKeywords(database);
      const rawRows = database
        .prepare(
          `SELECT id AS assetId, allLabels AS allLabelsJson, foodLabels AS foodLabelsJson
           FROM photos
           WHERE allLabels IS NOT NULL
           ORDER BY id ASC`,
        )
        .all() as unknown as RawPhotoRow[];
      if (rawRows.length === 0) {
        outcome = "no-analyzed-photos";
      } else {
        let rawAssetIdUtf8Bytes = 0;
        let rawAllLabelsJsonBytes = 0;
        let rawFoodLabelsJsonBytes = 0;
        const rows = rawRows.map((rawRow, index): ClassificationSourceRow => {
          if (typeof rawRow.assetId !== "string" || typeof rawRow.allLabelsJson !== "string") {
            throw new TypeError(`Analyzed photo row ${index} has an invalid identifier or allLabels value`);
          }
          if (rawRow.foodLabelsJson !== null && typeof rawRow.foodLabelsJson !== "string") {
            throw new TypeError(`Analyzed photo row ${index} has an invalid foodLabels value`);
          }
          rawAssetIdUtf8Bytes += utf8Bytes(rawRow.assetId);
          rawAllLabelsJsonBytes += utf8Bytes(rawRow.allLabelsJson);
          rawFoodLabelsJsonBytes += rawRow.foodLabelsJson === null ? 0 : utf8Bytes(rawRow.foodLabelsJson);
          return {
            assetId: rawRow.assetId,
            labels: parseLabels(rawRow.allLabelsJson, `Analyzed photo row ${index} allLabels`)!,
            storedFoodLabels: parseLabels(rawRow.foodLabelsJson, `Analyzed photo row ${index} foodLabels`),
          };
        });
        const metrics = buildDatasetMetrics(
          rows,
          enabledKeywords,
          rawAssetIdUtf8Bytes,
          rawAllLabelsJsonBytes,
          rawFoodLabelsJsonBytes,
        );
        if (metrics.nonFloat32Confidences !== 0) {
          throw new Error(
            "Real Vision source contains confidence values that cannot round-trip through Float32 exactly",
          );
        }
        outcome = {
          enabledKeywords,
          fallbackReason: null,
          metrics,
          mode: "immutable-real",
          pages: paginate(rows),
          sourceBefore,
        };
      }
    }
    database.exec("COMMIT");
    transactionActive = false;
  } catch (error) {
    if (transactionActive) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the primary validation failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }

  assert.deepEqual(
    snapshotSource(databasePath),
    sourceBefore,
    "Source database or sidecar changed while loading the immutable benchmark dataset",
  );
  return outcome;
}

function syntheticConfidence(rowIndex: number, labelIndex: number): number {
  return Math.fround(0.1 + ((rowIndex * 37 + labelIndex * 17) % 890) / 1_000);
}

function createSyntheticDataset(fallbackReason: FallbackReason): Dataset {
  const enabledKeywords = new Set(DEFAULT_FOOD_KEYWORDS);
  const rows: ClassificationSourceRow[] = [];
  let rawAssetIdUtf8Bytes = 0;
  let rawAllLabelsJsonBytes = 0;
  let rawFoodLabelsJsonBytes = 0;

  for (let rowIndex = 0; rowIndex < SYNTHETIC_ROW_COUNT; rowIndex++) {
    const assetId = `synthetic-asset-${rowIndex.toString().padStart(6, "0")}`;
    const labelCount = rowIndex % 29 === 0 ? 0 : 6 + (rowIndex % 6);
    const labels: VisionClassificationLabel[] = [];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const useFoodKeyword = labelIndex === 0 && rowIndex % 5 === 0;
      labels.push({
        label: useFoodKeyword
          ? DEFAULT_FOOD_KEYWORDS[rowIndex % DEFAULT_FOOD_KEYWORDS.length]!
          : `synthetic-label-${(rowIndex * 11 + labelIndex * 31) % SYNTHETIC_LABEL_VOCABULARY_SIZE}`,
        confidence: syntheticConfidence(rowIndex, labelIndex),
      });
    }
    const transformed = transformFoodDetection([{ assetId, labels }], enabledKeywords)[0]!;
    const allLabelsJson = JSON.stringify(labels);
    const foodLabelsJson = JSON.stringify(transformed.foodLabels);
    rawAssetIdUtf8Bytes += utf8Bytes(assetId);
    rawAllLabelsJsonBytes += utf8Bytes(allLabelsJson);
    rawFoodLabelsJsonBytes += utf8Bytes(foodLabelsJson);
    rows.push({ assetId, labels, storedFoodLabels: transformed.foodLabels });
  }

  return {
    enabledKeywords,
    fallbackReason,
    metrics: buildDatasetMetrics(
      rows,
      enabledKeywords,
      rawAssetIdUtf8Bytes,
      rawAllLabelsJsonBytes,
      rawFoodLabelsJsonBytes,
    ),
    mode: "synthetic",
    pages: paginate(rows),
    sourceBefore: null,
  };
}

function loadDataset(configuration: Configuration): Dataset {
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  const fallbackReason = sourceFallbackReason(configuration.databasePath);
  if (fallbackReason !== null) {
    return createSyntheticDataset(fallbackReason);
  }
  const realDataset = loadRealDataset(configuration.databasePath);
  return typeof realDataset === "string" ? createSyntheticDataset(realDataset) : realDataset;
}

function semanticDigest(pages: readonly ClassificationPage[]): string {
  const hash = createHash("sha256");
  for (const page of pages) {
    updateLengthPrefixedString(hash, canonicalResultsJson(page.results));
  }
  return hash.digest("hex");
}

function foodSemanticDigest(pages: readonly ClassificationPage[], enabledKeywords: ReadonlySet<string>): string {
  const hash = createHash("sha256");
  for (const page of pages) {
    updateLengthPrefixedString(hash, canonicalFoodResultsJson(transformFoodDetection(page.results, enabledKeywords)));
  }
  return hash.digest("hex");
}

function storedFoodSemanticDigest(pages: readonly ClassificationPage[]): string {
  const hash = createHash("sha256");
  for (const page of pages) {
    updateLengthPrefixedString(hash, JSON.stringify(page.storedFoodLabels));
  }
  return hash.digest("hex");
}

function payloadDigest(payloads: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const payload of payloads) {
    updateLengthPrefixedBytes(hash, payload);
  }
  return hash.digest("hex");
}

function stringPayloadDigest(payloads: readonly string[]): string {
  const hash = createHash("sha256");
  for (const payload of payloads) {
    updateLengthPrefixedString(hash, payload);
  }
  return hash.digest("hex");
}

function counterbalancedOrder(round: number): Strategy[] {
  const offset = round % STRATEGIES.length;
  const rotated = [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)];
  return Math.floor(round / STRATEGIES.length) % 2 === 0 ? rotated : rotated.reverse();
}

function percentileNearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]!;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summarize(values: readonly number[]): MeasurementSummary {
  return {
    maximumMilliseconds: Math.max(...values),
    medianMilliseconds: median(values),
    minimumMilliseconds: Math.min(...values),
    p95Milliseconds: percentileNearestRank(values, 0.95),
    samplesMilliseconds: values,
  };
}

function assertShape(actual: ResultShape, expected: ResultShape, strategy: Strategy): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${strategy} produced an aggregate semantic mismatch`);
  }
}

function run(configuration: Configuration): void {
  const dataset = loadDataset(configuration);
  const enabledKeywords = dataset.enabledKeywords;

  const legacyPayloads = dataset.pages.map((page) => JSON.stringify(page.results));
  const packedPayloads = dataset.pages.map((page) =>
    encodePackedVisionClassificationResults(page.assetIds, page.results),
  );
  const sourceDigest = semanticDigest(dataset.pages);
  const decodedHash = createHash("sha256");
  const currentParsedHash = createHash("sha256");
  let exactPageParity = true;
  for (const [pageIndex, page] of dataset.pages.entries()) {
    const currentParsed = JSON.parse(legacyPayloads[pageIndex]!) as VisionClassificationResult[];
    const packedDecoded = decodePackedVisionClassificationResults(page.assetIds, packedPayloads[pageIndex]!);
    const expectedJson = canonicalResultsJson(page.results);
    const currentJson = canonicalResultsJson(currentParsed);
    const packedJson = canonicalResultsJson(packedDecoded);
    exactPageParity &&= expectedJson === currentJson && expectedJson === packedJson;
    updateLengthPrefixedString(currentParsedHash, currentJson);
    updateLengthPrefixedString(decodedHash, packedJson);
  }
  if (!exactPageParity) {
    throw new Error("Vision transport exact page parity failed");
  }
  const currentParsedDigest = currentParsedHash.digest("hex");
  const packedDecodedDigest = decodedHash.digest("hex");
  assert.equal(currentParsedDigest, sourceDigest, "Legacy decoded semantic digest must match the source");
  assert.equal(packedDecodedDigest, sourceDigest, "Packed decoded semantic digest must match the source");

  const expectedDecodeShape = dataset.pages.reduce(
    (shape, page) => addShapes(shape, resultShape(page.results)),
    emptyShape(),
  );
  const expectedFoodShape = dataset.pages.reduce(
    (shape, page) => addShapes(shape, foodResultShape(transformFoodDetection(page.results, enabledKeywords))),
    emptyShape(),
  );

  const operations: Record<Strategy, () => ResultShape> = {
    legacyNestedJsonEncodeDecodeFood: () => {
      let shape = emptyShape();
      for (const page of dataset.pages) {
        const decoded = JSON.parse(JSON.stringify(page.results)) as VisionClassificationResult[];
        shape = addShapes(shape, foodResultShape(transformFoodDetection(decoded, enabledKeywords)));
      }
      return shape;
    },
    packedBinaryEncodeDecodeFood: () => {
      let shape = emptyShape();
      for (const page of dataset.pages) {
        const payload = encodePackedVisionClassificationResults(page.assetIds, page.results);
        const decoded = decodePackedVisionClassificationResults(page.assetIds, payload);
        shape = addShapes(shape, foodResultShape(transformFoodDetection(decoded, enabledKeywords)));
      }
      return shape;
    },
    legacyNestedJsonDecodeOnly: () => {
      let shape = emptyShape();
      for (const payload of legacyPayloads) {
        shape = addShapes(shape, resultShape(JSON.parse(payload) as VisionClassificationResult[]));
      }
      return shape;
    },
    packedBinaryDecodeOnly: () => {
      let shape = emptyShape();
      for (const [pageIndex, page] of dataset.pages.entries()) {
        shape = addShapes(
          shape,
          resultShape(decodePackedVisionClassificationResults(page.assetIds, packedPayloads[pageIndex]!)),
        );
      }
      return shape;
    },
  };

  const expectedShapeByStrategy: Record<Strategy, ResultShape> = {
    legacyNestedJsonEncodeDecodeFood: expectedFoodShape,
    packedBinaryEncodeDecodeFood: expectedFoodShape,
    legacyNestedJsonDecodeOnly: expectedDecodeShape,
    packedBinaryDecodeOnly: expectedDecodeShape,
  };
  for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
    for (const strategy of counterbalancedOrder(warmup)) {
      assertShape(operations[strategy](), expectedShapeByStrategy[strategy], strategy);
    }
  }

  const samples = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, [] as number[]])) as Record<
    Strategy,
    number[]
  >;
  const measurementOrder: Strategy[][] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    const order = counterbalancedOrder(sample + configuration.warmupIterations);
    measurementOrder.push(order);
    for (const strategy of order) {
      const startedAt = performance.now();
      const shape = operations[strategy]();
      samples[strategy].push(performance.now() - startedAt);
      assertShape(shape, expectedShapeByStrategy[strategy], strategy);
    }
  }

  const legacyPayloadBytes = legacyPayloads.reduce((sum, payload) => sum + utf8Bytes(payload), 0);
  const packedPayloadBytes = packedPayloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const timing = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, summarize(samples[strategy])])) as Record<
    Strategy,
    MeasurementSummary
  >;
  const sourceAfterTiming = dataset.mode === "immutable-real" ? snapshotSource(configuration.databasePath) : null;
  if (dataset.mode === "immutable-real") {
    assert.deepEqual(
      sourceAfterTiming,
      dataset.sourceBefore,
      "Read-only timing changed the source database or a sidecar",
    );
  }

  const report = {
    schemaVersion: 2,
    status: "ok",
    benchmarkScope:
      "Node/V8 models the current nested classification result as JSON encode/decode and compares the repository binary V1 oracle. It includes JavaScript encoding, payload creation, decoding, validation, and food transformation as labeled; it excludes Vision, PhotoKit, Swift/Expo serialization and copies, React Native scheduling, Hermes, SQLite persistence, and app rendering.",
    configuration: {
      binarySchemaVersion: PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION,
      databaseSelection: configuration.databaseSelection,
      pageSize: PAGE_SIZE,
      samples: configuration.samples,
      warmupIterations: configuration.warmupIterations,
    },
    runtime: {
      node: process.version,
      sqlite: process.versions.sqlite,
      v8: process.versions.v8,
    },
    dataset: {
      ...dataset.metrics,
      fallbackReason: dataset.fallbackReason,
      mode: dataset.mode,
      pageCount: dataset.pages.length,
      finalPageRows: dataset.pages.at(-1)?.assetIds.length ?? 0,
    },
    payload: {
      binaryBytes: packedPayloadBytes,
      binaryBytesPerAnalyzedRow: packedPayloadBytes / dataset.metrics.analyzedRows,
      binaryPayloadSha256: payloadDigest(packedPayloads),
      bytesSaved: legacyPayloadBytes - packedPayloadBytes,
      legacyNestedJsonBytes: legacyPayloadBytes,
      legacyNestedJsonBytesPerAnalyzedRow: legacyPayloadBytes / dataset.metrics.analyzedRows,
      legacyNestedJsonPayloadSha256: stringPayloadDigest(legacyPayloads),
      reductionPercent: ((legacyPayloadBytes - packedPayloadBytes) / legacyPayloadBytes) * 100,
    },
    correctness: {
      currentFoodSemanticSha256: foodSemanticDigest(dataset.pages, enabledKeywords),
      exactDecodedPageParity: exactPageParity,
      legacyDecodedSemanticSha256: currentParsedDigest,
      packedDecodedSemanticSha256: packedDecodedDigest,
      sourceSemanticSha256: sourceDigest,
      storedFoodSemanticSha256: storedFoodSemanticDigest(dataset.pages),
    },
    timing: {
      ...timing,
      comparisons: {
        decodeOnlySpeedup:
          timing.legacyNestedJsonDecodeOnly.medianMilliseconds / timing.packedBinaryDecodeOnly.medianMilliseconds,
        encodeDecodeFoodSpeedup:
          timing.legacyNestedJsonEncodeDecodeFood.medianMilliseconds /
          timing.packedBinaryEncodeDecodeFood.medianMilliseconds,
      },
      measurementOrder,
      p95Method: "nearest-rank",
    },
    privacy: {
      aggregateOnly: true,
      databasePathRetained: false,
      identifiersRetained: false,
      labelTextRetained: false,
      rawRowsRetained: false,
    },
    sourceAttestation:
      dataset.mode === "immutable-real"
        ? {
            after: sourceAfterTiming,
            before: dataset.sourceBefore,
            mainAndSidecarsByteIdentical: true,
            openMode: "mode=ro, immutable=1, PRAGMA query_only=ON, one read transaction",
          }
        : null,
  };

  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  mkdirSync(dirname(configuration.outputPath), { mode: 0o700, recursive: true });
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configuration.outputPath, 0o600);
  if (dataset.mode === "immutable-real") {
    assert.deepEqual(
      snapshotSource(configuration.databasePath),
      dataset.sourceBefore,
      "Publishing the aggregate report changed the source database or a sidecar",
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
  } else {
    run(configuration);
  }
}
