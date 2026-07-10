#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildPhotoVisitAssociationStatement,
  flattenPhotoVisitAssociations,
  PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
  type PhotoVisitAssociation,
  type PhotoVisitAssociationUpdate,
} from "../utils/db/photo-association-core.ts";

interface Configuration {
  readonly photos: number;
  readonly visits: number;
  readonly visitGroupsPerCall: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly seed: number;
  readonly legacyBatchSize: number;
}

interface PhotoSeed {
  readonly ordinal: number;
  readonly id: string;
  readonly payload: string;
  readonly initialVisitId: string | null;
}

interface PhotoRow {
  readonly ordinal: number;
  readonly id: string;
  readonly visitId: string | null;
  readonly payload: string;
}

interface BenchmarkDataset {
  readonly photos: readonly PhotoSeed[];
  readonly updates: readonly PhotoVisitAssociationUpdate[];
  readonly updateCalls: readonly (readonly PhotoVisitAssociationUpdate[])[];
  readonly associations: readonly PhotoVisitAssociation[];
  readonly expectedRows: readonly PhotoRow[];
  readonly expectedChecksum: string;
  readonly rawAssociationCount: number;
  readonly duplicateAssociationCount: number;
  readonly missingAssociationCount: number;
  readonly firstDuplicatePhotoId: string;
  readonly firstDuplicateExpectedVisitId: string;
}

interface Measurement {
  readonly elapsedMs: number;
  readonly databaseBuildMs: number;
}

interface MeasurementSummary {
  readonly samplesMs: number[];
  readonly minimumMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly databaseBuildMedianMs: number;
}

type Strategy = "legacyLiteralCase" | "parameterizedSetBased";

const DEFAULT_CONFIGURATION: Configuration = {
  // Matches the size of the macOS Photos library used for the app profiler.
  photos: 68_027,
  visits: 4_000,
  // Mirrors VISIT_BATCH_SIZE in services/visit.ts.
  visitGroupsPerCall: 200,
  samples: 7,
  warmupIterations: 1,
  seed: 0x50414c41,
  legacyBatchSize: 1_000,
};

const MAX_LEGACY_BATCH_SIZE = 1_000;
const EDGE_CASE_NAMES = [
  "duplicate photo IDs preserve exact legacy batch-boundary behavior",
  "missing photo IDs are ignored",
  "apostrophes in photo and visit IDs",
  "Unicode and emoji in photo and visit IDs",
  "unassociated rows remain unchanged",
] as const;

function usage(): string {
  return `Usage: benchmark-photo-visit-association.ts [options]

  --photos=N                    Photo rows (default: ${DEFAULT_CONFIGURATION.photos})
  --visits=N                    Realistic visit groups (default: ${DEFAULT_CONFIGURATION.visits})
  --visit-groups-per-call=N     Visit groups per production-style call (default: ${DEFAULT_CONFIGURATION.visitGroupsPerCall})
  --samples=N                   Measured samples per strategy (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N                    Warmup samples per strategy (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --seed=N                      Unsigned 32-bit dataset seed (default: ${DEFAULT_CONFIGURATION.seed})
  --legacy-batch-size=N         Literal CASE batch size, 1-${MAX_LEGACY_BATCH_SIZE} (default: ${DEFAULT_CONFIGURATION.legacyBatchSize})
  --help, -h                    Print this help`;
}

