export type {
  CalendarEventUpdate,
  ExportedCalendarEvent,
  FoodKeywordRecord,
  FoodLabel,
  IgnoredLocationRecord,
  MergeableVisitGroup,
  MichelinRestaurantRecord,
  MichelinStatsBucket,
  MichelinStatsRestaurantSummary,
  MovePhotosResult,
  PendingVisitForReview,
  PhotoRecord,
  RestaurantVisitWithPreview,
  ReclassifyProgress,
  RemovePhotosResult,
  RestaurantRecord,
  ReservationOnlyRestaurantInput,
  ReservationOnlyVisitImportResult,
  ReservationOnlyVisitInput,
  RestaurantWithVisits,
  UpdateRestaurantData,
  UnvisitedPhotoRecord,
  VisitForCalendarExport,
  VisitRecord,
  VisitSuggestedRestaurant,
  VisitWithDetails,
  WrappedStats,
} from "./db/types";

export { getDatabase, nukeDatabase, performDatabaseMaintenance, performFullMaintenance } from "./db/core";

export {
  batchUpdatePhotosFoodDetected,
  getExportPhotoCountsByVisitIds,
  getExistingPhotoAssetIdsForIncrementalScan,
  getPhotoDatabasePathForIncrementalScan,
  getPhotosByAssetIds,
  getPhotosByVisitId,
  getPhotosByVisitIdsPage,
  getTotalPhotoCount,
  getUnanalyzedPhotoCount,
  getUnanalyzedPhotoIds,
  getUnvisitedPhotos,
  getVisitablePhotoCounts,
  insertPhotos,
} from "./db/photos";

export { batchUpdatePhotoVisits, movePhotosToVisit, removePhotosFromVisit } from "./db/photo-association";

export {
  batchUpdateVisitStatuses,
  batchUpdateVisitPhotoCounts,
  batchConfirmVisits,
  confirmVisit,
  createManualVisit,
  getFoodDetectionVisitSamplePlan,
  getVisitListPage,
  getVisitById,
  getRestaurantVisitsWithPreviews,
  getVisits,
  getVisitsByRestaurantId,
  getVisitsWithDetails,
  insertVisits,
  syncAllVisitsFoodProbable,
  updateVisitNotes,
  updateVisitStatus,
} from "./db/visits";

export type { VisitListCursor, VisitListFilter, VisitListItem, VisitListPage } from "./db/visit-list-paging-core";

export {
  getPendingQuickActionsData,
  getPendingVisitReviewFirstPage,
  getPendingVisitReviewPage,
  getPendingVisitsForReview,
} from "./db/visit-review";

export type {
  PendingQuickActionExactMatch,
  PendingQuickActionSuggestion,
  PendingQuickActionVisit,
  PendingQuickActionsData,
  PendingVisitReviewProgressivePage,
} from "./db/visit-review";
export type {
  PendingVisitReviewExactConfirmation,
  PendingVisitReviewFilters,
  PendingVisitReviewGeneration,
  PendingVisitReviewGenerationRecord,
  PendingVisitReviewPageRequest,
} from "./db/visit-review-paging-core";

export type { ConfirmedRestaurantSearchRow } from "./db/confirmed-restaurant-search-core";

export {
  batchUpdateVisitSuggestedRestaurants,
  getSuggestedRestaurantsForVisits,
  insertVisitSuggestedRestaurants,
  recomputeSuggestedRestaurants,
  recomputeSuggestedRestaurantsIfNeeded,
} from "./db/visit-suggestions";

export {
  getAllRestaurants,
  getConfirmedRestaurantSearchRows,
  getConfirmedRestaurantsWithVisits,
  getRestaurantDisplayById,
  getRestaurantById,
  updateRestaurant,
} from "./db/restaurants";

export {
  getActiveMichelinUnicodeNameRows,
  getAllMichelinRestaurants,
  getMichelinMapViewport,
  getMichelinImportResolution,
  getImportedMichelinDatasetVersion,
  getMichelinRestaurantsForCalendarNormalizedNames,
  getMichelinRestaurantById,
  getMichelinRestaurantCount,
  hydrateUnvisitedMichelinNameSearchIds,
  insertMichelinRestaurants,
  importMichelinRestaurantsFromAttachedSource,
  selectMichelinProviderSpatialCandidates,
  searchUnvisitedMichelinRestaurantsByName,
} from "./db/michelin";

export type { MichelinUnicodeNameIndexRow, MichelinUnicodeNameRow } from "./db/michelin-name-search-core";

export type {
  MichelinMapAwardFilter,
  MichelinMapVisitStatusFilter,
  MichelinMapViewportRequest,
  MichelinMapViewportRestaurant,
  MichelinMapViewportSelection,
} from "./db/michelin-map-viewport-core";

export {
  addIgnoredLocation,
  getIgnoredLocations,
  rejectVisitsInIgnoredLocations,
  removeIgnoredLocation,
} from "./db/ignored-locations";

export {
  batchUpdateVisitCalendarEvents,
  batchUpdateVisitsCalendarEvents,
  clearExportedCalendarEvents,
  excludeReservationImportReviews,
  dismissReservationImportSources,
  dismissCalendarEvents,
  getConfirmedVisitsWithMichelinIds,
  getConfirmedVisitsWithoutCalendarEvents,
  getCalendarEnrichmentVisitSnapshot,
  getConfirmedLinkedReservationSourceEventIds,
  getDismissedReservationImportSourceEventIds,
  getDismissedCalendarEventIds,
  getExcludedReservationImportReviewSourceEventIds,
  getLinkedCalendarEventIds,
  getProviderReservationReviewPrefilterSnapshot,
  getReservationImportCandidatesMappedToConfirmedRestaurantDateSourceIds,
  getReservationOnlyVisitsMappedToConfirmedVisitSourceIds,
  getVisitsWithExportedCalendarEvents,
  getVisitsWithoutCalendarData,
  insertCalendarOnlyVisits,
  importCalendarSnapshotPlan,
  insertReservationOnlyVisits,
} from "./db/calendar";

export type { ReservationOnlyVisitPersistenceOptions, ReservationOnlyVisitPersistenceStrategy } from "./db/calendar";
export type {
  ReservationReviewPrefilterCandidate,
  ReservationReviewPrefilterSnapshot,
} from "./db/reservation-review-prefilter-core";

export { getMichelinRestaurantsForStatsBucket, getStats, getWrappedStats } from "./db/stats";

export {
  addFoodKeyword,
  getAllFoodKeywords,
  getEnabledFoodKeywords,
  getPhotosWithLabelsCount,
  removeFoodKeyword,
  reclassifyPhotosWithCurrentKeywords,
  resetFoodKeywordsToDefaults,
  toggleFoodKeyword,
} from "./db/food-keywords";

export {
  batchMergeSameRestaurantVisits,
  getMergeableSameRestaurantVisitGroups,
  getMergeableVisits,
  mergeVisits,
} from "./db/merge";
