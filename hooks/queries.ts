import { useQuery, useMutation, useQueryClient, type QueryClient, type UseQueryOptions } from "@tanstack/react-query";
import * as Location from "expo-location";
import { useMemo, useRef } from "react";
import { logVisitConfirmed, logVisitRejected } from "@/services/analytics";
import {
  getVisitsWithDetails,
  getVisitById,
  getStats,
  getPhotosByVisitId,
  updateVisitStatus,
  updateVisitNotes,
  getConfirmedRestaurantsWithVisits,
  getVisitsByRestaurantId,
  getPendingVisitsForReview,
  batchConfirmVisits,
  confirmVisit,
  getAllMichelinRestaurants,
  getWrappedStats,
  getMergeableVisits,
  mergeVisits,
  addIgnoredLocation,
  removeIgnoredLocation,
  getIgnoredLocations,
  rejectVisitsInIgnoredLocations,
  updateRestaurant,
  getSuggestedRestaurantsForVisits,
  getConfirmedVisitsWithoutCalendarEvents,
  getVisitsWithExportedCalendarEvents,
  clearExportedCalendarEvents,
  batchUpdateVisitCalendarEvents,
  getAllFoodKeywords,
  addFoodKeyword,
  removeFoodKeyword,
  toggleFoodKeyword,
  resetFoodKeywordsToDefaults,
  reclassifyPhotosWithCurrentKeywords,
  getPhotosWithLabelsCount,
  getUnanalyzedPhotoCount,
  recomputeSuggestedRestaurants,
  getPhotosByAssetIds,
  movePhotosToVisit,
  removePhotosFromVisit,
  type VisitWithDetails,
  type MovePhotosResult,
  type RemovePhotosResult,
  type PhotoRecord,
  type RestaurantRecord,
  type MichelinRestaurantRecord,
  type RestaurantWithVisits as RestaurantWithVisitsDB,
  type PendingVisitForReview as PendingVisitForReviewDB,
  type VisitRecord as VisitRecordDB,
  type WrappedStats,
  type IgnoredLocationRecord,
  type UpdateRestaurantData,
  type VisitForCalendarExport,
  type ExportedCalendarEvent,
  type FoodKeywordRecord,
  type ReclassifyProgress,
  createManualVisit,
  batchMergeSameRestaurantVisits,
  type MergeableVisitGroup,
  getMergeableSameRestaurantVisitGroups,
} from "@/utils/db";
import {
  compareRestaurantAndCalendarTitle,
  requestCalendarPermission,
  getWritableCalendars,
  getAllSyncableCalendars,
  getEventsOverlappingRange,
  batchCreateCalendarEvents,
  batchDeleteCalendarEvents,
  type WritableCalendar,
  type CalendarEventInfo,
} from "@/services/calendar";

// ============================================================================
// QUERY INVALIDATION HELPERS
// ============================================================================

/** Invalidate all visit-related queries */
function invalidateVisitQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.pendingReview });
  queryClient.invalidateQueries({ queryKey: queryKeys.unanalyzedPhotoCount });
}

// ============================================================================
// OPTIMISTIC UPDATE HELPERS
// ============================================================================

function optimisticallyRemoveVisitsFromPending(queryClient: QueryClient, visitIds: string[]) {
  queryClient.setQueryData<PendingReviewData>(queryKeys.pendingReview, (old) => {
    if (!old) {
      return old;
    }
    const visitIdSet = new Set(visitIds);
    return {
      visits: old.visits.filter((v) => !visitIdSet.has(v.id)),
      exactMatches: old.exactMatches.filter((m) => !visitIdSet.has(m.visitId)),
    };
  });
}

function optimisticallyUpdateStats(queryClient: QueryClient, delta: { pending?: number; confirmed?: number }) {
  queryClient.setQueryData<Stats>(queryKeys.stats, (old) =>
    old
      ? {
          ...old,
          pendingVisits: old.pendingVisits + (delta.pending ?? 0),
          confirmedVisits: old.confirmedVisits + (delta.confirmed ?? 0),
        }
      : old,
  );
}

function optimisticallyRemoveImportableCalendarEvents(queryClient: QueryClient, calendarEventIds: string[]) {
  const eventIdSet = new Set(calendarEventIds);
  queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, (old) =>
    old ? old.filter((event) => !eventIdSet.has(event.calendarEventId)) : old,
  );
}

// Re-export types for external use with visit naming
export type RestaurantWithVisits = RestaurantWithVisitsDB;
export type PendingVisitForReview = PendingVisitForReviewDB;
export type VisitWithRestaurant = VisitWithDetails;
export type VisitRecord = VisitRecordDB;
export type { IgnoredLocationRecord };
export type { WritableCalendar };

import {
  processPhotos,
  searchRestaurantsForVisit,
  deepScanAllPhotosForFood,
  scanVisitPhotosForFood,
  getImportableCalendarEvents,
  importCalendarEvents,
  dismissCalendarEvents,
  type DeepScanProgress,
  type VisitFoodScanProgress,
  type ImportableCalendarEvent,
} from "@/services/visit";
import { hasMediaLibraryPermission, requestMediaLibraryPermission, getPhotoCount } from "@/services/scanner";
import { exportToJSON, exportToCSV, shareExport, type ExportFormat, type ExportShareResult } from "@/services/export";
import {
  isMapKitSearchAvailable,
  searchNearbyRestaurants as mapKitSearchNearbyRestaurants,
  type MapKitSearchResult,
} from "@/modules/mapkit-search";
import {
  getMichelinRestaurantDetails,
  getAwardForDate,
  type MichelinAward,
  type MichelinRestaurantDetails,
} from "@/services/michelin";
import { searchPlaceByText, type PlaceResult } from "@/services/places";

// Types
export interface Stats {
  totalPhotos: number;
  photosWithLocation: number;
  totalVisits: number;
  pendingVisits: number;
  confirmedVisits: number;
  foodProbableVisits: number;
}

export type FilterType = "all" | "pending" | "confirmed" | "rejected" | "food";

