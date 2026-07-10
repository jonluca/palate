#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  buildLabeledPhotoFoodDetectionStatement,
  buildSimplePhotoFoodDetectionStatement,
  coalescePhotoFoodDetectionUpdates,
  LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  type PhotoFoodDetectionUpdate,
} from "../utils/db/photo-food-detection-core.ts";

interface PhotoRow {
  readonly id: string;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly payload: string;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    foodDetected INTEGER,
    foodLabels TEXT,
    foodConfidence REAL,
    allLabels TEXT,
    payload TEXT NOT NULL
  )`);
  return database;
}

function seedDatabase(database: DatabaseSync): void {
  const insert = database.prepare(
    `INSERT INTO photos (id, foodDetected, foodLabels, foodConfidence, allLabels, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("labeled", 1, "old-food", 0.99, "old-all", "sentinel-labeled");
  insert.run("confidence-only", 1, "old-food", 0.99, "old-all", "sentinel-confidence");
  insert.run("all-labels-only", 0, "old-food", 0.4, "old-all", "sentinel-all-labels");
  insert.run("overlap", 0, "old-food", 0.1, "old-all", "sentinel-overlap");
  insert.run("simple-false-wins", 1, "preserved-food", 0.5, "preserved-all", "sentinel-false");
  insert.run("simple-true-only", 0, "preserved-food", 0, "preserved-all", "sentinel-true");
  insert.run("photo-雪's", null, null, null, null, 'sentinel-雪-"quoted"');
  insert.run("untouched", 1, "untouched-food", 0.7, "untouched-all", "sentinel-untouched");

  for (let index = 0; index < 365; index++) {
    insert.run(`labeled-batch-${index.toString().padStart(3, "0")}`, 0, "old", 0.1, "old-all", `l-${index}`);
  }
  for (let index = 0; index < 901; index++) {
    insert.run(`simple-batch-${index.toString().padStart(3, "0")}`, 1, "keep", 0.2, "keep-all", `s-${index}`);
  }
}

function buildUpdates(): PhotoFoodDetectionUpdate[] {
  const updates: PhotoFoodDetectionUpdate[] = [
    {
      photoId: "labeled",
      foodDetected: true,
      foodLabels: [{ label: "first", confidence: 0.8 }],
      foodConfidence: 0.8,
      allLabels: [{ label: "first-all", confidence: 0.9 }],
    },
    { photoId: "confidence-only", foodDetected: false, foodConfidence: 0 },
    { photoId: "all-labels-only", foodDetected: true, allLabels: [] },
    {
      photoId: "overlap",
      foodDetected: true,
      foodLabels: [{ label: "pizza", confidence: 0.61 }],
      foodConfidence: 0.61,
      allLabels: [{ label: "pizza", confidence: 0.61 }],
    },
    { photoId: "overlap", foodDetected: true },
    { photoId: "overlap", foodDetected: false },
    { photoId: "simple-false-wins", foodDetected: false },
    { photoId: "simple-false-wins", foodDetected: true },
    { photoId: "simple-true-only", foodDetected: true },
    { photoId: "simple-true-only", foodDetected: true },
    {
      photoId: "photo-雪's",
      foodDetected: true,
      foodLabels: [{ label: "寿司 🍣", confidence: 1 }],
      allLabels: [],
    },
    { photoId: "missing-id", foodDetected: false, foodLabels: [], foodConfidence: 0, allLabels: [] },
  ];

  for (let index = 0; index < 365; index++) {
    updates.push({
      photoId: `labeled-batch-${index.toString().padStart(3, "0")}`,
      foodDetected: index % 2 === 0,
      foodLabels: index % 5 === 0 ? [] : [{ label: `label-${index}`, confidence: index / 365 }],
      foodConfidence: index === 0 ? 0 : index / 365,
      allLabels: [{ label: `all-${index}`, confidence: 1 }],
    });
  }
  // This duplicate appears after two full candidate batches. Legacy sequential
  // behavior requires it to replace every labeled column on the first row.
  updates.push({
    photoId: "labeled-batch-000",
    foodDetected: false,
    foodLabels: [],
    foodConfidence: 0,
    allLabels: [],
  });

  for (let index = 0; index < 901; index++) {
    updates.push({ photoId: `simple-batch-${index.toString().padStart(3, "0")}`, foodDetected: index % 3 !== 0 });
  }
  // A false simple update wins even when a later update is true.
  updates.push({ photoId: "simple-batch-000", foodDetected: false });
  updates.push({ photoId: "simple-batch-000", foodDetected: true });
  updates.push({ photoId: "simple-batch-001", foodDetected: false });

  // Final labeled duplicate proves last-write behavior and empty-array/zero
  // serialization independently of the generated boundary fixture.
  updates.push({
    photoId: "labeled",
    foodDetected: false,
    foodLabels: [],
    foodConfidence: 0,
    allLabels: [],
  });
  return updates;
}

