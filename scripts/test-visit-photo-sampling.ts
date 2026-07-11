#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildVisitPhotoSampleStatement,
  FOOD_DETECTION_VISIT_SAMPLES_SQL,
  parseFoodDetectionVisitSampleRows,
  VISIT_PHOTO_SAMPLE_BATCH_SIZE,
  type FoodDetectionVisitSample,
  type FoodDetectionVisitSampleRow,
} from "../utils/db/visit-photo-sampling-core.ts";

function legacySamplePlan(database: DatabaseSync, samplePercentage: number) {
  const visits = database
    .prepare(
      `SELECT v.id FROM visits AS v
       WHERE EXISTS (
         SELECT 1 FROM photos AS photo
         WHERE photo.visitId = v.id AND photo.foodDetected IS NULL
       )
       ORDER BY v.startTime DESC, v.id ASC`,
    )
    .all() as Array<{ id: string }>;
  const samples: FoodDetectionVisitSample[] = [];
  const sampleStatement = database.prepare(
    `SELECT id FROM photos
     WHERE visitId = ? AND foodDetected IS NULL
     ORDER BY creationTime ASC, id ASC
     LIMIT MAX(1, CAST((SELECT COUNT(*) FROM photos WHERE visitId = ?) * ? AS INTEGER))`,
  );
  for (const visit of visits) {
    const photos = sampleStatement.all(visit.id, visit.id, samplePercentage) as Array<{ id: string }>;
    samples.push(...photos.map(({ id }, index) => ({ visitId: visit.id, photoId: id, sampleRank: index + 1 })));
  }
  return { totalVisits: visits.length, samples };
}

function combinedSamplePlan(database: DatabaseSync, samplePercentage: number) {
  const rows = database
    .prepare(FOOD_DETECTION_VISIT_SAMPLES_SQL)
    .all(samplePercentage) as unknown as FoodDetectionVisitSampleRow[];
  return parseFoodDetectionVisitSampleRows(rows);
}

function chunkedSamplePlan(database: DatabaseSync, samplePercentage: number) {
  const visits = database
    .prepare(
      `SELECT v.id FROM visits AS v
       WHERE EXISTS (
         SELECT 1 FROM photos AS photo
         WHERE photo.visitId = v.id AND photo.foodDetected IS NULL
       )
       ORDER BY v.startTime DESC, v.id ASC`,
    )
    .all() as Array<{ id: string }>;
  const samples: FoodDetectionVisitSample[] = [];
  for (let offset = 0; offset < visits.length; offset += VISIT_PHOTO_SAMPLE_BATCH_SIZE) {
    const statement = buildVisitPhotoSampleStatement(
      visits.slice(offset, offset + VISIT_PHOTO_SAMPLE_BATCH_SIZE).map(({ id }) => id),
      samplePercentage,
    );
    const rows = database.prepare(statement.sql).all(...statement.parameters) as unknown as FoodDetectionVisitSample[];
    samples.push(...rows.map(({ visitId, photoId, sampleRank }) => ({ visitId, photoId, sampleRank })));
  }
  return { totalVisits: visits.length, samples };
}

