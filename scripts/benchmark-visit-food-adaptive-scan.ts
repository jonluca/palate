#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  commitAdaptiveVisitFoodTransition,
  createAdaptiveVisitFoodState,
  getAdaptiveVisitFoodWave,
  resolveAdaptiveVisitFoodWave,
  type AdaptiveVisitFoodOutcome,
  type AdaptiveVisitFoodSample,
  type AdaptiveVisitFoodState,
} from "../utils/visit-food-adaptive-scan-core.ts";

interface Configuration {
  readonly databasePath: string | null;
  readonly outputPath: string | null;
  readonly visitCount: number;
  readonly plannedSamples: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly nativePageSize: number;
}

interface Dataset {
  readonly mode: "synthetic" | "retained-private-control";
  readonly samples: readonly AdaptiveVisitFoodSample[];
  readonly outcomes: ReadonlyMap<string, AdaptiveVisitFoodOutcome>;
  readonly sqliteVersion: string | null;
}

interface FullOracleResult {
  readonly positiveVisitIds: readonly string[];
  readonly attemptedClassifications: number;
}

interface AdaptiveModelResult {
  readonly state: AdaptiveVisitFoodState;
  readonly waveCount: number;
  readonly modeledNativeCalls: number;
  readonly maximumWaveSize: number;
}

interface BoundedPrefixModel {
  readonly adaptivePrefixRanks: number;
  readonly prefixClassifications: number;
  readonly bulkTailClassifications: number;
  readonly totalClassifications: number;
  readonly avoidedClassifications: number;
  readonly avoidedPercent: number;
  readonly modeledNativeCalls: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: readonly number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface FileIdentity {
  readonly present: boolean;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly mode: string | null;
}

interface DatabaseIdentity {
  readonly main: FileIdentity;
  readonly wal: FileIdentity;
  readonly shm: FileIdentity;
  readonly journal: FileIdentity;
}

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RETAINED_CONTROL_PATH = resolve(WORKSPACE_ROOT, ".build/vision-transport-control-signed-20260710.result.db");
const BOUNDED_PREFIX_CUTOFFS = [1, 2, 3, 5, 10] as const;
const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  outputPath: null,
  visitCount: 6_510,
  plannedSamples: 13_059,
  samples: 9,
  warmupIterations: 2,
  nativePageSize: 1_000,
};

function usage(): string {
  return `Usage: benchmark-visit-food-adaptive-scan.ts [options]

  --database=retained|PATH  Use only the exact retained .build Vision control copy
  --output=PATH             Write a new mode-0600 JSON report under .build
  --visits=N               Synthetic visit count (default: ${DEFAULT_CONFIGURATION.visitCount})
  --planned-samples=N      Synthetic planned classifications (default: ${DEFAULT_CONFIGURATION.plannedSamples})
  --samples=N              Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N               Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --native-page-size=N     Modeled bounded native request size (default: ${DEFAULT_CONFIGURATION.nativePageSize})
  --help, -h               Show this help

The database option is deliberately restricted to
  ${RETAINED_CONTROL_PATH}
and cannot open the live Palate database.`;
}

