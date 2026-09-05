import type { FilterType } from "@/utils/query-keys";

/** The complete persisted state, separate from scan progress, UI state, and actions. */
export interface AppPreferences {
  visitsFilter: FilterType;
  reviewFoodFilter: "on" | "off";
  reviewCalendarMatchesFilter: "on" | "off";
  reviewRestaurantMatchesFilter: "on" | "off";
  reviewStarFilter: "any" | "1plus" | "2plus" | "3";
  reviewFiltersCollapsed: boolean;
  hasCompletedOnboarding: boolean;
  hasCompletedInitialScan: boolean;
  googleMapsApiKey: string | null;
  /** null means sync all calendars; an empty array means sync none. */
  selectedCalendarIds: string[] | null;
  hasSeenAddPhotosAlert: boolean;
  hideUndoBar: boolean;
  fastAnimations: boolean;
}

/** Fresh defaults for both first launch and a full user-requested reset. */
export function createDefaultAppPreferences(): AppPreferences {
  return {
    visitsFilter: "all",
    reviewFoodFilter: "on",
    reviewCalendarMatchesFilter: "on",
    reviewRestaurantMatchesFilter: "on",
    reviewStarFilter: "any",
    reviewFiltersCollapsed: true,
    hasCompletedOnboarding: false,
    hasCompletedInitialScan: false,
    googleMapsApiKey: null,
    selectedCalendarIds: null,
    hasSeenAddPhotosAlert: false,
    hideUndoBar: false,
    fastAnimations: false,
  };
}

/** Preserve the established on-disk fields and ordering, excluding transient state. */
export function selectAppPreferences(state: AppPreferences): AppPreferences {
  return {
    visitsFilter: state.visitsFilter,
    reviewFoodFilter: state.reviewFoodFilter,
    reviewCalendarMatchesFilter: state.reviewCalendarMatchesFilter,
    reviewRestaurantMatchesFilter: state.reviewRestaurantMatchesFilter,
    reviewStarFilter: state.reviewStarFilter,
    reviewFiltersCollapsed: state.reviewFiltersCollapsed,
    hasCompletedOnboarding: state.hasCompletedOnboarding,
    hasCompletedInitialScan: state.hasCompletedInitialScan,
    googleMapsApiKey: state.googleMapsApiKey,
    selectedCalendarIds: state.selectedCalendarIds,
    hasSeenAddPhotosAlert: state.hasSeenAddPhotosAlert,
    hideUndoBar: state.hideUndoBar,
    fastAnimations: state.fastAnimations,
  };
}
