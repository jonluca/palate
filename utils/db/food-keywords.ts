import { DEBUG_TIMING, getDatabase } from "./core";
import { syncAllVisitsFoodProbable } from "./visits";
import type { FoodKeywordRecord, FoodLabel, ReclassifyProgress } from "./types";

// ============================================================================
// FOOD KEYWORDS OPERATIONS
// ============================================================================

/**
 * Get all food keywords from the database
 */
export async function getAllFoodKeywords(): Promise<FoodKeywordRecord[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    id: number;
    keyword: string;
    enabled: number;
    isBuiltIn: number;
    createdAt: number;
  }>(`SELECT * FROM food_keywords ORDER BY keyword ASC`);

  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    enabled: row.enabled === 1,
    isBuiltIn: row.isBuiltIn === 1,
    createdAt: row.createdAt,
  }));
}

/**
 * Get only enabled food keywords (for classification)
 */
export async function getEnabledFoodKeywords(): Promise<string[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ keyword: string }>(
    `SELECT keyword FROM food_keywords WHERE enabled = 1 ORDER BY keyword ASC`,
  );
  return rows.map((row) => row.keyword);
}

/**
 * Add a new food keyword
 */
export async function addFoodKeyword(keyword: string): Promise<FoodKeywordRecord> {
  const database = await getDatabase();
  const now = Date.now();
  const normalizedKeyword = keyword.trim().toLowerCase();

  await database.runAsync(`INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt) VALUES (?, 1, 0, ?)`, [
    normalizedKeyword,
    now,
  ]);

  const result = await database.getFirstAsync<{
    id: number;
    keyword: string;
    enabled: number;
    isBuiltIn: number;
    createdAt: number;
  }>(`SELECT * FROM food_keywords WHERE keyword = ?`, [normalizedKeyword]);

  if (!result) {
    throw new Error("Failed to add food keyword");
  }

  return {
    id: result.id,
    keyword: result.keyword,
    enabled: result.enabled === 1,
    isBuiltIn: result.isBuiltIn === 1,
    createdAt: result.createdAt,
  };
}

/**
 * Remove a food keyword (only user-added keywords can be removed)
 */
export async function removeFoodKeyword(id: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`DELETE FROM food_keywords WHERE id = ? AND isBuiltIn = 0`, [id]);
}

/**
 * Toggle a food keyword on/off
 */
export async function toggleFoodKeyword(id: number, enabled: boolean): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`UPDATE food_keywords SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
}

/**
 * Reset food keywords to defaults (re-enable all built-in, remove user-added)
 */
export async function resetFoodKeywordsToDefaults(): Promise<void> {
  const database = await getDatabase();

  // Remove user-added keywords
  await database.runAsync(`DELETE FROM food_keywords WHERE isBuiltIn = 0`);

  // Re-enable all built-in keywords
  await database.runAsync(`UPDATE food_keywords SET enabled = 1 WHERE isBuiltIn = 1`);
}

/**
 * Get photos that have allLabels stored (for reclassification)
 */
async function getPhotosWithAllLabels(): Promise<Array<{ id: string; visitId: string | null; allLabels: string }>> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string; visitId: string | null; allLabels: string }>(
    `SELECT id, visitId, allLabels FROM photos WHERE allLabels IS NOT NULL`,
  );
}

/**
 * Get count of photos that have classification data for reclassification progress
 */
export async function getPhotosWithLabelsCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE allLabels IS NOT NULL`,
  );
  return result?.count ?? 0;
}

/**
 * Reclassify all photos based on current enabled food keywords.
 * This re-evaluates allLabels against the current keyword set and updates:
 * - foodDetected (true/false based on whether any enabled keyword matches)
 * - foodLabels (filtered labels that match enabled keywords)
 * - foodConfidence (max confidence among matched labels)
 */
export async function reclassifyPhotosWithCurrentKeywords(
  onProgress?: (progress: ReclassifyProgress) => void,
): Promise<ReclassifyProgress> {
  const database = await getDatabase();
  const start = DEBUG_TIMING ? performance.now() : 0;

  // Get enabled keywords as a Set for fast lookup
  const enabledKeywords = new Set(await getEnabledFoodKeywords());

  // Get all photos that have allLabels stored
  const photosToProcess = await getPhotosWithAllLabels();

  const progress: ReclassifyProgress = {
    total: photosToProcess.length,
    processed: 0,
    updated: 0,
    isComplete: false,
  };

  if (photosToProcess.length === 0) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  onProgress?.(progress);

  const BATCH_SIZE = 500;
  const updates: Array<{
    photoId: string;
    foodDetected: boolean;
    foodLabels: FoodLabel[];
    foodConfidence: number | null;
  }> = [];

  for (let i = 0; i < photosToProcess.length; i++) {
    const photo = photosToProcess[i];

    let allLabels: FoodLabel[] = [];
    try {
      allLabels = JSON.parse(photo.allLabels) as FoodLabel[];
    } catch {
      continue; // Skip malformed JSON
    }

    // Filter labels that match enabled keywords
    const matchedLabels = allLabels.filter((label) => {
      const lowerLabel = label.label.trim().toLowerCase();
      return enabledKeywords.has(lowerLabel);
    });

    const foodDetected = matchedLabels.length > 0;
    const foodConfidence = matchedLabels.length > 0 ? Math.max(...matchedLabels.map((l) => l.confidence)) : null;

    updates.push({
      photoId: photo.id,
      foodDetected,
      foodLabels: matchedLabels,
      foodConfidence,
    });

    progress.processed = i + 1;

    // Process in batches
    if (updates.length >= BATCH_SIZE || i === photosToProcess.length - 1) {
      // Update photos in database
      for (const update of updates) {
        await database.runAsync(`UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ? WHERE id = ?`, [
          update.foodDetected ? 1 : 0,
          update.foodLabels.length > 0 ? JSON.stringify(update.foodLabels) : null,
          update.foodConfidence,
          update.photoId,
        ]);
      }

      progress.updated += updates.length;
      updates.length = 0; // Clear the array

      onProgress?.(progress);
    }
  }

  // Update visit food probable flags
  await syncAllVisitsFoodProbable();

  progress.isComplete = true;
  onProgress?.(progress);

  if (DEBUG_TIMING) {
    console.log(
      `[DB] reclassifyPhotosWithCurrentKeywords: ${(performance.now() - start).toFixed(2)}ms (${progress.total} photos)`,
    );
  }

  return progress;
}
