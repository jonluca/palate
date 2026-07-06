import { requireNativeModule } from "expo";
import { Platform } from "react-native";

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

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;

interface SearchCacheEntry {
  readonly promise: Promise<MapKitSearchResult[]>;
  readonly expiresAt: number;
}

/** Bounded caches also coalesce identical searches that are currently in flight. */
const nearbyCache = new Map<string, SearchCacheEntry>();
const textSearchCache = new Map<string, SearchCacheEntry>();

function getCachedSearch(cache: Map<string, SearchCacheEntry>, key: string): Promise<MapKitSearchResult[]> | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  // Refresh insertion order so the first key remains the least recently used.
  cache.delete(key);
  cache.set(key, entry);
  return entry.promise;
}

function cacheSearch(cache: Map<string, SearchCacheEntry>, key: string, promise: Promise<MapKitSearchResult[]>): void {
  cache.set(key, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const leastRecentlyUsedKey = cache.keys().next().value;
    if (leastRecentlyUsedKey === undefined) {
      break;
    }
    cache.delete(leastRecentlyUsedKey);
  }

  promise.catch(() => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
  });
}

/**
 * Generate a cache key for nearby search
 * Uses fixed precision (4 decimal places ≈ 11m accuracy) to improve cache hits
 */
function nearbyKey(lat: number, lon: number, radius: number): string {
  return `${lat.toFixed(4)}:${lon.toFixed(4)}:${radius}`;
}

function textSearchKey(query: string, lat: number, lon: number, radius: number): string {
  return `${query.trim().toLowerCase()}:${nearbyKey(lat, lon, radius)}`;
}

function assertSearchRegion(latitude: number, longitude: number, radiusMeters: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`Latitude must be a finite number between -90 and 90; received ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`Longitude must be a finite number between -180 and 180; received ${longitude}`);
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RangeError(`Radius must be a positive finite number; received ${radiusMeters}`);
  }
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
 * Results are cached for 15 minutes based on location and radius.
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
  assertSearchRegion(latitude, longitude, radiusMeters);

  const key = nearbyKey(latitude, longitude, radiusMeters);

  // Return cached promise if available
  const cached = getCachedSearch(nearbyCache, key);
  if (cached) {
    return cached;
  }

  // Create and cache the promise
  const promise = MapKitSearchModule.searchNearbyRestaurants(latitude, longitude, radiusMeters) as Promise<
    MapKitSearchResult[]
  >;
  cacheSearch(nearbyCache, key, promise);

  return promise;
}

/**
 * Search for places by text using Apple MapKit.
 * Results are biased around the provided coordinate and sorted by distance.
 */
export async function searchByText(
  query: string,
  latitude: number,
  longitude: number,
  radiusMeters: number = 1000,
): Promise<MapKitSearchResult[]> {
  if (!MapKitSearchModule) {
    throw new Error("MapKitSearch module is only available on iOS");
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }
  assertSearchRegion(latitude, longitude, radiusMeters);

  const key = textSearchKey(trimmedQuery, latitude, longitude, radiusMeters);
  const cached = getCachedSearch(textSearchCache, key);
  if (cached) {
    return cached;
  }

  const promise = MapKitSearchModule.searchByText(trimmedQuery, latitude, longitude, radiusMeters) as Promise<
    MapKitSearchResult[]
  >;
  cacheSearch(textSearchCache, key, promise);

  return promise;
}
