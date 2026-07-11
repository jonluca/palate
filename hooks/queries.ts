import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/query-core";
import * as Location from "expo-location";
import { useMemo, useRef } from "react";
import { logVisitConfirmed, logVisitRejected } from "@/services/analytics";
import {
  getVisitListPage,
  getVisitById,
  getStats,
  getPhotosByVisitId,
  updateVisitStatus,
  updateVisitNotes,
  getConfirmedRestaurantSearchRows,
  getConfirmedRestaurantsWithVisits,
  getRestaurantVisitsWithPreviews,
  getPendingQuickActionsData,
  getPendingVisitReviewFirstPage,
  getPendingVisitReviewPage,
  batchUpdateVisitStatuses,
  batchConfirmVisits,
  confirmVisit,
  getAllMichelinRestaurants,
  getActiveMichelinUnicodeNameRows,
  getImportedMichelinDatasetVersion,
  getMichelinMapViewport,
  hydrateUnvisitedMichelinNameSearchIds,
  searchUnvisitedMichelinRestaurantsByName,
  getMichelinRestaurantById,
  getRestaurantById,
  getRestaurantDisplayById,
  getMichelinRestaurantsForStatsBucket,
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
  type VisitListCursor,
  type VisitListItem,
  type VisitListPage,
  type MovePhotosResult,
  type RemovePhotosResult,
  type PhotoRecord,
  type RestaurantRecord,
  type ConfirmedRestaurantSearchRow as ConfirmedRestaurantSearchRowDB,
  type MichelinRestaurantRecord,
  type MichelinMapViewportRequest,
  type RestaurantWithVisits as RestaurantWithVisitsDB,
  type PendingVisitForReview as PendingVisitForReviewDB,
  type PendingQuickActionsData as PendingQuickActionsDataDB,
  type PendingVisitReviewExactConfirmation,
  type PendingVisitReviewFilters,
  type PendingVisitReviewPageRequest,
  type PendingVisitReviewProgressivePage,
  type VisitRecord as VisitRecordDB,
  type WrappedStats,
  type IgnoredLocationRecord,
  type UpdateRestaurantData,
  type VisitForCalendarExport,
  type ExportedCalendarEvent,
  type FoodKeywordRecord,
  type ReclassifyProgress,
  type MichelinStatsBucket,
  type MichelinStatsRestaurantSummary,
  type MichelinUnicodeNameIndexRow,
  createManualVisit,
  batchMergeSameRestaurantVisits,
  type MergeableVisitGroup,
  getMergeableSameRestaurantVisitGroups,
  excludeReservationImportReviews,
} from "@/utils/db";
import {
  requestCalendarPermission,
  getWritableCalendars,
  getAllSyncableCalendars,
  getEventsOverlappingRange,
  batchCreateCalendarEvents,
  batchDeleteCalendarEvents,
  type WritableCalendar,
  type CalendarEventInfo,
} from "@/services/calendar";
import { compareSameNameMichelinFirst, normalizeRestaurantNameForPriority } from "@/utils/restaurant-priority";
import { selectCalendarMutationSuccessfulItems } from "@/utils/calendar-batch-mutation-core";
import { getUniqueCalendarImportEventIds, reconcileCalendarImportCache } from "@/utils/calendar-import-cache-policy";
import {
  REVIEW_QUERY_MOUNT_POLICY,
  REVIEW_STATUS_MUTATION_SCOPE,
  invalidatePendingReviewQuery,
  interruptPendingReviewRefreshForMutationSettlement,
  markPendingReviewQueryStale,
  removePendingReviewInfiniteVisits,
  restoreFailedPendingReviewMutation,
  restoreFailedPendingReviewInfiniteMutation,
  reviewQueryKeys,
  type PendingReviewInfiniteData,
} from "@/utils/review-query-policy";
import {
  invalidateVisitListPageQueries,
  invalidateVisitStatusQueries,
  invalidateWrappedStatsQueries,
  VISIT_LIST_PAGE_QUERY_ROOT,
  VISIT_LIST_QUERY_POLICY,
} from "@/utils/query-cache-policy";
import { getNextPendingVisitReviewPageRequest } from "@/utils/db/visit-review-paging-core";
import {
  CONFIRMED_RESTAURANTS_QUERY_KEY,
  CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
  shouldLoadConfirmedRestaurantSearch,
} from "@/utils/db/confirmed-restaurant-search-core";
import {
  assertMichelinNameSearchNotAborted,
  createMichelinUnicodeNameIndex,
  isNonAsciiMichelinNameSearchQuery,
  normalizeMichelinNameSearchQuery,
  runStableMichelinNameSearch,
  selectSortedMichelinUnicodeMatchIds,
} from "@/utils/db/michelin-name-search-core";
import { ensureMichelinDataInitialized, MICHELIN_STATIC_QUERY_CACHE_POLICY } from "@/utils/michelin-query-cache-policy";

// ============================================================================
// QUERY INVALIDATION HELPERS
// ============================================================================

/** Invalidate all visit-related queries */
function invalidateVisitQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.pendingReview });
  queryClient.invalidateQueries({ queryKey: queryKeys.unanalyzedPhotoCount });
}

/** Reconcile every cache that can reflect incrementally persisted food results. */
function invalidateFoodDetectionQueries(queryClient: QueryClient) {
  invalidateVisitStatusQueries(queryClient);
  void invalidatePendingReviewQuery(queryClient);
  queryClient.invalidateQueries({ queryKey: ["visitPhotos"] });
  queryClient.invalidateQueries({ queryKey: queryKeys.unanalyzedPhotoCount });
  queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  queryClient.invalidateQueries({ queryKey: ["wrapped"] });
  queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
  queryClient.invalidateQueries({ queryKey: queryKeys.photosWithLabelsCount });
}

