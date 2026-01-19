import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "expo-sqlite/kv-store";
import type { FilterType } from "@/hooks/queries";

// Review filter types
export type ReviewFoodFilter = "on" | "off";
export type ReviewMatchesFilter = "on" | "off";
export type ReviewStarFilter = "any" | "1plus" | "2plus" | "3";

// Scan progress state
interface ScanProgress {
  phase: "idle" | "scanning" | "analyzing-visits" | "enriching" | "complete" | "error";
  detail: string;
  photosPerSecond?: number;
  eta?: string;
}

// App store state
interface AppState {
  // Hydration state (not persisted)
  hasHydrated: boolean;
  setHasHydrated: (hydrated: boolean) => void;

  // Visits filter
  visitsFilter: FilterType;
  setVisitsFilter: (filter: FilterType) => void;

  // Review filters
  reviewFoodFilter: ReviewFoodFilter;
  setReviewFoodFilter: (filter: ReviewFoodFilter) => void;
  reviewMatchesFilter: ReviewMatchesFilter;
  setReviewMatchesFilter: (filter: ReviewMatchesFilter) => void;
  reviewStarFilter: ReviewStarFilter;
  setReviewStarFilter: (filter: ReviewStarFilter) => void;
  reviewFiltersCollapsed: boolean;
  setReviewFiltersCollapsed: (collapsed: boolean) => void;

  // Onboarding state (persisted)
  hasCompletedOnboarding: boolean;
  setHasCompletedOnboarding: (completed: boolean) => void;

  // Scan completed state (persisted)
  hasCompletedInitialScan: boolean;
  setHasCompletedInitialScan: (completed: boolean) => void;

  // Google Maps API key (persisted)
  googleMapsApiKey: string | null;
  setGoogleMapsApiKey: (key: string | null) => void;

  // Selected calendars for syncing (persisted) - null means sync all
  selectedCalendarIds: string[] | null;
  setSelectedCalendarIds: (ids: string[] | null) => void;

  // Scan state
  isScanning: boolean;
  scanProgress: ScanProgress;
  startScan: () => void;
  updateScanProgress: (progress: Partial<ScanProgress>) => void;
  completeScan: (message: string) => void;
  failScan: (message: string) => void;
  resetScan: () => void;

  // UI state
  selectedVisitId: string | null;
  setSelectedVisitId: (id: string | null) => void;

  // Restaurant search modal
  isRestaurantSearchOpen: boolean;
  restaurantSearchVisitId: string | null;
  openRestaurantSearch: (visitId: string) => void;
  closeRestaurantSearch: () => void;

  // Full reset
  resetAllState: () => void;
}