// Query Keys
export const queryKeys = {
  stats: ["stats"] as const,
  visits: (filter?: FilterType) => ["visits", filter] as const,
  visitDetail: (id: string) => ["visits", "visit", id] as const,
  visitPhotos: (id: string) => ["visitPhotos", id] as const,
  unmatchedVisits: ["unmatchedVisits"] as const,
  permissions: ["permissions"] as const,
  calendarPermissions: ["calendarPermissions"] as const,
  photoCount: ["photoCount"] as const,
  unanalyzedPhotoCount: ["unanalyzedPhotoCount"] as const,
  placesConfigured: ["static", "placesConfigured"] as const,
  // Restaurant-centric keys
  confirmedRestaurants: ["confirmedRestaurants"] as const,
  restaurantVisits: (restaurantId: string) => ["visits", "restaurantVisits", restaurantId] as const,
  restaurantDetail: (restaurantId: string) => ["restaurants", "detail", restaurantId] as const,
  pendingReview: ["visits", "pendingReview"] as const,
  michelinRestaurants: ["static", "michelinRestaurants"] as const,
  michelinRestaurantDetail: (michelinId: string) => ["static", "michelinRestaurants", "detail", michelinId] as const,
  nearbyMichelin: (lat: number, lon: number) => ["static", "nearbyMichelin", lat, lon] as const,
  mapKitNearby: (lat: number, lon: number) => ["static", "mapKitNearby", lat.toFixed(4), lon.toFixed(4)] as const,
  wrapped: (year?: number | null) => {
    if (year) {
      return ["wrapped", year] as const;
    }
    return ["wrapped"] as const;
  },
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

// Hooks

/**
 * Fetch stats about scanned photos and visits
 */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: getStats,
  });
}

// Re-export WrappedStats type
export type { WrappedStats };

/**
 * Fetch wrapped statistics for restaurant visits
 * @param year - Optional year to filter stats. When null/undefined, returns all-time stats.
 */
export function useWrappedStats(
  year?: number | null,
  options?: Omit<UseQueryOptions<WrappedStats, Error>, "queryKey" | "queryFn">,
) {
  return useQuery({
    queryKey: queryKeys.wrapped(year),
    queryFn: () => getWrappedStats(year),
    ...options,
  });
}

/**
 * Fetch visits with restaurant names and preview photos
 */
export function useVisits(
  filter: FilterType,
  options?: Omit<UseQueryOptions<VisitWithDetails[], Error>, "queryKey" | "queryFn">,
) {
  return useQuery({
    queryKey: queryKeys.visits(filter),
    queryFn: () => getVisitsWithDetails(filter === "all" ? undefined : filter),
    ...options,
  });
}

/**
 * Check if media library permission is granted
 */
export function usePermissions() {
  return useQuery({
    queryKey: queryKeys.permissions,
    queryFn: hasMediaLibraryPermission,
  });
}

/**
 * Get photo count from camera roll
 */
export function usePhotoCount(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.photoCount,
    queryFn: getPhotoCount,
    enabled,
  });
}

// Visit Detail Types
interface SuggestedRestaurantDetail {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  location: string;
  cuisine: string;
  award: string;
  distance: number;
}

export interface VisitDetail {
  visit: VisitRecord;
  restaurant: RestaurantRecord | null;
  suggestedRestaurant: MichelinRestaurantRecord | null;
  /** All nearby suggested restaurants from the pre-computed database (same as review page) */
  suggestedRestaurants: SuggestedRestaurantDetail[];
  /** All calendar events overlapping the visit time range (pending only) */
  calendarEvents: CalendarEventInfo[];
  photos: PhotoRecord[];
}

/**
 * Fetch visit detail with restaurant and photos
 */
export function useVisitDetail(id: string | undefined) {
  const { data: confirmedRestaurants } = useConfirmedRestaurants();
  const { data: allMichelinRestaurants } = useMichelinRestaurants();

  return useQuery({
    queryKey: queryKeys.visitDetail(id ?? ""),
    queryFn: async (): Promise<VisitDetail | null> => {
      if (!id) {
        return null;
      }

      const [visit, photos, suggestedRestaurantsMap] = await Promise.all([
        getVisitById(id),
        getPhotosByVisitId(id),
        getSuggestedRestaurantsForVisits([id]),
      ]);

      if (!visit) {
        return null;
      }

      // Find restaurant from confirmed restaurants list
      let restaurant: RestaurantRecord | null = null;
      if (visit.restaurantId && confirmedRestaurants) {
        restaurant = confirmedRestaurants.find((r) => r.id === visit.restaurantId) ?? null;
      }

      // Find suggested restaurant from michelin restaurants list
      let suggestedRestaurant: MichelinRestaurantRecord | null = null;
      if (visit.suggestedRestaurantId && allMichelinRestaurants) {
        suggestedRestaurant = allMichelinRestaurants.find((r) => r.id === visit.suggestedRestaurantId) ?? null;
      }

      // For confirmed visits, prefer the historical award stored at time of confirmation
      // Fall back to current award if no historical award was stored
      if (visit.status === "confirmed" && suggestedRestaurant && visit.awardAtVisit) {
        suggestedRestaurant = {
          ...suggestedRestaurant,
          award: visit.awardAtVisit,
        };
      }

      // Get suggested restaurants from pre-computed data (same source as review page)
      const suggestedRestaurants = suggestedRestaurantsMap.get(id) ?? [];

      const calendarEvents =
        visit.status !== "confirmed" ? await getEventsOverlappingRange(visit.startTime, visit.endTime) : [];

      return { visit, restaurant, suggestedRestaurant, suggestedRestaurants, calendarEvents, photos };
    },
    enabled: !!id,
  });
}

/**
 * Fetch confirmed restaurants with visit counts
 */
export function useConfirmedRestaurants() {
  return useQuery({
    queryKey: queryKeys.confirmedRestaurants,
    queryFn: getConfirmedRestaurantsWithVisits,
  });
}

/**
 * Fetch visits for a specific restaurant
 */
export function useRestaurantVisits(restaurantId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.restaurantVisits(restaurantId ?? ""),
    queryFn: () => getVisitsByRestaurantId(restaurantId!),
    enabled: !!restaurantId,
  });
}

export interface PendingReviewData {
  visits: PendingVisitForReviewDB[];
  exactMatches: ExactCalendarMatch[];
}

/**
 * Fetch pending visits for review with suggestions and exact calendar matches
 */
