import { requireNativeModule, Platform } from "expo-modules-core";

export interface MapKitSearchResult {
  /** Name of the place */
  name: string | null;
  /** Latitude coordinate */
  latitude: number;
  /** Longitude coordinate */
  longitude: number;
  /** Formatted address */
  address: string | null;
  /** Phone number if available */
  phoneNumber: string | null;
  /** Website URL if available */
  url: string | null;
  /** POI category identifier */
  category: string | null;
  /** Distance from search center in meters */
  distance: number;
  /** Timezone identifier */
  timeZone: string | null;
}

// Only available on iOS
const MapKitSearchModule = Platform.OS === "ios" ? requireNativeModule("MapKitSearch") : null;

// ============================================================================
// CACHING LAYER
// ============================================================================

/** Cache for nearby restaurant searches */
const nearbyCache = new Map<string, Promise<MapKitSearchResult[]>>();

/**
 * Generate a cache key for nearby search
 * Uses fixed precision (4 decimal places ≈ 11m accuracy) to improve cache hits
 */
function nearbyKey(lat: number, lon: number, radius: number): string {
  return `${lat.toFixed(4)}:${lon.toFixed(4)}:${radius}`;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Check if MapKit search is available (iOS only)
 */
export function isMapKitSearchAvailable(): boolean {
  return MapKitSearchModule !== null;
}

/**
 * Search for nearby restaurants using MapKit's native POI search.
 * Uses MKLocalPointsOfInterestRequest with food-related categories.
 * Results are cached indefinitely based on location and radius.
 *
 * @param latitude - Latitude of the search center
 * @param longitude - Longitude of the search center
 * @param radiusMeters - Search radius in meters (default: 200)
 * @returns Array of nearby restaurants sorted by distance
 */
export async function searchNearbyRestaurants(
  latitude: number,
  longitude: number,
  radiusMeters: number = 200,
): Promise<MapKitSearchResult[]> {
  if (!MapKitSearchModule) {
    throw new Error("MapKitSearch module is only available on iOS");
  }

  const key = nearbyKey(latitude, longitude, radiusMeters);

  // Return cached promise if available
  const cached = nearbyCache.get(key);
  if (cached) {
    return cached;
  }

  // Create and cache the promise
  const promise = MapKitSearchModule.searchNearbyRestaurants(latitude, longitude, radiusMeters) as Promise<
    MapKitSearchResult[]
  >;
  nearbyCache.set(key, promise);

  // If the promise rejects, remove it from cache so it can be retried
  promise.catch(() => {
    nearbyCache.delete(key);
  });

  return promise;
}
