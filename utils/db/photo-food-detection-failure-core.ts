export const MAX_PHOTO_FOOD_DETECTION_FAILURES = 3;

export const RECORD_PHOTO_FOOD_DETECTION_FAILURES_SQL = `
  UPDATE photos
  SET foodDetectionFailureCount = MIN(foodDetectionFailureCount + 1, ${MAX_PHOTO_FOOD_DETECTION_FAILURES})
  WHERE foodDetectionFailureCount < ${MAX_PHOTO_FOOD_DETECTION_FAILURES}
    AND id IN (
      SELECT CAST(value AS TEXT)
      FROM json_each(?)
      WHERE type = 'text'
    )
  RETURNING id, foodDetectionFailureCount
`;

interface PhotoFoodDetectionMigrationDatabase {
  getAllAsync(sql: string): Promise<Array<{ name: string }>>;
  execAsync(sql: string): Promise<void>;
}

/** Preserve existing classifications while giving every legacy row its initial retry budget. */
export async function ensurePhotoFoodDetectionFailureCount(
  database: PhotoFoodDetectionMigrationDatabase,
): Promise<void> {
  const columns = await database.getAllAsync("PRAGMA table_info(photos)");
  if (columns.some((column) => column.name === "foodDetectionFailureCount")) {
    return;
  }
  await database.execAsync("ALTER TABLE photos ADD COLUMN foodDetectionFailureCount INTEGER NOT NULL DEFAULT 0");
}