export function usePendingReview() {
  return useQuery({
    queryKey: queryKeys.pendingReview,
    queryFn: async (): Promise<PendingReviewData> => {
      const visits = await getPendingVisitsForReview();
      const exactMatches = getExactCalendarMatches(visits);
      return { visits, exactMatches };
    },
    refetchOnMount: "always",
  });
}

/**
 * Fetch all Michelin restaurants (for searching)
 */
export function useMichelinRestaurants() {
  return useQuery({
    queryKey: queryKeys.michelinRestaurants,
    queryFn: getAllMichelinRestaurants,
    staleTime: Infinity, // This data doesn't change
  });
}

// Re-export Michelin types
export type { MichelinAward, MichelinRestaurantDetails };

/**
 * Fetch detailed Michelin restaurant info including full award history
 */
export function useMichelinRestaurantDetails(michelinId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.michelinRestaurantDetail(michelinId ?? ""),
    queryFn: () => getMichelinRestaurantDetails(michelinId!),
    enabled: !!michelinId && michelinId.startsWith("michelin-"),
    staleTime: Infinity, // Michelin data doesn't change
  });
}

/**
 * Search nearby restaurants using native MapKit (iOS only)
 * Uses MKLocalPointsOfInterestRequest for finding restaurants, cafes, bakeries, etc.
 */
function useMapKitNearbyRestaurants(
  lat: number | undefined,
  lon: number | undefined,
  radiusMeters: number = 200,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: queryKeys.mapKitNearby(lat ?? 0, lon ?? 0),
    queryFn: async (): Promise<MapKitSearchResult[]> => {
      if (!lat || !lon || !isMapKitSearchAvailable()) {
        return [];
      }
      try {
        return await mapKitSearchNearbyRestaurants(lat, lon, radiusMeters);
      } catch (error) {
        console.warn("MapKit search failed:", error);
        return [];
      }
    },
    enabled: enabled && !!lat && !!lon && isMapKitSearchAvailable(),
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes
  });
}

// ============================================================================
// UNIFIED NEARBY RESTAURANTS (MICHELIN + MAPKIT)
// ============================================================================

/**
 * A restaurant result from nearby search, combining Michelin and MapKit sources
 */
export interface NearbyRestaurant {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance: number;
  award: string | null;
  cuisine?: string;
  address?: string | null;
  source: "michelin" | "mapkit";
}

interface MichelinRestaurantInput {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance: number;
  award: string;
  cuisine: string;
}

/**
 * Merge Michelin and MapKit restaurant results, deduplicating and sorting by distance.
 * Michelin restaurants are prioritized. MapKit results that are duplicates
 * (same name or within 30m) are filtered out.
 */
function mergeNearbyRestaurants(
  michelinRestaurants: MichelinRestaurantInput[],
  mapKitResults: MapKitSearchResult[],
): NearbyRestaurant[] {
  // Convert Michelin restaurants to common format
  const michelin: NearbyRestaurant[] = michelinRestaurants.map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    distance: r.distance,
    award: r.award || null,
    cuisine: r.cuisine,
    source: "michelin" as const,
  }));

  // Convert MapKit results to common format
  const mapKit: NearbyRestaurant[] = mapKitResults
    .filter((r) => r.name) // Ensure name exists
    .map((r) => ({
      id: `mapkit-${r.latitude.toFixed(6)}-${r.longitude.toFixed(6)}-${r.name?.toLowerCase().trim()}`,
      name: r.name!,
      latitude: r.latitude,
      longitude: r.longitude,
      distance: r.distance,
      award: null,
      address: r.address,
      source: "mapkit" as const,
    }));

  // Deduplicate: remove MapKit results that are very close to Michelin restaurants
  const dedupedMapKit = mapKit.filter((mk) => {
    const isDuplicate = michelin.some((m) => {
      // Check if names are similar (case insensitive, trimmed)
      const nameMatch = m.name.toLowerCase().trim() === mk.name.toLowerCase().trim();
      // Or if they're within 30m of each other
      const distanceBetween = Math.sqrt(
        Math.pow((m.latitude - mk.latitude) * 111000, 2) +
          Math.pow((m.longitude - mk.longitude) * 111000 * Math.cos((m.latitude * Math.PI) / 180), 2),
      );
      return nameMatch || distanceBetween < 30;
    });
    return !isDuplicate;
  });

  // Combine: Michelin first, then MapKit, all sorted by distance
  return [...michelin, ...dedupedMapKit].sort((a, b) => a.distance - b.distance);
}

const MAPKIT_RADIUS_METERS = 200;

/** Input type for visit with suggested restaurants */
interface VisitWithSuggestedRestaurants {
  centerLat?: number;
  centerLon?: number;
  suggestedRestaurants?: Array<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    distance: number;
    award?: string | null;
    cuisine?: string;
    address?: string;
  }>;
}

/**
 * Unified hook for fetching nearby restaurants, merging the visit's suggested Michelin
 * restaurants with MapKit results.
 *
 * - Always includes the visit's suggestedRestaurants (Michelin database)
 * - When enabled, also fetches from MapKit and merges/deduplicates
 * - Michelin restaurants are prioritized over MapKit duplicates
 *
 * @param visit - The visit containing centerLat, centerLon, and suggestedRestaurants
 * @param enabled - Whether to fetch additional MapKit results (expensive, use sparingly)
 */
export function useUnifiedNearbyRestaurants(visit: VisitWithSuggestedRestaurants | undefined, enabled: boolean = true) {
  const lat = visit?.centerLat;
  const lon = visit?.centerLon;

  // Only fetch MapKit if enabled and we have coordinates
  const shouldFetchMapKit = enabled && Boolean(lat) && Boolean(lon);

  // Fetch MapKit restaurants
  const { data: mapKitResults = [], isLoading: mapKitLoading } = useMapKitNearbyRestaurants(
    lat,
    lon,
    MAPKIT_RADIUS_METERS,
    shouldFetchMapKit,
  );

  // Convert visit's suggestedRestaurants to MichelinRestaurantInput format for merging
  // Use visit?.suggestedRestaurants directly in dependency to avoid creating new array reference
  const michelinRestaurants: MichelinRestaurantInput[] = useMemo(() => {
    const suggestedRestaurants = visit?.suggestedRestaurants ?? [];
    return suggestedRestaurants.map((r) => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      distance: r.distance,
      award: r.award ?? "",
      cuisine: r.cuisine ?? "",
    }));
  }, [visit?.suggestedRestaurants]);

  // Merge results: Michelin + MapKit, deduplicated and sorted by distance
  const mergedRestaurants = useMemo(() => {
    return mergeNearbyRestaurants(michelinRestaurants, mapKitResults);
  }, [michelinRestaurants, mapKitResults]);

  return {
    data: mergedRestaurants,
    isLoading: shouldFetchMapKit && mapKitLoading,
    mapKitResults,
    michelinCount: michelinRestaurants.length,
    mapKitCount: mapKitResults.length,
  };
}

