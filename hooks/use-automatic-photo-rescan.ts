import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
  AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE,
  AUTOMATIC_PHOTO_RESCAN_START_DELAY_MS,
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

const PREFLIGHT_FEEDBACK_DELAY_MS = 400;
const MINIMUM_PREFLIGHT_FEEDBACK_MS = 500;

function subscribeToAutomaticPhotoRescanAppState(controller: AutomaticPhotoRescanController): () => void {
  let activationTimer: ReturnType<typeof setTimeout> | null = null;
  const handleAppStateChange = (nextState: string) => {
    if (activationTimer !== null) {
      clearTimeout(activationTimer);
      activationTimer = null;
    }
    if (nextState !== "active") {
      controller.handleAppStateChange(nextState);
      return;
    }
    activationTimer = setTimeout(() => {
      activationTimer = null;
      controller.handleAppStateChange(nextState);
    }, AUTOMATIC_PHOTO_RESCAN_START_DELAY_MS);
  };

  handleAppStateChange(AppState.currentState);
  const subscription = AppState.addEventListener("change", handleAppStateChange);

  return () => {
    if (activationTimer !== null) {
      clearTimeout(activationTimer);
      activationTimer = null;
    }
    subscription.remove();
  };
}

async function finishPendingAutomaticPhotoFoodSync(queryClient: QueryClient): Promise<void> {
  try {
    await syncAllVisitsFoodProbable();
    await clearAutomaticPhotoFoodSyncRequired();
  } finally {
    await invalidateFoodDetectionQueries(queryClient);
  }
}

/** Run a silent incremental rescan once per eligible app-open cycle. */
export function useAutomaticPhotoRescan(enabled: boolean): void {
  const queryClient = useQueryClient();
  const validationModeEnabled = isVisionVisitFoodValidationModeEnabled();
  const quickScanRanRef = useRef(false);

  const handleQuickScanProgress = (progress: ScanProgress) => {
    useAppStore.getState().updateBackgroundPhotoScanProgress({
      stage: progress.phase,
      detail: progress.detail,
      progress: getAutomaticQuickScanOverallProgress(progress.phase, progress.progress, !validationModeEnabled),
    });
  };

  const handleDeepScanProgress = (progress: DeepScanProgress) => {
    const retryDetail =
      progress.retryableFailures > 0 ? ` · ${progress.retryableFailures.toLocaleString()} queued to retry` : "";
    useAppStore.getState().updateBackgroundPhotoScanProgress({
      stage: "deep-scanning",
      detail:
        progress.totalPhotos > 0
          ? `Analyzed ${progress.processedPhotos.toLocaleString()} of ${progress.totalPhotos.toLocaleString()} photos${retryDetail}`
          : "Preparing photo analysis…",
      progress: getAutomaticDeepScanOverallProgress(
        progress.processedPhotos,
        progress.totalPhotos,
        quickScanRanRef.current,
      ),
    });
  };

  const { mutateAsync: scanPhotos } = useScanPhotos(
    handleQuickScanProgress,
    {
      requestCalendarPermissionIfNeeded: false,
      enqueueInsertedPhotosForAutomaticDeepScan: !validationModeEnabled,
      runVisitFoodDetection: validationModeEnabled,
    },
    {
      invalidateQueriesOnSettled: false,
    },
  );
  const { mutateAsync: deepScanPhotos } = useDeepScan(handleDeepScanProgress, {
    invalidateQueriesOnSettled: false,
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
        let preflightFeedbackShownAt: number | null = null;
        let preflightFeedbackTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          preflightFeedbackTimer = null;
          preflightFeedbackShownAt = Date.now();
          useAppStore.getState().updateBackgroundPhotoScanProgress({
            stage: "checking",
            detail: "Checking for photo updates…",
            progress: null,
          });
        }, PREFLIGHT_FEEDBACK_DELAY_MS);

        const stopPreflightFeedbackDelay = () => {
          if (preflightFeedbackTimer !== null) {
            clearTimeout(preflightFeedbackTimer);
            preflightFeedbackTimer = null;
          }
        };

        const runPhotoScan = async () => {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.unscannedPhotoCount,
            exact: true,
            refetchType: "none",
          });
          if (await isAutomaticPhotoFoodSyncRequired()) {
            stopPreflightFeedbackDelay();
            useAppStore.getState().updateBackgroundPhotoScanProgress({
              stage: "reconciling",
              detail: "Finishing a previous photo update…",
              progress: null,
            });
            await finishPendingAutomaticPhotoFoodSync(queryClient);
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
          stopPreflightFeedbackDelay();
          const shouldRunQuickScan = shouldRunAutomaticPhotoQuickScan(pendingPhotoCount, quickPipelineIncomplete);
          if (!shouldRunQuickScan && queuedDeepScanCount === 0) {
            return;
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
            scanPhotos,
            getDeepScanCandidates: validationModeEnabled
              ? async () => []
              : () => claimAutomaticPhotoDeepScanCandidates(AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE),
            deepScanPhotos: async (photos) => {
              await markAutomaticPhotoFoodSyncRequired();
              const deepScanResult = await deepScanPhotos(photos);
              await clearAutomaticPhotoFoodSyncRequired();
              return deepScanResult;
            },
            finalizeDeepScanQueue: validationModeEnabled ? async () => undefined : pruneAutomaticPhotoDeepScanQueue,
          }).finally(async () => {
            // Keep the progress visible until active Restaurants and Review data
            // have reconciled, then let the shared bar disappear once.
            useAppStore.getState().updateBackgroundPhotoScanProgress({
              stage: "reconciling",
              detail: "Refreshing restaurants and reviews…",
              progress: null,
            });

            const visibleReconciliations = [invalidateFoodDetectionQueries(queryClient)];
            if (shouldRunQuickScan) {
              visibleReconciliations.push(
                queryClient.invalidateQueries({ queryKey: queryKeys.unmatchedVisits }),
                queryClient.invalidateQueries({ queryKey: queryKeys.photoCount }),
              );
            }
            await Promise.allSettled(visibleReconciliations);
          });
          logScanCompleted(result?.photosProcessed ?? 0, result?.visitsCreated ?? 0);
        };

        await runPhotoScan().finally(async () => {
          stopPreflightFeedbackDelay();
          if (preflightFeedbackShownAt !== null) {
            const feedbackElapsedMs = Date.now() - preflightFeedbackShownAt;
            const remainingFeedbackMs = MINIMUM_PREFLIGHT_FEEDBACK_MS - feedbackElapsedMs;
            if (remainingFeedbackMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, remainingFeedbackMs));
            }
          }
          useAppStore.getState().finishBackgroundPhotoScan();
        });
      },
      onError: (error) => {
        console.warn("Automatic photo rescan failed; it will retry on a future app open:", error);
      },
    });

    const unsubscribeFromAppState = subscribeToAutomaticPhotoRescanAppState(controller);

    return () => {
      unsubscribeFromAppState();
      controller.dispose();
    };
  }, [deepScanPhotos, enabled, queryClient, scanPhotos, validationModeEnabled]);
}
