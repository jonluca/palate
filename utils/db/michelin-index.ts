import type * as SQLite from "expo-sqlite";
import { MichelinLocationIndex } from "../michelin-location-index";
import type { MichelinRestaurantRecord } from "./types";

/** Maximum distance for the primary Michelin suggestion. */
export const MICHELIN_PRIMARY_MATCH_RADIUS_METERS = 100;

/** Maximum distance for the list of nearby Michelin suggestions. */
export const MICHELIN_SUGGESTION_RADIUS_METERS = 200;

/** Maximum number of Michelin suggestions stored for one visit. */
export const MICHELIN_SUGGESTION_LIMIT = 5;

let restaurantLocationIndex: MichelinLocationIndex<MichelinRestaurantRecord> | null = null;
let isRestaurantLocationIndexReady = false;
let restaurantLocationIndexGeneration = 0;
let activeBuild:
  | {
      generation: number;
      promise: Promise<MichelinLocationIndex<MichelinRestaurantRecord> | null>;
    }
  | undefined;

async function createRestaurantLocationIndex(
  database: SQLite.SQLiteDatabase,
  debugTiming: boolean,
): Promise<MichelinLocationIndex<MichelinRestaurantRecord> | null> {
  const startedAt = debugTiming ? performance.now() : 0;
  const restaurants = await database.getAllAsync<MichelinRestaurantRecord>(
    `SELECT m.*
     FROM michelin_restaurants m
     JOIN app_metadata metadata
       ON metadata.key = 'michelin_dataset_version'
      AND m.datasetVersion = metadata.value`,
  );
  const index = restaurants.length > 0 ? new MichelinLocationIndex(restaurants) : null;

  if (debugTiming) {
    console.log(
      `[DB] Built Michelin location index for ${restaurants.length} restaurants in ${(performance.now() - startedAt).toFixed(2)}ms`,
    );
  }

  return index;
}

/**
 * Returns the shared immutable Michelin index, building it from SQLite once when necessary.
 * Concurrent callers share one build for the current restaurant-data generation.
 */
export async function ensureRestaurantLocationIndex(
  database: SQLite.SQLiteDatabase,
  debugTiming: boolean,
): Promise<MichelinLocationIndex<MichelinRestaurantRecord> | null> {
  while (true) {
    if (isRestaurantLocationIndexReady) {
      return restaurantLocationIndex;
    }

    const generation = restaurantLocationIndexGeneration;
    let build = activeBuild;
    if (!build || build.generation !== generation) {
      build = {
        generation,
        promise: createRestaurantLocationIndex(database, debugTiming),
      };
      activeBuild = build;
    }

    try {
      const index = await build.promise;
      if (generation !== restaurantLocationIndexGeneration) {
        continue;
      }

      restaurantLocationIndex = index;
      isRestaurantLocationIndexReady = true;
      if (activeBuild === build) {
        activeBuild = undefined;
      }
      return index;
    } catch (error) {
      if (activeBuild === build) {
        activeBuild = undefined;
      }
      if (generation !== restaurantLocationIndexGeneration) {
        continue;
      }
      throw error;
    }
  }
}

/** Invalidates the shared index after Michelin reference data changes. */
export function invalidateRestaurantIndex(): void {
  restaurantLocationIndexGeneration += 1;
  restaurantLocationIndex = null;
  isRestaurantLocationIndexReady = false;
  activeBuild = undefined;
}