/**
 * Fetch photos for a specific visit
 */
export function useVisitPhotos(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.visitPhotos(id ?? ""),
    queryFn: () => getPhotosByVisitId(id!),
    enabled: !!id,
  });
}

// Mutations

export interface ScanProgress {
  phase:
    | "scanning"
    | "grouping-visits"
    | "calendar-events"
    | "calendar-only-visits"
    | "detecting-food"
    | "optimizing-database"
    | "recomputing-suggested-restaurants";
  detail: string;
  photosPerSecond?: number;
  eta?: string;
  /** Progress value 0-1 for the current phase */
  progress?: number;
}

/**
 * Request media library permission
 */
export function useRequestPermission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: requestMediaLibraryPermission,
    onSuccess: (granted) => {
      queryClient.setQueryData(queryKeys.permissions, granted);
      if (granted) {
        queryClient.invalidateQueries({ queryKey: queryKeys.photoCount });
      }
    },
  });
}

/**
 * Request calendar permission
 */
export function useRequestCalendarPermission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: requestCalendarPermission,
    onSuccess: (granted) => {
      queryClient.setQueryData(queryKeys.calendarPermissions, granted);
    },
  });
}

/**
 * Scan camera roll and process photos
 */
export function useScanPhotos(onProgress?: (progress: ScanProgress) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => processPhotos(onProgress),
    onSuccess: () => {
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.unmatchedVisits });
    },
  });
}

/**
 * Search for nearby restaurants via Google Places API
 */
export function useSearchNearbyRestaurants() {
  return useMutation({
    mutationFn: async ({ lat, lon, radius }: { lat: number; lon: number; radius?: number }) => {
      return searchRestaurantsForVisit(lat, lon, radius);
    },
  });
}

/**
 * Confirm a visit by linking visit to restaurant
 * Uses optimistic updates for instant UI feedback - no query invalidation needed for pending reviews
 * Looks up and stores the historical Michelin award at the time of visit
 */
export function useConfirmVisit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      visitId,
      restaurantId,
      restaurantName,
      latitude,
      longitude,
      startTime,
    }: {
      visitId: string;
      restaurantId: string;
      restaurantName: string;
      latitude: number;
      longitude: number;
      startTime: number;
    }) => {
      // Look up the historical award for this restaurant at the time of visit
      // Only Michelin restaurants (with "michelin-" prefix) have historical awards
      let awardAtVisit: string | null = null;
      if (restaurantId.startsWith("michelin-")) {
        awardAtVisit = await getAwardForDate(restaurantId, startTime);
      }
      await confirmVisit(visitId, restaurantId, restaurantName, latitude, longitude, awardAtVisit);
      return { visitId };
    },
    onMutate: async ({ visitId }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.pendingReview }),
        queryClient.cancelQueries({ queryKey: queryKeys.stats }),
      ]);
      const previousPending = queryClient.getQueryData<PendingReviewData>(queryKeys.pendingReview);
      const previousStats = queryClient.getQueryData<Stats>(queryKeys.stats);

      optimisticallyRemoveVisitsFromPending(queryClient, [visitId]);
      optimisticallyUpdateStats(queryClient, { pending: -1, confirmed: 1 });

      return { previousPending, previousStats };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(queryKeys.pendingReview, context.previousPending);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(queryKeys.stats, context.previousStats);
      }
    },
    onSuccess: (_data, variables) => {
      // Only invalidate confirmed restaurants list, not pending reviews (handled optimistically)
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      // Track analytics
      logVisitConfirmed(parseInt(variables.visitId, 10) || 0);
    },
  });
}

/**
 * Batch confirm multiple visits with their matched restaurants
 * Uses optimistic updates for instant UI feedback - no query invalidation needed for pending reviews
 * Looks up and stores the historical Michelin award at the time of each visit
 */
export function useBatchConfirmVisits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      confirmations: Array<{
        visitId: string;
        restaurantId: string;
        restaurantName: string;
        latitude: number;
        longitude: number;
        startTime: number;
      }>,
    ) => {
      const confirmationsWithAwards = await Promise.all(
        confirmations.map(async (c) => {
          // Look up the historical award for this restaurant at the time of visit
          let awardAtVisit: string | null = null;
          if (c.restaurantId.startsWith("michelin-")) {
            awardAtVisit = await getAwardForDate(c.restaurantId, c.startTime);
          }
          return {
            ...c,
            awardAtVisit,
          };
        }),
      );
      await batchConfirmVisits(confirmationsWithAwards);

      let mergeCount = 0;
      try {
        const mergeableGroups = await getMergeableSameRestaurantVisitGroups();
        if (mergeableGroups.length > 0) {
          mergeCount = await batchMergeSameRestaurantVisits(mergeableGroups);
        }
      } catch (error) {
        // Batch confirmation already succeeded. Treat duplicate merging as best-effort.
        console.error("Error auto-merging duplicate visits after batch confirm:", error);
      }

      return { count: confirmations.length, mergeCount };
    },
    onMutate: async (confirmations) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.pendingReview }),
        queryClient.cancelQueries({ queryKey: queryKeys.stats }),
      ]);
      const previousPending = queryClient.getQueryData<PendingReviewData>(queryKeys.pendingReview);
      const previousStats = queryClient.getQueryData<Stats>(queryKeys.stats);

      optimisticallyRemoveVisitsFromPending(
        queryClient,
        confirmations.map((c) => c.visitId),
      );
      optimisticallyUpdateStats(queryClient, { pending: -confirmations.length, confirmed: confirmations.length });

      return { previousPending, previousStats };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(queryKeys.pendingReview, context.previousPending);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(queryKeys.stats, context.previousStats);
      }
    },
    onSuccess: () => {
      // Merging duplicates may affect confirmed visits, stats, and cleanup queries.
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.mergeableSameRestaurantVisits });
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
    },
  });
}