const initialScanProgress: ScanProgress = {
  phase: "idle",
  detail: "",
  photosPerSecond: undefined,
  eta: undefined,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // Hydration state (not persisted)
      hasHydrated: false,
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),

      // Visits filter
      visitsFilter: "all",
      setVisitsFilter: (filter) => set({ visitsFilter: filter }),

      // Review filters
      reviewFoodFilter: "on",
      setReviewFoodFilter: (filter) => set({ reviewFoodFilter: filter }),
      reviewMatchesFilter: "on",
      setReviewMatchesFilter: (filter) => set({ reviewMatchesFilter: filter }),
      reviewStarFilter: "any",
      setReviewStarFilter: (filter) => set({ reviewStarFilter: filter }),
      reviewFiltersCollapsed: true,
      setReviewFiltersCollapsed: (collapsed) => set({ reviewFiltersCollapsed: collapsed }),

      // Onboarding state (persisted)
      hasCompletedOnboarding: false,
      setHasCompletedOnboarding: (completed) => set({ hasCompletedOnboarding: completed }),

      // Scan completed state (persisted)
      hasCompletedInitialScan: false,
      setHasCompletedInitialScan: (completed) => set({ hasCompletedInitialScan: completed }),

      // Google Maps API key (persisted)
      googleMapsApiKey: null,
      setGoogleMapsApiKey: (key) => set({ googleMapsApiKey: key }),

      // Selected calendars for syncing (persisted) - null means sync all
      selectedCalendarIds: null,
      setSelectedCalendarIds: (ids) => set({ selectedCalendarIds: ids }),

      // Scan state
      isScanning: false,
      scanProgress: initialScanProgress,

      startScan: () =>
        set({
          isScanning: true,
          scanProgress: {
            phase: "scanning",
            detail: "Starting scan...",
            photosPerSecond: undefined,
            eta: undefined,
          },
        }),

      updateScanProgress: (progress: Partial<ScanProgress>) =>
        set((state) => ({
          scanProgress: { ...state.scanProgress, ...progress },
        })),

      completeScan: (message: string) =>
        set({
          isScanning: false,
          hasCompletedInitialScan: true,
          scanProgress: {
            phase: "complete",
            detail: message,
            photosPerSecond: undefined,
            eta: undefined,
          },
        }),

      failScan: (message: string) =>
        set({
          isScanning: false,
          scanProgress: {
            phase: "error",
            detail: message,
            photosPerSecond: undefined,
            eta: undefined,
          },
        }),

      resetScan: () =>
        set({
          isScanning: false,
          scanProgress: initialScanProgress,
        }),

      // UI state
      selectedVisitId: null as string | null,
      setSelectedVisitId: (id: string | null) => set({ selectedVisitId: id }),

      // Restaurant search modal
      isRestaurantSearchOpen: false,
      restaurantSearchVisitId: null as string | null,

      openRestaurantSearch: (visitId: string) =>
        set({
          isRestaurantSearchOpen: true,
          restaurantSearchVisitId: visitId,
        }),

      closeRestaurantSearch: () =>
        set({
          isRestaurantSearchOpen: false,
          restaurantSearchVisitId: null,
        }),

      // Reset all state to initial values
      resetAllState: () =>
        set({
          visitsFilter: "all",
          reviewFoodFilter: "on",
          reviewMatchesFilter: "on",
          reviewStarFilter: "any",
          reviewFiltersCollapsed: true,
          hasCompletedOnboarding: false,
          hasCompletedInitialScan: false,
          selectedCalendarIds: null,
          isScanning: false,
          scanProgress: initialScanProgress,
          selectedVisitId: null,
          isRestaurantSearchOpen: false,
          restaurantSearchVisitId: null,
        }),
    }),
    {
      name: "app-store", // unique name for the storage key
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist user preferences, not transient UI state
      partialize: (state): Partial<AppState> => ({
        visitsFilter: state.visitsFilter,
        reviewFoodFilter: state.reviewFoodFilter,
        reviewMatchesFilter: state.reviewMatchesFilter,
        reviewStarFilter: state.reviewStarFilter,
        reviewFiltersCollapsed: state.reviewFiltersCollapsed,
        hasCompletedOnboarding: state.hasCompletedOnboarding,
        hasCompletedInitialScan: state.hasCompletedInitialScan,
        googleMapsApiKey: state.googleMapsApiKey,
        selectedCalendarIds: state.selectedCalendarIds,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

// Selector hooks for better performance (avoid re-renders when unrelated state changes)
export const useHasHydrated = () => useAppStore((state) => state.hasHydrated);

export const useVisitsFilter = () => useAppStore((state) => state.visitsFilter);
export const useSetVisitsFilter = () => useAppStore((state) => state.setVisitsFilter);

export const useReviewFoodFilter = () => useAppStore((state) => state.reviewFoodFilter);
export const useSetReviewFoodFilter = () => useAppStore((state) => state.setReviewFoodFilter);
export const useReviewMatchesFilter = () => useAppStore((state) => state.reviewMatchesFilter);
export const useSetReviewMatchesFilter = () => useAppStore((state) => state.setReviewMatchesFilter);
export const useReviewStarFilter = () => useAppStore((state) => state.reviewStarFilter);
export const useSetReviewStarFilter = () => useAppStore((state) => state.setReviewStarFilter);
export const useReviewFiltersCollapsed = () => useAppStore((state) => state.reviewFiltersCollapsed);
export const useSetReviewFiltersCollapsed = () => useAppStore((state) => state.setReviewFiltersCollapsed);

export const useHasCompletedOnboarding = () => useAppStore((state) => state.hasCompletedOnboarding);
export const useSetHasCompletedOnboarding = () => useAppStore((state) => state.setHasCompletedOnboarding);

export const useHasCompletedInitialScan = () => useAppStore((state) => state.hasCompletedInitialScan);
export const useSetHasCompletedInitialScan = () => useAppStore((state) => state.setHasCompletedInitialScan);

export const useGoogleMapsApiKey = () => useAppStore((state) => state.googleMapsApiKey);
export const useSetGoogleMapsApiKey = () => useAppStore((state) => state.setGoogleMapsApiKey);

export const useSelectedCalendarIds = () => useAppStore((state) => state.selectedCalendarIds);
export const useSetSelectedCalendarIds = () => useAppStore((state) => state.setSelectedCalendarIds);

/** Get the Google Maps API key directly from the store (for non-React contexts) */
export const getGoogleMapsApiKey = () => useAppStore.getState().googleMapsApiKey;

/** Get selected calendar IDs directly from the store (for non-React contexts) */
export const getSelectedCalendarIds = () => useAppStore.getState().selectedCalendarIds;