/** Independent transcription of the previous production writer. */
function applySequentialOracle(database: DatabaseSync, updates: readonly PhotoFoodDetectionUpdate[]): void {
  const labeledUpdates = updates.filter(
    (update) =>
      update.foodLabels !== undefined || update.foodConfidence !== undefined || update.allLabels !== undefined,
  );
  const simpleUpdates = updates.filter(
    (update) =>
      update.foodLabels === undefined && update.foodConfidence === undefined && update.allLabels === undefined,
  );

  database.exec("BEGIN");
  try {
    const labeledStatement = database.prepare(
      "UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ?, allLabels = ? WHERE id = ?",
    );
    for (const update of labeledUpdates) {
      labeledStatement.run(
        update.foodDetected ? 1 : 0,
        update.foodLabels ? JSON.stringify(update.foodLabels) : null,
        update.foodConfidence ?? null,
        update.allLabels ? JSON.stringify(update.allLabels) : null,
        update.photoId,
      );
    }

    const detectedIds = simpleUpdates.filter(({ foodDetected }) => foodDetected).map(({ photoId }) => photoId);
    const notDetectedIds = simpleUpdates.filter(({ foodDetected }) => !foodDetected).map(({ photoId }) => photoId);
    for (const [value, ids] of [
      [1, detectedIds],
      [0, notDetectedIds],
    ] as const) {
      for (let offset = 0; offset < ids.length; offset += 1_000) {
        const batch = ids.slice(offset, offset + 1_000);
        database
          .prepare(`UPDATE photos SET foodDetected = ${value} WHERE id IN (${batch.map(() => "?").join(", ")})`)
          .run(...batch);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function applyCandidate(
  database: DatabaseSync,
  updates: readonly PhotoFoodDetectionUpdate[],
  failAfterLabeled = false,
): void {
  const { labeledUpdates, simpleUpdates } = coalescePhotoFoodDetectionUpdates(updates);
  database.exec("BEGIN");
  try {
    let reusableLabeledStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
    for (let offset = 0; offset < labeledUpdates.length; offset += LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
      const batch = labeledUpdates.slice(offset, offset + LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE);
      const persistence = buildLabeledPhotoFoodDetectionStatement(batch);
      const statement =
        batch.length === LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE
          ? (reusableLabeledStatement ??= database.prepare(persistence.sql))
          : database.prepare(persistence.sql);
      statement.run(...persistence.parameters);
    }
    if (failAfterLabeled) {
      throw new Error("injected failure between persistence phases");
    }
    let reusableSimpleStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
    for (let offset = 0; offset < simpleUpdates.length; offset += SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
      const batch = simpleUpdates.slice(offset, offset + SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE);
      const persistence = buildSimplePhotoFoodDetectionStatement(batch);
      const statement =
        batch.length === SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE
          ? (reusableSimpleStatement ??= database.prepare(persistence.sql))
          : database.prepare(persistence.sql);
      statement.run(...persistence.parameters);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readRows(database: DatabaseSync): PhotoRow[] {
  return database
    .prepare(
      `SELECT id, foodDetected, foodLabels, foodConfidence, allLabels, payload
       FROM photos ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row })) as unknown as PhotoRow[];
}

function rowsChecksum(rows: readonly PhotoRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    for (const value of [row.id, row.foodDetected, row.foodLabels, row.foodConfidence, row.allLabels, row.payload]) {
      hash.update(value === null ? "<null>" : String(value));
      hash.update("\0");
    }
    hash.update("\u0001");
  }
  return hash.digest("hex");
}

const updates = buildUpdates();
const coalesced = coalescePhotoFoodDetectionUpdates(updates);
const finalLabeled = coalesced.labeledUpdates.find(({ photoId }) => photoId === "labeled");
assert.deepEqual(finalLabeled, {
  photoId: "labeled",
  foodDetected: false,
  foodLabelsJson: "[]",
  foodConfidence: 0,
  allLabelsJson: "[]",
});
assert.equal(coalesced.simpleUpdates.find(({ photoId }) => photoId === "simple-false-wins")?.foodDetected, false);
assert.equal(coalesced.simpleUpdates.find(({ photoId }) => photoId === "simple-true-only")?.foodDetected, true);

assert.throws(() => buildLabeledPhotoFoodDetectionStatement([]), RangeError);
assert.throws(() => buildSimplePhotoFoodDetectionStatement([]), RangeError);
assert.throws(
  () =>
    buildLabeledPhotoFoodDetectionStatement(
      Array.from({ length: LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE + 1 }, (_, index) => ({
        photoId: `too-many-${index}`,
        foodDetected: true,
        foodLabelsJson: null,
        foodConfidence: null,
        allLabelsJson: null,
      })),
    ),
  RangeError,
);
assert.throws(
  () =>
    buildSimplePhotoFoodDetectionStatement([
      { photoId: "duplicate", foodDetected: true },
      { photoId: "duplicate", foodDetected: false },
    ]),
  /duplicate photo IDs/,
);

const fullLabeledStatement = buildLabeledPhotoFoodDetectionStatement(
  coalesced.labeledUpdates.slice(0, LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE),
);
const fullSimpleStatement = buildSimplePhotoFoodDetectionStatement(
  coalesced.simpleUpdates.slice(0, SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE),
);
assert.equal(fullLabeledStatement.parameters.length, 900);
assert.equal(fullSimpleStatement.parameters.length, 900);

const oracleDatabase = createDatabase();
const candidateDatabase = createDatabase();
const rollbackDatabase = createDatabase();
try {
  seedDatabase(oracleDatabase);
  seedDatabase(candidateDatabase);
  seedDatabase(rollbackDatabase);
  const beforeRollbackRows = readRows(rollbackDatabase);

  applySequentialOracle(oracleDatabase, updates);
  applyCandidate(candidateDatabase, updates);
  assert.deepEqual(readRows(candidateDatabase), readRows(oracleDatabase));

  assert.throws(() => applyCandidate(rollbackDatabase, updates, true), /injected failure/);
  assert.deepEqual(readRows(rollbackDatabase), beforeRollbackRows);

  const labeledRow = candidateDatabase.prepare("SELECT * FROM photos WHERE id = ?").get("labeled");
  assert.deepEqual(
    {
      foodDetected: labeledRow?.foodDetected,
      foodLabels: labeledRow?.foodLabels,
      foodConfidence: labeledRow?.foodConfidence,
      allLabels: labeledRow?.allLabels,
    },
    { foodDetected: 0, foodLabels: "[]", foodConfidence: 0, allLabels: "[]" },
  );
  const overlapRow = candidateDatabase.prepare("SELECT * FROM photos WHERE id = ?").get("overlap");
  assert.equal(overlapRow?.foodDetected, 0);
  assert.equal(overlapRow?.foodLabels, '[{"label":"pizza","confidence":0.61}]');
  const confidenceOnlyRow = candidateDatabase.prepare("SELECT * FROM photos WHERE id = ?").get("confidence-only");
  assert.equal(confidenceOnlyRow?.foodLabels, null);
  assert.equal(confidenceOnlyRow?.foodConfidence, 0);
  assert.equal(confidenceOnlyRow?.allLabels, null);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        subsystem: "photo food-detection persistence",
        fixture: {
          databaseRows: readRows(candidateDatabase).length,
          rawUpdates: updates.length,
          uniqueLabeledUpdates: coalesced.labeledUpdates.length,
          uniqueSimpleUpdates: coalesced.simpleUpdates.length,
          fullDatabaseChecksum: rowsChecksum(readRows(candidateDatabase)),
        },
        assertions: {
          independentSequentialOracleParity: true,
          emptyArraysSerializeAsJson: true,
          omittedLabelsBecomeNull: true,
          zeroConfidencePreserved: true,
          missingIdsAreNoOp: true,
          lastLabeledDuplicateWinsAcrossBatches: true,
          falseSimpleDuplicateWins: true,
          simplePhaseRunsAfterLabeledAndPreservesPayload: true,
          unicodeAndQuotesAreParameterized: true,
          untouchedColumnsAndRowsPreserved: true,
          fullBatchParameterCountsStayBelow999: true,
          fullBatchStatementsExecuteAndReuse: true,
          mixedTransactionRollsBackAtomically: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  oracleDatabase.close();
  candidateDatabase.close();
  rollbackDatabase.close();
}