/**
 * Exact calendar match - visit where calendar event name exactly matches a Michelin restaurant
 */
export interface ExactCalendarMatch {
  visitId: string;
  visit: PendingVisitForReview;
  restaurantId: string;
  restaurantName: string;
  latitude: number;
  longitude: number;
  calendarTitle: string;
  startTime: number;
}

/**
 * Find exact calendar event matches to Michelin restaurant names
 * Pure function that can be called independently
 */
function getExactCalendarMatches(pendingVisits: PendingVisitForReview[]): ExactCalendarMatch[] {
  const matches: ExactCalendarMatch[] = [];

  for (const visit of pendingVisits) {
    if (!visit.calendarEventTitle) {
      continue;
    }

    // Check for match with any suggested restaurant using comprehensive comparison
    for (const restaurant of visit.suggestedRestaurants) {
      if (compareRestaurantAndCalendarTitle(visit.calendarEventTitle, restaurant.name)) {
        matches.push({
          visitId: visit.id,
          visit,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
          calendarTitle: visit.calendarEventTitle,
          startTime: visit.startTime,
        });
        break; // Only match once per visit
      }
    }
  }

  return matches;
}

// Re-export for use in UI
export type { ImportableCalendarEvent };

/**
 * Get calendar events that can be imported as visits.
 * These are reservation-like events that match Michelin restaurants.
 */
export function useImportableCalendarEvents() {
  return useQuery({
    queryKey: queryKeys.importableCalendarEvents,
    queryFn: () => getImportableCalendarEvents(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Input for importing calendar events with optional restaurant selection
 */
export interface ImportCalendarEventsInput {
  calendarEventIds: string[];
  /** Map of calendarEventId -> restaurantId to use instead of the default matched restaurant */
  restaurantOverrides?: Map<string, string>;
}

/**
 * Import calendar events as visits
 */
export function useImportCalendarEvents() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: string[] | ImportCalendarEventsInput) => {
      // Support both old simple array and new object format
      if (Array.isArray(input)) {
        return importCalendarEvents(input);
      }
      return importCalendarEvents(input.calendarEventIds, {
        restaurantOverrides: input.restaurantOverrides,
      });
    },
    onMutate: async (input) => {
      const calendarEventIds = Array.isArray(input) ? input : input.calendarEventIds;

      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.importableCalendarEvents });

      // Snapshot the previous value for rollback
      const previousEvents = queryClient.getQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents);

      // Optimistically remove the imported events from the list
      optimisticallyRemoveImportableCalendarEvents(queryClient, calendarEventIds);

      // Also optimistically update stats (since these are now confirmed visits)
      optimisticallyUpdateStats(queryClient, { confirmed: calendarEventIds.length });

      return { previousEvents };
    },
    onError: (_error, _input, context) => {
      // Rollback to previous state on error
      if (context?.previousEvents) {
        queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, context.previousEvents);
      }
    },
  });
}

/**
 * Dismiss calendar events (hide them from import list)
 */
export function useDismissCalendarEvents() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (calendarEventIds: string[]) => dismissCalendarEvents(calendarEventIds),
    onMutate: async (calendarEventIds) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.importableCalendarEvents });

      // Snapshot the previous value for rollback
      const previousEvents = queryClient.getQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents);

      // Optimistically remove the dismissed events from the list
      optimisticallyRemoveImportableCalendarEvents(queryClient, calendarEventIds);

      return { previousEvents };
    },
    onError: (_error, _calendarEventIds, context) => {
      // Rollback to previous state on error
      if (context?.previousEvents) {
        queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, context.previousEvents);
      }
    },
  });
}

export type { ExportFormat };

/**
 * Export data to file
 */
export function useExportData() {
  return useMutation<ExportShareResult, Error, ExportFormat>({
    mutationFn: async (format: ExportFormat) => {
      const data =
        format === "json"
          ? await exportToJSON({ statusFilter: "confirmed" })
          : await exportToCSV({ statusFilter: "confirmed" });
      return shareExport(data, format);
    },
  });
}

export type VisitStatus = "pending" | "confirmed" | "rejected";

/**
 * Update visit status
 */
export function useUpdateVisitStatus(visitId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (newStatus: VisitStatus) => {
      if (!visitId) {
        throw new Error("Visit ID is required");
      }
      await updateVisitStatus(visitId, newStatus);
      return newStatus;
    },
    onSuccess: (newStatus) => {
      queryClient.setQueryData<VisitDetail | null>(queryKeys.visitDetail(visitId ?? ""), (old) =>
        old ? { ...old, visit: { ...old.visit, status: newStatus } } : old,
      );
      invalidateVisitQueries(queryClient);
      // Track analytics
      if (newStatus === "confirmed" && visitId) {
        logVisitConfirmed(parseInt(visitId, 10) || 0);
      } else if (newStatus === "rejected" && visitId) {
        logVisitRejected(parseInt(visitId, 10) || 0);
      }
    },
  });
}

/**
 * Update visit notes
 */
export function useUpdateVisitNotes(visitId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notes: string | null) => {
      if (!visitId) {
        throw new Error("Visit ID is required");
      }
      await updateVisitNotes(visitId, notes);
      return notes;
    },
    onSuccess: (notes) => {
      queryClient.setQueryData<VisitDetail | null>(queryKeys.visitDetail(visitId ?? ""), (old) =>
        old ? { ...old, visit: { ...old.visit, notes } } : old,
      );
    },
  });
}

/**
 * Quick status update mutation
 * Uses optimistic updates for instant UI feedback - no query invalidation needed for pending reviews
 */
