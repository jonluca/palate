import * as geokdbush from "geokdbush";
import { calculateDistanceMeters } from "@/data/restaurants";
import { DEBUG_TIMING, getDatabase } from "./core";
import { buildRestaurantSpatialIndex, getIndexedRestaurants, getRestaurantIndex } from "./michelin-index";
import type { MichelinRestaurantRecord, VisitSuggestedRestaurant } from "./types";

// Constants for restaurant matching (same as services/visit.ts)
const RESTAURANT_MATCH_THRESHOLD = 100; // 100 meters for primary suggestion
const RESTAURANT_SEARCH_RADIUS = 200; // 200 meters for multiple suggestions
const RESTAURANT_SUGGESTION_LIMIT = 5;

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
async function recomputeSuggestedRestaurantsInternal(database: Awaited<ReturnType<typeof getDatabase>>): Promise<number> {
  const start = DEBUG_TIMING ? performance.now() : 0;

  // Build spatial index if needed (loads all restaurants into memory once)
  if (!getRestaurantIndex()) {
    const hasRestaurants = await buildRestaurantSpatialIndex(database, DEBUG_TIMING);
    if (!hasRestaurants) {
      // No Michelin data loaded yet, skip
      return 0;
    }
  }

  const restaurantIndex = getRestaurantIndex();
  const indexedRestaurants = getIndexedRestaurants();

  if (!restaurantIndex || indexedRestaurants.length === 0) {
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

  // Convert search radius to kilometers for geokdbush
  const searchRadiusKm = RESTAURANT_SEARCH_RADIUS / 1000;

  for (const visit of pendingVisits) {
    // geokdbush.around returns indices sorted by distance - O(log n + k)
    // Much faster than DB query per visit
    const nearbyIndices = geokdbush.around(
      restaurantIndex,
      visit.centerLon, // lon first
      visit.centerLat,
      RESTAURANT_SUGGESTION_LIMIT,
      searchRadiusKm,
    );

    let hasPrimarySuggestion = false;

    for (const idx of nearbyIndices) {
      const restaurant = indexedRestaurants[idx];
      // Calculate precise distance for storage
      const distance = calculateDistanceMeters(
        visit.centerLat,
        visit.centerLon,
        restaurant.latitude,
        restaurant.longitude,
      );

      allSuggestions.push({
        visitId: visit.id,
        restaurantId: restaurant.id,
        distance,
      });

      // First result within threshold is primary suggestion (results are sorted by distance)
      if (!hasPrimarySuggestion && distance <= RESTAURANT_MATCH_THRESHOLD) {
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