function invalidateMichelinRestaurantSearch(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["michelinRestaurantSearch"] });
}

function invalidateReservationImportQueries(queryClient: QueryClient) {
  invalidateVisitQueries(queryClient);
  // Imports can auto-merge and delete source visits, so invalidate the whole
  // visit-key family rather than only the confirmed list.
  invalidateVisitStatusQueries(queryClient);
  queryClient.invalidateQueries({ queryKey: queryKeys.mergeableSameRestaurantVisits });
}

// ============================================================================
// OPTIMISTIC UPDATE HELPERS
// ============================================================================

type PendingReviewPagedData = PendingReviewInfiniteData<PendingVisitForReviewDB>;

interface PendingReviewMutationBaseline {
  readonly legacy: PendingReviewData | undefined;
  readonly pages: ReadonlyArray<readonly [QueryKey, PendingReviewPagedData | undefined]>;
}

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
  queryClient.setQueriesData<PendingReviewPagedData>({ queryKey: reviewQueryKeys.pendingReviewPagesRoot }, (current) =>
    removePendingReviewInfiniteVisits(current, visitIds),
  );
}

function restoreFailedVisitsToPending(
  queryClient: QueryClient,
  baseline: PendingReviewMutationBaseline | undefined,
  visitIds: readonly string[],
) {
  queryClient.setQueryData<PendingReviewData>(queryKeys.pendingReview, (current) =>
    restoreFailedPendingReviewMutation(current, baseline?.legacy, visitIds),
  );
  for (const [queryKey, previous] of baseline?.pages ?? []) {
    queryClient.setQueryData<PendingReviewPagedData>(queryKey, (current) =>
      restoreFailedPendingReviewInfiniteMutation(current, previous, visitIds),
    );
  }
}

const optimisticallyStalePendingReviewClients = new WeakSet<QueryClient>();

interface PendingReviewMutationGroup {
  activeMutations: number;
  readonly rollbackBaseline: PendingReviewMutationBaseline;
  readonly successfulVisitIds: Set<string>;
}

const pendingReviewMutationGroups = new WeakMap<QueryClient, PendingReviewMutationGroup>();

function snapshotPendingReviewMutationBaseline(queryClient: QueryClient): PendingReviewMutationBaseline {
  return {
    legacy: queryClient.getQueryData<PendingReviewData>(queryKeys.pendingReview),
    pages: queryClient.getQueriesData<PendingReviewPagedData>({
      queryKey: reviewQueryKeys.pendingReviewPagesRoot,
    }),
  };
}

function beginPendingReviewMutationGroup(queryClient: QueryClient): PendingReviewMutationBaseline {
  const existing = pendingReviewMutationGroups.get(queryClient);
  if (existing) {
    existing.activeMutations += 1;
    return existing.rollbackBaseline;
  }
  const rollbackBaseline = snapshotPendingReviewMutationBaseline(queryClient);
  pendingReviewMutationGroups.set(queryClient, {
    activeMutations: 1,
    rollbackBaseline,
    successfulVisitIds: new Set(),
  });
  return rollbackBaseline;
}

function markPendingReviewMutationIdsSuccessful(queryClient: QueryClient, visitIds: readonly string[]): void {
  const group = pendingReviewMutationGroups.get(queryClient);
  for (const visitId of visitIds) {
    group?.successfulVisitIds.add(visitId);
  }
}

function pendingReviewMutationIdsEligibleForRollback(queryClient: QueryClient, visitIds: readonly string[]): string[] {
  const successfulVisitIds = pendingReviewMutationGroups.get(queryClient)?.successfulVisitIds;
  return successfulVisitIds ? visitIds.filter((visitId) => !successfulVisitIds.has(visitId)) : [...visitIds];
}

function finishPendingReviewMutationGroup(queryClient: QueryClient): void {
  const group = pendingReviewMutationGroups.get(queryClient);
  if (!group) {
    return;
  }
  group.activeMutations -= 1;
  if (group.activeMutations === 0) {
    pendingReviewMutationGroups.delete(queryClient);
  }
}

function pendingReviewRefreshNeedsReconciliation(queryClient: QueryClient): boolean {
  const expectedOptimisticStaleness = optimisticallyStalePendingReviewClients.delete(queryClient);
  const states = queryClient
    .getQueryCache()
    .findAll({ queryKey: reviewQueryKeys.pendingReview })
    .map((query) => query.state);
  return (
    states.some((state) => state.fetchStatus === "fetching") ||
    (expectedOptimisticStaleness === false && states.some((state) => state.isInvalidated === true))
  );
}

async function settleOptimisticPendingReviewMutation(
  queryClient: QueryClient,
  refreshNeedsReconciliation: boolean,
): Promise<void> {
  await markPendingReviewQueryStale(queryClient);
  optimisticallyStalePendingReviewClients.add(queryClient);
  if (refreshNeedsReconciliation) {
    optimisticallyStalePendingReviewClients.delete(queryClient);
    await invalidatePendingReviewQuery(queryClient);
  }
}

async function initializeMichelinDataForQuery(queryClient: QueryClient): Promise<void> {
  await ensureMichelinDataInitialized(queryClient, initializeMichelinData, async () => {
    await Promise.all([invalidatePendingReviewQuery(queryClient), invalidateVisitListPageQueries(queryClient)]);
  });
}

