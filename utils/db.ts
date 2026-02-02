export type {
  CalendarEventUpdate,
  ExportedCalendarEvent,
  FoodKeywordRecord,
  FoodLabel,
  IgnoredLocationRecord,
  MergeableVisitGroup,
  MichelinRestaurantRecord,
  MovePhotosResult,
  PendingVisitForReview,
  PhotoRecord,
  ReclassifyProgress,
  RemovePhotosResult,
  RestaurantRecord,
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
  getUnanalyzedPhotoIds,
  getUnvisitedPhotos,
  getVisitablePhotoCounts,
  insertPhotos,
} from "./db/photos";

export { batchUpdatePhotoVisits, movePhotosToVisit, removePhotosFromVisit } from "./db/photo-association";

export {
  batchUpdateVisitPhotoCounts,
  confirmVisit,
  createManualVisit,
  getVisitById,
  getVisitPhotoSamples,
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
  getRestaurantById,
  updateRestaurant,
} from "./db/restaurants";

export { getAllMichelinRestaurants, getMichelinRestaurantCount, insertMichelinRestaurants } from "./db/michelin";

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
  dismissCalendarEvents,
  getConfirmedVisitsWithMichelinIds,
  getConfirmedVisitsWithoutCalendarEvents,
  getDismissedCalendarEventIds,
  getLinkedCalendarEventIds,
  getVisitsWithExportedCalendarEvents,
  getVisitsWithoutCalendarData,
  insertCalendarOnlyVisits,
} from "./db/calendar";

export { getStats, getWrappedStats } from "./db/stats";

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
