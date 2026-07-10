#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildFoodReclassificationBatches,
  buildFoodReclassificationStatement,
  buildFoodReclassificationUpdate,
  FOOD_RECLASSIFICATION_BATCH_SIZE,
  type FoodReclassificationSource,
} from "../utils/db/food-reclassification-core.ts";

const enabledKeywords = new Set(["pizza", "coffee", "ice_cream"]);

const matched = buildFoodReclassificationUpdate(
  {
    photoId: "matched",
    allLabelsJson: JSON.stringify([
      { label: " Pizza ", confidence: 0.72 },
      { label: "person", confidence: 0.99 },
      { label: "COFFEE", confidence: 0.81 },
      { label: "pizza", confidence: 0.64 },
    ]),
  },
  enabledKeywords,
);
assert.deepEqual(matched, {
  photoId: "matched",
  foodDetected: true,
  foodLabelsJson: JSON.stringify([
    { label: " Pizza ", confidence: 0.72 },
    { label: "COFFEE", confidence: 0.81 },
    { label: "pizza", confidence: 0.64 },
  ]),
  foodConfidence: 0.81,
});

const unmatched = buildFoodReclassificationUpdate(
  {
    photoId: "unmatched",
    allLabelsJson: JSON.stringify([
      { label: "person", confidence: 0.95 },
      { label: "building", confidence: 0.82 },
    ]),
  },
  enabledKeywords,
);
assert.deepEqual(unmatched, {
  photoId: "unmatched",
  foodDetected: false,
  foodLabelsJson: null,
  foodConfidence: null,
});
assert.equal(
  buildFoodReclassificationUpdate({ photoId: "malformed", allLabelsJson: "not-json" }, enabledKeywords),
  null,
);
assert.equal(
  buildFoodReclassificationUpdate({ photoId: "non-array", allLabelsJson: '{"label":"pizza"}' }, enabledKeywords),
  null,
);

const finalMalformedSources: FoodReclassificationSource[] = [
  ...Array.from({ length: 499 }, (_, index) => ({
    photoId: `valid-${index}`,
    allLabelsJson: JSON.stringify([{ label: "pizza", confidence: index / 500 }]),
  })),
  { photoId: "malformed-final", allLabelsJson: "{" },
];
const finalMalformedBatches = [...buildFoodReclassificationBatches(finalMalformedSources, enabledKeywords, 500)];
assert.equal(finalMalformedBatches.length, 1);
assert.equal(finalMalformedBatches[0].updates.length, 499);
assert.equal(finalMalformedBatches[0].processed, 500);
assert.equal(finalMalformedBatches[0].updates.at(-1)?.photoId, "valid-498");

const defaultSizedBatches = [...buildFoodReclassificationBatches(finalMalformedSources.slice(0, 401), enabledKeywords)];
assert.deepEqual(
  defaultSizedBatches.map(({ updates, processed }) => ({ updates: updates.length, processed })),
  [
    { updates: FOOD_RECLASSIFICATION_BATCH_SIZE, processed: FOOD_RECLASSIFICATION_BATCH_SIZE },
    { updates: FOOD_RECLASSIFICATION_BATCH_SIZE, processed: FOOD_RECLASSIFICATION_BATCH_SIZE * 2 },
    { updates: 1, processed: 401 },
  ],
);
assert.throws(() => [...buildFoodReclassificationBatches([], enabledKeywords, 0)], RangeError);

assert.throws(() => buildFoodReclassificationStatement([]), RangeError);
assert.throws(
  () => buildFoodReclassificationStatement(defaultSizedBatches.flatMap(({ updates }) => updates)),
  RangeError,
);
assert.throws(
  () =>
    buildFoodReclassificationStatement([
      { ...defaultSizedBatches[0].updates[0] },
      { ...defaultSizedBatches[0].updates[0] },
    ]),
  /duplicate photo IDs/,
);

const database = new DatabaseSync(":memory:");
try {
  database.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    foodDetected INTEGER,
    foodLabels TEXT,
    foodConfidence REAL,
    allLabels TEXT,
    payload TEXT NOT NULL
  )`);
  const insert = database.prepare(
    `INSERT INTO photos (id, foodDetected, foodLabels, foodConfidence, allLabels, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("matched", 0, "old-labels", 0.01, "preserve-matched-labels", "sentinel-a");
  insert.run("unmatched", 1, "old-labels", 0.99, "preserve-unmatched-labels", "sentinel-b");
  insert.run("untouched", 1, "untouched-labels", 0.5, "preserve-untouched-labels", "sentinel-c");

  assert.ok(matched && unmatched);
  const statement = buildFoodReclassificationStatement([
    matched,
    unmatched,
    {
      photoId: "missing-id",
      foodDetected: true,
      foodLabelsJson: "[]",
      foodConfidence: 1,
    },
  ]);
  database.exec("BEGIN");
  database.prepare(statement.sql).run(...statement.parameters);
  database.exec("COMMIT");

  const rows = database
    .prepare(
      `SELECT id, foodDetected, foodLabels, foodConfidence, allLabels, payload
       FROM photos ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      id: "matched",
      foodDetected: 1,
      foodLabels: matched.foodLabelsJson,
      foodConfidence: 0.81,
      allLabels: "preserve-matched-labels",
      payload: "sentinel-a",
    },
    {
      id: "unmatched",
      foodDetected: 0,
      foodLabels: null,
      foodConfidence: null,
      allLabels: "preserve-unmatched-labels",
      payload: "sentinel-b",
    },
    {
      id: "untouched",
      foodDetected: 1,
      foodLabels: "untouched-labels",
      foodConfidence: 0.5,
      allLabels: "preserve-untouched-labels",
      payload: "sentinel-c",
    },
  ]);
} finally {
  database.close();
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "food reclassification",
      assertions: {
        labelNormalizationAndOrder: true,
        maximumMatchedConfidence: true,
        noMatchNullSemantics: true,
        malformedJsonSkipped: true,
        validNonArrayJsonSkipped: true,
        malformedFinalRowFlush: true,
        boundedBatches: true,
        parameterizedSetBasedUpdate: true,
        sourceLabelsAndPayloadPreserved: true,
        missingAndUntouchedRows: true,
      },
    },
    null,
    2,
  ),
);