function optimisticallyRemoveImportableCalendarEvents(queryClient: QueryClient, calendarEventIds: string[]) {
  const eventIdSet = new Set(calendarEventIds);
  queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, (old) =>
    old ? old.filter((event) => !eventIdSet.has(event.calendarEventId)) : old,
  );
}

// Re-export types for external use with visit naming
export type RestaurantWithVisits = RestaurantWithVisitsDB;
export type ConfirmedRestaurantSearchRow = ConfirmedRestaurantSearchRowDB;
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
  initializeMichelinData,
  type DeepScanProgress,
  type VisitFoodScanProgress,
  type ImportableCalendarEvent,
} from "@/services/visit";
import { hasMediaLibraryPermission, requestMediaLibraryPermission, getPhotoCount } from "@/services/scanner";
import {
  exportAndShareJSON,
  exportToCSV,
  shareExport,
  type ExportFormat,
  type ExportShareResult,
} from "@/services/export";
import { importOpenTableVisitHistory } from "@/services/opentable";
import { fetchResyVisitHistory, importResyVisitHistory, type ResyImportProgress } from "@/services/resy";
import { importTockVisitHistory } from "@/services/tock";
import {
  filterProviderReservationReviewCandidates,
  importReservationVisitHistory,
  type ImportableReservation,
  type ReservationReviewFilterResult,
  type ReservationImportResult,
} from "@/services/reservation-import";
import {
  isMapKitSearchAvailable,
  searchByText as mapKitSearchByText,
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

function isValidCoordinatePair(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

// Query Keys
export const queryKeys = {
  stats: ["stats"] as const,
  visits: (filter?: FilterType) => ["visits", filter] as const,
  visitPages: (filter: FilterType) => [...VISIT_LIST_PAGE_QUERY_ROOT, filter] as const,
  visitDetail: (id: string) => ["visits", "visit", id] as const,
  visitPhotos: (id: string) => ["visitPhotos", id] as const,
  unmatchedVisits: ["unmatchedVisits"] as const,
  permissions: ["permissions"] as const,
  calendarPermissions: ["calendarPermissions"] as const,
  photoCount: ["photoCount"] as const,
  unanalyzedPhotoCount: reviewQueryKeys.unanalyzedPhotoCount,
  placesConfigured: ["static", "placesConfigured"] as const,
  // Restaurant-centric keys
  confirmedRestaurants: CONFIRMED_RESTAURANTS_QUERY_KEY,
  confirmedRestaurantSearch: CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
  restaurantVisits: (restaurantId: string) => ["visits", "restaurantVisits", restaurantId] as const,
  restaurantDetail: (restaurantId: string) => ["restaurants", "detail", restaurantId] as const,
  pendingReview: reviewQueryKeys.pendingReview,
  michelinRestaurants: ["static", "michelinRestaurants"] as const,
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

// Re-export stats-related types
export type { MichelinStatsBucket, MichelinStatsRestaurantSummary, WrappedStats };

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
    // These 19-20 query aggregates only change after an explicit local mutation.
    // Invalidation remains authoritative and overrides this freshness window.
    staleTime: Infinity,
    ...options,
  });
}

export function useMichelinStatsBucketRestaurants(
  year: number | null | undefined,
  bucket: MichelinStatsBucket,
  options?: Omit<UseQueryOptions<MichelinStatsRestaurantSummary[], Error>, "queryKey" | "queryFn">,
) {
  return useQuery({
    queryKey: queryKeys.wrappedMichelinBucketRestaurants(year, bucket),
    queryFn: () => getMichelinRestaurantsForStatsBucket(year, bucket),
    ...options,
  });
}

/**
 * Fetch visits with restaurant names and preview photos
 */
export function useVisits(filter: FilterType, options?: { readonly enabled?: boolean }) {
  return useInfiniteQuery({
    queryKey: queryKeys.visitPages(filter),
    initialPageParam: null as VisitListCursor | null,
    queryFn: async ({ pageParam, signal }): Promise<VisitListPage & { readonly filter: FilterType }> => {
      if (signal.aborted) {
        throw signal.reason ?? new Error("Visit-list page request was cancelled");
      }
      const page = await getVisitListPage(filter === "all" ? undefined : filter, pageParam);
      if (signal.aborted) {
        throw signal.reason ?? new Error("Visit-list page request was cancelled");
      }
      return { ...page, filter };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...VISIT_LIST_QUERY_POLICY,
    placeholderData: keepPreviousData,
    enabled: options?.enabled,
  });
}

export type { VisitListItem };

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
    staleTime: 1000 * 60 * 2,
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

      const [restaurant, suggestedRestaurantRecord] = await Promise.all([
        visit.restaurantId ? getRestaurantById(visit.restaurantId) : Promise.resolve(null),
        visit.suggestedRestaurantId ? getMichelinRestaurantById(visit.suggestedRestaurantId) : Promise.resolve(null),
      ]);

      let suggestedRestaurant: MichelinRestaurantRecord | null = suggestedRestaurantRecord;

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
 * Fetch the modal's slim confirmed-restaurant projection only while the user
 * can see and use visited-restaurant search results.
 */
export function useConfirmedRestaurantSearch(visible: boolean, searchQuery: string) {
  return useQuery({
    queryKey: queryKeys.confirmedRestaurantSearch,
    queryFn: getConfirmedRestaurantSearchRows,
    enabled: shouldLoadConfirmedRestaurantSearch(visible, searchQuery),
  });
}

/**
 * Fetch visits for a specific restaurant
 */
export function useRestaurantVisits(restaurantId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.restaurantVisits(restaurantId ?? ""),
    queryFn: () => getRestaurantVisitsWithPreviews(restaurantId!),
    enabled: !!restaurantId,
  });
}

