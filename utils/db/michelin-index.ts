import type * as SQLite from "expo-sqlite";
import { MichelinLocationIndex } from "../michelin-location-index";
import {
  loadActiveMichelinSuggestionLocations,
  type MichelinSuggestionLocation,
} from "./michelin-suggestion-index-core";

export {
  MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
  MICHELIN_SUGGESTION_LIMIT,
  MICHELIN_SUGGESTION_RADIUS_METERS,
  type MichelinSuggestionLocation,
} from "./michelin-suggestion-index-core";

let restaurantLocationIndex: MichelinLocationIndex<MichelinSuggestionLocation> | null = null;
let isRestaurantLocationIndexReady = false;
let restaurantLocationIndexGeneration = 0;
let activeBuild:
  | {
      generation: number;
      promise: Promise<MichelinLocationIndex<MichelinSuggestionLocation> | null>;
    }
  | undefined;

async function createRestaurantLocationIndex(
  database: SQLite.SQLiteDatabase,
  debugTiming: boolean,
): Promise<MichelinLocationIndex<MichelinSuggestionLocation> | null> {
  const startedAt = debugTiming ? performance.now() : 0;
  const restaurants = await loadActiveMichelinSuggestionLocations(database);
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
): Promise<MichelinLocationIndex<MichelinSuggestionLocation> | null> {
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
