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
  VisitForCalendarExport,
  VisitRecord,
  VisitSuggestedRestaurant,
  VisitWithDetails,
  WrappedStats,
} from "./db/types";

export { getDatabase, nukeDatabase, performDatabaseMaintenance, performFullMaintenance } from "./db/core";

export {
  batchUpdatePhotosFoodDetected,
  getPhotosByAssetIds,
  getPhotosByVisitId,
  getTotalPhotoCount,
  getUnanalyzedPhotoCount,
  getUnanalyzedPhotoIds,
  getUnvisitedPhotos,
  getVisitablePhotoCounts,
  insertPhotos,
} from "./db/photos";

export { batchUpdatePhotoVisits, movePhotosToVisit, removePhotosFromVisit } from "./db/photo-association";

export {
  batchUpdateVisitPhotoCounts,
  batchConfirmVisits,
  confirmVisit,
  createManualVisit,
  getVisitById,
  getVisitPhotoSamples,
  getRestaurantVisitsWithPreviews,
  getVisits,
  getVisitsByRestaurantId,
  getVisitsNeedingFoodDetection,
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
  getMichelinRestaurantById,
  getMichelinRestaurantCount,
  insertMichelinRestaurants,
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