export type PendingReviewData = PendingQuickActionsDataDB;

export type ExactCalendarConfirmation = PendingVisitReviewExactConfirmation;
export type PendingReviewPageFilters = PendingVisitReviewFilters;

export function createLoadedExactCalendarMatches(
  visits: readonly PendingVisitForReviewDB[],
  confirmations: readonly PendingVisitReviewExactConfirmation[],
): ExactCalendarMatch[] {
  const visitsById = new Map(visits.map((visit) => [visit.id, visit]));
  return confirmations.flatMap((confirmation) => {
    const visit = visitsById.get(confirmation.visitId);
    return visit ? [{ ...confirmation, visit }] : [];
  });
}

/**
 * Fetch the complete Quick Actions queue without hydrating Review-card fields.
 * The legacy cache key is retained so status mutations keep one optimistic source of truth.
 */
export function usePendingQuickActions() {
  return useQuery({
    queryKey: queryKeys.pendingReview,
    queryFn: getPendingQuickActionsData,
    ...REVIEW_QUERY_MOUNT_POLICY,
  });
}

/** Progressively hydrate the globally ordered Review queue in bounded pages. */
export function usePendingReviewPages(filters: PendingVisitReviewFilters) {
  return useInfiniteQuery({
    queryKey: reviewQueryKeys.pendingReviewPages(filters.food, filters.restaurantMatches),
    initialPageParam: null as PendingVisitReviewPageRequest | null,
    queryFn: async ({ pageParam, signal }): Promise<PendingVisitReviewProgressivePage> => {
      if (signal.aborted) {
        throw signal.reason ?? new Error("Pending-review page request was cancelled");
      }
      const page = pageParam
        ? await getPendingVisitReviewPage(pageParam)
        : await getPendingVisitReviewFirstPage(filters);
      if (signal.aborted) {
        throw signal.reason ?? new Error("Pending-review page request was cancelled");
      }
      return page;
    },
    getNextPageParam: (_lastPage: PendingVisitReviewProgressivePage, pages: PendingVisitReviewProgressivePage[]) =>
      getNextPendingVisitReviewPageRequest(pages),
    ...REVIEW_QUERY_MOUNT_POLICY,
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch all Michelin restaurants (for searching)
 */
export function useMichelinRestaurants() {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: queryKeys.michelinRestaurants,
    queryFn: async () => {
      // The version check is cheap after the first import and prevents an app
      // update from caching the previous bundled guide for this whole process.
      await initializeMichelinDataForQuery(queryClient);
      return getAllMichelinRestaurants();
    },
    staleTime: Infinity, // This data doesn't change
  });
}

/** Fetch only the active Michelin rows that can be rendered in one map viewport. */
export function useMichelinMapViewport(request: MichelinMapViewportRequest, enabled: boolean = true) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: queryKeys.michelinMapViewport(request),
    queryFn: async () => {
      await initializeMichelinDataForQuery(queryClient);
      const selection = await getMichelinMapViewport(request);
      return {
        ...selection,
        resolvedFilters: {
          visitStatus: request.visitStatusFilter,
          award: request.awardFilter,
        },
      };
    },
    enabled: enabled && request.width > 0 && request.height > 0,
    staleTime: Infinity,
    // Keep recent viewports warm across quick back navigation and preserve the
    // currently displayed snapshot while the next camera/filter query settles.
    gcTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Search unvisited restaurants in the active Michelin dataset.
 * The query remains disabled until the user enters non-whitespace text.
 */
export function useMichelinRestaurantSearch(query: string, enabled: boolean = true) {
  const queryClient = useQueryClient();
  const normalizedQuery = normalizeMichelinNameSearchQuery(query);

  return useQuery({
    queryKey: queryKeys.michelinRestaurantSearch(normalizedQuery),
    queryFn: async ({ signal }) => {
      await initializeMichelinDataForQuery(queryClient);
      assertMichelinNameSearchNotAborted(signal);

      if (!isNonAsciiMichelinNameSearchQuery(normalizedQuery)) {
        return searchUnvisitedMichelinRestaurantsByName(normalizedQuery, undefined, signal);
      }

      return runStableMichelinNameSearch({
        signal,
        readDatasetVersion: getImportedMichelinDatasetVersion,
        loadIndex: (datasetVersion) =>
          queryClient.ensureQueryData<MichelinUnicodeNameIndexRow[]>({
            queryKey: queryKeys.michelinUnicodeNameIndex(datasetVersion),
            queryFn: async ({ signal: indexSignal }) => {
              const rows = await getActiveMichelinUnicodeNameRows();
              assertMichelinNameSearchNotAborted(indexSignal);
              return createMichelinUnicodeNameIndex(rows);
            },
            ...MICHELIN_STATIC_QUERY_CACHE_POLICY,
            revalidateIfStale: true,
          }),
        selectMatchingIds: (index) => selectSortedMichelinUnicodeMatchIds(index, normalizedQuery),
        hydrateMatchingIds: hydrateUnvisitedMichelinNameSearchIds,
        onDatasetChanged: (previousVersion) => {
          queryClient.removeQueries({
            queryKey: queryKeys.michelinUnicodeNameIndex(previousVersion),
            exact: true,
          });
        },
      });
    },
    enabled: enabled && normalizedQuery.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
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
    queryKey: queryKeys.mapKitNearby(lat ?? 0, lon ?? 0, radiusMeters),
    queryFn: async (): Promise<MapKitSearchResult[]> => {
      if (lat === undefined || lon === undefined || !isValidCoordinatePair(lat, lon) || !isMapKitSearchAvailable()) {
        return [];
      }
      try {
        return await mapKitSearchNearbyRestaurants(lat, lon, radiusMeters);
      } catch (error) {
        console.warn("MapKit search failed:", error);
        throw error;
      }
    },
    enabled:
      enabled && lat !== undefined && lon !== undefined && isValidCoordinatePair(lat, lon) && isMapKitSearchAvailable(),
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 2000),
    refetchOnMount: true,
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
      const nameMatch = normalizeRestaurantNameForPriority(m.name) === normalizeRestaurantNameForPriority(mk.name);
      // Or if they're within 30m of each other
      const distanceBetween = Math.sqrt(
        Math.pow((m.latitude - mk.latitude) * 111000, 2) +
          Math.pow((m.longitude - mk.longitude) * 111000 * Math.cos((m.latitude * Math.PI) / 180), 2),
      );
      return nameMatch || distanceBetween < 30;
    });
    return !isDuplicate;
  });

  // Combine: keep Michelin ahead of same-name Apple results, otherwise sort by distance.
  return [...michelin, ...dedupedMapKit].sort((a, b) => compareSameNameMichelinFirst(a, b) || a.distance - b.distance);
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
  const shouldFetchMapKit = enabled && lat !== undefined && lon !== undefined && isValidCoordinatePair(lat, lon);

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
    | "optimizing-database";
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
    onSettled: () => {
      invalidateFoodDetectionQueries(queryClient);
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
 * Search for restaurants by text via Apple MapKit.
 */
export function useSearchAppleRestaurants() {
  return useMutation({
    mutationFn: async ({ query, lat, lon, radius }: { query: string; lat: number; lon: number; radius?: number }) => {
      return mapKitSearchByText(query, lat, lon, radius);
    },
  });
}

/**
 * Confirm a visit by linking visit to restaurant
 * Uses optimistic updates for instant UI feedback, then reconciles all status-derived caches.
 * Looks up and stores the historical Michelin award at the time of visit
 */
export function useConfirmVisit() {
  const queryClient = useQueryClient();

  return useMutation({
    scope: REVIEW_STATUS_MUTATION_SCOPE,
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
      const refreshNeedsReconciliation = pendingReviewRefreshNeedsReconciliation(queryClient);
      const rollbackBaseline = beginPendingReviewMutationGroup(queryClient);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.pendingReview });
      } catch (error) {
        finishPendingReviewMutationGroup(queryClient);
        throw error;
      }

      optimisticallyRemoveVisitsFromPending(queryClient, [visitId]);

      return { rollbackBaseline, refreshNeedsReconciliation };
    },
    onError: async (_err, { visitId }, context) => {
      await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      restoreFailedVisitsToPending(
        queryClient,
        context?.rollbackBaseline,
        pendingReviewMutationIdsEligibleForRollback(queryClient, [visitId]),
      );
      // Failures are rare; reconcile canonically so overlapping status work
      // cannot leave an optimistic rollback as the final source of truth.
      await settleOptimisticPendingReviewMutation(queryClient, true);
    },
    onSuccess: async (_data, variables, context) => {
      const refreshNeedsReconciliation = await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      // Reapply the exact postcondition after an earlier serialized rollback.
      markPendingReviewMutationIdsSuccessful(queryClient, [variables.visitId]);
      optimisticallyRemoveVisitsFromPending(queryClient, [variables.visitId]);
      await settleOptimisticPendingReviewMutation(queryClient, refreshNeedsReconciliation);
      invalidateVisitStatusQueries(queryClient);
      // Track analytics
      logVisitConfirmed(parseInt(variables.visitId, 10) || 0);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context) {
        finishPendingReviewMutationGroup(queryClient);
      }
    },
  });
}

