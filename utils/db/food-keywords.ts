import { DEBUG_TIMING, getDatabase } from "./core";
import {
  buildFoodReclassificationBatches,
  buildFoodReclassificationStatement,
  FOOD_RECLASSIFICATION_BATCH_SIZE,
  type FoodReclassificationSource,
} from "./food-reclassification-core";
import { syncAllVisitsFoodProbable } from "./visits";
import type { FoodKeywordRecord, ReclassifyProgress } from "./types";

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
export async function getEnabledFoodKeywords(
  databaseOverride?: Awaited<ReturnType<typeof getDatabase>>,
): Promise<string[]> {
  const database = databaseOverride ?? (await getDatabase());
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
async function getPhotosWithAllLabels(
  databaseOverride?: Awaited<ReturnType<typeof getDatabase>>,
): Promise<FoodReclassificationSource[]> {
  const database = databaseOverride ?? (await getDatabase());
  return database.getAllAsync<FoodReclassificationSource>(
    `SELECT id AS photoId, allLabels AS allLabelsJson FROM photos WHERE allLabels IS NOT NULL`,
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

  const progress: ReclassifyProgress = {
    total: 0,
    processed: 0,
    updated: 0,
    isComplete: false,
  };

  await database.withExclusiveTransactionAsync(async (transaction) => {
    // Keep the keyword and photo reads on the transaction connection so every
    // write is derived from one consistent database snapshot.
    const enabledKeywords = new Set(await getEnabledFoodKeywords(transaction));
    const photosToProcess = await getPhotosWithAllLabels(transaction);
    progress.total = photosToProcess.length;
    if (photosToProcess.length === 0) {
      return;
    }

    onProgress?.({ ...progress });
    let reusableFullBatchStatement: Awaited<ReturnType<typeof transaction.prepareAsync>> | null = null;
    try {
      for (const batch of buildFoodReclassificationBatches(photosToProcess, enabledKeywords)) {
        const statement = buildFoodReclassificationStatement(batch.updates);
        const result =
          batch.updates.length === FOOD_RECLASSIFICATION_BATCH_SIZE
            ? await (reusableFullBatchStatement ??= await transaction.prepareAsync(statement.sql)).executeAsync(
                statement.parameters,
              )
            : await transaction.runAsync(statement.sql, statement.parameters);
        progress.processed = batch.processed;
        progress.updated += result.changes;
        onProgress?.({ ...progress });
      }

      // Malformed rows are counted as processed even though they intentionally
      // keep their previous classification. The batch generator still yields a
      // partial valid batch when the final source row is malformed.
      progress.processed = photosToProcess.length;
      await syncAllVisitsFoodProbable(transaction);
    } finally {
      await reusableFullBatchStatement?.finalizeAsync();
    }
  });

  progress.isComplete = true;
  onProgress?.({ ...progress });

  if (DEBUG_TIMING) {
    console.log(
      `[DB] reclassifyPhotosWithCurrentKeywords: ${(performance.now() - start).toFixed(2)}ms (${progress.total} photos)`,
    );
  }

  return progress;
}