export function useQuickUpdateVisitStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ visitId, newStatus }: { visitId: string; newStatus: VisitStatus }) => {
      await updateVisitStatus(visitId, newStatus);
      return { visitId, newStatus };
    },
    onMutate: async ({ visitId, newStatus }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.pendingReview }),
        queryClient.cancelQueries({ queryKey: queryKeys.stats }),
      ]);
      const previousPending = queryClient.getQueryData<PendingReviewData>(queryKeys.pendingReview);
      const previousStats = queryClient.getQueryData<Stats>(queryKeys.stats);

      // Optimistically remove from pending review list
      optimisticallyRemoveVisitsFromPending(queryClient, [visitId]);
      // Update stats based on new status
      const delta = newStatus === "confirmed" ? { pending: -1, confirmed: 1 } : { pending: -1 }; // rejected just decrements pending
      optimisticallyUpdateStats(queryClient, delta);

      return { previousPending, previousStats };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(queryKeys.pendingReview, context.previousPending);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(queryKeys.stats, context.previousStats);
      }
    },
    onSuccess: (_data, { visitId, newStatus }) => {
      // Only invalidate confirmed restaurants list if confirming, not pending reviews (handled optimistically)
      if (newStatus === "confirmed") {
        queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
        logVisitConfirmed(parseInt(visitId, 10) || 0);
      } else if (newStatus === "rejected") {
        logVisitRejected(parseInt(visitId, 10) || 0);
      }
    },
  });
}

/**
 * Undo a visit action (confirm or reject) by restoring it to pending status.
 * This is used by the undo banner to revert actions.
 */
export function useUndoVisitAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ visitId }: { visitId: string }) => {
      await updateVisitStatus(visitId, "pending");
      return { visitId };
    },
    onSuccess: () => {
      // Refetch the pending review list to restore the visit
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingReview });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
    },
  });
}

/**
 * Batch update visit statuses - for bulk operations
 * Uses optimistic updates for instant UI feedback - no query invalidation needed for pending reviews
 */
export function useBatchUpdateVisitStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ visitIds, newStatus }: { visitIds: string[]; newStatus: VisitStatus }) => {
      await Promise.all(visitIds.map((visitId) => updateVisitStatus(visitId, newStatus)));
      return { visitIds, newStatus };
    },
    onMutate: async ({ visitIds, newStatus }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.pendingReview }),
        queryClient.cancelQueries({ queryKey: queryKeys.stats }),
      ]);
      const previousPending = queryClient.getQueryData<PendingReviewData>(queryKeys.pendingReview);
      const previousStats = queryClient.getQueryData<Stats>(queryKeys.stats);

      optimisticallyRemoveVisitsFromPending(queryClient, visitIds);
      const delta =
        newStatus === "confirmed"
          ? { pending: -visitIds.length, confirmed: visitIds.length }
          : { pending: -visitIds.length };
      optimisticallyUpdateStats(queryClient, delta);

      return { previousPending, previousStats };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(queryKeys.pendingReview, context.previousPending);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(queryKeys.stats, context.previousStats);
      }
    },
    onSuccess: (_data, { newStatus }) => {
      // Only invalidate confirmed restaurants list if confirming, not pending reviews (handled optimistically)
      if (newStatus === "confirmed") {
        queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      }
    },
  });
}

/**
 * Fetch visits that can be merged with the current visit
 */
export function useMergeableVisits(
  visitId: string | undefined,
  startTime: number | undefined,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: queryKeys.mergeableVisits(visitId ?? ""),
    queryFn: () => getMergeableVisits(visitId!, startTime!),
    enabled: enabled && !!visitId && startTime !== undefined,
  });
}

/**
 * Merge two visits together
 */
export function useMergeVisits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ targetVisitId, sourceVisitId }: { targetVisitId: string; sourceVisitId: string }) => {
      await mergeVisits(targetVisitId, sourceVisitId);
      return { targetVisitId };
    },
    onSuccess: ({ targetVisitId }) => {
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(targetVisitId) });
    },
  });
}

// Re-export MergeableVisitGroup type
export type { MergeableVisitGroup };

export function useMergeableSameRestaurantVisits() {
  return useQuery({
    queryKey: queryKeys.mergeableSameRestaurantVisits,
    queryFn: getMergeableSameRestaurantVisitGroups,
  });
}

export function useBatchMergeSameRestaurantVisits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (groups: MergeableVisitGroup[]) => {
      const mergeCount = await batchMergeSameRestaurantVisits(groups);
      return { mergeCount };
    },
    onSuccess: () => {
      // Invalidate all visit-related queries
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.mergeableSameRestaurantVisits });
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
    },
  });
}

/**
 * Create a manual visit for a restaurant (without photos).
 * This allows users to log past visits that weren't captured by photos.
 */
export function useCreateManualVisit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      restaurantId,
      restaurantName,
      latitude,
      longitude,
      visitDate,
      notes,
    }: {
      restaurantId: string;
      restaurantName: string;
      latitude: number;
      longitude: number;
      visitDate: number;
      notes?: string | null;
    }) => {
      const visitId = await createManualVisit(restaurantId, restaurantName, latitude, longitude, visitDate, notes);
      return { visitId, restaurantId };
    },
    onSuccess: ({ restaurantId }) => {
      // Invalidate restaurant visits to show the new visit
      queryClient.invalidateQueries({ queryKey: queryKeys.restaurantVisits(restaurantId) });
      // Invalidate confirmed restaurants list (visit count changed)
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      // Invalidate stats
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      // Invalidate wrapped stats (invalidates all years)
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
    },
  });
}

// ============================================================================
// IGNORED LOCATIONS HOOKS
// ============================================================================

/**
 * Fetch all ignored locations
 */
export function useIgnoredLocations() {
  return useQuery({
    queryKey: queryKeys.ignoredLocations,
    queryFn: getIgnoredLocations,
  });
}

/**
 * Add an ignored location and reject all visits within it
 */
export function useIgnoreLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      latitude,
      longitude,
      radius = 100,
      name,
    }: {
      latitude: number;
      longitude: number;
      radius?: number;
      name?: string | null;
    }) => {
      const id = await addIgnoredLocation(latitude, longitude, radius, name ?? null);
      const rejectedCount = await rejectVisitsInIgnoredLocations();
      return { id, rejectedCount };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ignoredLocations });
      invalidateVisitQueries(queryClient);
    },
  });
}

/**
 * Remove an ignored location (won't restore rejected visits automatically)
 */
export function useRemoveIgnoredLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await removeIgnoredLocation(id);
      return { id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ignoredLocations });
    },
  });
}

/** Restaurant detail query */
export function useRestaurantDetail(restaurantId: string | undefined) {
  const { data: confirmedRestaurants } = useConfirmedRestaurants();

  return useMemo(() => {
    if (!restaurantId || !confirmedRestaurants) {
      return { data: undefined };
    }
    const restaurant = confirmedRestaurants.find((r) => r.id === restaurantId);
    return { data: restaurant ?? undefined };
  }, [restaurantId, confirmedRestaurants]);
}

