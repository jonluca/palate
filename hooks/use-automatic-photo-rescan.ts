import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { prepareAutomaticPhotoScan, hasMediaLibraryPermission, type PreparedPhotoScan } from "@/services/scanner";
import { logScanCompleted, logScanStarted } from "@/services/analytics";
import { captureMobileError } from "@/lib/error-reporting";
import { monitorPhotoRefreshWait } from "@/utils/photo-refresh-wait-monitor";
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
  syncVisitsFoodProbableForPhotos,
} from "@/utils/db";
import { isBatchAssetInfoAvailable, isVisionVisitFoodValidationModeEnabled } from "@/modules/batch-asset-info";
import {
  AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE,
  AUTOMATIC_PHOTO_DEEP_SCAN_BUDGET_MS,
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

function subscribeToAutomaticPhotoRescanAppState(
  controller: AutomaticPhotoRescanController,
  onForeground: () => void,
): () => void {
  let wasActive = false;
  const handleAppStateChange = (nextState: string) => {
    if (nextState === "active" && !wasActive) {
      onForeground();
    }
    wasActive = nextState === "active";
    controller.handleAppStateChange(nextState);
  };
  const subscription = AppState.addEventListener("change", handleAppStateChange);
  if (AppState.currentState != null) {
    handleAppStateChange(AppState.currentState);
  }
  return () => subscription.remove();
}

function refreshAutomaticPhotoQueries(queryClient: QueryClient, photosImported = false): void {
  // Observer reads can include PhotoKit, EventKit, and inactive navigation tabs.
  // They must refresh after writes, but cannot own the scan lock: a stalled read
  // would otherwise keep the progress bar and block every subsequent scan.
  const refreshes = [invalidateFoodDetectionQueries(queryClient)];
  if (photosImported) {
    refreshes.push(
      queryClient.invalidateQueries({ queryKey: queryKeys.unmatchedVisits }),
      queryClient.invalidateQueries({ queryKey: queryKeys.photoCount }),
    );
  }
  void Promise.all(refreshes).catch((error) => {
    console.warn("Failed to refresh photo results:", error);
  });
}

async function finishPendingAutomaticPhotoFoodSync(): Promise<void> {
  await syncAllVisitsFoodProbable();
  await clearAutomaticPhotoFoodSyncRequired();
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
      progress.retryableFailures > 0 ? ` · ${progress.retryableFailures.toLocaleString()} could not be analyzed` : "";
    const processedPhotos = deepScanTotalsRef.current.completed + progress.processedPhotos;
    const totalPhotos = Math.max(
      deepScanTotalsRef.current.total,
      deepScanTotalsRef.current.completed + progress.totalPhotos,
    );
    useAppStore.getState().updateBackgroundPhotoScanProgress({
      stage: "deep-scanning",
      detail:
        totalPhotos > 0
          ? `Checked ${processedPhotos.toLocaleString()} of ${totalPhotos.toLocaleString()} photos${retryDetail}`
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
    retryFailedPhotos: false,
  });

  useEffect(() => {
    if (!enabled || Platform.OS === "web") {
      return;
    }

    let currentStep = "starting";
    let failedStep: string | null = null;
    let analysisTimeUsedMs = 0;
    const waitForStep = <T>(step: string, operation: Promise<T>): Promise<T> => {
      currentStep = step;
      return monitorPhotoRefreshWait(operation, {
        shouldReport: () => controller.isActive(),
        onSlowWait: () => {
          const error = Object.assign(new Error("Photo refresh operation is still waiting"), {
            code: "PHOTO_REFRESH_SLOW_WAIT",
          });
          const phase = step === "quick_scan" ? useAppStore.getState().backgroundPhotoScanProgress?.stage : null;
          captureMobileError(error, `photo_refresh.${step}${phase ? `.${phase}` : ""}.slow_wait`);
        },
      }).catch((error) => {
        if (failedStep === null) {
          failedStep = step;
        }
        throw error;
      });
    };
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
        failedStep = null;
        deepScanTotalsRef.current = { completed: 0, total: 0 };
        let deepScanRan = false;
        let preparedScan: PreparedPhotoScan | undefined;

        const runPhotoScan = async () => {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.unscannedPhotoCount,
            exact: true,
            refetchType: "none",
          });
          useAppStore.getState().updateBackgroundPhotoScanProgress({
            stage: "checking",
            detail: "Opening photo history…",
            progress: null,
          });
          if (await waitForStep("database_open", isAutomaticPhotoFoodSyncRequired())) {
            useAppStore.getState().updateBackgroundPhotoScanProgress({
              stage: "reconciling",
              detail: "Finishing a previous photo update…",
              progress: null,
            });
            await waitForStep("food_sync_recovery", finishPendingAutomaticPhotoFoodSync()).finally(() => {
              refreshAutomaticPhotoQueries(queryClient);
            });
          }
          if (automaticDeepScanEnabled) {
            await waitForStep("queue_prune", pruneAutomaticPhotoDeepScanQueue());
          }
          // Keep native ownership outside React Query: cached numbers must never
          // retain or share a one-shot PhotoKit session between callers.
          useAppStore.getState().updateBackgroundPhotoScanProgress({
            stage: "checking",
            detail: "Checking your photo library…",
            progress: null,
          });
          preparedScan = await waitForStep("library_prepare", prepareAutomaticPhotoScan());
          const pendingPhotoCount = preparedScan.pendingPhotoCount;
          queryClient.setQueryData(queryKeys.unscannedPhotoCount, pendingPhotoCount);
          const [queuedDeepScanCount, quickPipelineIncomplete] = await waitForStep(
            "queue_read",
            Promise.all([
              automaticDeepScanEnabled ? getAutomaticPhotoDeepScanQueueCount() : Promise.resolve(0),
              isAutomaticPhotoQuickPipelineIncomplete(),
            ]),
          );
          const shouldRunQuickScan = shouldRunAutomaticPhotoQuickScan(pendingPhotoCount, quickPipelineIncomplete);
          if (!controller.isActive()) {
            return;
          }
          if (!shouldRunQuickScan) {
            await waitForStep("checkpoint", preparedScan.complete(0));
            await waitForStep("snapshot_release", preparedScan.dispose());
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
            scanPhotos: async () => {
              const result = await waitForStep("quick_scan", scanPhotos(preparedScan));
              // Publish imported visits now, even if queued analysis needs more time.
              refreshAutomaticPhotoQueries(queryClient, true);
              return result;
            },
            shouldContinue: controller.isActive,
            shouldAnalyzePhotos: () => analysisTimeUsedMs < AUTOMATIC_PHOTO_DEEP_SCAN_BUDGET_MS,
            getDeepScanCandidates: !automaticDeepScanEnabled
              ? async () => []
              : async (attemptedAssetIds) => {
                  if (attemptedAssetIds.length === 0) {
                    deepScanTotalsRef.current.total = await waitForStep(
                      "queue_count",
                      getAutomaticPhotoDeepScanQueueCount(),
                    );
                  }
                  return waitForStep(
                    "queue_claim",
                    claimAutomaticPhotoDeepScanCandidates(AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE, attemptedAssetIds),
                  );
                },
            deepScanPhotos: async (photos) => {
              if (!deepScanRan) {
                await waitForStep("food_sync_mark", markAutomaticPhotoFoodSyncRequired());
                deepScanRan = true;
              }
              const startedAt = performance.now();
              const deepScanResult = await waitForStep("photo_analysis", deepScanPhotos(photos)).finally(() => {
                analysisTimeUsedMs += performance.now() - startedAt;
              });
              await waitForStep("batch_food_sync", syncVisitsFoodProbableForPhotos(photos.map((photo) => photo.id)));
              refreshAutomaticPhotoQueries(queryClient);
              deepScanTotalsRef.current.completed += photos.length;
              return deepScanResult;
            },
            finalizeDeepScanQueue: () =>
              waitForStep(
                "queue_finalize",
                automaticDeepScanEnabled ? pruneAutomaticPhotoDeepScanQueue() : Promise.resolve(),
              ).finally(async () => {
                // Persist derived food state before releasing scan ownership. Cache
                // refreshes continue independently of that write lifecycle.
                useAppStore.getState().updateBackgroundPhotoScanProgress({
                  stage: "reconciling",
                  detail: "Refreshing restaurants and reviews…",
                  progress: null,
                });

                await waitForStep(
                  "food_sync_finalize",
                  deepScanRan ? finishPendingAutomaticPhotoFoodSync() : Promise.resolve(),
                ).finally(() => {
                  refreshAutomaticPhotoQueries(queryClient, shouldRunQuickScan);
                });
              }),
          });
          logScanCompleted(result?.photosProcessed ?? 0, result?.visitsCreated ?? 0);
        };

        await runPhotoScan().finally(async () => {
          await waitForStep("snapshot_release", preparedScan?.dispose() ?? Promise.resolve()).catch((cleanupError) => {
            console.warn("Failed to release the prepared automatic photo scan:", cleanupError);
          });
          useAppStore.getState().finishBackgroundPhotoScan();
        });
      },
      onError: (error) => {
        captureMobileError(error, `photo_refresh.${failedStep ?? currentStep}`);
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
    const unsubscribeFromAppState = subscribeToAutomaticPhotoRescanAppState(controller, () => {
      analysisTimeUsedMs = 0;
    });

    return () => {
      controller.dispose();
      unsubscribeFromAppState();
      librarySubscription.remove();
      unsubscribeFromStore();
      unsubscribeFromMutations();
    };
  }, [automaticDeepScanEnabled, deepScanPhotos, enabled, queryClient, scanPhotos]);
}
