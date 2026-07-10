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

export { getPendingVisitsForReview } from "./db/visit-review";

export {
  batchUpdateVisitSuggestedRestaurants,
  getSuggestedRestaurantsForVisits,
  insertVisitSuggestedRestaurants,
  recomputeSuggestedRestaurants,
  recomputeSuggestedRestaurantsIfNeeded,
} from "./db/visit-suggestions";

export {
  getAllRestaurants,
  getConfirmedRestaurantsWithVisits,
  getRestaurantDisplayById,
  getRestaurantById,
  updateRestaurant,
} from "./db/restaurants";

export {
  getAllMichelinRestaurants,
  getImportedMichelinDatasetVersion,
  getMichelinRestaurantsForCalendarNormalizedNames,
  getMichelinRestaurantById,
  getMichelinRestaurantCount,
  insertMichelinRestaurants,
  selectMichelinProviderSpatialCandidates,
  searchUnvisitedMichelinRestaurantsByName,
} from "./db/michelin";

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
  getConfirmedLinkedReservationSourceEventIds,
  getDismissedReservationImportSourceEventIds,
  getDismissedCalendarEventIds,
  getExcludedReservationImportReviewSourceEventIds,
  getLinkedCalendarEventIds,
  getReservationImportCandidatesMappedToConfirmedRestaurantDateSourceIds,
  getReservationOnlyVisitsMappedToConfirmedVisitSourceIds,
  getVisitsWithExportedCalendarEvents,
  getVisitsWithoutCalendarData,
  insertCalendarOnlyVisits,
  insertReservationOnlyVisits,
} from "./db/calendar";

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
