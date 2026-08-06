#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CLEAR_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
  COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL,
  CREATE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL,
  ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL,
  GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL,
  IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
  MARK_AUTOMATIC_PHOTO_DEEP_SCAN_ATTEMPTS_SQL,
  MARK_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
  PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL,
  validateAutomaticPhotoDeepScanBatchLimit,
} from "../utils/db/automatic-photo-deep-scan-queue-core.ts";
import { buildPhotoIngestionStatement } from "../utils/db/photo-ingestion-core.ts";
import { AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE } from "../utils/automatic-photo-rescan-core.ts";

const database = new DatabaseSync(":memory:");
try {
  database.exec(`CREATE TABLE app_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
  database.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY NOT NULL,
    uri TEXT NOT NULL,
    creationTime INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    foodDetected INTEGER,
    mediaType TEXT,
    duration REAL
  )`);
  database.exec(CREATE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL);

  const claimCandidates = (limit: number): string[] => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const ids = database
        .prepare(GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL)
        .all(limit)
        .map((row) => String(row.id));
      if (ids.length > 0) {
        database.prepare(MARK_AUTOMATIC_PHOTO_DEEP_SCAN_ATTEMPTS_SQL).run(JSON.stringify(ids));
      }
      database.exec("COMMIT");
      return ids;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const getStateFlag = (source: string): number =>
    Number((database.prepare(source).get() as { isPending: number }).isPending);

  const insertPhoto = database.prepare(
    `INSERT INTO photos (id, uri, creationTime, foodDetected, mediaType) VALUES (?, ?, ?, ?, 'photo')`,
  );
  insertPhoto.run("needs-'深度'-🍜", "ph://null", 1, null);
  insertPhoto.run("known-food", "ph://food", 2, 1);
  insertPhoto.run("known-not-food", "ph://not-food", 3, 0);

  database
    .prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL)
    .run(JSON.stringify(["needs-'深度'-🍜", "known-food", "known-not-food", "missing", "needs-'深度'-🍜"]));

  const initialCount = database.prepare(COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL).get() as {
    pendingCount: number;
  };
  assert.equal(initialCount.pendingCount, 1, "only queued NULL rows are deep-scan candidates");
  assert.deepEqual(
    database
      .prepare(GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL)
      .all(999)
      .map((row) => String(row.id)),
    ["needs-'深度'-🍜"],
  );

  database.prepare(PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL).run();
  assert.deepEqual(
    database
      .prepare("SELECT assetId FROM automatic_photo_deep_scan_queue ORDER BY assetId")
      .all()
      .map((row) => String(row.assetId)),
    ["needs-'深度'-🍜"],
  );

  const ingestion = buildPhotoIngestionStatement([
    {
      id: "known-food",
      uri: "ph://ignored-existing",
      creationTime: 4,
      latitude: null,
      longitude: null,
      mediaType: "photo",
      duration: null,
    },
    {
      id: "arrived-during-scan",
      uri: "ph://new",
      creationTime: 5,
      latitude: null,
      longitude: null,
      mediaType: "photo",
      duration: null,
    },
  ]);
  assert.ok(ingestion);
  const insertedRows = database.prepare(`${ingestion.sql} RETURNING id`).all(...ingestion.parameters) as Array<{
    id: string;
  }>;
  assert.deepEqual(
    insertedRows.map((row) => row.id),
    ["arrived-during-scan"],
    "RETURNING captures exact inserts, not a preflight snapshot",
  );
  database.prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL).run(JSON.stringify(insertedRows.map((row) => row.id)));
  database.prepare(MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run();
  assert.equal(getStateFlag(IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL), 1);
  database.prepare(CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run();
  assert.equal(getStateFlag(IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL), 0);

  const afterExactInsert = database.prepare(COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL).get() as {
    pendingCount: number;
  };
  assert.equal(afterExactInsert.pendingCount, 2);

  database.prepare("UPDATE photos SET foodDetected = 0 WHERE id = ?").run("needs-'深度'-🍜");
  database.prepare(PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL).run();
  assert.deepEqual(
    database
      .prepare("SELECT assetId FROM automatic_photo_deep_scan_queue")
      .all()
      .map((row) => String(row.assetId)),
    ["arrived-during-scan"],
  );

  assert.equal(validateAutomaticPhotoDeepScanBatchLimit(999), 999);
  assert.throws(() => validateAutomaticPhotoDeepScanBatchLimit(0), /positive safe integer/);
  assert.throws(() => validateAutomaticPhotoDeepScanBatchLimit(Number.NaN), /positive safe integer/);

  database.prepare(MARK_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL).run();
  assert.equal(getStateFlag(IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL), 1);
  database.prepare(CLEAR_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL).run();
  assert.equal(getStateFlag(IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL), 0);

  database.exec("DELETE FROM automatic_photo_deep_scan_queue; DELETE FROM photos;");
  const boundedIds = Array.from(
    { length: AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE + 1 },
    (_, index) => `bounded-${index.toString().padStart(2, "0")}`,
  );
  for (const [index, id] of boundedIds.entries()) {
    insertPhoto.run(id, `ph://${id}`, index, null);
  }
  database.prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL).run(JSON.stringify(boundedIds));
  const boundedClaim = claimCandidates(AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE);
  assert.equal(boundedClaim.length, AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE);
  assert.equal(new Set(boundedClaim).size, AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE);
  assert.ok(
    boundedIds.some((id) => !boundedClaim.includes(id)),
    "one queued row must remain outside the bounded claim",
  );

  database.exec("DELETE FROM automatic_photo_deep_scan_queue; DELETE FROM photos;");
  const fairnessIds = Array.from({ length: 1_001 }, (_, index) => `fairness-${index.toString().padStart(4, "0")}`);
  for (const [index, id] of fairnessIds.entries()) {
    insertPhoto.run(id, `ph://${id}`, index, null);
  }
  database.prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL).run(JSON.stringify(fairnessIds));
  const firstClaim = claimCandidates(999);
  database.prepare(PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL).run();
  const secondClaim = claimCandidates(999);
  const firstClaimSet = new Set(firstClaim);
  assert.equal(firstClaim.length, 999);
  assert.ok(
    secondClaim.some((id) => !firstClaimSet.has(id)),
    "failed rows must rotate behind never-attempted queue rows",
  );

  database.exec("DELETE FROM automatic_photo_deep_scan_queue; DELETE FROM photos;");
  database.exec("BEGIN IMMEDIATE");
  let reachedForcedRollback = false;
  try {
    const rollbackIngestion = buildPhotoIngestionStatement([
      {
        id: "must-roll-back",
        uri: "ph://rollback",
        creationTime: 1,
        latitude: null,
        longitude: null,
        mediaType: "photo",
        duration: null,
      },
    ]);
    assert.ok(rollbackIngestion);
    const rollbackRows = database
      .prepare(`${rollbackIngestion.sql} RETURNING id`)
      .all(...rollbackIngestion.parameters)
      .map((row) => String(row.id));
    database.prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL).run(JSON.stringify(rollbackRows));
    database.prepare(MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run();
    reachedForcedRollback = true;
    database.exec("INSERT INTO deliberately_missing_table VALUES (1)");
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
  }
  assert.equal(reachedForcedRollback, true);
  assert.equal(Number((database.prepare("SELECT COUNT(*) AS count FROM photos").get() as { count: number }).count), 0);
  assert.equal(
    Number(
      (database.prepare("SELECT COUNT(*) AS count FROM automatic_photo_deep_scan_queue").get() as { count: number })
        .count,
    ),
    0,
  );
  assert.equal(getStateFlag(IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL), 0);

  console.log("Automatic photo deep-scan queue tests passed.");
} finally {
  database.close();
}