function integerOption(value: string | undefined, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`);
  }
  return parsed;
}

function resolveRetainedDatabasePath(value: string): string {
  const requested = value === "retained" ? RETAINED_CONTROL_PATH : resolve(value);
  // Reject every other lexical path before issuing even a metadata syscall, so
  // this profiler cannot inspect the protected live Palate database by mistake.
  if (requested !== RETAINED_CONTROL_PATH) {
    throw new Error("--database may only reference the exact retained .build Vision control database.");
  }
  if (!existsSync(requested)) {
    throw new Error(`Retained Vision control database does not exist: ${requested}`);
  }
  const canonicalRequested = realpathSync(requested);
  const canonicalAllowed = realpathSync(RETAINED_CONTROL_PATH);
  if (canonicalRequested !== canonicalAllowed) {
    throw new Error("--database may only reference the exact retained .build Vision control database.");
  }
  return canonicalRequested;
}

function resolveOutputPath(value: string): string {
  const requested = resolve(value);
  const buildDirectory = resolve(WORKSPACE_ROOT, ".build");
  if (!requested.startsWith(`${buildDirectory}/`) || !requested.endsWith(".json")) {
    throw new Error("--output must be a .json path inside the workspace .build directory.");
  }
  if (requested === RETAINED_CONTROL_PATH) {
    throw new Error("--output cannot alias the retained Vision control database.");
  }
  return requested;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === "--") {
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const key = argument.slice(2, separator);
    if (values.has(key)) {
      throw new Error(`Duplicate option: --${key}`);
    }
    values.set(key, argument.slice(separator + 1));
  }

  const known = new Set(["database", "output", "visits", "planned-samples", "samples", "warmup", "native-page-size"]);
  for (const key of values.keys()) {
    if (!known.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }

  const databaseValue = values.get("database");
  const configuration: Configuration = {
    databasePath: databaseValue === undefined ? null : resolveRetainedDatabasePath(databaseValue),
    outputPath: values.has("output") ? resolveOutputPath(values.get("output") ?? "") : null,
    visitCount: values.has("visits")
      ? integerOption(values.get("visits"), "--visits")
      : DEFAULT_CONFIGURATION.visitCount,
    plannedSamples: values.has("planned-samples")
      ? integerOption(values.get("planned-samples"), "--planned-samples")
      : DEFAULT_CONFIGURATION.plannedSamples,
    samples: values.has("samples") ? integerOption(values.get("samples"), "--samples") : DEFAULT_CONFIGURATION.samples,
    warmupIterations: values.has("warmup")
      ? integerOption(values.get("warmup"), "--warmup", true)
      : DEFAULT_CONFIGURATION.warmupIterations,
    nativePageSize: values.has("native-page-size")
      ? integerOption(values.get("native-page-size"), "--native-page-size")
      : DEFAULT_CONFIGURATION.nativePageSize,
  };
  if (configuration.databasePath === null && configuration.plannedSamples < configuration.visitCount) {
    throw new Error("--planned-samples must be at least --visits so every synthetic visit has rank one.");
  }
  return configuration;
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
  return state.value;
}

function createSyntheticDataset(configuration: Configuration): Dataset {
  const random = { value: 0x51f15e };
  const counts = new Uint32Array(configuration.visitCount);
  counts.fill(1);
  for (let index = configuration.visitCount; index < configuration.plannedSamples; index++) {
    const boundedSkew = index % 5 === 0;
    const range = boundedSkew ? Math.max(1, Math.floor(configuration.visitCount / 10)) : configuration.visitCount;
    counts[nextRandom(random) % range] += 1;
  }

  const samples: AdaptiveVisitFoodSample[] = [];
  const outcomes = new Map<string, AdaptiveVisitFoodOutcome>();
  for (let visitIndex = 0; visitIndex < configuration.visitCount; visitIndex++) {
    const visitId = `synthetic-visit-${visitIndex.toString().padStart(5, "0")}`;
    const sampleCount = counts[visitIndex];
    const isFoodVisit = nextRandom(random) % 1_000 < 157;
    const foodRank = isFoodVisit ? 1 + (nextRandom(random) % sampleCount) : null;
    for (let rank = 1; rank <= sampleCount; rank++) {
      const photoId = `${visitId}-photo-${rank.toString().padStart(3, "0")}`;
      samples.push({ visitId, photoId, sampleRank: rank });
      const outcomeKind = nextRandom(random) % 251;
      if (outcomeKind === 0) {
        continue;
      }
      if (outcomeKind === 1) {
        outcomes.set(photoId, { photoId, status: "failure" });
      } else {
        outcomes.set(photoId, { photoId, status: "success", containsFood: rank === foodRank });
      }
    }
  }
  return { mode: "synthetic", samples, outcomes, sqliteVersion: null };
}

function fileIdentity(path: string): FileIdentity {
  if (!existsSync(path)) {
    return { present: false, bytes: null, sha256: null, mode: null };
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    throw new Error(`SQLite component is not a regular file: ${path}`);
  }
  return {
    present: true,
    bytes: metadata.size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
  };
}

function databaseIdentity(path: string): DatabaseIdentity {
  return {
    main: fileIdentity(path),
    wal: fileIdentity(`${path}-wal`),
    shm: fileIdentity(`${path}-shm`),
    journal: fileIdentity(`${path}-journal`),
  };
}

function assertImmutableSourceReady(identity: DatabaseIdentity): void {
  if (!identity.main.present || identity.main.bytes === 0) {
    throw new Error("Retained Vision control database main file is absent or empty.");
  }
  if (identity.wal.present && identity.wal.bytes !== 0) {
    throw new Error("Retained Vision control database has a non-empty WAL and cannot be opened immutable.");
  }
  if (identity.journal.present && identity.journal.bytes !== 0) {
    throw new Error("Retained Vision control database has a non-empty rollback journal.");
  }
}

function immutableDatabaseUri(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function loadRetainedDataset(path: string): { dataset: Dataset; before: DatabaseIdentity } {
  const before = databaseIdentity(path);
  assertImmutableSourceReady(before);
  const database = new DatabaseSync(immutableDatabaseUri(path), { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; BEGIN;");
    const tableCount = Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('photos', 'visits')")
          .get() as { count: number | bigint }
      ).count,
    );
    if (tableCount !== 2) {
      throw new Error("Retained Vision control database is missing photos or visits.");
    }
    const rows = database
      .prepare(
        `WITH ranked AS (
           SELECT
             photo.visitId,
             photo.id AS photoId,
             photo.foodDetected,
             ROW_NUMBER() OVER (
               PARTITION BY photo.visitId
               ORDER BY photo.creationTime ASC, photo.id ASC
             ) AS sampleRank
           FROM photos AS photo
           WHERE photo.visitId IS NOT NULL
             AND photo.foodDetected IS NOT NULL
             AND photo.allLabels IS NOT NULL
         )
         SELECT ranked.visitId, ranked.photoId, ranked.sampleRank, ranked.foodDetected
         FROM ranked
         INNER JOIN visits AS visit ON visit.id = ranked.visitId
         ORDER BY visit.startTime DESC, ranked.visitId ASC, ranked.sampleRank ASC`,
      )
      .all() as Array<{
      visitId: unknown;
      photoId: unknown;
      sampleRank: unknown;
      foodDetected: unknown;
    }>;
    if (rows.length === 0) {
      throw new Error("Retained Vision control database contains no analyzed visit photos.");
    }

    const samples: AdaptiveVisitFoodSample[] = [];
    const outcomes = new Map<string, AdaptiveVisitFoodOutcome>();
    for (const [index, row] of rows.entries()) {
      if (typeof row.visitId !== "string" || row.visitId.length === 0) {
        throw new Error(`Retained row ${index} has an invalid visitId.`);
      }
      if (typeof row.photoId !== "string" || row.photoId.length === 0) {
        throw new Error(`Retained row ${index} has an invalid photoId.`);
      }
      const sampleRank = Number(row.sampleRank);
      if (!Number.isSafeInteger(sampleRank) || sampleRank < 1) {
        throw new Error(`Retained row ${index} has an invalid sampleRank.`);
      }
      const foodDetected = Number(row.foodDetected);
      if (foodDetected !== 0 && foodDetected !== 1) {
        throw new Error(`Retained row ${index} has an invalid foodDetected value.`);
      }
      samples.push({ visitId: row.visitId, photoId: row.photoId, sampleRank });
      outcomes.set(row.photoId, { photoId: row.photoId, status: "success", containsFood: foodDetected === 1 });
    }
    const sqliteVersion = String(
      (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
    );
    database.exec("COMMIT;");
    return {
      dataset: { mode: "retained-private-control", samples, outcomes, sqliteVersion },
      before,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The primary validation/open error remains authoritative.
    }
    throw error;
  } finally {
    database.close();
  }
}

function runFullOracle(dataset: Dataset): FullOracleResult {
  const positiveVisitIds = new Set<string>();
  for (const sample of dataset.samples) {
    const outcome = dataset.outcomes.get(sample.photoId);
    if (outcome?.status === "success" && outcome.containsFood) {
      positiveVisitIds.add(sample.visitId);
    }
  }
  return {
    positiveVisitIds: [...positiveVisitIds].sort(),
    attemptedClassifications: dataset.samples.length,
  };
}

function runAdaptiveModel(dataset: Dataset, nativePageSize: number): AdaptiveModelResult {
  let state = createAdaptiveVisitFoodState(dataset.samples);
  let waveCount = 0;
  let modeledNativeCalls = 0;
  let maximumWaveSize = 0;
  while (!state.isComplete) {
    const wave = getAdaptiveVisitFoodWave(state);
    maximumWaveSize = Math.max(maximumWaveSize, wave.length);
    modeledNativeCalls += Math.ceil(wave.length / nativePageSize);
    waveCount += 1;
    const outcomes = wave.flatMap((sample) => {
      const outcome = dataset.outcomes.get(sample.photoId);
      return outcome ? [outcome] : [];
    });
    const transition = resolveAdaptiveVisitFoodWave(state, outcomes);
    state = commitAdaptiveVisitFoodTransition(state, transition);
  }
  return { state, waveCount, modeledNativeCalls, maximumWaveSize };
}

/**
 * Model a production-safe hybrid: run only the first N adaptive ranks, then
 * concatenate every remaining sample for non-positive visits into the existing
 * bounded full-plan pipeline. This retains complete positive-visit parity while
 * avoiding the one-native-call-per-rank long tail.
 */
function modelBoundedPrefix(
  dataset: Dataset,
  state: AdaptiveVisitFoodState,
  adaptivePrefixRanks: number,
  nativePageSize: number,
): BoundedPrefixModel {
  const firstFoodRankByVisit = new Map<string, number>();
  for (const visit of state.plan.visits) {
    const firstFood = visit.samples.find((sample) => {
      const outcome = dataset.outcomes.get(sample.photoId);
      return outcome?.status === "success" && outcome.containsFood === true;
    });
    if (firstFood) {
      firstFoodRankByVisit.set(visit.visitId, firstFood.sampleRank);
    }
  }

  let prefixClassifications = 0;
  let prefixNativeCalls = 0;
  for (let rank = 1; rank <= adaptivePrefixRanks; rank++) {
    let waveSize = 0;
    for (const visit of state.plan.visits) {
      const firstFoodRank = firstFoodRankByVisit.get(visit.visitId) ?? Number.POSITIVE_INFINITY;
      if (visit.samples.length >= rank && firstFoodRank >= rank) {
        waveSize += 1;
      }
    }
    prefixClassifications += waveSize;
    prefixNativeCalls += Math.ceil(waveSize / nativePageSize);
  }

  let bulkTailClassifications = 0;
  for (const visit of state.plan.visits) {
    const firstFoodRank = firstFoodRankByVisit.get(visit.visitId) ?? Number.POSITIVE_INFINITY;
    if (firstFoodRank <= adaptivePrefixRanks) {
      continue;
    }
    bulkTailClassifications += Math.max(0, visit.samples.length - adaptivePrefixRanks);
  }

  const totalClassifications = prefixClassifications + bulkTailClassifications;
  const avoidedClassifications = dataset.samples.length - totalClassifications;
  return {
    adaptivePrefixRanks,
    prefixClassifications,
    bulkTailClassifications,
    totalClassifications,
    avoidedClassifications,
    avoidedPercent: dataset.samples.length === 0 ? 0 : rounded((avoidedClassifications / dataset.samples.length) * 100),
    modeledNativeCalls: prefixNativeCalls + Math.ceil(bulkTailClassifications / nativePageSize),
  };
}

function digestStrings(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(encoded.byteLength);
    hash.update(length).update(encoded);
  }
  return hash.digest("hex");
}

function adaptiveDigest(result: AdaptiveModelResult): string {
  return digestStrings([
    ...result.state.positiveVisitIds.map((visitId) => `positive\0${visitId}`),
    ...result.state.attempts.map(({ sample, status }) => `attempt\0${sample.photoId}\0${status}`),
    ...result.state.skippedAfterPositive.map(({ photoId }) => `skipped\0${photoId}`),
  ]);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(values: readonly number[]): MeasurementSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMilliseconds: values.map(rounded),
    minimumMilliseconds: rounded(sorted[0]),
    medianMilliseconds: rounded(median(sorted)),
    p95Milliseconds: rounded(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    maximumMilliseconds: rounded(sorted.at(-1) ?? 0),
  };
}

function measure<Result>(operation: () => Result, validate: (result: Result) => void): number {
  const startedAt = performance.now();
  const result = operation();
  const elapsed = performance.now() - startedAt;
  validate(result);
  return elapsed;
}

function histogram(values: readonly number[]): Array<{ rank: number; count: number }> {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left - right).map(([rank, count]) => ({ rank, count }));
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const retained = configuration.databasePath ? loadRetainedDataset(configuration.databasePath) : null;
const dataset = retained?.dataset ?? createSyntheticDataset(configuration);
const expected = runFullOracle(dataset);
const candidate = runAdaptiveModel(dataset, configuration.nativePageSize);
assert.deepEqual([...candidate.state.positiveVisitIds].sort(), expected.positiveVisitIds);
assert.equal(candidate.state.attempts.length + candidate.state.skippedAfterPositive.length, dataset.samples.length);
const fullPlanNativeCalls = Math.ceil(dataset.samples.length / configuration.nativePageSize);
const boundedPrefixModels = BOUNDED_PREFIX_CUTOFFS.map((cutoff) =>
  modelBoundedPrefix(dataset, candidate.state, cutoff, configuration.nativePageSize),
);
const recommendedBoundedPrefix =
  [...boundedPrefixModels]
    .filter(({ modeledNativeCalls }) => modeledNativeCalls <= fullPlanNativeCalls)
    .sort(
      (left, right) =>
        right.avoidedClassifications - left.avoidedClassifications ||
        right.adaptivePrefixRanks - left.adaptivePrefixRanks,
    )[0] ?? boundedPrefixModels[0];
for (const model of boundedPrefixModels) {
  assert.equal(model.totalClassifications + model.avoidedClassifications, dataset.samples.length);
}
const expectedFullDigest = digestStrings(expected.positiveVisitIds);
const expectedAdaptiveDigest = adaptiveDigest(candidate);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  if (warmup % 2 === 0) {
    assert.deepEqual(runFullOracle(dataset).positiveVisitIds, expected.positiveVisitIds);
    assert.equal(adaptiveDigest(runAdaptiveModel(dataset, configuration.nativePageSize)), expectedAdaptiveDigest);
  } else {
    assert.equal(adaptiveDigest(runAdaptiveModel(dataset, configuration.nativePageSize)), expectedAdaptiveDigest);
    assert.deepEqual(runFullOracle(dataset).positiveVisitIds, expected.positiveVisitIds);
  }
}

const fullSamples: number[] = [];
const adaptiveSamples: number[] = [];
const measurementOrder: string[] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const fullFirst = sample % 2 === 0;
  measurementOrder.push(fullFirst ? "full-then-adaptive" : "adaptive-then-full");
  const runFull = () =>
    fullSamples.push(
      measure(
        () => runFullOracle(dataset),
        (result) => assert.equal(digestStrings(result.positiveVisitIds), expectedFullDigest),
      ),
    );
  const runAdaptive = () =>
    adaptiveSamples.push(
      measure(
        () => runAdaptiveModel(dataset, configuration.nativePageSize),
        (result) => assert.equal(adaptiveDigest(result), expectedAdaptiveDigest),
      ),
    );
  if (fullFirst) {
    runFull();
    runAdaptive();
  } else {
    runAdaptive();
    runFull();
  }
}

const fullTiming = summarize(fullSamples);
const adaptiveTiming = summarize(adaptiveSamples);
const avoidedClassifications = dataset.samples.length - candidate.state.attempts.length;
const avoidedPercent = dataset.samples.length === 0 ? 0 : (avoidedClassifications / dataset.samples.length) * 100;
const firstFoodRanks: number[] = [];
let noFoodVisitCount = 0;
for (const visit of candidate.state.plan.visits) {
  const firstFood = visit.samples.find((sample) => {
    const outcome = dataset.outcomes.get(sample.photoId);
    return outcome?.status === "success" && outcome.containsFood === true;
  });
  if (firstFood) {
    firstFoodRanks.push(firstFood.sampleRank);
  } else {
    noFoodVisitCount += 1;
  }
}
const attemptedRanks = candidate.state.attempts.map(({ sample }) => sample.sampleRank);
const skippedRanks = candidate.state.skippedAfterPositive.map(({ sampleRank }) => sampleRank);

let after: DatabaseIdentity | null = null;
if (configuration.databasePath && retained) {
  after = databaseIdentity(configuration.databasePath);
  assert.deepEqual(after, retained.before, "retained private database or a sidecar changed during profiling");
}

const report = {
  schemaVersion: 1,
  status: "ok",
  benchmarkScope:
    "Model-only TypeScript rank-wave scheduling over precomputed outcomes. Timings exclude PhotoKit, Vision inference, native/JavaScript transfer, SQLite persistence, UI work, and rendering; classification counts are the decision-relevant output.",
  runtime: { node: process.version, sqlite: dataset.sqliteVersion },
  configuration: {
    source: dataset.mode,
    requestedSyntheticVisitCount: configuration.visitCount,
    requestedSyntheticPlannedSamples: configuration.plannedSamples,
    measuredSamples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    nativePageSize: configuration.nativePageSize,
  },
  dataset: {
    visitCount: candidate.state.plan.visits.length,
    plannedClassifications: dataset.samples.length,
    positiveVisitCount: expected.positiveVisitIds.length,
    failedOutcomeCount: [...dataset.outcomes.values()].filter(({ status }) => status === "failure").length,
    missingOutcomeCount: dataset.samples.length - dataset.outcomes.size,
    maximumRank: candidate.state.plan.maximumRank,
  },
  correctness: {
    exactPositiveVisitParity: true,
    fullPositiveVisitDigest: expectedFullDigest,
    adaptiveSemanticDigest: expectedAdaptiveDigest,
    everyPlannedSampleAttemptedOrSkippedAfterPositive: true,
    skippedAfterPositiveRowsUnattempted: true,
    resultValidatedAfterEveryRun: true,
  },
  work: {
    fullPlanClassifications: expected.attemptedClassifications,
    adaptiveClassifications: candidate.state.attempts.length,
    avoidedClassifications,
    avoidedPercent: rounded(avoidedPercent),
    skippedAfterPositive: candidate.state.skippedAfterPositive.length,
    rankWaveCount: candidate.waveCount,
    maximumWaveSize: candidate.maximumWaveSize,
    modeledNativeCalls: {
      fullPlan: fullPlanNativeCalls,
      adaptiveRankWaves: candidate.modeledNativeCalls,
    },
    boundedPrefixBulkTailModels: boundedPrefixModels,
    recommendedBoundedPrefixRanks: recommendedBoundedPrefix.adaptivePrefixRanks,
  },
  rankHistogram: {
    firstFood: histogram(firstFoodRanks),
    noFoodVisitCount,
    attempted: histogram(attemptedRanks),
    skippedAfterPositive: histogram(skippedRanks),
  },
  timing: {
    interpretation: "model-only; never extrapolate these JavaScript timings to Vision wall time",
    measurementOrder,
    fullLiteralOracle: fullTiming,
    adaptivePlanner: adaptiveTiming,
  },
  sourceAttestation: retained
    ? {
        basename: basename(configuration.databasePath ?? RETAINED_CONTROL_PATH),
        pathRetained: false,
        openMode: "mode=ro, immutable=1, PRAGMA query_only=ON, one read transaction",
        before: retained.before,
        after,
        exactMainAndSidecarIdentityPreserved: true,
      }
    : null,
  privacy: {
    aggregateOnly: true,
    databasePathRetained: false,
    identifiersRetained: false,
    labelTextRetained: false,
    rawRowsRetained: false,
  },
};
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
if (configuration.outputPath) {
  writeFileSync(configuration.outputPath, serializedReport, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
process.stdout.write(serializedReport);
