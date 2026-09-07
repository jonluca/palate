import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { prepareAutomaticPhotoScan, hasMediaLibraryPermission, type PreparedPhotoScan } from "@/services/scanner";
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
import { isBatchAssetInfoAvailable, isVisionVisitFoodValidationModeEnabled } from "@/modules/batch-asset-info";
import {
  AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE,
  createAutomaticPhotoRescanController,
  getAutomaticDeepScanOverallProgress,
  getAutomaticQuickScanOverallProgress,
  runAutomaticPhotoScanSequence,
  shouldRunAutomaticPhotoQuickScan,
  type AutomaticPhotoRescanController,
} from "@/utils/automatic-photo-rescan-core";
import {
  invalidateFoodDetectionQueries,
  mutationKeys,
  queryKeys,
  useDeepScan,
  useScanPhotos,
  type DeepScanProgress,
  type ScanProgress,
} from "./queries";

function subscribeToAutomaticPhotoRescanAppState(controller: AutomaticPhotoRescanController): () => void {
  const subscription = AppState.addEventListener("change", controller.handleAppStateChange);
  controller.handleAppStateChange(AppState.currentState);
  return () => subscription.remove();
}

async function finishPendingAutomaticPhotoFoodSync(queryClient: QueryClient): Promise<void> {
  try {
    await syncAllVisitsFoodProbable();
    await clearAutomaticPhotoFoodSyncRequired();
  } finally {
    await invalidateFoodDetectionQueries(queryClient);
  }
}