/**
 * Batch confirm multiple visits with their matched restaurants
 * Uses optimistic updates for instant UI feedback, then reconciles all status-derived caches.
 * Looks up and stores the historical Michelin award at the time of each visit
 */
export function useBatchConfirmVisits() {
  const queryClient = useQueryClient();

  return useMutation({
    scope: REVIEW_STATUS_MUTATION_SCOPE,
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
      const awardAtVisitByIndex = new Map<number, string | null>();
      const michelinConfirmationsByYear = new Map<
        number,
        Array<{ index: number; restaurantId: string; startTime: number }>
      >();

      for (const [index, c] of confirmations.entries()) {
        if (!c.restaurantId.startsWith("michelin-")) {
          continue;
        }
        const visitYear = new Date(c.startTime).getFullYear();
        const yearGroup = michelinConfirmationsByYear.get(visitYear);
        const entry = { index, restaurantId: c.restaurantId, startTime: c.startTime };
        if (yearGroup) {
          yearGroup.push(entry);
        } else {
          michelinConfirmationsByYear.set(visitYear, [entry]);
        }
      }

      await Promise.all(
        Array.from(michelinConfirmationsByYear.values()).map(async (yearGroup) => {
          const restaurantIds = [...new Set(yearGroup.map((c) => c.restaurantId))];
          const awardsByRestaurantId = await getAwardForDate(restaurantIds, yearGroup[0].startTime);
          for (const c of yearGroup) {
            awardAtVisitByIndex.set(c.index, awardsByRestaurantId[c.restaurantId] ?? null);
          }
        }),
      );

      const confirmationsWithAwards = confirmations.map((c, index) => ({
        ...c,
        awardAtVisit: awardAtVisitByIndex.get(index) ?? null,
      }));
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
      const refreshNeedsReconciliation = pendingReviewRefreshNeedsReconciliation(queryClient);
      const rollbackBaseline = beginPendingReviewMutationGroup(queryClient);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.pendingReview });
      } catch (error) {
        finishPendingReviewMutationGroup(queryClient);
        throw error;
      }

      optimisticallyRemoveVisitsFromPending(
        queryClient,
        confirmations.map((c) => c.visitId),
      );

      return { rollbackBaseline, refreshNeedsReconciliation };
    },
    onError: async (_err, confirmations, context) => {
      await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      const visitIds = confirmations.map((confirmation) => confirmation.visitId);
      restoreFailedVisitsToPending(
        queryClient,
        context?.rollbackBaseline,
        pendingReviewMutationIdsEligibleForRollback(queryClient, visitIds),
      );
      await settleOptimisticPendingReviewMutation(queryClient, true);
    },
    onSuccess: async (_data, confirmations, context) => {
      const refreshNeedsReconciliation = await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      const visitIds = confirmations.map((confirmation) => confirmation.visitId);
      markPendingReviewMutationIdsSuccessful(queryClient, visitIds);
      optimisticallyRemoveVisitsFromPending(queryClient, visitIds);
      await settleOptimisticPendingReviewMutation(queryClient, refreshNeedsReconciliation);
      // Merging duplicates may affect confirmed visits, stats, and cleanup queries.
      invalidateVisitStatusQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.mergeableSameRestaurantVisits });
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context) {
        finishPendingReviewMutationGroup(queryClient);
      }
    },
  });
}

