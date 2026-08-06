import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getUnscannedPhotoCount, hasMediaLibraryPermission } from "@/services/scanner";
import { logScanCompleted, logScanStarted } from "@/services/analytics";
import { useAppStore } from "@/store";
import {
  claimAutomaticPhotoDeepScanCandidates,
  clearAutomaticPhotoFoodSyncRequired,
  getAutomaticPhotoDeepScanQueueCount,
  isAutomaticPhotoFoodSyncRequired,
  isAutomaticPhotoQuickPipelineIncomplete,
  markAutomaticPhotoFoodSyncRequired,
  pruneAutomaticPhotoDeepScanQueue,
  syncAllVisitsFoodProbable,
} from "@/utils/db";
import { isVisionVisitFoodValidationModeEnabled } from "@/modules/batch-asset-info";
import {
  AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT,
  createAutomaticPhotoRescanController,
  runAutomaticPhotoScanSequence,
  shouldRunAutomaticPhotoQuickScan,
} from "@/utils/automatic-photo-rescan-core";
import { invalidateFoodDetectionQueries, mutationKeys, queryKeys, useDeepScan, useScanPhotos } from "./queries";

/** Run a silent incremental rescan once per eligible app-open cycle. */
export function useAutomaticPhotoRescan(enabled: boolean): void {
  const queryClient = useQueryClient();
  const validationModeEnabled = isVisionVisitFoodValidationModeEnabled();
  const { mutateAsync: scanPhotos } = useScanPhotos(undefined, {
    requestCalendarPermissionIfNeeded: false,
    enqueueInsertedPhotosForAutomaticDeepScan: !validationModeEnabled,
  });
  const { mutateAsync: deepScanPhotos } = useDeepScan();

  useEffect(() => {
    if (!enabled || Platform.OS === "web") {
      return;
    }

    const controller = createAutomaticPhotoRescanController({
      canRun: () => {
        const state = useAppStore.getState();
        return (
          state.hasHydrated &&
          state.hasCompletedInitialScan &&
          !state.isScanning &&
          !state.isBackgroundPhotoScanRunning &&
          queryClient.isMutating({ mutationKey: mutationKeys.photoAnalysis }) === 0
        );
      },
      hasPhotoLibraryPermission: hasMediaLibraryPermission,
      runAttempt: async () => {
        const store = useAppStore.getState();
        if (!store.startBackgroundPhotoScan()) {
          return;
        }

        try {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.unscannedPhotoCount,
            exact: true,
            refetchType: "none",
          });
          if (await isAutomaticPhotoFoodSyncRequired()) {
            await syncAllVisitsFoodProbable();
            await clearAutomaticPhotoFoodSyncRequired();
            invalidateFoodDetectionQueries(queryClient);
          }
          if (!validationModeEnabled) {
            await pruneAutomaticPhotoDeepScanQueue();
          }
          const [pendingPhotoCount, queuedDeepScanCount, quickPipelineIncomplete] = await Promise.all([
            queryClient.fetchQuery({
              queryKey: queryKeys.unscannedPhotoCount,
              queryFn: getUnscannedPhotoCount,
              staleTime: 0,
            }),
            validationModeEnabled ? Promise.resolve(0) : getAutomaticPhotoDeepScanQueueCount(),
            isAutomaticPhotoQuickPipelineIncomplete(),
          ]);
          const shouldRunQuickScan = shouldRunAutomaticPhotoQuickScan(pendingPhotoCount, quickPipelineIncomplete);
          if (!shouldRunQuickScan && queuedDeepScanCount === 0) {
            return;
          }

          logScanStarted();
          const result = await runAutomaticPhotoScanSequence({
            shouldRunQuickScan,
            scanPhotos,
            getDeepScanCandidates: validationModeEnabled
              ? async () => []
              : () => claimAutomaticPhotoDeepScanCandidates(AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT - 1),
            deepScanPhotos: async (photos) => {
              await markAutomaticPhotoFoodSyncRequired();
              const deepScanResult = await deepScanPhotos(photos);
              await clearAutomaticPhotoFoodSyncRequired();
              return deepScanResult;
            },
            finalizeDeepScanQueue: validationModeEnabled ? async () => undefined : pruneAutomaticPhotoDeepScanQueue,
          });
          logScanCompleted(result?.photosProcessed ?? 0, result?.visitsCreated ?? 0);
        } finally {
          useAppStore.getState().finishBackgroundPhotoScan();
        }
      },
      onError: (error) => {
        console.warn("Automatic photo rescan failed; it will retry on a future app open:", error);
      },
    });

    controller.handleAppStateChange(AppState.currentState);
    const subscription = AppState.addEventListener("change", controller.handleAppStateChange);

    return () => {
      controller.dispose();
      subscription.remove();
    };
  }, [deepScanPhotos, enabled, queryClient, scanPhotos, validationModeEnabled]);
}