function parseUnsignedInteger(option: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be an unsigned integer; received ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${option} must be an unsigned safe integer; received ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(option: string, value: string): number {
  const parsed = parseUnsignedInteger(option, value);
  if (parsed === 0) {
    throw new RangeError(`${option} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const values = { ...DEFAULT_CONFIGURATION };

  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }

    const separatorIndex = argument.indexOf("=");
    if (!argument.startsWith("--") || separatorIndex === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const option = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);
    switch (option) {
      case "--photos":
        values.photos = parsePositiveInteger(option, value);
        break;
      case "--visits":
        values.visits = parsePositiveInteger(option, value);
        break;
      case "--visit-groups-per-call":
        values.visitGroupsPerCall = parsePositiveInteger(option, value);
        break;
      case "--samples":
        values.samples = parsePositiveInteger(option, value);
        break;
      case "--warmup":
        values.warmupIterations = parseUnsignedInteger(option, value);
        break;
      case "--seed":
        values.seed = parseUnsignedInteger(option, value);
        if (values.seed > 0xffff_ffff) {
          throw new RangeError(`${option} must fit in an unsigned 32-bit integer; received ${value}`);
        }
        break;
      case "--legacy-batch-size":
        values.legacyBatchSize = parsePositiveInteger(option, value);
        if (values.legacyBatchSize > MAX_LEGACY_BATCH_SIZE) {
          throw new RangeError(
            `${option} cannot exceed the legacy production batch size of ${MAX_LEGACY_BATCH_SIZE}; received ${value}`,
          );
        }
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (values.visits > values.photos) {
    throw new RangeError(
      `--visits cannot exceed --photos; received ${values.visits} visits and ${values.photos} photos`,
    );
  }

  return values;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function photoId(index: number): string {
  switch (index) {
    case 0:
      return "asset-O'Brien";
    case 1:
      return "写真-東京-🍣";
    case 2:
      return "asset-'quoted'-\"double\"";
    default:
      return `asset-${index.toString().padStart(8, "0")}`;
  }
}

function visitId(index: number): string {
  switch (index) {
    case 0:
      return "visit-O'Brien's-table";
    case 1:
      return "訪問-東京-🍜";
    default:
      return `visit-${index.toString().padStart(6, "0")}`;
  }
}

function createPhotos(count: number): PhotoSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index,
    id: photoId(index),
    payload: index % 997 === 0 ? `payload-'${index}'-写真` : `payload-${index.toString(36)}`,
    initialVisitId: index % 41 === 0 ? `preexisting-${index % 17}` : null,
  }));
}

function createPrimaryUpdates(
  photos: readonly PhotoSeed[],
  visitCount: number,
  random: () => number,
): PhotoVisitAssociationUpdate[] {
  const updates: PhotoVisitAssociationUpdate[] = [];
  let photoOffset = 0;

  for (let visitIndex = 0; visitIndex < visitCount; visitIndex++) {
    const visitsRemaining = visitCount - visitIndex;
    const photosRemaining = photos.length - photoOffset;
    const averageGroupSize = photosRemaining / visitsRemaining;
    const variedGroupSize = Math.round(averageGroupSize * (0.55 + random() * 0.9));
    const maximumGroupSize = photosRemaining - (visitsRemaining - 1);
    const groupSize =
      visitIndex === visitCount - 1 ? photosRemaining : Math.max(1, Math.min(maximumGroupSize, variedGroupSize));

    updates.push({
      visitId: visitId(visitIndex),
      photoIds: photos.slice(photoOffset, photoOffset + groupSize).map((photo) => photo.id),
    });
    photoOffset += groupSize;
  }

  assert.equal(photoOffset, photos.length);
  return updates;
}

function flattenLegacyBatchSemantics(
  updates: readonly PhotoVisitAssociationUpdate[],
  batchSize: number,
): PhotoVisitAssociation[] {
  const associationsByPhotoId = new Map<string, PhotoVisitAssociation>();
  const seenInCurrentBatch = new Set<string>();
  let rawAssociationIndex = 0;

  for (const update of updates) {
    for (const id of update.photoIds) {
      if (rawAssociationIndex % batchSize === 0) {
        seenInCurrentBatch.clear();
      }
      if (!seenInCurrentBatch.has(id)) {
        seenInCurrentBatch.add(id);
        associationsByPhotoId.set(id, { photoId: id, visitId: update.visitId });
      }
      rawAssociationIndex += 1;
    }
  }

  return [...associationsByPhotoId.values()];
}

function splitUpdateCalls(
  updates: readonly PhotoVisitAssociationUpdate[],
  visitGroupsPerCall: number,
): readonly (readonly PhotoVisitAssociationUpdate[])[] {
  const calls: PhotoVisitAssociationUpdate[][] = [];
  for (let offset = 0; offset < updates.length; offset += visitGroupsPerCall) {
    calls.push(updates.slice(offset, offset + visitGroupsPerCall));
  }
  return calls;
}

function flattenLegacyCallSemantics(
  updateCalls: readonly (readonly PhotoVisitAssociationUpdate[])[],
  batchSize: number,
): PhotoVisitAssociation[] {
  const finalAssociations = new Map<string, PhotoVisitAssociation>();
  for (const updates of updateCalls) {
    for (const association of flattenLegacyBatchSemantics(updates, batchSize)) {
      finalAssociations.set(association.photoId, association);
    }
  }
  return [...finalAssociations.values()];
}

function flattenCandidateCallSemantics(
  updateCalls: readonly (readonly PhotoVisitAssociationUpdate[])[],
  legacyBatchSize: number,
): PhotoVisitAssociation[] {
  const finalAssociations = new Map<string, PhotoVisitAssociation>();
  for (const updates of updateCalls) {
    for (const association of flattenPhotoVisitAssociations(updates, legacyBatchSize)) {
      finalAssociations.set(association.photoId, association);
    }
  }
  return [...finalAssociations.values()];
}

function createDataset(configuration: Configuration): BenchmarkDataset {
  const random = createRandom(configuration.seed);
  const photos = createPhotos(configuration.photos);
  const primaryUpdates = createPrimaryUpdates(photos, configuration.visits, random);
  const duplicateCount = Math.max(3, Math.floor(configuration.photos / 500));
  const duplicatePhotoIds: string[] = [];
  for (let index = 0; index < duplicateCount; index++) {
    const photoIndex = Math.floor(random() * photos.length);
    duplicatePhotoIds.push(photos[photoIndex].id);
  }

  const missingCount = Math.max(3, Math.floor(configuration.photos / 2_000));
  const missingPhotoIds = Array.from({ length: missingCount }, (_, index) => {
    if (index === 0) {
      return "missing-O'Brien-写真-🫥";
    }
    return `missing-asset-${index.toString().padStart(5, "0")}`;
  });

  const updates: PhotoVisitAssociationUpdate[] = [
    ...primaryUpdates,
    {
      visitId: "duplicate-later-call-wins-'二番'",
      photoIds: duplicatePhotoIds,
    },
    {
      visitId: "missing-target-O'Brien-不存在",
      photoIds: missingPhotoIds,
    },
  ];
  const rawAssociationCount = updates.reduce((total, update) => total + update.photoIds.length, 0);
  const updateCalls = splitUpdateCalls(updates, configuration.visitGroupsPerCall);
  const associations = flattenLegacyCallSemantics(updateCalls, configuration.legacyBatchSize);
  assert.deepEqual(flattenCandidateCallSemantics(updateCalls, configuration.legacyBatchSize), associations);
  const photoIds = new Set(photos.map((photo) => photo.id));
  const missingAssociationCount = associations.reduce(
    (total, association) => total + (photoIds.has(association.photoId) ? 0 : 1),
    0,
  );
  const associationByPhotoId = new Map(associations.map((association) => [association.photoId, association.visitId]));
  const expectedRows = photos.map<PhotoRow>((photo) => ({
    ordinal: photo.ordinal,
    id: photo.id,
    visitId: associationByPhotoId.get(photo.id) ?? photo.initialVisitId,
    payload: photo.payload,
  }));
  const firstDuplicatePhotoId = duplicatePhotoIds[0];
  const firstDuplicateExpectedVisitId = associationByPhotoId.get(firstDuplicatePhotoId);
  assert.ok(firstDuplicateExpectedVisitId);
  assert.equal(associationByPhotoId.get(firstDuplicatePhotoId), firstDuplicateExpectedVisitId);

  return {
    photos,
    updates,
    updateCalls,
    associations,
    expectedRows,
    expectedChecksum: checksumRows(expectedRows),
    rawAssociationCount,
    duplicateAssociationCount: rawAssociationCount - associations.length,
    missingAssociationCount,
    firstDuplicatePhotoId,
    firstDuplicateExpectedVisitId,
  };
}

function createDatabase(photos: readonly PhotoSeed[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    CREATE TABLE photos (
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT PRIMARY KEY,
      visitId TEXT,
      payload TEXT NOT NULL
    );
    BEGIN;
  `);

  try {
    const insert = database.prepare(`INSERT INTO photos (ordinal, id, visitId, payload) VALUES (?, ?, ?, ?)`);
    for (const photo of photos) {
      insert.run(photo.ordinal, photo.id, photo.initialVisitId, photo.payload);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    database.close();
    throw error;
  }

  return database;
}

function escapeSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runLegacyLiteralCase(
  database: DatabaseSync,
  updates: readonly PhotoVisitAssociationUpdate[],
  batchSize: number,
): void {
  const associations = updates.flatMap(({ photoIds, visitId }) => photoIds.map((photoId) => ({ photoId, visitId })));
  for (let offset = 0; offset < associations.length; offset += batchSize) {
    const batch = associations.slice(offset, offset + batchSize);
    const cases = batch
      .map(
        ({ photoId: id, visitId: targetVisitId }) =>
          `WHEN id = ${escapeSqlLiteral(id)} THEN ${escapeSqlLiteral(targetVisitId)}`,
      )
      .join(" ");
    const placeholders = batch.map(() => "?").join(", ");
    database
      .prepare(`UPDATE photos SET visitId = CASE ${cases} END WHERE id IN (${placeholders})`)
      .run(...batch.map((association) => association.photoId));
  }
}

function runParameterizedSetBased(
  database: DatabaseSync,
  updates: readonly PhotoVisitAssociationUpdate[],
  legacyBatchSize: number,
): void {
  const associations = flattenPhotoVisitAssociations(updates, legacyBatchSize);
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (let offset = 0; offset < associations.length; offset += PHOTO_VISIT_ASSOCIATION_BATCH_SIZE) {
      const statement = buildPhotoVisitAssociationStatement(
        associations.slice(offset, offset + PHOTO_VISIT_ASSOCIATION_BATCH_SIZE),
      );
      database.prepare(statement.sql).run(...statement.parameters);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function readRows(database: DatabaseSync): PhotoRow[] {
  return database
    .prepare(`SELECT ordinal, id, visitId, payload FROM photos ORDER BY ordinal`)
    .all() as unknown as PhotoRow[];
}

function updateChecksum(checksum: number, value: string): number {
  let result = checksum;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619) >>> 0;
  }
  return result;
}

function checksumRows(rows: readonly PhotoRow[]): string {
  let checksum = 2_166_136_261;
  for (const row of rows) {
    checksum = updateChecksum(
      checksum,
      `${row.ordinal}\u001f${row.id}\u001f${row.visitId ?? "<null>"}\u001f${row.payload}\u001e`,
    );
  }
  return checksum.toString(16).padStart(8, "0");
}

function assertExactRows(actual: readonly PhotoRow[], expected: readonly PhotoRow[], expectedChecksum: string): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const actualRow = actual[index];
    const expectedRow = expected[index];
    if (
      actualRow.ordinal !== expectedRow.ordinal ||
      actualRow.id !== expectedRow.id ||
      actualRow.visitId !== expectedRow.visitId ||
      actualRow.payload !== expectedRow.payload
    ) {
      assert.deepEqual(actualRow, expectedRow, `Photo row ${index} does not match`);
    }
  }
  assert.equal(checksumRows(actual), expectedChecksum);
}

function executeStrategy(
  strategy: Strategy,
  database: DatabaseSync,
  dataset: BenchmarkDataset,
  configuration: Configuration,
): void {
  for (const updateCall of dataset.updateCalls) {
    if (strategy === "legacyLiteralCase") {
      runLegacyLiteralCase(database, updateCall, configuration.legacyBatchSize);
    } else {
      runParameterizedSetBased(database, updateCall, configuration.legacyBatchSize);
    }
  }
}

function runStrategy(
  strategy: Strategy,
  dataset: BenchmarkDataset,
  configuration: Configuration,
  measure: boolean,
): Measurement {
  const buildStartedAt = performance.now();
  const database = createDatabase(dataset.photos);
  const databaseBuildMs = performance.now() - buildStartedAt;

  try {
    const startedAt = performance.now();
    executeStrategy(strategy, database, dataset, configuration);
    const elapsedMs = performance.now() - startedAt;
    assertExactRows(readRows(database), dataset.expectedRows, dataset.expectedChecksum);
    return {
      elapsedMs: measure ? elapsedMs : 0,
      databaseBuildMs: measure ? databaseBuildMs : 0,
    };
  } finally {
    database.close();
  }
}

function assertEdgeCases(): void {
  const photos: PhotoSeed[] = [
    { ordinal: 0, id: "asset-O'Brien", initialVisitId: null, payload: "apostrophe" },
    { ordinal: 1, id: "写真-東京-🍣", initialVisitId: null, payload: "Unicode-🙂" },
    { ordinal: 2, id: "untouched", initialVisitId: "original", payload: "unchanged" },
  ];
  const updates: PhotoVisitAssociationUpdate[] = [
    { photoIds: ["asset-O'Brien", "写真-東京-🍣", "missing-'不存在'"], visitId: "first-O'Brien-訪問" },
    { photoIds: ["asset-O'Brien", "写真-東京-🍣"], visitId: "second-cross-batch-wins" },
  ];
  const edgeConfiguration = { ...DEFAULT_CONFIGURATION, legacyBatchSize: 2 };
  const associations = flattenLegacyBatchSemantics(updates, edgeConfiguration.legacyBatchSize);
  assert.deepEqual(flattenPhotoVisitAssociations(updates, edgeConfiguration.legacyBatchSize), associations);
  assert.deepEqual(associations, [
    { photoId: "asset-O'Brien", visitId: "second-cross-batch-wins" },
    { photoId: "写真-東京-🍣", visitId: "second-cross-batch-wins" },
    { photoId: "missing-'不存在'", visitId: "first-O'Brien-訪問" },
  ]);

  const expectedRows: PhotoRow[] = [
    { ordinal: 0, id: "asset-O'Brien", visitId: "second-cross-batch-wins", payload: "apostrophe" },
    { ordinal: 1, id: "写真-東京-🍣", visitId: "second-cross-batch-wins", payload: "Unicode-🙂" },
    { ordinal: 2, id: "untouched", visitId: "original", payload: "unchanged" },
  ];
  const expectedChecksum = checksumRows(expectedRows);
  const edgeDataset: BenchmarkDataset = {
    photos,
    updates,
    updateCalls: [updates],
    associations,
    expectedRows,
    expectedChecksum,
    rawAssociationCount: 5,
    duplicateAssociationCount: 2,
    missingAssociationCount: 1,
    firstDuplicatePhotoId: "asset-O'Brien",
    firstDuplicateExpectedVisitId: "second-cross-batch-wins",
  };
  runStrategy("legacyLiteralCase", edgeDataset, edgeConfiguration, false);
  runStrategy("parameterizedSetBased", edgeDataset, edgeConfiguration, false);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(measurements: readonly Measurement[]): MeasurementSummary {
  const samples = measurements.map((measurement) => measurement.elapsedMs);
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMs: samples.map(rounded),
    minimumMs: rounded(sorted[0]),
    medianMs: rounded(median(samples)),
    p95Ms: rounded(percentile95(samples)),
    maximumMs: rounded(sorted[sorted.length - 1]),
    databaseBuildMedianMs: rounded(median(measurements.map((measurement) => measurement.databaseBuildMs))),
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  return iteration % 2 === 0
    ? ["legacyLiteralCase", "parameterizedSetBased"]
    : ["parameterizedSetBased", "legacyLiteralCase"];
}

function benchmark(
  dataset: BenchmarkDataset,
  configuration: Configuration,
): {
  readonly legacyLiteralCase: MeasurementSummary;
  readonly parameterizedSetBased: MeasurementSummary;
} {
  // Full-dataset correctness is established on independently built databases
  // before warmups or measured samples are accepted.
  runStrategy("legacyLiteralCase", dataset, configuration, false);
  runStrategy("parameterizedSetBased", dataset, configuration, false);

  for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
    for (const strategy of strategyOrder(iteration)) {
      runStrategy(strategy, dataset, configuration, false);
    }
  }

  const measurements: Record<Strategy, Measurement[]> = {
    legacyLiteralCase: [],
    parameterizedSetBased: [],
  };
  for (let sample = 0; sample < configuration.samples; sample++) {
    for (const strategy of strategyOrder(sample)) {
      measurements[strategy].push(runStrategy(strategy, dataset, configuration, true));
    }
  }

  return {
    legacyLiteralCase: summarize(measurements.legacyLiteralCase),
    parameterizedSetBased: summarize(measurements.parameterizedSetBased),
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

assertEdgeCases();
const dataset = createDataset(configuration);
const benchmarkResult = benchmark(dataset, configuration);
const speedup =
  benchmarkResult.parameterizedSetBased.medianMs > 0
    ? benchmarkResult.legacyLiteralCase.medianMs / benchmarkResult.parameterizedSetBased.medianMs
    : 0;
const runtimeDatabase = new DatabaseSync(":memory:");

try {
  const report = {
    schemaVersion: 1,
    status: "ok",
    runtime: {
      node: process.version,
      sqlite: (runtimeDatabase.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
    },
    configuration,
    dataset: {
      photoRows: dataset.photos.length,
      visitGroups: configuration.visits,
      averagePhotosPerVisit: rounded(dataset.photos.length / configuration.visits),
      updateGroups: dataset.updates.length,
      productionStyleCalls: dataset.updateCalls.length,
      rawAssociations: dataset.rawAssociationCount,
      canonicalAssociations: dataset.associations.length,
      duplicateAssociationsDropped: dataset.duplicateAssociationCount,
      missingAssociations: dataset.missingAssociationCount,
    },
    correctness: {
      exactFullRowParity: true,
      deterministicChecksum: dataset.expectedChecksum,
      duplicateSemantics:
        "later production calls overwrite earlier calls; within a call, the first occurrence in the final legacy statement wins",
      firstDuplicatePhotoId: dataset.firstDuplicatePhotoId,
      firstDuplicateExpectedVisitId: dataset.firstDuplicateExpectedVisitId,
      edgeCases: EDGE_CASE_NAMES,
    },
    fairness: {
      freshDatabasePerStrategyAndSample: true,
      databaseBuildExcludedFromStrategyTiming: true,
      measuredOrderAlternatesBySample: true,
      associationFlatteningIncludedInStrategyTiming: true,
      resultValidationExcludedFromStrategyTiming: true,
      resultValidatedAfterEveryRun: true,
    },
    strategies: {
      legacyLiteralCase: {
        batchSize: configuration.legacyBatchSize,
        transactionScope: "one implicit transaction per statement",
        ...benchmarkResult.legacyLiteralCase,
      },
      parameterizedSetBased: {
        batchSize: PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
        transactionScope: "one transaction per production-style call",
        usesProductionFlattenerAndSqlBuilder: true,
        ...benchmarkResult.parameterizedSetBased,
      },
    },
    medianSpeedup: Number(speedup.toFixed(2)),
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  runtimeDatabase.close();
}
