import KDBush from "kdbush";
import type * as SQLite from "expo-sqlite";
import type { MichelinRestaurantRecord } from "./types";

let restaurantIndex: KDBush | null = null;
let indexedRestaurants: MichelinRestaurantRecord[] = [];

/**
 * Build or rebuild the spatial index for Michelin restaurants.
 * Uses kdbush for efficient nearest-neighbor queries.
 */
export async function buildRestaurantSpatialIndex(
  database: SQLite.SQLiteDatabase,
  debugTiming: boolean,
): Promise<boolean> {
  indexedRestaurants = await database.getAllAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants`);

  if (indexedRestaurants.length === 0) {
    restaurantIndex = null;
    return false;
  }

  // Build spatial index - O(n log n) once
  restaurantIndex = new KDBush(indexedRestaurants.length);
  for (const r of indexedRestaurants) {
    restaurantIndex.add(r.longitude, r.latitude); // Note: lon, lat order for geokdbush
  }
  restaurantIndex.finish();

  if (debugTiming) {
    console.log(`[DB] Built spatial index for ${indexedRestaurants.length} restaurants`);
  }

  return true;
}

/**
 * Invalidate the restaurant spatial index (call when Michelin data changes).
 */
export function invalidateRestaurantIndex(): void {
  restaurantIndex = null;
  indexedRestaurants = [];
}

export function getRestaurantIndex(): KDBush | null {
  return restaurantIndex;
}

export function getIndexedRestaurants(): MichelinRestaurantRecord[] {
  return indexedRestaurants;
}
