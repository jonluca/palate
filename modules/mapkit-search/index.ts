// Reexport the native module
export {
  isMapKitSearchAvailable,
  searchNearbyRestaurants,
  searchByText,
  clearSearchCache,
  getSearchCacheStats,
  type MapKitSearchResult,
} from "./src/index";
