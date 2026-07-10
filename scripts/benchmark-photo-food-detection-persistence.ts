#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildLabeledPhotoFoodDetectionStatement,
  buildSimplePhotoFoodDetectionStatement,
  coalescePhotoFoodDetectionUpdates,
  LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  type PhotoFoodDetectionUpdate,
} from "../utils/db/photo-food-detection-core.ts";
import {
  DEFAULT_VISION_NATIVE_PAGE_SIZE,
  DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
} from "../utils/food-detection-buffer-core.ts";

interface Configuration {
  photos: number;
  samples: number;
  warmupIterations: number;
  callSize: number;
  outputPath: string;
}

interface PhotoRow {
  readonly id: string;
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly uri: string;
  readonly payload: string;
}

interface Dataset {
  readonly initialRows: readonly PhotoRow[];
  readonly calls: readonly (readonly PhotoFoodDetectionUpdate[])[];
  readonly expectedDigest: DatabaseDigest;
  readonly rawUpdates: number;
  readonly rawLabeledUpdates: number;
  readonly rawSimpleUpdates: number;
  readonly missingUpdates: number;
}

interface DatabaseDigest {
  readonly checksum: string;
  readonly rows: number;
  readonly detectedRows: number;
}

interface Measurement {
  readonly milliseconds: number;
  readonly executions: number;
  readonly statementsPrepared: number;
  readonly transactions: number;
  readonly rowsReportedChanged: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface StrategySummary {
  readonly timing: MeasurementSummary;
  readonly executions: number;
  readonly statementsPrepared: number;
  readonly transactions: number;
  readonly rowsReportedChanged: number;
}

type Strategy = "legacySequential" | "productionSetBased";

const DEFAULT_CONFIGURATION: Configuration = {
  photos: 68_027,
  samples: 7,
  warmupIterations: 1,
  callSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
  outputPath: ".build/photo-food-detection-persistence-profile.json",
};
const LEGACY_LABELED_SQL =
  "UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ?, allLabels = ? WHERE id = ?";

function usage(): string {
  return `Usage: benchmark-photo-food-detection-persistence.ts [options]

  --photos=N       Photo rows (default: ${DEFAULT_CONFIGURATION.photos})
  --samples=N      Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --call-size=N    Updates per persistence call (default: ${DEFAULT_CONFIGURATION.callSize})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--photos":
        configuration.photos = parseInteger(value, option);
        break;
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--call-size":
        configuration.callSize = parseInteger(value, option);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function photoId(index: number): string {
  switch (index) {
    case 0:
      return "photo-O'Brien's-table";
    case 1:
      return "写真-東京-🍣";
    case 2:
      return 'photo-"quoted"-café';
    default:
      return `photo-${index.toString().padStart(7, "0")}`;
  }
}

function createInitialRows(count: number): PhotoRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: photoId(index),
    visitId: index % 31 === 0 ? null : `visit-${(index % 4_000).toString().padStart(5, "0")}`,
    foodDetected: index % 11 === 0 ? null : index % 2,
    foodLabels: index % 7 === 0 ? null : `[{"label":"stale-${index % 23}","confidence":0.1}]`,
    foodConfidence: index % 7 === 0 ? null : Number(((index % 97) / 100).toFixed(2)),
    allLabels: index % 5 === 0 ? null : `[{"label":"old-all-${index % 19}","confidence":0.2}]`,
    uri: `ph://${photoId(index)}/L0/001`,
    payload: index === 1 ? `sentinel-雪-'quoted'-🙂` : `sentinel-${index.toString(36)}`,
  }));
}

function isLabeledUpdate(update: PhotoFoodDetectionUpdate): boolean {
  return update.foodLabels !== undefined || update.foodConfidence !== undefined || update.allLabels !== undefined;
}

