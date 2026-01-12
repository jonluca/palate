import { getGoogleMapsApiKey } from "@/store";

const CACHE_TTL_MS = 1000 * 60 * 15; // 15 minutes
const API_TIMEOUT_MS = 10000;

export interface PlaceResult {
  placeId: string;
  name: string;
  latitude: number;
  longitude: number;
  address?: string;
  rating?: number;
  priceLevel?: number;
  types?: string[];
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  priceLevel: number | null;
  openingHours: string[] | null;
  googleMapsUrl: string | null;
}

interface PlacesAPIResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    place_id: string;
    name: string;
    geometry: { location: { lat: number; lng: number } };
    vicinity?: string;
    formatted_address?: string;
    rating?: number;
    price_level?: number;
    types?: string[];
  }>;
  result?: {
    place_id: string;
    name: string;
    geometry: { location: { lat: number; lng: number } };
    formatted_address?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    website?: string;
    rating?: number;
    price_level?: number;
    opening_hours?: { weekday_text?: string[] };
    url?: string;
  };
}

class PlacesAPIError extends Error {
  constructor(
    message: string,
    public readonly status: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "PlacesAPIError";
  }
}

// Caches
const placesCache = new Map<string, { data: PlaceResult[]; timestamp: number }>();
const placeDetailsCache = new Map<string, { data: PlaceDetails; timestamp: number }>();

/** Check if a cached item is still valid */
function isCacheValid<T>(cached: { data: T; timestamp: number } | undefined): cached is { data: T; timestamp: number } {
  return !!cached && Date.now() - cached.timestamp < CACHE_TTL_MS;
}

/** Generate cache key for location searches */
const getCacheKey = (lat: number, lon: number, radius: number) => `${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;

/** Fetch from Google Places API with timeout and error handling */
async function fetchPlacesAPI<T extends PlacesAPIResponse>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new PlacesAPIError(`HTTP error: ${response.status}`, `HTTP_${response.status}`, response.status >= 500);
    }

    const data: T = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      const isRetryable = ["OVER_QUERY_LIMIT", "UNKNOWN_ERROR"].includes(data.status);
      throw new PlacesAPIError(data.error_message ?? `API error: ${data.status}`, data.status, isRetryable);
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof PlacesAPIError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new PlacesAPIError("Request timeout", "TIMEOUT", true);
    }
    throw error;
  }
}

/** Convert API response to PlaceResult array */
function toPlaceResults(results: PlacesAPIResponse["results"]): PlaceResult[] {
  return (results ?? []).map((place) => ({
    placeId: place.place_id,
    name: place.name,
    latitude: place.geometry.location.lat,
    longitude: place.geometry.location.lng,
    address: place.vicinity || place.formatted_address,
    rating: place.rating,
    priceLevel: place.price_level,
    types: place.types,
  }));
}

/**
 * Search for restaurants near a given location using Google Places API
 */
export async function searchNearbyRestaurants(
  latitude: number,
  longitude: number,
  radiusMeters: number = 100,
): Promise<PlaceResult[]> {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    return [];
  }

  const cacheKey = getCacheKey(latitude, longitude, radiusMeters);
  const cached = placesCache.get(cacheKey);
  if (isCacheValid(cached)) {
    return cached.data;
  }

  const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
  url.searchParams.set("location", `${latitude},${longitude}`);
  url.searchParams.set("radius", radiusMeters.toString());
  url.searchParams.set("type", "restaurant");
  url.searchParams.set("key", apiKey);

  try {
    const data = await fetchPlacesAPI<PlacesAPIResponse>(url);
    const results = toPlaceResults(data.results);
    placesCache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  } catch (error) {
    console.error("Failed to search nearby restaurants:", error);
    return [];
  }
}

/** Check if the Google Maps API key is configured */
export function isGoogleMapsConfigured(): boolean {
  return !!getGoogleMapsApiKey();
}

/** Get detailed information about a place using its Place ID */
export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    return null;
  }

  const cached = placeDetailsCache.get(placeId);
  if (isCacheValid(cached)) {
    return cached.data;
  }

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set(
    "fields",
    "place_id,name,geometry,formatted_address,formatted_phone_number,international_phone_number,website,rating,price_level,opening_hours,url",
  );
  url.searchParams.set("key", apiKey);

  try {
    const data = await fetchPlacesAPI<PlacesAPIResponse>(url);

    if (!data.result || data.status === "NOT_FOUND") {
      return null;
    }

    const r = data.result;
    const details: PlaceDetails = {
      placeId: r.place_id,
      name: r.name,
      latitude: r.geometry.location.lat,
      longitude: r.geometry.location.lng,
      address: r.formatted_address ?? null,
      phone: r.international_phone_number ?? r.formatted_phone_number ?? null,
      website: r.website ?? null,
      rating: r.rating ?? null,
      priceLevel: r.price_level ?? null,
      openingHours: r.opening_hours?.weekday_text ?? null,
      googleMapsUrl: r.url ?? null,
    };

    placeDetailsCache.set(placeId, { data: details, timestamp: Date.now() });
    return details;
  } catch (error) {
    console.error("Failed to get place details:", error);
    return null;
  }
}

/** Search for a place by text query */
export async function searchPlaceByText(query: string, latitude?: number, longitude?: number): Promise<PlaceResult[]> {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    return [];
  }

  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  url.searchParams.set("type", "restaurant");
  url.searchParams.set("key", apiKey);

  if (latitude !== undefined && longitude !== undefined) {
    url.searchParams.set("location", `${latitude},${longitude}`);
    url.searchParams.set("radius", "5000");
  }

  try {
    const data = await fetchPlacesAPI<PlacesAPIResponse>(url);
    return toPlaceResults(data.results);
  } catch (error) {
    console.error("Failed to search place by text:", error);
    return [];
  }
}
