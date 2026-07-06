import { getDatabase } from "./core";
import type { FoodLabel, PhotoRecord, UnvisitedPhotoRecord } from "./types";

// Raw photo record as stored in database (foodLabels and allLabels are JSON strings)
interface RawPhotoRecord extends Omit<PhotoRecord, "foodLabels" | "foodDetected" | "allLabels" | "mediaType"> {
  foodLabels: string | null;
  foodDetected: number | null;
  allLabels: string | null;
  mediaType: string | null;
}

// Helper to parse raw database photo record into proper PhotoRecord
function parsePhotoRecord(raw: RawPhotoRecord): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    try {
      foodLabels = JSON.parse(raw.foodLabels) as FoodLabel[];
    } catch {
      // Skip malformed JSON
    }
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    try {
      allLabels = JSON.parse(raw.allLabels) as FoodLabel[];
    } catch {
      // Skip malformed JSON
    }
  }

  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels,
    allLabels,
    mediaType: (raw.mediaType === "video" ? "video" : "photo") as "photo" | "video",
  };
}

// Photo operations
export async function insertPhotos(
  photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence" | "allLabels">[],
): Promise<number> {
  if (photos.length === 0) {
    return 0;
  }

  const database = await getDatabase();
  const batchSize = 1000;
  let insertedCount = 0;

  for (let i = 0; i < photos.length; i += batchSize) {
    const batch = photos.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((p) => [
      p.id,
      p.uri,
      p.creationTime,
      p.latitude,
      p.longitude,
      p.mediaType,
      p.duration,
    ]);

    // foodDetected is left as NULL (not set until food detection runs)
    const result = await database.runAsync(
      `INSERT OR IGNORE INTO photos (id, uri, creationTime, latitude, longitude, mediaType, duration) VALUES ${placeholders}`,
      values,
    );
    insertedCount += result.changes;
  }

  return insertedCount;
}

export async function getUnvisitedPhotos(): Promise<UnvisitedPhotoRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<UnvisitedPhotoRecord>(
    `SELECT id, creationTime, latitude, longitude
     FROM photos
     WHERE visitId IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY creationTime ASC, id ASC`,
  );
}

export async function getPhotosByVisitId(visitId: string): Promise<PhotoRecord[]> {
  const database = await getDatabase();
  // Order by food detected first (1 = food, 0 = no food, NULL = unknown), then by creation time
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE visitId = ? ORDER BY 
      CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
      creationTime ASC`,
    [visitId],
  );
  return rawPhotos.map(parsePhotoRecord);
}

/**
 * Get photo IDs that haven't been analyzed for food yet (foodDetected IS NULL)
 * Ordered deterministically by creationTime and id
 */
export async function getUnanalyzedPhotoIds(): Promise<{ id: string }[]> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string }>(
    `SELECT id FROM photos WHERE foodDetected IS NULL ORDER BY creationTime ASC, id ASC`,
  );
}

/**
 * Get count of photos that haven't been analyzed for food yet (foodDetected IS NULL)
 */
export async function getUnanalyzedPhotoCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE foodDetected IS NULL`,
  );
  return result?.count ?? 0;
}

export async function getTotalPhotoCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM photos`);
  return result?.count ?? 0;
}

export async function getVisitablePhotoCounts(): Promise<{
  total: number;
  visited: number;
  unvisited: number;
}> {
  const database = await getDatabase();
  const counts = await database.getFirstAsync<{ total: number; visited: number }>(
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN visitId IS NOT NULL THEN 1 ELSE 0 END) as visited
     FROM photos 
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
  );
  return {
    total: counts?.total ?? 0,
    visited: counts?.visited ?? 0,
    unvisited: (counts?.total ?? 0) - (counts?.visited ?? 0),
  };
}

export async function batchUpdatePhotosFoodDetected(
  updates: {
    photoId: string;
    foodDetected: boolean;
    foodLabels?: FoodLabel[];
    foodConfidence?: number;
    allLabels?: FoodLabel[];
  }[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // For updates with labels/confidence/allLabels, we need to update individually
  const updatesWithLabels = updates.filter(
    (u) => u.foodLabels !== undefined || u.foodConfidence !== undefined || u.allLabels !== undefined,
  );
  const simpleUpdates = updates.filter(
    (u) => u.foodLabels === undefined && u.foodConfidence === undefined && u.allLabels === undefined,
  );

  await database.withExclusiveTransactionAsync(async (transaction) => {
    if (updatesWithLabels.length > 0) {
      const statement = await transaction.prepareAsync(
        `UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ?, allLabels = ? WHERE id = ?`,
      );

      try {
        for (const update of updatesWithLabels) {
          await statement.executeAsync([
            update.foodDetected ? 1 : 0,
            update.foodLabels ? JSON.stringify(update.foodLabels) : null,
            update.foodConfidence ?? null,
            update.allLabels ? JSON.stringify(update.allLabels) : null,
            update.photoId,
          ]);
        }
      } finally {
        await statement.finalizeAsync();
      }
    }

    // For simple updates (no labels), batch by detected/not detected.
    const detectedIds = simpleUpdates.filter((update) => update.foodDetected).map((update) => update.photoId);
    const notDetectedIds = simpleUpdates.filter((update) => !update.foodDetected).map((update) => update.photoId);
    const batchSize = 1000;

    for (let i = 0; i < detectedIds.length; i += batchSize) {
      const batch = detectedIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      await transaction.runAsync(`UPDATE photos SET foodDetected = 1 WHERE id IN (${placeholders})`, batch);
    }

    for (let i = 0; i < notDetectedIds.length; i += batchSize) {
      const batch = notDetectedIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      await transaction.runAsync(`UPDATE photos SET foodDetected = 0 WHERE id IN (${placeholders})`, batch);
    }
  });
}

/**
 * Get photos by their asset IDs (for checking if photos exist in the database)
 */
export async function getPhotosByAssetIds(assetIds: string[]): Promise<PhotoRecord[]> {
  if (assetIds.length === 0) {
    return [];
  }

  const database = await getDatabase();
  const placeholders = assetIds.map(() => "?").join(", ");
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE id IN (${placeholders})`,
    assetIds,
  );
  return rawPhotos.map(parsePhotoRecord);
}
