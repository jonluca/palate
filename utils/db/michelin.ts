import { getDatabase } from "./core";
import { invalidateRestaurantIndex } from "./michelin-index";
import type { MichelinRestaurantRecord } from "./types";

const MICHELIN_DATASET_VERSION_KEY = "michelin_dataset_version";
const MAX_MICHELIN_NAME_SEARCH_RESULTS = 50;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// Michelin restaurant operations
export async function insertMichelinRestaurants(
  restaurants: MichelinRestaurantRecord[],
  datasetVersion: string,
): Promise<void> {
  if (restaurants.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (let i = 0; i < restaurants.length; i += batchSize) {
      const batch = restaurants.slice(i, i + batchSize);
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const values = batch.flatMap((restaurant) => [
        restaurant.id,
        restaurant.name,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.address,
        restaurant.location,
        restaurant.cuisine,
        restaurant.latestAwardYear,
        restaurant.award,
        datasetVersion,
      ]);

      await transaction.runAsync(
        `INSERT INTO michelin_restaurants
           (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
         VALUES ${placeholders}
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           address = excluded.address,
           location = excluded.location,
           cuisine = excluded.cuisine,
           latestAwardYear = excluded.latestAwardYear,
           award = excluded.award,
           datasetVersion = excluded.datasetVersion`,
        values,
      );
    }

    // Keep rows that disappeared from the latest guide. Confirmed visits and old
    // suggestions still reference them, and deleting them would erase historical
    // Michelin attribution. Current search/index queries filter by datasetVersion.
    await transaction.runAsync(
      `INSERT INTO app_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [MICHELIN_DATASET_VERSION_KEY, datasetVersion],
    );
  });

  // Invalidate spatial index so it rebuilds with new data
  invalidateRestaurantIndex();
}

export async function getImportedMichelinDatasetVersion(): Promise<string | null> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ value: string }>(`SELECT value FROM app_metadata WHERE key = ?`, [
    MICHELIN_DATASET_VERSION_KEY,
  ]);
  return result?.value ?? null;
}

export async function getMichelinRestaurantCount(datasetVersion?: string): Promise<number> {
  const database = await getDatabase();
  const result = datasetVersion
    ? await database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) as count FROM michelin_restaurants WHERE datasetVersion = ?`,
        [datasetVersion],
      )
    : await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM michelin_restaurants`);
  return result?.count ?? 0;
}

export async function getAllMichelinRestaurants(): Promise<MichelinRestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<MichelinRestaurantRecord>(
    `SELECT m.*
     FROM michelin_restaurants m
     WHERE NOT EXISTS (
       SELECT 1 FROM app_metadata WHERE key = ?
     ) OR m.datasetVersion = (
       SELECT value FROM app_metadata WHERE key = ?
     )`,
    [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY],
  );
}

/**
 * Search the active Michelin dataset without transferring the full guide to JS.
 * Confirmed restaurants are excluded in SQL before applying the result cap so
 * visited matches cannot crowd unvisited results out of the first page.
 */
export async function searchUnvisitedMichelinRestaurantsByName(
  query: string,
  limit: number = MAX_MICHELIN_NAME_SEARCH_RESULTS,
): Promise<MichelinRestaurantRecord[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MICHELIN_NAME_SEARCH_RESULTS) {
    throw new RangeError(`Michelin search limit must be an integer between 1 and ${MAX_MICHELIN_NAME_SEARCH_RESULTS}`);
  }

  const database = await getDatabase();
  const normalizedSearchText = normalizedQuery.toLowerCase();

  // SQLite's built-in NOCASE collation only folds ASCII. Preserve the prior
  // Unicode-aware JS search semantics for explicit non-ASCII queries without
  // paying the full-guide bridge cost during app startup or ordinary searches.
  if (/[^\u0000-\u007f]/.test(normalizedSearchText)) {
    const candidates = await database.getAllAsync<MichelinRestaurantRecord>(
      `SELECT m.*
       FROM michelin_restaurants m
       WHERE (
         NOT EXISTS (
           SELECT 1 FROM app_metadata WHERE key = ?
         ) OR m.datasetVersion = (
           SELECT value FROM app_metadata WHERE key = ?
         )
       )
         AND NOT EXISTS (
           SELECT 1
           FROM visits v
           WHERE v.restaurantId = m.id AND v.status = 'confirmed'
         )`,
      [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY],
    );

    return candidates
      .filter((restaurant) => restaurant.name.toLowerCase().includes(normalizedSearchText))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  const escapedPattern = `%${escapeLikePattern(normalizedQuery)}%`;

  return database.getAllAsync<MichelinRestaurantRecord>(
    `SELECT m.*
     FROM michelin_restaurants m
     WHERE (
       NOT EXISTS (
         SELECT 1 FROM app_metadata WHERE key = ?
       ) OR m.datasetVersion = (
         SELECT value FROM app_metadata WHERE key = ?
       )
     )
       AND m.name COLLATE NOCASE LIKE ? ESCAPE '\\'
       AND NOT EXISTS (
         SELECT 1
         FROM visits v
         WHERE v.restaurantId = m.id AND v.status = 'confirmed'
       )
     ORDER BY m.name COLLATE NOCASE ASC, m.name ASC, m.id ASC
     LIMIT ?`,
    [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY, escapedPattern, limit],
  );
}

export async function getMichelinRestaurantById(id: string): Promise<MichelinRestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants WHERE id = ?`, [id]);
}