const database = new DatabaseSync(":memory:");
try {
  database.exec(`
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      startTime INTEGER NOT NULL
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      creationTime INTEGER NOT NULL,
      foodDetected INTEGER
    );
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_visits_time ON visits(startTime);
  `);
  const insertVisit = database.prepare("INSERT INTO visits (id, startTime) VALUES (?, ?)");
  // v-newer-a and v-newer-b deliberately tie; the explicit ID tie-break makes
  // visit order stable regardless of whether idx_visits_time is used.
  insertVisit.run("v-old-雪's", 100);
  insertVisit.run("v-newer-a", 300);
  insertVisit.run("v-middle-analyzed", 200);
  insertVisit.run("v-newer-b", 300);
  insertVisit.run("v-nine", 250);
  insertVisit.run("v-empty", 400);

  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, visitId, creationTime, foodDetected) VALUES (?, ?, ?, ?)",
  );
  for (let index = 0; index < 10; index++) {
    insertPhoto.run(
      `a-${index.toString().padStart(2, "0")}`,
      "v-newer-a",
      index === 0 || index === 1 ? 10 : index * 10,
      index < 5 ? null : index % 2,
    );
  }
  // Same creation time verifies the secondary ID ordering.
  insertPhoto.run("b-z", "v-newer-b", 20, null);
  insertPhoto.run("b-a", "v-newer-b", 20, null);
  insertPhoto.run("b-m", "v-newer-b", 30, 0);
  for (let index = 0; index < 9; index++) {
    insertPhoto.run(index === 0 ? "nine-雪's" : `nine-${index}`, "v-nine", index, index < 3 ? null : index % 2);
  }
  for (let index = 0; index < 5; index++) {
    insertPhoto.run(`old-${index}`, "v-old-雪's", index, null);
    insertPhoto.run(`analyzed-${index}`, "v-middle-analyzed", index, index % 2);
  }
  insertPhoto.run("unassigned", null, 0, null);
  insertPhoto.run("orphan", "missing-visit", 0, null);

  for (const samplePercentage of [-0.5, 0, 0.1, 0.2, 1, 2]) {
    assert.deepEqual(
      combinedSamplePlan(database, samplePercentage),
      legacySamplePlan(database, samplePercentage),
      `sample percentage ${samplePercentage} changed results`,
    );
    assert.deepEqual(
      chunkedSamplePlan(database, samplePercentage),
      legacySamplePlan(database, samplePercentage),
      `chunked sample percentage ${samplePercentage} changed results`,
    );
  }

  assert.deepEqual(combinedSamplePlan(database, 0.2), {
    totalVisits: 4,
    samples: [
      { visitId: "v-newer-a", photoId: "a-00", sampleRank: 1 },
      { visitId: "v-newer-a", photoId: "a-01", sampleRank: 2 },
      { visitId: "v-newer-b", photoId: "b-a", sampleRank: 1 },
      { visitId: "v-nine", photoId: "nine-雪's", sampleRank: 1 },
      { visitId: "v-old-雪's", photoId: "old-0", sampleRank: 1 },
    ],
  });

  const duplicateStatement = buildVisitPhotoSampleStatement(["v-old-雪's", "v-old-雪's"], 0);
  assert.deepEqual(
    database
      .prepare(duplicateStatement.sql)
      .all(...duplicateStatement.parameters)
      .map(({ visitId, photoId, sampleRank }) => ({ visitId, photoId, sampleRank })),
    [
      { visitId: "v-old-雪's", photoId: "old-0", sampleRank: 1 },
      { visitId: "v-old-雪's", photoId: "old-0", sampleRank: 1 },
    ],
  );
  assert.throws(() => buildVisitPhotoSampleStatement([], 0.2), RangeError);
  assert.throws(
    () =>
      buildVisitPhotoSampleStatement(
        Array.from({ length: VISIT_PHOTO_SAMPLE_BATCH_SIZE + 1 }, () => "v"),
        0.2,
      ),
    RangeError,
  );
  assert.throws(() => buildVisitPhotoSampleStatement(["v"], Number.NaN), RangeError);

  database.exec("DELETE FROM photos");
  assert.deepEqual(combinedSamplePlan(database, 0.2), { totalVisits: 0, samples: [] });
  assert.deepEqual(parseFoodDetectionVisitSampleRows([]), { totalVisits: 0, samples: [] });
  assert.throws(
    () => parseFoodDetectionVisitSampleRows([{ visitId: "visit", photoId: "photo", sampleRank: 0, totalVisits: 1 }]),
    /sampleRank/,
  );
  assert.throws(
    () => parseFoodDetectionVisitSampleRows([{ visitId: "visit", photoId: "photo-2", sampleRank: 2, totalVisits: 1 }]),
    /expected 1/,
  );
  assert.throws(
    () => parseFoodDetectionVisitSampleRows([{ visitId: "visit", photoId: "photo", sampleRank: 1, totalVisits: 2 }]),
    /contain 1 visits but report totalVisits 2/,
  );
  assert.throws(
    () =>
      parseFoodDetectionVisitSampleRows([
        { visitId: "visit-a", photoId: "photo", sampleRank: 1, totalVisits: 2 },
        { visitId: "visit-b", photoId: "photo", sampleRank: 1, totalVisits: 2 },
      ]),
    /duplicate photoId/,
  );
} finally {
  database.close();
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "visit photo sampling",
      assertions: {
        exactLegacyParity: true,
        chunkedAlternativeParity: true,
        duplicateAndParameterizedVisitIds: true,
        visitOrderingAndTieGrouping: true,
        photoCreationTimeAndIdOrdering: true,
        sampleLimitUsesAllPhotos: true,
        fractionalLimitTruncates: true,
        atLeastOneUnanalyzedSample: true,
        allUnanalyzedAtOneHundredPercent: true,
        analyzedAndEmptyVisitsExcluded: true,
        unassignedAndOrphanPhotosExcluded: true,
        emptyPlan: true,
        strictSampleRankParsing: true,
        consistentVisitCountParsing: true,
      },
    },
    null,
    2,
  ),
);