/**
 * Exact calendar match - visit where the calendar event matches a Michelin restaurant
 */
export interface ExactCalendarMatch extends PendingVisitReviewExactConfirmation {
  visit: PendingVisitForReview;
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
  events: readonly ImportableCalendarEvent[];
  /** Map of calendarEventId -> restaurantId to use instead of the default matched restaurant */
  restaurantOverrides?: ReadonlyMap<string, string>;
}

/**
 * Import calendar events as visits
 */
export function useImportCalendarEvents() {
  const queryClient = useQueryClient();

  return useMutation({
    scope: { id: "calendar-import" },
    mutationFn: (input: ImportCalendarEventsInput) =>
      importCalendarEvents(input.events, {
        restaurantOverrides: input.restaurantOverrides,
      }),
    onMutate: async (input) => {
      const calendarEventIds = getUniqueCalendarImportEventIds(input.events);

      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.importableCalendarEvents });

      // Snapshot the previous value for rollback
      const previousEvents = queryClient.getQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents);

      // Optimistically remove the imported events from the list
      optimisticallyRemoveImportableCalendarEvents(queryClient, calendarEventIds);

      return { previousEvents, calendarEventIds };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, (current) =>
        reconcileCalendarImportCache(current, context?.previousEvents, context?.calendarEventIds ?? [], []),
      );
    },
    onSuccess: (result, _input, context) => {
      queryClient.setQueryData<ImportableCalendarEvent[]>(queryKeys.importableCalendarEvents, (current) =>
        reconcileCalendarImportCache(
          current,
          context?.previousEvents,
          context?.calendarEventIds ?? [],
          result.insertedCalendarEventIds,
        ),
      );
      // Stats are intentionally not optimistic: exact inserted cardinality is
      // unknown until SQLite resolves conflicts. This invalidation loads the
      // canonical count for zero, partial, and complete outcomes.
      invalidateReservationImportQueries(queryClient);
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

/**
 * Fetch the user's full past Resy reservation history for manual review.
 */
export function useFetchResyVisitHistory(onProgress?: (progress: ResyImportProgress) => void) {
  return useMutation({
    mutationFn: (authToken: string) => fetchResyVisitHistory(authToken, { onProgress }),
  });
}

/**
 * Remove provider reservations that already map to confirmed visits before review.
 */
export function useFilterProviderReservationReviewCandidates(sourceDisplayName: string) {
  return useMutation<ReservationReviewFilterResult, Error, ImportableReservation[]>({
    mutationFn: (reservations: ImportableReservation[]) =>
      filterProviderReservationReviewCandidates(reservations, { sourceDisplayName }),
  });
}

/**
 * Dismiss provider reservations so they do not reappear in manual import review.
 */
export function useDismissProviderReservations() {
  return useMutation<void, Error, ImportableReservation[]>({
    mutationFn: (reservations: ImportableReservation[]) => excludeReservationImportReviews(reservations, "dismissed"),
  });
}

/**
 * Import manually approved provider reservations as confirmed visits.
 */
export function useImportProviderReservations(sourceDisplayName: string) {
  const queryClient = useQueryClient();

  return useMutation<ReservationImportResult, Error, ImportableReservation[]>({
    mutationFn: async (reservations: ImportableReservation[]) => {
      const result = await importReservationVisitHistory(reservations, {
        sourceDisplayName,
        fetchedCount: reservations.length,
        invalidCount: 0,
      });
      await excludeReservationImportReviews(reservations, "approved");
      return result;
    },
    onSuccess: () => {
      invalidateReservationImportQueries(queryClient);
    },
  });
}

/**
 * Import the user's full past Resy reservation history as confirmed visits.
 */
export function useImportResyVisitHistory(onProgress?: (progress: ResyImportProgress) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (authToken: string) => importResyVisitHistory(authToken, { onProgress }),
    onSuccess: () => {
      invalidateReservationImportQueries(queryClient);
    },
  });
}