function createCalls(
  rows: readonly PhotoRow[],
  callSize: number,
): {
  readonly calls: PhotoFoodDetectionUpdate[][];
  readonly missingUpdates: number;
} {
  const calls: PhotoFoodDetectionUpdate[][] = [];
  let missingUpdates = 0;
  for (let offset = 0, callIndex = 0; offset < rows.length; offset += callSize, callIndex++) {
    const call: PhotoFoodDetectionUpdate[] = [];
    const end = Math.min(rows.length, offset + callSize);
    for (let index = offset; index < end; index++) {
      const id = rows[index].id;
      // Every successful production Vision result carries classifier payloads.
      // The focused test exercises the separate simple-update API path.
      const confidence = index % 101 === 0 ? 0 : Number((0.25 + (index % 70) / 100).toFixed(2));
      call.push({
        photoId: id,
        foodDetected: index % 6 !== 0,
        foodLabels:
          index % 97 === 0
            ? []
            : [
                { label: index % 3 === 0 ? "pizza" : "food", confidence },
                { label: `dish-${index % 43}`, confidence: Number((confidence / 2).toFixed(3)) },
              ],
        foodConfidence: confidence,
        allLabels: index % 89 === 0 ? [] : [{ label: `all-${index % 67}`, confidence }],
      });
    }

    if (callIndex % 37 === 0 && call.length >= 4) {
      // Final labeled duplicate wins, including [] and zero values.
      call.push({
        photoId: rows[offset].id,
        foodDetected: false,
        foodLabels: [],
        foodConfidence: 0,
        allLabels: [],
      });
      // Confidence-only is labeled and clears both omitted label columns.
      call.push({ photoId: rows[offset + 1].id, foodDetected: true, foodConfidence: 0 });
      call.push({
        photoId: `missing-${callIndex}-雪's`,
        foodDetected: true,
        foodLabels: [],
        foodConfidence: 0,
        allLabels: [],
      });
      missingUpdates += 1;
    }

    if (callIndex > 0 && callIndex % 53 === 0) {
      // A labeled duplicate across persistence calls is applied by the later
      // transaction, just like independently returned Vision results.
      call.push({
        photoId: rows[offset - 1].id,
        foodDetected: true,
        foodLabels: [{ label: "later-call", confidence: 1 }],
        foodConfidence: 1,
        allLabels: [{ label: "later-call", confidence: 1 }],
      });
    }
    calls.push(call);
  }
  return { calls, missingUpdates };
}

/** Pure, independent model of the previous two-phase SQL writer. */
function applySequentialOracle(
  initialRows: readonly PhotoRow[],
  calls: readonly (readonly PhotoFoodDetectionUpdate[])[],
): PhotoRow[] {
  const byId = new Map(initialRows.map((row) => [row.id, { ...row }]));
  for (const updates of calls) {
    const labeledUpdates = updates.filter(isLabeledUpdate);
    const simpleUpdates = updates.filter((update) => !isLabeledUpdate(update));
    for (const update of labeledUpdates) {
      const row = byId.get(update.photoId);
      if (!row) {
        continue;
      }
      byId.set(update.photoId, {
        ...row,
        foodDetected: update.foodDetected ? 1 : 0,
        foodLabels: update.foodLabels ? JSON.stringify(update.foodLabels) : null,
        foodConfidence: update.foodConfidence ?? null,
        allLabels: update.allLabels ? JSON.stringify(update.allLabels) : null,
      });
    }
    for (const expectedValue of [true, false]) {
      for (const update of simpleUpdates) {
        if (update.foodDetected !== expectedValue) {
          continue;
        }
        const row = byId.get(update.photoId);
        if (row) {
          byId.set(update.photoId, { ...row, foodDetected: expectedValue ? 1 : 0 });
        }
      }
    }
  }
  return [...byId.values()].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
}

function hashRow(hash: ReturnType<typeof createHash>, row: PhotoRow): void {
  for (const value of [
    row.id,
    row.visitId,
    row.foodDetected,
    row.foodLabels,
    row.foodConfidence,
    row.allLabels,
    row.uri,
    row.payload,
  ]) {
    hash.update(value === null ? "<null>" : String(value));
    hash.update("\0");
  }
  hash.update("\u0001");
}

function rowsDigest(rows: readonly PhotoRow[]): DatabaseDigest {
  const hash = createHash("sha256");
  let detectedRows = 0;
  for (const row of rows) {
    hashRow(hash, row);
    detectedRows += row.foodDetected === 1 ? 1 : 0;
  }
  return { checksum: hash.digest("hex"), rows: rows.length, detectedRows };
}

