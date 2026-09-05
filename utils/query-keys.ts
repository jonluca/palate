import type { MichelinMapViewportRequest } from "./db/michelin-map-viewport-core.ts";
import type { MichelinStatsBucket } from "./db/types.ts";
import type { VisitListFilter } from "./visit-status.ts";
import {
  CONFIRMED_RESTAURANTS_QUERY_KEY,
  CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
} from "./db/confirmed-restaurant-search-core.ts";
import { VISIT_LIST_PAGE_QUERY_ROOT } from "./query-cache-policy.ts";
import { reviewQueryKeys } from "./review-query-policy.ts";

// Persisted UI filters extend the database query contract with the unfiltered view.
export type FilterType = "all" | VisitListFilter;

export const mutationKeys = {
  photoAnalysis: ["photoAnalysis"] as const,
};

// Shared cache identities remain importable without mounting hooks or loading services.
export const queryKeys = {
  stats: ["stats"] as const,
  visits: (filter?: FilterType) => ["visits", filter] as const,
  visitPages: (filter: FilterType) => [...VISIT_LIST_PAGE_QUERY_ROOT, filter] as const,
  visitDetail: (id: string) => ["visits", "visit", id] as const,
  unmatchedVisits: ["unmatchedVisits"] as const,
  permissions: ["permissions"] as const,
  calendarPermissions: ["calendarPermissions"] as const,
  photoCount: ["photoCount"] as const,
  unscannedPhotoCount: ["photoCount", "unscanned"] as const,
  unanalyzedPhotoCount: reviewQueryKeys.unanalyzedPhotoCount,
  placesConfigured: ["static", "placesConfigured"] as const,
  // Restaurant-centric keys
  confirmedRestaurants: CONFIRMED_RESTAURANTS_QUERY_KEY,
  confirmedRestaurantSearch: CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
  restaurantVisits: (restaurantId: string) => ["visits", "restaurantVisits", restaurantId] as const,
  restaurantDetail: (restaurantId: string) => ["restaurants", "detail", restaurantId] as const,
  pendingReview: reviewQueryKeys.pendingReview,
  michelinMapViewport: (request: MichelinMapViewportRequest) =>
    [
      "michelinMapViewport",
      request.minimumAwardYear,
      request.visitStatusFilter,
      request.awardFilter,
      request.maximumResults ?? 500,
      request.camera.latitude,
      request.camera.longitude,
      request.camera.zoom,
      request.width,
      request.height,
    ] as const,
  michelinRestaurantSearch: (query: string) => ["michelinRestaurantSearch", query] as const,
  michelinUnicodeNameIndex: (datasetVersion: string | null) =>
    ["static", "michelinUnicodeNameIndex", datasetVersion ?? "unversioned"] as const,
  michelinRestaurantDetail: (michelinId: string) => ["static", "michelinRestaurants", "detail", michelinId] as const,
  nearbyMichelin: (lat: number, lon: number) => ["static", "nearbyMichelin", lat, lon] as const,
  mapKitNearby: (lat: number, lon: number, radius: number) =>
    ["static", "mapKitNearby", lat.toFixed(4), lon.toFixed(4), radius] as const,
  wrapped: (year?: number | null) => {
    if (year) {
      return ["wrapped", year] as const;
    }
    return ["wrapped"] as const;
  },
  wrappedMichelinBucketRestaurants: (year: number | null | undefined, bucket: MichelinStatsBucket) =>
    ["wrapped", "michelinAwardRestaurants", year ?? "all", bucket] as const,
  mergeableVisits: (visitId: string) => ["visits", "mergeableVisits", visitId] as const,
  mergeableSameRestaurantVisits: ["visits", "mergeableSameRestaurantVisits"] as const,
  ignoredLocations: ["ignoredLocations"] as const,
  importableCalendarEvents: ["importableCalendarEvents"] as const,
  visitsAtLocation: (lat: number, lon: number, radius: number) =>
    ["visits", "visitsAtLocation", lat, lon, radius] as const,
  reverseGeocode: (lat: number, lon: number) => ["reverseGeocode", lat.toFixed(4), lon.toFixed(4)] as const,
  writableCalendars: ["writableCalendars"] as const,
  syncableCalendars: ["syncableCalendars"] as const,
  visitsWithoutCalendarEvents: ["visitsWithoutCalendarEvents"] as const,
  exportedCalendarEvents: ["exportedCalendarEvents"] as const,
  foodKeywords: ["foodKeywords"] as const,
  photosWithLabelsCount: ["photosWithLabelsCount"] as const,
  placeTextSearch: (query: string, lat?: number, lon?: number) =>
    ["placeTextSearch", query, lat?.toFixed(4), lon?.toFixed(4)] as const,
};
