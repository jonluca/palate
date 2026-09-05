import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "expo-sqlite/kv-store";
import { createDefaultAppPreferences, selectAppPreferences, type AppPreferences } from "./app-preferences";
import { createDeduplicatingStorage } from "./deduplicating-storage";

// Scan progress state
interface ScanProgress {
  phase:
    | "idle"
    | "scanning"
    | "grouping-visits"
    | "calendar-events"
    | "calendar-only-visits"
    | "detecting-food"
    | "optimizing-database"
    | "analyzing-visits"
    | "enriching"
    | "complete"
    | "error";
  detail: string;
  photosPerSecond?: number;
  eta?: string;
}

export type BackgroundPhotoScanStage =
  | "checking"
  | "scanning"
  | "grouping-visits"
  | "calendar-events"
  | "calendar-only-visits"
  | "detecting-food"
  | "optimizing-database"
  | "deep-scanning"
  | "reconciling";

export interface BackgroundPhotoScanProgress {
  stage: BackgroundPhotoScanStage;
  detail: string;
  /** Overall progress from 0-1, or null while the amount of work is still unknown. */
  progress: number | null;
}

// App store state
interface AppState extends AppPreferences {
  // Hydration state (not persisted)
  hasHydrated: boolean;
  setHasHydrated: (hydrated: boolean) => void;

  // Visits filter
  setVisitsFilter: (filter: AppPreferences["visitsFilter"]) => void;

  // Review filters
  setReviewFoodFilter: (filter: AppPreferences["reviewFoodFilter"]) => void;
  setReviewCalendarMatchesFilter: (filter: AppPreferences["reviewCalendarMatchesFilter"]) => void;
  setReviewRestaurantMatchesFilter: (filter: AppPreferences["reviewRestaurantMatchesFilter"]) => void;
  setReviewStarFilter: (filter: AppPreferences["reviewStarFilter"]) => void;
  setReviewFiltersCollapsed: (collapsed: AppPreferences["reviewFiltersCollapsed"]) => void;

  // Onboarding state (persisted)
  setHasCompletedOnboarding: (completed: AppPreferences["hasCompletedOnboarding"]) => void;

  // Scan completed state (persisted)
  setHasCompletedInitialScan: (completed: AppPreferences["hasCompletedInitialScan"]) => void;

  // Google Maps API key (persisted)
  setGoogleMapsApiKey: (key: AppPreferences["googleMapsApiKey"]) => void;

  // Selected calendars for syncing (persisted) - null means sync all
  setSelectedCalendarIds: (ids: AppPreferences["selectedCalendarIds"]) => void;

  // Add photos alert seen state (persisted)
  setHasSeenAddPhotosAlert: (seen: AppPreferences["hasSeenAddPhotosAlert"]) => void;

  // Scan state
  isScanning: boolean;
  isBackgroundPhotoScanRunning: boolean;
  backgroundPhotoScanProgress: BackgroundPhotoScanProgress | null;
  scanProgress: ScanProgress;
  startScan: () => boolean;
  startBackgroundPhotoScan: () => boolean;
  updateBackgroundPhotoScanProgress: (progress: BackgroundPhotoScanProgress) => void;
  finishBackgroundPhotoScan: () => void;
  updateScanProgress: (progress: Partial<ScanProgress>) => void;
  completeScan: (message: string) => void;
  failScan: (message: string) => void;
  resetScan: () => void;