/**
 * Import the user's full past Tock reservation history as confirmed visits.
 */
export function useImportTockVisitHistory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: unknown) => importTockVisitHistory(payload),
    onSuccess: () => {
      invalidateReservationImportQueries(queryClient);
    },
  });
}

/**
 * Import the user's full past OpenTable reservation history as confirmed visits.
 */
export function useImportOpenTableVisitHistory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: unknown) => importOpenTableVisitHistory(payload),
    onSuccess: () => {
      invalidateReservationImportQueries(queryClient);
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
      if (format === "json") {
        return exportAndShareJSON({ statusFilter: "confirmed" });
      }
      const data = await exportToCSV({ statusFilter: "confirmed" });
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
    scope: REVIEW_STATUS_MUTATION_SCOPE,
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
      invalidateVisitStatusQueries(queryClient);
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
    onSuccess: async (notes) => {
      queryClient.setQueryData<VisitDetail | null>(queryKeys.visitDetail(visitId ?? ""), (old) =>
        old ? { ...old, visit: { ...old.visit, notes } } : old,
      );
      await invalidatePendingReviewQuery(queryClient);
    },
  });
}

/**
 * Quick status update mutation
 * Keeps the exact optimistic Review result visible and marks it stale without refetching.
 */
export function useQuickUpdateVisitStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    scope: REVIEW_STATUS_MUTATION_SCOPE,
    mutationFn: async ({ visitId, newStatus }: { visitId: string; newStatus: VisitStatus }) => {
      await updateVisitStatus(visitId, newStatus);
      return { visitId, newStatus };
    },
    onMutate: async ({ visitId, newStatus }) => {
      const refreshNeedsReconciliation = pendingReviewRefreshNeedsReconciliation(queryClient);
      const rollbackBaseline = newStatus === "pending" ? undefined : beginPendingReviewMutationGroup(queryClient);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.pendingReview });
      } catch (error) {
        if (newStatus !== "pending") {
          finishPendingReviewMutationGroup(queryClient);
        }
        throw error;
      }

      if (newStatus !== "pending") {
        // Optimistically remove from pending review list
        optimisticallyRemoveVisitsFromPending(queryClient, [visitId]);
      }

      return { rollbackBaseline, mutationGroupStarted: newStatus !== "pending", refreshNeedsReconciliation };
    },
    onError: async (_err, { visitId, newStatus }, context) => {
      await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      if (newStatus !== "pending") {
        restoreFailedVisitsToPending(
          queryClient,
          context?.rollbackBaseline,
          pendingReviewMutationIdsEligibleForRollback(queryClient, [visitId]),
        );
      }
      await settleOptimisticPendingReviewMutation(queryClient, true);
    },
    onSuccess: async (_data, { visitId, newStatus }, context) => {
      const refreshNeedsReconciliation = await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      if (newStatus === "pending") {
        await invalidatePendingReviewQuery(queryClient);
      } else {
        markPendingReviewMutationIdsSuccessful(queryClient, [visitId]);
        optimisticallyRemoveVisitsFromPending(queryClient, [visitId]);
        await settleOptimisticPendingReviewMutation(queryClient, refreshNeedsReconciliation);
      }
      invalidateVisitStatusQueries(queryClient);
      if (newStatus === "confirmed") {
        logVisitConfirmed(parseInt(visitId, 10) || 0);
      } else if (newStatus === "rejected") {
        logVisitRejected(parseInt(visitId, 10) || 0);
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.mutationGroupStarted) {
        finishPendingReviewMutationGroup(queryClient);
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
    scope: REVIEW_STATUS_MUTATION_SCOPE,
    mutationFn: async ({ visitId }: { visitId: string }) => {
      await updateVisitStatus(visitId, "pending");
      return { visitId };
    },
    onSuccess: async () => {
      // Refetch the pending review list to restore the visit
      await invalidatePendingReviewQuery(queryClient);
      invalidateVisitStatusQueries(queryClient);
    },
  });
}

/**
 * Batch update visit statuses - for bulk operations
 * Keeps the exact optimistic Review result visible and marks it stale without refetching.
 */
