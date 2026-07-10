#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildFoodReclassificationStatement,
  buildFoodReclassificationUpdate,
  FOOD_RECLASSIFICATION_BATCH_SIZE,
  type FoodReclassificationSource,
  type FoodReclassificationUpdate,
} from "../utils/db/food-reclassification-core.ts";

interface Configuration {
  readonly photos: number;
  readonly visits: number;
  readonly samples: number;
  readonly warmupIterations: number;
}

type StrategyName = "legacyPerRowAutocommit" | "parameterizedSetBasedRunAsync" | "parameterizedSetBasedPrepared";

interface Measurement {
  readonly readMilliseconds: number;
  readonly transformMilliseconds: number;
  readonly writeMilliseconds: number;
  readonly visitSyncMilliseconds: number;
  readonly totalMilliseconds: number;
  readonly photoUpdateExecutions: number;
  readonly photoUpdateStatementsPrepared: number;
  readonly rowsChanged: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface StrategySummary {
  readonly read: MeasurementSummary;
  readonly transform: MeasurementSummary;
  readonly writes: MeasurementSummary;
  readonly visitSync: MeasurementSummary;
  readonly total: MeasurementSummary;
  readonly photoUpdateExecutions: number;
  readonly photoUpdateStatementsPrepared: number;
  readonly rowsChanged: number;
}

interface DatabaseDigest {
  readonly checksum: string;
  readonly photoRows: number;
  readonly visitRows: number;
  readonly detectedPhotoRows: number;
  readonly foodProbableVisitRows: number;
}

interface SeedResult {
  readonly templatePath: string;
  readonly inputJsonBytes: number;
  readonly totalLabels: number;
  readonly unlabeledPhotos: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  photos: 68_027,
  visits: 4_000,
  samples: 7,
  warmupIterations: 1,
};
const LABELS_PER_PHOTO = 13;
const LEGACY_STAGING_BATCH_SIZE = 500;
const UNLABELED_PHOTOS = 37;
const ENABLED_KEYWORDS = ["coffee", "ice_cream", "pizza"] as const;
const PHOTO_UPDATE_SQL = "UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ? WHERE id = ?";
const VISIT_SYNC_SQL = `UPDATE visits SET foodProbable = COALESCE(
  (SELECT MAX(foodDetected) FROM photos WHERE photos.visitId = visits.id),
  0
)`;
const NON_FOOD_LABELS = [
  "person",
  "building",
  "sky",
  "tree",
  "vehicle",
  "indoor",
  "outdoor",
  "furniture",
  "flower",
  "animal",
  "text",
  "landscape",
  "portrait",
] as const;

function usage(): string {
  return `Usage: benchmark-food-reclassification.ts [options]

  --photos=N       Photos with stored classifier labels (default: ${DEFAULT_CONFIGURATION.photos})
  --visits=N       Visits referenced by photos (default: ${DEFAULT_CONFIGURATION.visits})
  --samples=N      Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --help, -h       Show this help`;
}

function parsePositiveInteger(value: string | undefined, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
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
    values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  const known = new Set(["photos", "visits", "samples", "warmup"]);
  for (const key of values.keys()) {
    if (!known.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  return {
    photos: values.has("photos")
      ? parsePositiveInteger(values.get("photos"), "--photos")
      : DEFAULT_CONFIGURATION.photos,
    visits: values.has("visits")
      ? parsePositiveInteger(values.get("visits"), "--visits")
      : DEFAULT_CONFIGURATION.visits,
    samples: values.has("samples")
      ? parsePositiveInteger(values.get("samples"), "--samples")
      : DEFAULT_CONFIGURATION.samples,
    warmupIterations: values.has("warmup")
      ? parsePositiveInteger(values.get("warmup"), "--warmup", true)
      : DEFAULT_CONFIGURATION.warmupIterations,
  };
}

function photoId(index: number): string {
  const ordinal = index.toString().padStart(6, "0");
  return index === 7 ? `photo-${ordinal}-café's` : `photo-${ordinal}`;
}

function visitId(index: number): string {
  return `visit-${index.toString().padStart(5, "0")}`;
}

function labelsJson(index: number): string {
  const labels: Array<{ label: string; confidence: number }> = Array.from(
    { length: LABELS_PER_PHOTO },
    (_, labelIndex) => ({
      label: NON_FOOD_LABELS[(index + labelIndex * 5) % NON_FOOD_LABELS.length],
      confidence: Number((0.1 + ((index * 17 + labelIndex * 11) % 89) / 100).toFixed(2)),
    }),
  );
  if (index % 29 === 0) {
    labels[index % LABELS_PER_PHOTO] = {
      label: index % 58 === 0 ? " Pizza " : "COFFEE",
      confidence: index === 0 ? 0.11 : Number((0.31 + (index % 67) / 100).toFixed(2)),
    };
    if (index % 87 === 0) {
      labels[(index + 3) % LABELS_PER_PHOTO] = { label: "pizza", confidence: 0.44 };
    }
  }
  return JSON.stringify(labels);
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE food_keywords (
      keyword TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      foodProbable INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_food ON photos(foodDetected);
    CREATE INDEX idx_photos_food_labels
      ON photos(visitId) WHERE foodDetected = 1 AND foodLabels IS NOT NULL;
  `);
}

function seedDatabase(configuration: Configuration, templatePath: string): SeedResult {
  const database = new DatabaseSync(templatePath);
  try {
    initializeSchema(database);
    database.exec("BEGIN");

    const insertKeyword = database.prepare("INSERT INTO food_keywords (keyword, enabled) VALUES (?, 1)");
    for (const keyword of ENABLED_KEYWORDS) {
      insertKeyword.run(keyword);
    }

    const insertVisit = database.prepare("INSERT INTO visits (id, foodProbable, payload) VALUES (?, ?, ?)");
    for (let index = 0; index < configuration.visits; index++) {
      insertVisit.run(visitId(index), index % 2, `visit-sentinel-${index}`);
    }

    const insertPhoto = database.prepare(
      `INSERT INTO photos
       (id, visitId, foodDetected, foodLabels, foodConfidence, allLabels, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let inputJsonBytes = 0;
    for (let index = 0; index < configuration.photos; index++) {
      const allLabelsJson = labelsJson(index);
      inputJsonBytes += Buffer.byteLength(allLabelsJson);
      insertPhoto.run(
        photoId(index),
        visitId(index % configuration.visits),
        index % 2,
        `[{"label":"stale-${index}","confidence":0.01}]`,
        0.01,
        allLabelsJson,
        index === 11 ? 'photo-sentinel-雪-"quoted"' : `photo-sentinel-${index}`,
      );
    }
    for (let index = 0; index < UNLABELED_PHOTOS; index++) {
      insertPhoto.run(
        `unlabeled-${index.toString().padStart(4, "0")}`,
        visitId((configuration.photos + index) % configuration.visits),
        index % 3 === 0 ? 1 : 0,
        index % 3 === 0 ? '[{"label":"preserved","confidence":0.5}]' : null,
        index % 3 === 0 ? 0.5 : null,
        null,
        `unlabeled-sentinel-${index}`,
      );
    }
    database.exec("COMMIT");
    return {
      templatePath,
      inputJsonBytes,
      totalLabels: configuration.photos * LABELS_PER_PHOTO,
      unlabeledPhotos: UNLABELED_PHOTOS,
    };
  } finally {
    database.close();
  }
}

function cloneDatabase(templatePath: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  initializeSchema(database);
  const escapedTemplatePath = templatePath.replaceAll("'", "''");
  database.exec(`
    ATTACH DATABASE '${escapedTemplatePath}' AS template;
    BEGIN;
    INSERT INTO food_keywords SELECT * FROM template.food_keywords;
    INSERT INTO visits SELECT * FROM template.visits;
    INSERT INTO photos SELECT * FROM template.photos;
    COMMIT;
    DETACH DATABASE template;
  `);
  return database;
}

function oracleUpdate(
  source: FoodReclassificationSource,
  enabledKeywords: ReadonlySet<string>,
): FoodReclassificationUpdate {
  const labels = JSON.parse(source.allLabelsJson) as Array<{ label: string; confidence: number }>;
  const matches: Array<{ label: string; confidence: number }> = [];
  let maximumConfidence: number | null = null;
  for (const label of labels) {
    if (enabledKeywords.has(label.label.trim().toLowerCase())) {
      matches.push(label);
      maximumConfidence = maximumConfidence === null ? label.confidence : Math.max(maximumConfidence, label.confidence);
    }
  }
  return {
    photoId: source.photoId,
    foodDetected: matches.length > 0,
    foodLabelsJson: matches.length > 0 ? JSON.stringify(matches) : null,
    foodConfidence: maximumConfidence,
  };
}

function readInputs(database: DatabaseSync): {
  readonly enabledKeywords: Set<string>;
  readonly sources: FoodReclassificationSource[];
} {
  const enabledKeywords = new Set(
    database
      .prepare("SELECT keyword FROM food_keywords WHERE enabled = 1 ORDER BY keyword ASC")
      .all()
      .map((row) => row.keyword as string),
  );
  const sources = database
    .prepare(
      `SELECT id AS photoId, allLabels AS allLabelsJson
       FROM photos WHERE allLabels IS NOT NULL`,
    )
    .all() as unknown as FoodReclassificationSource[];
  return { enabledKeywords, sources };
}

function transformInputs(
  strategy: StrategyName,
  sources: readonly FoodReclassificationSource[],
  enabledKeywords: ReadonlySet<string>,
): FoodReclassificationUpdate[] {
  if (strategy === "legacyPerRowAutocommit") {
    return sources.map((source) => oracleUpdate(source, enabledKeywords));
  }
  return sources.map((source) => {
    const update = buildFoodReclassificationUpdate(source, enabledKeywords);
    assert.ok(update, "timed fixture unexpectedly contained malformed classifier JSON");
    return update;
  });
}

function executeStrategy(
  templatePath: string,
  strategy: StrategyName,
): { readonly database: DatabaseSync; readonly measurement: Measurement } {
  const database = cloneDatabase(templatePath);
  try {
    const totalStartedAt = performance.now();
    const readStartedAt = performance.now();
    const { enabledKeywords, sources } = readInputs(database);
    const readMilliseconds = performance.now() - readStartedAt;

    const transformStartedAt = performance.now();
    const updates = transformInputs(strategy, sources, enabledKeywords);
    const transformMilliseconds = performance.now() - transformStartedAt;

    const writeStartedAt = performance.now();
    let photoUpdateExecutions = 0;
    let photoUpdateStatementsPrepared = 0;
    let rowsChanged = 0;
    if (strategy === "legacyPerRowAutocommit") {
      for (let offset = 0; offset < updates.length; offset += LEGACY_STAGING_BATCH_SIZE) {
        const batch = updates.slice(offset, offset + LEGACY_STAGING_BATCH_SIZE);
        for (const update of batch) {
          const result = database
            .prepare(PHOTO_UPDATE_SQL)
            .run(update.foodDetected ? 1 : 0, update.foodLabelsJson, update.foodConfidence, update.photoId);
          photoUpdateExecutions += 1;
          photoUpdateStatementsPrepared += 1;
          rowsChanged += Number(result.changes);
        }
      }
    } else {
      database.exec("BEGIN");
      let reusableFullBatchStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
      for (let offset = 0; offset < updates.length; offset += FOOD_RECLASSIFICATION_BATCH_SIZE) {
        const updateBatch = updates.slice(offset, offset + FOOD_RECLASSIFICATION_BATCH_SIZE);
        const statement = buildFoodReclassificationStatement(updateBatch);
        let preparedStatement: ReturnType<DatabaseSync["prepare"]>;
        if (strategy === "parameterizedSetBasedPrepared" && updateBatch.length === FOOD_RECLASSIFICATION_BATCH_SIZE) {
          if (!reusableFullBatchStatement) {
            reusableFullBatchStatement = database.prepare(statement.sql);
            photoUpdateStatementsPrepared += 1;
          }
          preparedStatement = reusableFullBatchStatement;
        } else {
          preparedStatement = database.prepare(statement.sql);
          photoUpdateStatementsPrepared += 1;
        }
        const result = preparedStatement.run(...statement.parameters);
        photoUpdateExecutions += 1;
        rowsChanged += Number(result.changes);
      }
    }
    const writeMilliseconds = performance.now() - writeStartedAt;

    const syncStartedAt = performance.now();
    database.prepare(VISIT_SYNC_SQL).run();
    if (strategy !== "legacyPerRowAutocommit") {
      database.exec("COMMIT");
    }
    const visitSyncMilliseconds = performance.now() - syncStartedAt;
    return {
      database,
      measurement: {
        readMilliseconds,
        transformMilliseconds,
        writeMilliseconds,
        visitSyncMilliseconds,
        totalMilliseconds: performance.now() - totalStartedAt,
        photoUpdateExecutions,
        photoUpdateStatementsPrepared,
        rowsChanged,
      },
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The legacy strategy does not open an explicit transaction.
    }
    database.close();
    throw error;
  }
}

function applyOracle(templatePath: string): DatabaseSync {
  const database = cloneDatabase(templatePath);
  const { enabledKeywords, sources } = readInputs(database);
  const updates = sources.map((source) => oracleUpdate(source, enabledKeywords));
  database.exec("BEGIN");
  const updateStatement = database.prepare(PHOTO_UPDATE_SQL);
  for (const update of updates) {
    updateStatement.run(update.foodDetected ? 1 : 0, update.foodLabelsJson, update.foodConfidence, update.photoId);
  }
  database.prepare(VISIT_SYNC_SQL).run();
  database.exec("COMMIT");
  return database;
}

function updateHashWithRow(hash: ReturnType<typeof createHash>, values: readonly unknown[]): void {
  for (const value of values) {
    hash.update(value === null ? "<null>" : String(value));
    hash.update("\0");
  }
  hash.update("\u0001");
}

function databaseDigest(database: DatabaseSync): DatabaseDigest {
  const hash = createHash("sha256");
  let photoRows = 0;
  let detectedPhotoRows = 0;
  for (const row of database
    .prepare(
      `SELECT id, visitId, foodDetected, foodLabels, foodConfidence, allLabels, payload
       FROM photos ORDER BY id`,
    )
    .iterate()) {
    photoRows += 1;
    detectedPhotoRows += row.foodDetected === 1 ? 1 : 0;
    updateHashWithRow(hash, [
      row.id,
      row.visitId,
      row.foodDetected,
      row.foodLabels,
      row.foodConfidence,
      row.allLabels,
      row.payload,
    ]);
  }
  let visitRows = 0;
  let foodProbableVisitRows = 0;
  for (const row of database.prepare("SELECT id, foodProbable, payload FROM visits ORDER BY id").iterate()) {
    visitRows += 1;
    foodProbableVisitRows += row.foodProbable === 1 ? 1 : 0;
    updateHashWithRow(hash, [row.id, row.foodProbable, row.payload]);
  }
  return {
    checksum: hash.digest("hex"),
    photoRows,
    visitRows,
    detectedPhotoRows,
    foodProbableVisitRows,
  };
}

function assertProductionTransformParity(templatePath: string): string {
  const database = cloneDatabase(templatePath);
  try {
    const { enabledKeywords, sources } = readInputs(database);
    const hash = createHash("sha256");
    for (const source of sources) {
      const expected = oracleUpdate(source, enabledKeywords);
      const actual = buildFoodReclassificationUpdate(source, enabledKeywords);
      assert.deepEqual(actual, expected, `${source.photoId}: production transform differed from oracle`);
      updateHashWithRow(hash, [
        expected.photoId,
        expected.foodDetected,
        expected.foodLabelsJson,
        expected.foodConfidence,
      ]);
    }
    return hash.digest("hex");
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
    assert.equal(measurement.photoUpdateExecutions, first.photoUpdateExecutions);
    assert.equal(measurement.photoUpdateStatementsPrepared, first.photoUpdateStatementsPrepared);
    assert.equal(measurement.rowsChanged, first.rowsChanged);
  }
  return {
    read: summarize(measurements.map(({ readMilliseconds }) => readMilliseconds)),
    transform: summarize(measurements.map(({ transformMilliseconds }) => transformMilliseconds)),
    writes: summarize(measurements.map(({ writeMilliseconds }) => writeMilliseconds)),
    visitSync: summarize(measurements.map(({ visitSyncMilliseconds }) => visitSyncMilliseconds)),
    total: summarize(measurements.map(({ totalMilliseconds }) => totalMilliseconds)),
    photoUpdateExecutions: first.photoUpdateExecutions,
    photoUpdateStatementsPrepared: first.photoUpdateStatementsPrepared,
    rowsChanged: first.rowsChanged,
  };
}

function runAndValidate(templatePath: string, strategy: StrategyName, expectedDigest: DatabaseDigest): Measurement {
  const result = executeStrategy(templatePath, strategy);
  try {
    assert.deepEqual(databaseDigest(result.database), expectedDigest, `${strategy}: full database parity failed`);
    return result.measurement;
  } finally {
    result.database.close();
  }
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-food-reclassification-"));
process.on("exit", () => rmSync(temporaryDirectory, { force: true, recursive: true }));
const seed = seedDatabase(configuration, join(temporaryDirectory, "template.sqlite"));
const transformChecksum = assertProductionTransformParity(seed.templatePath);
const oracleDatabase = applyOracle(seed.templatePath);
const expectedDigest = databaseDigest(oracleDatabase);
const sqliteVersion = (oracleDatabase.prepare("SELECT sqlite_version() AS version").get() as { version: string })
  .version;
oracleDatabase.close();

const strategyNames: readonly StrategyName[] = [
  "legacyPerRowAutocommit",
  "parameterizedSetBasedRunAsync",
  "parameterizedSetBasedPrepared",
];
for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  const order = warmup % 2 === 0 ? strategyNames : [...strategyNames].reverse();
  for (const strategy of order) {
    runAndValidate(seed.templatePath, strategy, expectedDigest);
  }
}

const measurements: Record<StrategyName, Measurement[]> = {
  legacyPerRowAutocommit: [],
  parameterizedSetBasedRunAsync: [],
  parameterizedSetBasedPrepared: [],
};
const measurementOrder: string[] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order = sample % 2 === 0 ? strategyNames : [...strategyNames].reverse();
  measurementOrder.push(order.join("-then-"));
  for (const strategy of order) {
    measurements[strategy].push(runAndValidate(seed.templatePath, strategy, expectedDigest));
  }
}

const legacy = summarizeStrategy(measurements.legacyPerRowAutocommit);
const setBasedRunAsync = summarizeStrategy(measurements.parameterizedSetBasedRunAsync);
const candidate = summarizeStrategy(measurements.parameterizedSetBasedPrepared);
const report = {
  schemaVersion: 1,
  status: "ok",
  runtime: {
    node: process.version,
    sqlite: sqliteVersion,
  },
  configuration: {
    photosWithLabels: configuration.photos,
    visits: configuration.visits,
    labelsPerPhoto: LABELS_PER_PHOTO,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    enabledKeywords: ENABLED_KEYWORDS,
  },
  dataset: {
    photosWithLabels: configuration.photos,
    unlabeledPhotos: seed.unlabeledPhotos,
    totalPhotoRows: configuration.photos + seed.unlabeledPhotos,
    totalLabels: seed.totalLabels,
    inputJsonBytes: seed.inputJsonBytes,
    expectedDetectedPhotoRows: expectedDigest.detectedPhotoRows,
    expectedFoodProbableVisitRows: expectedDigest.foodProbableVisitRows,
  },
  correctness: {
    exactPhotoAndVisitRowParity: true,
    productionTransformMatchesIndependentOracle: true,
    transformChecksum,
    fullDatabaseChecksum: expectedDigest.checksum,
    sourceLabelsVisitIdsAndPayloadPreservedByChecksum: true,
    resultValidatedAfterEveryRun: true,
  },
  fairness: {
    freshDatabasePerStrategyAndSample: true,
    databaseConstructionExcluded: true,
    keywordReadSourceReadTransformWritesAndVisitSyncIncluded: true,
    validationExcludedFromTiming: true,
    measuredOrderAlternates: true,
  },
  algorithms: {
    legacyPerRowAutocommit: "500-row JS staging + prepare/execute one autocommit UPDATE per photo + visit sync",
    parameterizedSetBasedRunAsync: `${FOOD_RECLASSIFICATION_BATCH_SIZE}-row parameterized UPDATE FROM batches prepared independently + visit sync in one transaction`,
    parameterizedSetBasedPrepared: `production ${FOOD_RECLASSIFICATION_BATCH_SIZE}-row parameterized UPDATE FROM batches reusing the full-batch statement + visit sync in one transaction`,
  },
  timingScope:
    "isolated Node/V8 plus in-memory SQLite; includes the full reclassification database pipeline but excludes React Native/Expo async bridge overhead",
  measurementOrder,
  legacyPerRowAutocommit: legacy,
  parameterizedSetBasedRunAsync: setBasedRunAsync,
  parameterizedSetBasedPrepared: candidate,
  speedup: {
    writeMedian: Number((legacy.writes.medianMilliseconds / candidate.writes.medianMilliseconds).toFixed(2)),
    totalMedian: Number((legacy.total.medianMilliseconds / candidate.total.medianMilliseconds).toFixed(2)),
    updateExecutionReduction: Number((legacy.photoUpdateExecutions / candidate.photoUpdateExecutions).toFixed(2)),
  },
};

console.log(JSON.stringify(report, null, 2));