  // UI preferences
  setHideUndoBar: (hide: AppPreferences["hideUndoBar"]) => void;
  setFastAnimations: (enabled: AppPreferences["fastAnimations"]) => void;

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
    (set, get): AppState => ({
      ...createDefaultAppPreferences(),

      // Hydration state (not persisted)
      hasHydrated: false,
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),

      // Visits filter
      setVisitsFilter: (filter) => set({ visitsFilter: filter }),

      // Review filters
      setReviewFoodFilter: (filter) => set({ reviewFoodFilter: filter }),
      setReviewCalendarMatchesFilter: (filter) => set({ reviewCalendarMatchesFilter: filter }),
      setReviewRestaurantMatchesFilter: (filter) => set({ reviewRestaurantMatchesFilter: filter }),
      setReviewStarFilter: (filter) => set({ reviewStarFilter: filter }),
      setReviewFiltersCollapsed: (collapsed) => set({ reviewFiltersCollapsed: collapsed }),

      // Onboarding state (persisted)
      setHasCompletedOnboarding: (completed) => set({ hasCompletedOnboarding: completed }),

      // Scan completed state (persisted)
      setHasCompletedInitialScan: (completed) => set({ hasCompletedInitialScan: completed }),

      // Google Maps API key (persisted)
      setGoogleMapsApiKey: (key) => set({ googleMapsApiKey: key }),

      // Selected calendars for syncing (persisted) - null means sync all
      setSelectedCalendarIds: (ids) => set({ selectedCalendarIds: ids }),

      // Add photos alert seen state (persisted)
      setHasSeenAddPhotosAlert: (seen) => set({ hasSeenAddPhotosAlert: seen }),

      // Scan state
      isScanning: false,
      isBackgroundPhotoScanRunning: false,
      backgroundPhotoScanProgress: null,
      scanProgress: initialScanProgress,

      startScan: () => {
        const state = get();
        if (state.isScanning || state.isBackgroundPhotoScanRunning) {
          return false;
        }
        set({
          isScanning: true,
          scanProgress: {
            phase: "scanning",
            detail: "Starting scan...",
            photosPerSecond: undefined,
            eta: undefined,
          },
        });
        return true;
      },

      startBackgroundPhotoScan: () => {
        const state = get();
        if (state.isScanning || state.isBackgroundPhotoScanRunning) {
          return false;
        }
        set({
          isBackgroundPhotoScanRunning: true,
          backgroundPhotoScanProgress: null,
        });
        return true;
      },

      updateBackgroundPhotoScanProgress: (progress) =>
        set((state) =>
          state.isBackgroundPhotoScanRunning
            ? {
                backgroundPhotoScanProgress: {
                  ...progress,
                  progress: progress.progress === null ? null : Math.min(1, Math.max(0, progress.progress)),
                },
              }
            : state,
        ),

      finishBackgroundPhotoScan: () =>
        set({
          isBackgroundPhotoScanRunning: false,
          backgroundPhotoScanProgress: null,
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

      // UI preferences
      setHideUndoBar: (hide) => set({ hideUndoBar: hide }),
      setFastAnimations: (enabled) => set({ fastAnimations: enabled }),

      // Reset all state to initial values
      resetAllState: () =>
        set({
          ...createDefaultAppPreferences(),
          isScanning: false,
          isBackgroundPhotoScanRunning: false,
          backgroundPhotoScanProgress: null,
          scanProgress: initialScanProgress,
        }),
    }),
    {
      name: __DEV__ ? "app-store-dev" : "app-store", // unique name for the storage key
      storage: createJSONStorage(() => createDeduplicatingStorage(AsyncStorage)),
      // Only persist user preferences, not transient UI state
      partialize: selectAppPreferences,
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
export const useReviewCalendarMatchesFilter = () => useAppStore((state) => state.reviewCalendarMatchesFilter);
export const useSetReviewCalendarMatchesFilter = () => useAppStore((state) => state.setReviewCalendarMatchesFilter);
export const useReviewRestaurantMatchesFilter = () => useAppStore((state) => state.reviewRestaurantMatchesFilter);
export const useSetReviewRestaurantMatchesFilter = () => useAppStore((state) => state.setReviewRestaurantMatchesFilter);
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

export const useHasSeenAddPhotosAlert = () => useAppStore((state) => state.hasSeenAddPhotosAlert);
export const useSetHasSeenAddPhotosAlert = () => useAppStore((state) => state.setHasSeenAddPhotosAlert);
export const useResetScan = () => useAppStore((state) => state.resetScan);

export const useHideUndoBar = () => useAppStore((state) => state.hideUndoBar);
export const useSetHideUndoBar = () => useAppStore((state) => state.setHideUndoBar);
export const useFastAnimations = () => useAppStore((state) => state.fastAnimations);
export const useSetFastAnimations = () => useAppStore((state) => state.setFastAnimations);

/** Get the Google Maps API key directly from the store (for non-React contexts) */
export const getGoogleMapsApiKey = () => useAppStore.getState().googleMapsApiKey;

/** Get selected calendar IDs directly from the store (for non-React contexts) */
export const getSelectedCalendarIds = () => useAppStore.getState().selectedCalendarIds;