export function useBatchUpdateVisitStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    scope: REVIEW_STATUS_MUTATION_SCOPE,
    mutationFn: async ({ visitIds, newStatus }: { visitIds: string[]; newStatus: VisitStatus }) => {
      const uniqueVisitIds = [...new Set(visitIds)];
      await batchUpdateVisitStatuses(uniqueVisitIds, newStatus);
      return { visitIds: uniqueVisitIds, newStatus };
    },
    onMutate: async ({ visitIds, newStatus }) => {
      const refreshNeedsReconciliation = pendingReviewRefreshNeedsReconciliation(queryClient);
      const rollbackBaseline = newStatus === "pending" ? undefined : beginPendingReviewMutationGroup(queryClient);
      try {
        await queryClient.cancelQueries({ queryKey: queryKeys.pendingReview });
      } catch (error) {
        if (newStatus !== "pending") {
          finishPendingReviewMutationGroup(queryClient);
        }
        throw error;
      }

      if (newStatus !== "pending") {
        optimisticallyRemoveVisitsFromPending(queryClient, visitIds);
      }

      return { rollbackBaseline, mutationGroupStarted: newStatus !== "pending", refreshNeedsReconciliation };
    },
    onError: async (_err, { visitIds, newStatus }, context) => {
      await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      if (newStatus !== "pending") {
        restoreFailedVisitsToPending(
          queryClient,
          context?.rollbackBaseline,
          pendingReviewMutationIdsEligibleForRollback(queryClient, visitIds),
        );
      }
      await settleOptimisticPendingReviewMutation(queryClient, true);
    },
    onSuccess: async (data, { newStatus }, context) => {
      const refreshNeedsReconciliation = await interruptPendingReviewRefreshForMutationSettlement(
        queryClient,
        context?.refreshNeedsReconciliation ?? false,
      );
      if (newStatus === "pending") {
        await invalidatePendingReviewQuery(queryClient);
      } else {
        markPendingReviewMutationIdsSuccessful(queryClient, data.visitIds);
        optimisticallyRemoveVisitsFromPending(queryClient, data.visitIds);
        await settleOptimisticPendingReviewMutation(queryClient, refreshNeedsReconciliation);
      }
      // Reconcile every status-derived cache with the atomic database result.
      // This also handles duplicate/missing IDs after the optimistic update.
      invalidateVisitStatusQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.mutationGroupStarted) {
        finishPendingReviewMutationGroup(queryClient);
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
    onSettled: (_data, _error, { targetVisitId }) => {
      invalidateVisitQueries(queryClient);
      invalidateVisitStatusQueries(queryClient);
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
    onSettled: () => {
      // Invalidate all visit-related queries
      invalidateVisitQueries(queryClient);
      invalidateVisitStatusQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.mergeableSameRestaurantVisits });
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
      void invalidateVisitListPageQueries(queryClient);
      // Invalidate restaurant visits to show the new visit
      queryClient.invalidateQueries({ queryKey: queryKeys.restaurantVisits(restaurantId) });
      // Invalidate confirmed restaurants list (visit count changed)
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      // Invalidate stats
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      // Invalidate wrapped stats (invalidates all years)
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
      invalidateMichelinRestaurantSearch(queryClient);
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
    scope: REVIEW_STATUS_MUTATION_SCOPE,
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
    onSettled: async () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ignoredLocations });
      await invalidatePendingReviewQuery(queryClient);
      invalidateVisitStatusQueries(queryClient);
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
  return useQuery({
    queryKey: queryKeys.restaurantDetail(restaurantId ?? ""),
    queryFn: () => getRestaurantDisplayById(restaurantId!),
    enabled: !!restaurantId,
  });
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
    onSuccess: async (data) => {
      if (data.name !== undefined) {
        await invalidatePendingReviewQuery(queryClient);
      }
    },
    onSettled: () => {
      void invalidateVisitListPageQueries(queryClient);
      // Refetch to ensure consistency with server
      queryClient.invalidateQueries({ queryKey: queryKeys.confirmedRestaurants });
      if (restaurantId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.restaurantDetail(restaurantId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.restaurantVisits(restaurantId) });
      }
      invalidateWrappedStatsQueries(queryClient);
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
    mutationFn: (photos?: Array<{ id: string }>) =>
      deepScanAllPhotosForFood({ photos, onProgress: (p) => onProgressRef.current?.(p) }),
    onSettled: () => {
      invalidateFoodDetectionQueries(queryClient);
    },
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
    onSettled: () => {
      invalidateFoodDetectionQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(visitId ?? "") });
      queryClient.invalidateQueries({ queryKey: queryKeys.visitPhotos(visitId ?? "") });
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
      if (lat === undefined || lon === undefined || !isValidCoordinatePair(lat, lon)) {
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
        throw error;
      }
    },
    enabled: enabled && lat !== undefined && lon !== undefined && isValidCoordinatePair(lat, lon),
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 2000),
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
      if (results.createdEvents.length > 0) {
        const updates = results.createdEvents.map(({ inputIndex, visitId, eventId }) => {
          const visit = visits[inputIndex];
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
      void invalidateVisitListPageQueries(queryClient);
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
        const visitIdsToUpdate = selectCalendarMutationSuccessfulItems(events, results.successfulInputIndices).map(
          (event) => event.visitId,
        );
        await clearExportedCalendarEvents(visitIdsToUpdate);
      }

      return results;
    },
    onSuccess: () => {
      // Invalidate queries to refresh the lists
      queryClient.invalidateQueries({ queryKey: queryKeys.exportedCalendarEvents });
      queryClient.invalidateQueries({ queryKey: queryKeys.visitsWithoutCalendarEvents });
      void invalidateVisitListPageQueries(queryClient);
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
      void invalidateVisitListPageQueries(queryClient);
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
    onSettled: () => {
      // Invalidate visit-related queries to reflect new suggestions
      void invalidateVisitListPageQueries(queryClient);
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
    onSettled: (_result, _error, _vars) => {
      void invalidateVisitListPageQueries(queryClient);
      // Invalidate visit detail query for this visit
      if (visitId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(visitId) });
      }
      // Also invalidate any affected source visits and general queries
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
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
    onSettled: (_result, _error, _vars) => {
      void invalidateVisitListPageQueries(queryClient);
      // Invalidate visit detail query for this visit
      if (visitId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.visitDetail(visitId) });
      }
      // Also invalidate general queries
      invalidateVisitQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: ["wrapped"] });
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