function createDataset(configuration: Configuration): Dataset {
  const initialRows = createInitialRows(configuration.photos);
  const { calls, missingUpdates } = createCalls(initialRows, configuration.callSize);
  const expectedRows = applySequentialOracle(initialRows, calls);
  const updates = calls.flat();
  return {
    initialRows,
    calls,
    expectedDigest: rowsDigest(expectedRows),
    rawUpdates: updates.length,
    rawLabeledUpdates: updates.filter(isLabeledUpdate).length,
    rawSimpleUpdates: updates.filter((update) => !isLabeledUpdate(update)).length,
    missingUpdates,
  };
}

function createSeededDatabase(rows: readonly PhotoRow[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      uri TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  database.exec("BEGIN");
  const insert = database.prepare(
    `INSERT INTO photos
      (id, visitId, foodDetected, foodLabels, foodConfidence, allLabels, uri, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.visitId,
      row.foodDetected,
      row.foodLabels,
      row.foodConfidence,
      row.allLabels,
      row.uri,
      row.payload,
    );
  }
  database.exec("COMMIT");
  return database;
}

function databaseDigest(database: DatabaseSync): DatabaseDigest {
  const hash = createHash("sha256");
  let rows = 0;
  let detectedRows = 0;
  for (const rawRow of database
    .prepare(
      `SELECT id, visitId, foodDetected, foodLabels, foodConfidence, allLabels, uri, payload
       FROM photos ORDER BY id`,
    )
    .iterate()) {
    const row = rawRow as unknown as PhotoRow;
    hashRow(hash, row);
    rows += 1;
    detectedRows += row.foodDetected === 1 ? 1 : 0;
  }
  return { checksum: hash.digest("hex"), rows, detectedRows };
}

function executeLegacy(database: DatabaseSync, calls: readonly (readonly PhotoFoodDetectionUpdate[])[]): Measurement {
  let executions = 0;
  let statementsPrepared = 0;
  let transactions = 0;
  let rowsReportedChanged = 0;
  const startedAt = performance.now();
  for (const updates of calls) {
    const labeledUpdates = updates.filter(isLabeledUpdate);
    const simpleUpdates = updates.filter((update) => !isLabeledUpdate(update));
    database.exec("BEGIN");
    transactions += 1;
    try {
      if (labeledUpdates.length > 0) {
        const statement = database.prepare(LEGACY_LABELED_SQL);
        statementsPrepared += 1;
        for (const update of labeledUpdates) {
          const result = statement.run(
            update.foodDetected ? 1 : 0,
            update.foodLabels ? JSON.stringify(update.foodLabels) : null,
            update.foodConfidence ?? null,
            update.allLabels ? JSON.stringify(update.allLabels) : null,
            update.photoId,
          );
          executions += 1;
          rowsReportedChanged += Number(result.changes);
        }
      }

      const detectedIds = simpleUpdates.filter(({ foodDetected }) => foodDetected).map(({ photoId }) => photoId);
      const notDetectedIds = simpleUpdates.filter(({ foodDetected }) => !foodDetected).map(({ photoId }) => photoId);
      for (const [value, ids] of [
        [1, detectedIds],
        [0, notDetectedIds],
      ] as const) {
        for (let offset = 0; offset < ids.length; offset += 1_000) {
          const batch = ids.slice(offset, offset + 1_000);
          const statement = database.prepare(
            `UPDATE photos SET foodDetected = ${value} WHERE id IN (${batch.map(() => "?").join(", ")})`,
          );
          const result = statement.run(...batch);
          executions += 1;
          statementsPrepared += 1;
          rowsReportedChanged += Number(result.changes);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    milliseconds: performance.now() - startedAt,
    executions,
    statementsPrepared,
    transactions,
    rowsReportedChanged,
  };
}

function executeCandidate(
  database: DatabaseSync,
  calls: readonly (readonly PhotoFoodDetectionUpdate[])[],
): Measurement {
  let executions = 0;
  let statementsPrepared = 0;
  let transactions = 0;
  let rowsReportedChanged = 0;
  const startedAt = performance.now();
  for (const updates of calls) {
    const { labeledUpdates, simpleUpdates } = coalescePhotoFoodDetectionUpdates(updates);
    database.exec("BEGIN");
    transactions += 1;
    try {
      let reusableLabeledStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
      for (let offset = 0; offset < labeledUpdates.length; offset += LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
        const batch = labeledUpdates.slice(offset, offset + LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE);
        const persistence = buildLabeledPhotoFoodDetectionStatement(batch);
        let statement: ReturnType<DatabaseSync["prepare"]>;
        if (batch.length === LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
          if (!reusableLabeledStatement) {
            reusableLabeledStatement = database.prepare(persistence.sql);
            statementsPrepared += 1;
          }
          statement = reusableLabeledStatement;
        } else {
          statement = database.prepare(persistence.sql);
          statementsPrepared += 1;
        }
        const result = statement.run(...persistence.parameters);
        executions += 1;
        rowsReportedChanged += Number(result.changes);
      }

      let reusableSimpleStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
      for (let offset = 0; offset < simpleUpdates.length; offset += SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
        const batch = simpleUpdates.slice(offset, offset + SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE);
        const persistence = buildSimplePhotoFoodDetectionStatement(batch);
        let statement: ReturnType<DatabaseSync["prepare"]>;
        if (batch.length === SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
          if (!reusableSimpleStatement) {
            reusableSimpleStatement = database.prepare(persistence.sql);
            statementsPrepared += 1;
          }
          statement = reusableSimpleStatement;
        } else {
          statement = database.prepare(persistence.sql);
          statementsPrepared += 1;
        }
        const result = statement.run(...persistence.parameters);
        executions += 1;
        rowsReportedChanged += Number(result.changes);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    milliseconds: performance.now() - startedAt,
    executions,
    statementsPrepared,
    transactions,
    rowsReportedChanged,
  };
}

function runAndValidate(strategy: Strategy, dataset: Dataset): Measurement {
  const database = createSeededDatabase(dataset.initialRows);
  try {
    const measurement =
      strategy === "legacySequential"
        ? executeLegacy(database, dataset.calls)
        : executeCandidate(database, dataset.calls);
    assert.deepEqual(
      databaseDigest(database),
      dataset.expectedDigest,
      `${strategy}: full ordered database parity failed`,
    );
    return measurement;
  } finally {
    database.close();
  }
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

function summarize(values: readonly number[]): MeasurementSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMilliseconds: values.map(rounded),
    minimumMilliseconds: rounded(sorted[0]),
    medianMilliseconds: rounded(median(values)),
    p95Milliseconds: rounded(percentile95(values)),
    maximumMilliseconds: rounded(sorted[sorted.length - 1]),
  };
}

function summarizeStrategy(measurements: readonly Measurement[]): StrategySummary {
  const first = measurements[0];
  for (const measurement of measurements) {
    assert.equal(measurement.executions, first.executions);
    assert.equal(measurement.statementsPrepared, first.statementsPrepared);
    assert.equal(measurement.transactions, first.transactions);
    assert.equal(measurement.rowsReportedChanged, first.rowsReportedChanged);
  }
  return {
    timing: summarize(measurements.map(({ milliseconds }) => milliseconds)),
    executions: first.executions,
    statementsPrepared: first.statementsPrepared,
    transactions: first.transactions,
    rowsReportedChanged: first.rowsReportedChanged,
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  return iteration % 2 === 0
    ? (["legacySequential", "productionSetBased"] as const)
    : (["productionSetBased", "legacySequential"] as const);
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const dataset = createDataset(configuration);
assert.equal(dataset.rawSimpleUpdates, 0, "production deep-scan fixture must contain only labeled results");
for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  for (const strategy of strategyOrder(warmup)) {
    runAndValidate(strategy, dataset);
  }
}

const measurements: Record<Strategy, Measurement[]> = { legacySequential: [], productionSetBased: [] };
const measurementOrder: string[] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order = strategyOrder(sample);
  measurementOrder.push(order.join("-then-"));
  for (const strategy of order) {
    measurements[strategy].push(runAndValidate(strategy, dataset));
  }
}

const legacy = summarizeStrategy(measurements.legacySequential);
const candidate = summarizeStrategy(measurements.productionSetBased);
const runtimeDatabase = new DatabaseSync(":memory:");
const sqliteVersion = (runtimeDatabase.prepare("SELECT sqlite_version() AS version").get() as { version: string })
  .version;
runtimeDatabase.close();
const eliminatedExecutions = legacy.executions - candidate.executions;
const candidateNodeOverheadMilliseconds = candidate.timing.medianMilliseconds - legacy.timing.medianMilliseconds;
const breakEvenAsyncOverheadMicroseconds =
  eliminatedExecutions > 0 && candidateNodeOverheadMilliseconds > 0
    ? (candidateNodeOverheadMilliseconds * 1_000) / eliminatedExecutions
    : 0;

const report = {
  schemaVersion: 1,
  status: "ok",
  runtime: { node: process.version, sqlite: sqliteVersion },
  configuration: {
    photos: configuration.photos,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    persistenceCallSize: configuration.callSize,
    nativeResultPageSize: DEFAULT_VISION_NATIVE_PAGE_SIZE,
    productionPersistenceFlushSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    labeledBatchSize: LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE,
    simpleBatchSize: SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  },
  dataset: {
    photoRows: dataset.initialRows.length,
    persistenceCalls: dataset.calls.length,
    rawUpdates: dataset.rawUpdates,
    rawLabeledUpdates: dataset.rawLabeledUpdates,
    rawSimpleUpdates: dataset.rawSimpleUpdates,
    missingUpdates: dataset.missingUpdates,
  },
  correctness: {
    exactFullOrderedRowParityWithIndependentSequentialOracle: true,
    resultValidatedAfterEveryRun: true,
    checksum: dataset.expectedDigest.checksum,
    expectedDetectedRows: dataset.expectedDigest.detectedRows,
    coveredSemantics: [
      "empty foodLabels/allLabels arrays serialize as []",
      "omitted labels serialize as SQL NULL",
      "zero confidence remains zero",
      "missing photo IDs are ignored",
      "last labeled duplicate wins within a call and across persistence calls",
      "Unicode, emoji, apostrophes, and quotes remain parameterized",
      "visitId, URI, and unrelated payload columns remain unchanged",
    ],
  },
  fairness: {
    freshDatabasePerStrategyAndSample: true,
    databaseConstructionExcludedFromTiming: true,
    partitioningCoalescingJsonSerializationSqlConstructionTransactionsAndWritesIncluded: true,
    validationExcludedFromTiming: true,
    measuredOrderAlternates: true,
    defaultCallSizeMatchesProductionPersistenceFlushSize:
      configuration.callSize === DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    fixtureMatchesProductionAllLabeledVisionResults: dataset.rawSimpleUpdates === 0,
  },
  timingScope:
    "isolated Node/V8 plus in-memory SQLite; excludes Expo SQLite async scheduling/bridge overhead, which is why execution and preparation counts are reported independently",
  measurementOrder,
  nodeSqliteTiming: {
    legacySequential: legacy.timing,
    productionSetBased: candidate.timing,
    medianSpeedup: Number((legacy.timing.medianMilliseconds / candidate.timing.medianMilliseconds).toFixed(2)),
  },
  asyncDatabaseOperationCounts: {
    legacySequential: {
      executions: legacy.executions,
      statementsPrepared: legacy.statementsPrepared,
      transactions: legacy.transactions,
      rowsReportedChanged: legacy.rowsReportedChanged,
    },
    productionSetBased: {
      executions: candidate.executions,
      statementsPrepared: candidate.statementsPrepared,
      transactions: candidate.transactions,
      rowsReportedChanged: candidate.rowsReportedChanged,
    },
    executionReduction: Number((legacy.executions / candidate.executions).toFixed(2)),
    statementPreparationReduction: Number((legacy.statementsPrepared / candidate.statementsPrepared).toFixed(2)),
    eliminatedExecutions,
    breakEvenAsyncOverheadMicroseconds: rounded(breakEvenAsyncOverheadMicroseconds),
  },
};

const reportJson = `${JSON.stringify(report, null, 2)}\n`;
mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, reportJson);
console.log(reportJson.trimEnd());
console.error(`Saved photo food-detection persistence profile to ${configuration.outputPath}`);