/** Update restaurant mutation */
export function useUpdateRestaurant(restaurantId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateRestaurantData) => {
      if (!restaurantId) {
        throw new Error("Restaurant ID is required");
      }
      await updateRestaurant(restaurantId, data);
      return data;
    },
    onMutate: async (data) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.confirmedRestaurants });

      // Snapshot the previous value
      const previousRestaurants = queryClient.getQueryData<RestaurantWithVisits[]>(queryKeys.confirmedRestaurants);

      // Optimistically update the restaurant in the list
      if (previousRestaurants && restaurantId) {
        queryClient.setQueryData<RestaurantWithVisits[]>(queryKeys.confirmedRestaurants, (old) =>
          old?.map((r) => (r.id === restaurantId ? { ...r, ...data, name: data.name ?? r.name } : r)),
        );
      }

      return { previousRestaurants };
    },
    onError: (_err, _data, context) => {
      // Rollback on error
      if (context?.previousRestaurants) {
        queryClient.setQueryData(queryKeys.confirmedRestaurants, context.previousRestaurants);
      }
    },
    onSettled: () => {
      // Refetch to ensure consistency with server
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
    },
  });
}

// Re-export DeepScanProgress type
export type { DeepScanProgress, VisitFoodScanProgress };

/**
 * Deep scan all photos for food detection
 */
export function useDeepScan(onProgress?: (progress: DeepScanProgress) => void) {
  const queryClient = useQueryClient();
  // Use ref to always call the latest callback
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  return useMutation({
    mutationFn: () => deepScanAllPhotosForFood({ onProgress: (p) => onProgressRef.current?.(p) }),
    onSuccess: () => invalidateVisitQueries(queryClient),
  });
}

/**
 * Scan a specific visit's photos for food detection
 */
export function useScanVisitForFood(
  visitId: string | undefined,
  onProgress?: (progress: VisitFoodScanProgress) => void,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (photos: Array<{ id: string }>) => {
      if (!visitId) {
        throw new Error("Visit ID is required");
      }
      return scanVisitPhotosForFood(visitId, photos, { onProgress });
    },
    onSuccess: () => {
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(visitId ?? "") });
    },
  });
}

/**
 * Reverse geocode coordinates to a location name (on-device)
 * Uses expo-location which leverages native CoreLocation (iOS) or Google Geocoder (Android)
 * Results are cached by rounded coordinates to avoid duplicate lookups
 */
export function useReverseGeocode(lat: number | undefined, lon: number | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: queryKeys.reverseGeocode(lat ?? 0, lon ?? 0),
    queryFn: async (): Promise<string | null> => {
      if (!lat || !lon) {
        return null;
      }

      try {
        const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });

        if (results.length === 0) {
          return null;
        }

        const place = results[0];

        // Build a human-readable location string
        // Prefer: Neighborhood/District, City or Street, City
        const parts: string[] = [];

        if (place.subregion) {
          // Subregion is usually a neighborhood or district
          parts.push(place.subregion);
        } else if (place.street) {
          parts.push(place.street);
        } else if (place.district) {
          parts.push(place.district);
        }

        if (place.city) {
          parts.push(place.city);
        } else if (place.region) {
          parts.push(place.region);
        }

        if (parts.length === 0) {
          // Fallback to country if nothing else available
          return place.country ?? null;
        }

        return parts.join(", ");
      } catch (error) {
        console.warn("Reverse geocoding failed:", error);
        return null;
      }
    },
    enabled: enabled && lat !== undefined && lon !== undefined,
    staleTime: Infinity, // Location names don't change - cache forever
    gcTime: 1000 * 60 * 60 * 24, // Keep in cache for 24 hours
  });
}

// ============================================================================
// CALENDAR EXPORT HOOKS
// ============================================================================

/**
 * Fetch writable calendars the user can add events to
 */
export function useWritableCalendars() {
  return useQuery({
    queryKey: queryKeys.writableCalendars,
    queryFn: getWritableCalendars,
  });
}

/**
 * Fetch all syncable calendars for the calendar selection UI
 */
export function useSyncableCalendars() {
  return useQuery({
    queryKey: queryKeys.syncableCalendars,
    queryFn: getAllSyncableCalendars,
  });
}

/**
 * Fetch confirmed visits that don't have calendar events
 */
export function useVisitsWithoutCalendarEvents() {
  return useQuery({
    queryKey: queryKeys.visitsWithoutCalendarEvents,
    queryFn: getConfirmedVisitsWithoutCalendarEvents,
  });
}

/**
 * Create calendar events for visits and update the visits with event IDs
 */
export function useCreateCalendarEventsForVisits() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      visits,
      calendarId,
    }: {
      visits: VisitForCalendarExport[];
      calendarId: string;
    }): Promise<{ created: number; failed: number }> => {
      // Create calendar events
      const results = await batchCreateCalendarEvents(visits, calendarId);

      // Update visits with the created event IDs and track which calendar we exported to
      if (results.eventIds.size > 0) {
        const updates = Array.from(results.eventIds.entries()).map(([visitId, eventId]) => {
          const visit = visits.find((v) => v.id === visitId);
          return {
            visitId,
            calendarEventId: eventId,
            calendarEventTitle: visit?.restaurantName ?? "Restaurant Visit",
            exportedToCalendarId: calendarId, // Track which calendar we exported to
          };
        });
        await batchUpdateVisitCalendarEvents(updates);
      }

      return { created: results.created, failed: results.failed };
    },
    onSuccess: () => {
      // Invalidate queries to refresh the lists
      queryClient.invalidateQueries({ queryKey: queryKeys.visitsWithoutCalendarEvents });
      queryClient.invalidateQueries({ queryKey: queryKeys.exportedCalendarEvents });
      queryClient.invalidateQueries({ queryKey: queryKeys.visits() });
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
    },
  });
}

/**
 * Get visits that have calendar events we created (can be deleted)
 */
export function useExportedCalendarEvents() {
  return useQuery({
    queryKey: queryKeys.exportedCalendarEvents,
    queryFn: getVisitsWithExportedCalendarEvents,
    staleTime: 30_000,
  });
}

/**
 * Delete all exported calendar events and clear the tracking data
 */
