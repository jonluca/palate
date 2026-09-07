export const REFRESH_AFFECTED_VISIT_PHOTO_COUNTS_SQL = `UPDATE visits
SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id)
WHERE id IN (SELECT value FROM json_each(?))`;

const ATOMIC_VISIT_PHOTO_COUNTS_VERSION_KEY = "atomic_visit_photo_counts_v1";

interface VisitPhotoCountMigrationDatabase {
  getAllAsync<T>(sql: string): Promise<T[]>;
  execAsync(sql: string): Promise<void>;
}

/** Repair pre-upgrade interrupted assignments once, before the database is published. */
export async function repairLegacyVisitPhotoCounts(database: VisitPhotoCountMigrationDatabase): Promise<void> {
  const completed = await database.getAllAsync<{ value: string }>(
    `SELECT value FROM app_metadata WHERE key = '${ATOMIC_VISIT_PHOTO_COUNTS_VERSION_KEY}' AND value = '1'`,
  );
  if (completed.length > 0) {
    return;
  }
  try {
    await database.execAsync(`BEGIN IMMEDIATE;
      UPDATE visits SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id);
      INSERT INTO app_metadata (key, value) VALUES ('${ATOMIC_VISIT_PHOTO_COUNTS_VERSION_KEY}', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      COMMIT;`);
  } catch (error) {
    await database.execAsync("ROLLBACK;").catch(() => undefined);
    throw error;
  }
}
