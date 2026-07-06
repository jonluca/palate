import { DEBUG_TIMING, getDatabase } from "./core";
import {
  ensureRestaurantLocationIndex,
  MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
  MICHELIN_SUGGESTION_LIMIT,
  MICHELIN_SUGGESTION_RADIUS_METERS,
} from "./michelin-index";
import type { MichelinRestaurantRecord, VisitSuggestedRestaurant } from "./types";
import { getImportedMichelinDatasetVersion } from "./michelin";

const MICHELIN_SUGGESTION_VERSION_KEY = "michelin_suggestion_version";
const MICHELIN_MATCHING_ALGORITHM_VERSION = `geodesic-v1-r${MICHELIN_PRIMARY_MATCH_RADIUS_METERS}-r${MICHELIN_SUGGESTION_RADIUS_METERS}-l${MICHELIN_SUGGESTION_LIMIT}`;

let activeConditionalRefresh:
  | {
      version: string;
      promise: Promise<{ refreshed: boolean; visitsUpdated: number }>;
    }
  | undefined;

// Visit suggested restaurants operations (multiple suggestions per visit)
export async function insertVisitSuggestedRestaurants(suggestions: VisitSuggestedRestaurant[]): Promise<void> {
  if (suggestions.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  for (let i = 0; i < suggestions.length; i += batchSize) {
    const batch = suggestions.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
    const values = batch.flatMap((s) => [s.visitId, s.restaurantId, s.distance]);

    await database.runAsync(
      `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function getSuggestedRestaurantsForVisits(
  visitIds: string[],
): Promise<Map<string, Array<MichelinRestaurantRecord & { distance: number }>>> {
  if (visitIds.length === 0) {
    return new Map();
  }

  const database = await getDatabase();
  const placeholders = visitIds.map(() => "?").join(", ");

  const results = await database.getAllAsync<MichelinRestaurantRecord & { distance: number; visitId: string }>(
    `SELECT m.*, vsr.distance, vsr.visitId
     FROM visit_suggested_restaurants vsr
     JOIN michelin_restaurants m ON vsr.restaurantId = m.id
     WHERE vsr.visitId IN (${placeholders})
     ORDER BY vsr.visitId, vsr.distance ASC`,
    visitIds,
  );

  const grouped = new Map<string, Array<MichelinRestaurantRecord & { distance: number }>>();
  for (const row of results) {
    const { visitId, ...restaurant } = row;
    const existing = grouped.get(visitId) ?? [];
    existing.push(restaurant);
    grouped.set(visitId, existing);
  }

  return grouped;
}

export async function batchUpdateVisitSuggestedRestaurants(
  updates: { visitId: string; suggestedRestaurantId: string }[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Update in batches
  const batchSize = 500;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);

    // Use CASE WHEN for batch update
    const whenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
    const visitIds = batch.map((u) => u.visitId);
    const values = batch.flatMap((u) => [u.visitId, u.suggestedRestaurantId]);
    const placeholders = visitIds.map(() => "?").join(", ");

    await database.runAsync(
      `UPDATE visits SET suggestedRestaurantId = CASE id ${whenClauses} END WHERE id IN (${placeholders})`,
      [...values, ...visitIds],
    );
  }
}

/**
 * Internal helper to recompute suggested restaurants for all pending visits.
 * This ensures the visit_suggested_restaurants table is up-to-date.
 * Called during database initialization.
 *
 * Optimized to use kdbush/geokdbush spatial index for O(log n) lookups
 * instead of O(n) database queries per visit.
 */
async function recomputeSuggestedRestaurantsInternal(
  database: Awaited<ReturnType<typeof getDatabase>>,
): Promise<number> {
  const start = DEBUG_TIMING ? performance.now() : 0;

  const restaurantIndex = await ensureRestaurantLocationIndex(database, DEBUG_TIMING);
  if (!restaurantIndex) {
    return 0;
  }

  // Get all pending visits
  const pendingVisits = await database.getAllAsync<{ id: string; centerLat: number; centerLon: number }>(
    `SELECT id, centerLat, centerLon FROM visits WHERE status = 'pending'`,
  );

  if (pendingVisits.length === 0) {
    return 0;
  }

  // Clear existing suggestions for pending visits first
  const visitIds = pendingVisits.map((v) => v.id);
  const placeholders = visitIds.map(() => "?").join(", ");
  await database.runAsync(`DELETE FROM visit_suggested_restaurants WHERE visitId IN (${placeholders})`, visitIds);

  // Also clear primary suggestions that will be recomputed
  await database.runAsync(`UPDATE visits SET suggestedRestaurantId = NULL WHERE id IN (${placeholders})`, visitIds);

  // Process all visits using spatial index - no per-visit DB queries!
  const allSuggestions: VisitSuggestedRestaurant[] = [];
  const primarySuggestionUpdates: { visitId: string; suggestedRestaurantId: string }[] = [];

  for (const visit of pendingVisits) {
    const nearbyRestaurants = restaurantIndex.findNearby({
      latitude: visit.centerLat,
      longitude: visit.centerLon,
      radiusMeters: MICHELIN_SUGGESTION_RADIUS_METERS,
      limit: MICHELIN_SUGGESTION_LIMIT,
    });

    let hasPrimarySuggestion = false;

    for (const { restaurant, distanceMeters } of nearbyRestaurants) {
      allSuggestions.push({
        visitId: visit.id,
        restaurantId: restaurant.id,
        distance: distanceMeters,
      });

      // First result within threshold is primary suggestion (results are sorted by distance)
      if (!hasPrimarySuggestion && distanceMeters <= MICHELIN_PRIMARY_MATCH_RADIUS_METERS) {
        primarySuggestionUpdates.push({
          visitId: visit.id,
          suggestedRestaurantId: restaurant.id,
        });
        hasPrimarySuggestion = true;
      }
    }
  }

  // Insert new suggestions in batches
  if (allSuggestions.length > 0) {
    const batchSize = 1000;
    for (let i = 0; i < allSuggestions.length; i += batchSize) {
      const batch = allSuggestions.slice(i, i + batchSize);
      const insertPlaceholders = batch.map(() => "(?, ?, ?)").join(", ");
      const values = batch.flatMap((s) => [s.visitId, s.restaurantId, s.distance]);

      await database.runAsync(
        `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES ${insertPlaceholders}`,
        values,
      );
    }
  }

  // Batch update primary suggestions using CASE WHEN (much faster than individual updates)
  if (primarySuggestionUpdates.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < primarySuggestionUpdates.length; i += batchSize) {
      const batch = primarySuggestionUpdates.slice(i, i + batchSize);
      const whenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
      const batchVisitIds = batch.map((u) => u.visitId);
      const values = batch.flatMap((u) => [u.visitId, u.suggestedRestaurantId]);
      const batchPlaceholders = batchVisitIds.map(() => "?").join(", ");

      await database.runAsync(
        `UPDATE visits SET suggestedRestaurantId = CASE id ${whenClauses} END WHERE id IN (${batchPlaceholders})`,
        [...values, ...batchVisitIds],
      );
    }
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] recomputeSuggestedRestaurants: ${(performance.now() - start).toFixed(2)}ms (${pendingVisits.length} visits, ${allSuggestions.length} suggestions)`,
    );
  }

  return pendingVisits.length;
}

/**
 * Recompute suggested restaurants for all pending visits.
 * This ensures the visit_suggested_restaurants table is up-to-date
 * based on the current Michelin restaurant data.
 */
export async function recomputeSuggestedRestaurants(): Promise<number> {
  const database = await getDatabase();
  return recomputeSuggestedRestaurantsInternal(database);
}

/**
 * Recompute existing pending visits only when the bundled guide or matching
 * policy changes. New visits are indexed as they are created, so normal scans
 * avoid the former redundant full-table recomputation.
 */
export async function recomputeSuggestedRestaurantsIfNeeded(
  datasetVersion: string,
): Promise<{ refreshed: boolean; visitsUpdated: number }> {
  const targetVersion = `${datasetVersion}:${MICHELIN_MATCHING_ALGORITHM_VERSION}`;
  if (activeConditionalRefresh?.version === targetVersion) {
    return activeConditionalRefresh.promise;
  }

  const promise = (async () => {
    const database = await getDatabase();

    // Never compute or stamp suggestions for a guide version that failed to
    // import. Otherwise an older active index could be mislabeled as current,
    // preventing a later successful import from refreshing pending visits.
    const activeDatasetVersion = await getImportedMichelinDatasetVersion();
    if (activeDatasetVersion !== datasetVersion) {
      return { refreshed: false, visitsUpdated: 0 };
    }

    const importedVersion = await database.getFirstAsync<{ value: string }>(
      `SELECT value FROM app_metadata WHERE key = ?`,
      [MICHELIN_SUGGESTION_VERSION_KEY],
    );
    if (importedVersion?.value === targetVersion) {
      return { refreshed: false, visitsUpdated: 0 };
    }

    // Do not mark a refresh complete when reference data is unavailable; a later
    // scan should retry after Michelin initialization succeeds.
    const restaurantIndex = await ensureRestaurantLocationIndex(database, DEBUG_TIMING);
    if (!restaurantIndex) {
      return { refreshed: false, visitsUpdated: 0 };
    }

    const visitsUpdated = await recomputeSuggestedRestaurantsInternal(database);
    await database.runAsync(
      `INSERT INTO app_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [MICHELIN_SUGGESTION_VERSION_KEY, targetVersion],
    );
    return { refreshed: true, visitsUpdated };
  })();

  activeConditionalRefresh = { version: targetVersion, promise };
  try {
    return await promise;
  } finally {
    if (activeConditionalRefresh?.promise === promise) {
      activeConditionalRefresh = undefined;
    }
  }
}