/** Start incremental import and queued deep analysis on foreground or library changes. */
export function useAutomaticPhotoRescan(enabled: boolean): void {
  const queryClient = useQueryClient();
  const validationModeEnabled = isVisionVisitFoodValidationModeEnabled();
  const automaticDeepScanEnabled = !validationModeEnabled && isBatchAssetInfoAvailable();
  const quickScanRanRef = useRef(false);
  const deepScanTotalsRef = useRef({ completed: 0, total: 0 });

  const handleQuickScanProgress = (progress: ScanProgress) => {
    useAppStore.getState().updateBackgroundPhotoScanProgress({
      stage: progress.phase,
      detail: progress.detail,
      progress: getAutomaticQuickScanOverallProgress(progress.phase, progress.progress, automaticDeepScanEnabled),
    });
  };

  const handleDeepScanProgress = (progress: DeepScanProgress) => {
    const retryDetail =
      progress.retryableFailures > 0 ? ` · ${progress.retryableFailures.toLocaleString()} queued to retry` : "";
    const processedPhotos = deepScanTotalsRef.current.completed + progress.processedPhotos;
    const totalPhotos = Math.max(
      deepScanTotalsRef.current.total,
      deepScanTotalsRef.current.completed + progress.totalPhotos,
    );
    useAppStore.getState().updateBackgroundPhotoScanProgress({
      stage: "deep-scanning",
      detail:
        totalPhotos > 0
          ? `Analyzed ${processedPhotos.toLocaleString()} of ${totalPhotos.toLocaleString()} photos${retryDetail}`
          : "Preparing photo analysis…",
      progress: getAutomaticDeepScanOverallProgress(processedPhotos, totalPhotos, quickScanRanRef.current),
    });
  };

  const { mutateAsync: scanPhotos } = useScanPhotos(
    handleQuickScanProgress,
    {
      requestCalendarPermissionIfNeeded: false,
      incrementalVisitWork: true,
      enqueueInsertedPhotosForAutomaticDeepScan: automaticDeepScanEnabled,
      runVisitFoodDetection: validationModeEnabled,
    },
    {
      invalidateQueriesOnSettled: false,
    },
  );
  const { mutateAsync: deepScanPhotos } = useDeepScan(handleDeepScanProgress, {
    invalidateQueriesOnSettled: false,
    synchronizeVisitFood: false,
  });

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
        quickScanRanRef.current = false;
        deepScanTotalsRef.current = { completed: 0, total: 0 };
        let deepScanRan = false;
        let preparedScan: PreparedPhotoScan | undefined;

        const runPhotoScan = async () => {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.unscannedPhotoCount,
            exact: true,
            refetchType: "none",
          });
          if (await isAutomaticPhotoFoodSyncRequired()) {
            useAppStore.getState().updateBackgroundPhotoScanProgress({
              stage: "reconciling",
              detail: "Finishing a previous photo update…",
              progress: null,
            });
            await finishPendingAutomaticPhotoFoodSync(queryClient);
          }
          if (automaticDeepScanEnabled) {
            await pruneAutomaticPhotoDeepScanQueue();
          }
          // Keep native ownership outside React Query: cached numbers must never
          // retain or share a one-shot PhotoKit session between callers.
          preparedScan = await prepareAutomaticPhotoScan();
          const pendingPhotoCount = preparedScan.pendingPhotoCount;
          queryClient.setQueryData(queryKeys.unscannedPhotoCount, pendingPhotoCount);
          const [queuedDeepScanCount, quickPipelineIncomplete] = await Promise.all([
            automaticDeepScanEnabled ? getAutomaticPhotoDeepScanQueueCount() : Promise.resolve(0),
            isAutomaticPhotoQuickPipelineIncomplete(),
          ]);
          const shouldRunQuickScan = shouldRunAutomaticPhotoQuickScan(pendingPhotoCount, quickPipelineIncomplete);
          if (!controller.isActive()) {
            return;
          }
          if (!shouldRunQuickScan) {
            await preparedScan.complete(0);
            await preparedScan.dispose();
            if (queuedDeepScanCount === 0) {
              return;
            }
          }
          quickScanRanRef.current = shouldRunQuickScan;
          useAppStore.getState().updateBackgroundPhotoScanProgress({
            stage: "checking",
            detail: shouldRunQuickScan ? "Preparing your photo update…" : "Preparing photo analysis…",
            progress: 0.03,
          });

          logScanStarted();
          const result = await runAutomaticPhotoScanSequence({
            shouldRunQuickScan,
            scanPhotos: () => scanPhotos(preparedScan),
            shouldContinue: controller.isActive,
            getDeepScanCandidates: !automaticDeepScanEnabled
              ? async () => []
              : async (attemptedAssetIds) => {
                  if (attemptedAssetIds.length === 0) {
                    deepScanTotalsRef.current.total = await getAutomaticPhotoDeepScanQueueCount();
                  }
                  return claimAutomaticPhotoDeepScanCandidates(AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE, attemptedAssetIds);
                },
            deepScanPhotos: async (photos) => {
              if (!deepScanRan) {
                await markAutomaticPhotoFoodSyncRequired();
                deepScanRan = true;
              }
              const deepScanResult = await deepScanPhotos(photos);
              deepScanTotalsRef.current.completed += photos.length;
              return deepScanResult;
            },
            finalizeDeepScanQueue: () =>
              (automaticDeepScanEnabled ? pruneAutomaticPhotoDeepScanQueue() : Promise.resolve()).finally(async () => {
                // Keep the progress visible until active Restaurants and Review data
                // have reconciled, then let the shared bar disappear once.
                useAppStore.getState().updateBackgroundPhotoScanProgress({
                  stage: "reconciling",
                  detail: "Refreshing restaurants and reviews…",
                  progress: null,
                });

                const visibleReconciliations = [
                  deepScanRan
                    ? finishPendingAutomaticPhotoFoodSync(queryClient)
                    : invalidateFoodDetectionQueries(queryClient),
                ];
                if (shouldRunQuickScan) {
                  visibleReconciliations.push(
                    queryClient.invalidateQueries({ queryKey: queryKeys.unmatchedVisits }),
                    queryClient.invalidateQueries({ queryKey: queryKeys.photoCount }),
                  );
                }
                const [foodSyncResult] = await Promise.allSettled(visibleReconciliations);
                if (deepScanRan && foodSyncResult.status === "rejected") {
                  throw foodSyncResult.reason;
                }
              }),
          });
          logScanCompleted(result?.photosProcessed ?? 0, result?.visitsCreated ?? 0);
        };

        await runPhotoScan().finally(async () => {
          await preparedScan?.dispose().catch((cleanupError) => {
            console.warn("Failed to release the prepared automatic photo scan:", cleanupError);
          });
          useAppStore.getState().finishBackgroundPhotoScan();
        });
      },
      onError: (error) => {
        console.warn("Automatic photo refresh failed; it will retry on the next library change or app open:", error);
      },
    });

    const unsubscribeFromStore = useAppStore.subscribe(controller.handleAvailabilityChange);
    const unsubscribeFromMutations = queryClient.getMutationCache().subscribe(controller.handleAvailabilityChange);
    const librarySubscription = MediaLibrary.addListener((event) => {
      if (
        event.hasIncrementalChanges &&
        !event.insertedAssets?.length &&
        !event.deletedAssets?.length &&
        !event.updatedAssets?.length
      ) {
        return;
      }
      controller.handlePhotoLibraryChange();
    });
    const unsubscribeFromAppState = subscribeToAutomaticPhotoRescanAppState(controller);

    return () => {
      controller.dispose();
      unsubscribeFromAppState();
      librarySubscription.remove();
      unsubscribeFromStore();
      unsubscribeFromMutations();
    };
  }, [automaticDeepScanEnabled, deepScanPhotos, enabled, queryClient, scanPhotos]);
}
