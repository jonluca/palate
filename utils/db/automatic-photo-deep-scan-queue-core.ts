import { MAX_PHOTO_FOOD_DETECTION_FAILURES } from "./photo-food-detection-failure-core.ts";

export const AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE = "automatic_photo_deep_scan_queue";
export const AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_KEY = "automatic_photo_quick_pipeline_incomplete";
export const AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_KEY = "automatic_photo_food_sync_required";

export const CREATE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL = `
  CREATE TABLE IF NOT EXISTS ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE} (
    assetId TEXT PRIMARY KEY NOT NULL,
    attemptCount INTEGER NOT NULL DEFAULT 0
  );
`;

export const ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL = `
  INSERT OR IGNORE INTO ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE} (assetId)
  SELECT CAST(value AS TEXT)
  FROM json_each(?)
  WHERE type = 'text'
`;

export const COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL = `
  SELECT COUNT(*) AS pendingCount
  FROM ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE} AS queue
  INNER JOIN photos AS photo ON photo.id = queue.assetId
  WHERE photo.foodDetected IS NULL
    AND photo.foodDetectionFailureCount < ${MAX_PHOTO_FOOD_DETECTION_FAILURES}
`;

/** Bind the batch limit as ?1 and this run's already-attempted ID JSON array as ?2. */
export const GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL = `
  SELECT photo.id
  FROM ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE} AS queue
  INNER JOIN photos AS photo ON photo.id = queue.assetId
  WHERE photo.foodDetected IS NULL
    AND photo.foodDetectionFailureCount < ${MAX_PHOTO_FOOD_DETECTION_FAILURES}
    AND queue.assetId NOT IN (
      SELECT CAST(value AS TEXT)
      FROM json_each(?2)
      WHERE type = 'text'
    )
  ORDER BY queue.attemptCount ASC, photo.creationTime ASC, photo.id ASC
  LIMIT ?1
`;

export const MARK_AUTOMATIC_PHOTO_DEEP_SCAN_ATTEMPTS_SQL = `
  UPDATE ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE}
  SET attemptCount = attemptCount + 1
  WHERE assetId IN (
    SELECT CAST(value AS TEXT)
    FROM json_each(?)
    WHERE type = 'text'
  )
`;

/** Keep only rows that still exist and still need a successful deep result. */
export const PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL = `
  DELETE FROM ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE}
  WHERE NOT EXISTS (
    SELECT 1
    FROM photos AS photo
    WHERE photo.id = ${AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_TABLE}.assetId
      AND photo.foodDetected IS NULL
      AND photo.foodDetectionFailureCount < ${MAX_PHOTO_FOOD_DETECTION_FAILURES}
  )
`;

export const MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL = `
  INSERT INTO app_metadata (key, value)
  VALUES ('${AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_KEY}', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`;

export const CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL = `
  DELETE FROM app_metadata WHERE key = '${AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_KEY}'
`;

export const IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL = `
  SELECT EXISTS(
    SELECT 1 FROM app_metadata
    WHERE key = '${AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_KEY}' AND value = '1'
  ) AS isPending
`;

export const MARK_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL = `
  INSERT INTO app_metadata (key, value)
  VALUES ('${AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_KEY}', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`;

export const CLEAR_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL = `
  DELETE FROM app_metadata WHERE key = '${AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_KEY}'
`;

export const IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL = `
  SELECT EXISTS(
    SELECT 1 FROM app_metadata
    WHERE key = '${AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_KEY}' AND value = '1'
  ) AS isPending
`;

export function validateAutomaticPhotoDeepScanBatchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`Automatic deep-scan batch limit must be a positive safe integer; received ${String(limit)}`);
  }
  return limit;
}