export function useDeleteExportedCalendarEvents() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (events: ExportedCalendarEvent[]): Promise<{ deleted: number; failed: number }> => {
      // Delete events from calendar
      const eventIds = events.map((e) => e.calendarEventId);
      const results = await batchDeleteCalendarEvents(eventIds);

      // Clear the exported calendar event data from visits
      if (results.deleted > 0) {
        const deletedEventIds = new Set(eventIds.slice(0, results.deleted));
        const visitIdsToUpdate = events.filter((e) => deletedEventIds.has(e.calendarEventId)).map((e) => e.visitId);
        await clearExportedCalendarEvents(visitIdsToUpdate);
      }

      return results;
    },
    onSuccess: () => {
      // Invalidate queries to refresh the lists
      queryClient.invalidateQueries({ queryKey: queryKeys.exportedCalendarEvents });
      queryClient.invalidateQueries({ queryKey: queryKeys.visitsWithoutCalendarEvents });
      queryClient.invalidateQueries({ queryKey: queryKeys.visits() });
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
    },
  });
}

// ============================================================================
// FOOD KEYWORDS HOOKS
// ============================================================================

// Re-export types
export type { FoodKeywordRecord, ReclassifyProgress };

/**
 * Fetch all food keywords
 */
export function useFoodKeywords() {
  return useQuery({
    queryKey: queryKeys.foodKeywords,
    queryFn: getAllFoodKeywords,
  });
}

/**
 * Get count of photos that have classification labels stored (for reclassification UI)
 */
export function usePhotosWithLabelsCount() {
  return useQuery({
    queryKey: queryKeys.photosWithLabelsCount,
    queryFn: getPhotosWithLabelsCount,
  });
}

/**
 * Get count of photos that still need food detection (used to gate deep scan UI)
 */
export function useUnanalyzedPhotoCount() {
  return useQuery({
    queryKey: queryKeys.unanalyzedPhotoCount,
    queryFn: getUnanalyzedPhotoCount,
  });
}

/**
 * Add a new food keyword
 */
export function useAddFoodKeyword() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (keyword: string) => {
      return addFoodKeyword(keyword);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.foodKeywords });
    },
  });
}

/**
 * Remove a food keyword (only user-added keywords can be removed)
 */
export function useRemoveFoodKeyword() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      await removeFoodKeyword(id);
      return { id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.foodKeywords });
    },
  });
}

/**
 * Toggle a food keyword on/off
 */
export function useToggleFoodKeyword() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      await toggleFoodKeyword(id, enabled);
      return { id, enabled };
    },
    onMutate: async ({ id, enabled }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.foodKeywords });

      // Snapshot the previous value
      const previousKeywords = queryClient.getQueryData<FoodKeywordRecord[]>(queryKeys.foodKeywords);

      // Optimistically update the cache
      queryClient.setQueryData<FoodKeywordRecord[]>(queryKeys.foodKeywords, (old) =>
        old?.map((k) => (k.id === id ? { ...k, enabled } : k)),
      );

      return { previousKeywords };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.previousKeywords) {
        queryClient.setQueryData(queryKeys.foodKeywords, context.previousKeywords);
      }
    },
  });
}

/**
 * Reset food keywords to defaults (re-enable all built-in, remove user-added)
 */
export function useResetFoodKeywords() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await resetFoodKeywordsToDefaults();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.foodKeywords });
    },
  });
}

/**
 * Reclassify all photos based on current enabled food keywords
 */
export function useReclassifyPhotos(onProgress?: (progress: ReclassifyProgress) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return reclassifyPhotosWithCurrentKeywords(onProgress);
    },
    onSuccess: () => {
      // Invalidate all relevant queries after reclassification
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.photosWithLabelsCount });
    },
  });
}

/**
 * Recompute suggested restaurants for all pending visits.
 * This recalculates which restaurants are near each visit based on location.
 */
export function useRecomputeSuggestedRestaurants() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return recomputeSuggestedRestaurants();
    },
    onSuccess: () => {
      // Invalidate visit-related queries to reflect new suggestions
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

// ============================================================================
// PHOTO MANAGEMENT
// ============================================================================

/**
 * Add photos to a visit by moving them from their current visit (if any).
 * Photos can only belong to one visit at a time.
 */
export function useAddPhotosToVisit(visitId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assetIds: string[]): Promise<MovePhotosResult> => {
      if (!visitId) {
        throw new Error("Visit ID is required");
      }
      // First check which photos exist in the database
      const existingPhotos = await getPhotosByAssetIds(assetIds);
      const existingPhotoIds = existingPhotos.map((p) => p.id);

      if (existingPhotoIds.length === 0) {
        return { movedCount: 0, fromVisitIds: [] };
      }

      // Move the photos to this visit
      return movePhotosToVisit(existingPhotoIds, visitId);
    },
    onSuccess: (_result, _vars) => {
      // Invalidate visit detail query for this visit
      if (visitId) {
        queryClient.invalidateQueries({ queryKey: ["visitDetail", visitId] });
      }
      // Also invalidate any affected source visits and general queries
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

/**
 * Remove photos from a visit.
 * This disassociates the photos from the visit without deleting them from the device.
 */
export function useRemovePhotosFromVisit(visitId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (photoIds: string[]): Promise<RemovePhotosResult> => {
      if (!visitId) {
        throw new Error("Visit ID is required");
      }
      return removePhotosFromVisit(photoIds, visitId);
    },
    onSuccess: (_result, _vars) => {
      // Invalidate visit detail query for this visit
      if (visitId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(visitId) });
      }
      // Also invalidate general queries
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

// ============================================================================
// GOOGLE PLACES SEARCH
// ============================================================================

// Re-export PlaceResult type
export type { PlaceResult };

/**
 * Search for places by text query using Google Places API.
 * Results are biased towards the provided location if lat/lon are provided.
 *
 * @param query - The search query text
 * @param lat - Optional latitude to bias results
 * @param lon - Optional longitude to bias results
 * @param enabled - Whether the query should run (default: true when query is non-empty)
 */
export function usePlaceTextSearch(query: string, lat?: number, lon?: number, enabled: boolean = true) {
  return useQuery({
    queryKey: queryKeys.placeTextSearch(query, lat, lon),
    queryFn: () => searchPlaceByText(query, lat, lon),
    enabled: enabled && query.trim().length > 0,
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });
}
