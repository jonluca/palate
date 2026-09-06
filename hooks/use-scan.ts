import { useCallback, useRef } from "react";
import {
  usePermissions,
  usePhotoCount,
  useRequestPermission,
  useScanPhotos,
  useDeepScan,
  type DeepScanProgress,
  type ScanProgress,
} from "./queries";
import { useScanProgress, type ProgressSharedValues } from "./use-progress";
import { useAppStore, useHasCompletedInitialScan } from "@/store/app-store";
import { formatEta, getPhotoCount } from "@/services/scanner";
import { logScanStarted, logScanCompleted } from "@/services/analytics";
import { getUnanalyzedPhotoCount } from "@/utils/db";
import {
  allowsAutomaticDeepScanFollowup,
  getResolvedVisitFoodDetectionStrategy,
  isVisionVisitFoodValidationModeEnabled,
} from "@/modules/batch-asset-info";

export interface UseScanReturn {
  // Permission state
  hasPermission: boolean | undefined;
  cameraRollCount: number | null | undefined;
  requestPermission: () => void;
  isRequestingPermission: boolean;

  // Scan state
  isScanning: boolean;
  isBackgroundScanRunning: boolean;
  isComplete: boolean;

  // Deep scan state
  isDeepScanning: boolean;

  // Actions
  scan: () => Promise<void>;
  deepScan: () => Promise<void>;

  // Progress for UI
  sharedValues: ProgressSharedValues;
}

interface UseScanOptions {
  autoDeepScanPhotoThreshold?: number;
  autoDeepScanRemainingPhotoThreshold?: number;
}

export function useScan(options: UseScanOptions = {}): UseScanReturn {
  const { autoDeepScanPhotoThreshold, autoDeepScanRemainingPhotoThreshold } = options;
  const { data: hasPermission } = usePermissions();
  const { data: cameraRollCount } = usePhotoCount(hasPermission === true);
  const requestPermissionMutation = useRequestPermission();
  const hasCompletedInitialScan = useHasCompletedInitialScan();

  // Zustand store for scan state
  const {
    startScan,
    updateScanProgress,
    completeScan,
    failScan,
    scanProgress,
    isScanning: isStoreScanning,
    isBackgroundPhotoScanRunning,
  } = useAppStore();
  const activeScanRef = useRef<"scan" | "deep-scan" | null>(null);

  // Worklet-based progress tracking for UI animations
  const { sharedValues, onProgress, start, complete, error } = useScanProgress();

  const handleProgress = useCallback(
    (progress: ScanProgress) => {
      onProgress(progress);
      updateScanProgress({
        phase: progress.phase,
        detail: progress.detail,
        photosPerSecond: progress.photosPerSecond,
        eta: progress.eta,
      });
    },
    [onProgress, updateScanProgress],
  );

  const handleDeepScanProgress = useCallback(
    (progress: DeepScanProgress) => {
      const progressValue = progress.totalPhotos > 0 ? progress.processedPhotos / progress.totalPhotos : 0;
      const percent = Math.round(progressValue * 100);
      const eta = progress.isComplete ? "Done" : formatEta(progress.etaMs);
      const retryDetail =
        progress.retryableFailures > 0 ? `; ${progress.retryableFailures.toLocaleString()} queued to retry` : "";

      onProgress({
        phase: "deep-scanning",
        detail: `Scanned ${progress.processedPhotos.toLocaleString()} of ${progress.totalPhotos.toLocaleString()} photos (${percent.toLocaleString()}%)${retryDetail}`,
        photosPerSecond: Math.round(progress.photosPerSecond),
        eta,
        progress: progressValue,
      });
      updateScanProgress({
        phase: "scanning",
        detail: `Deep scanning: ${progress.processedPhotos.toLocaleString()} / ${progress.totalPhotos.toLocaleString()} (${percent.toLocaleString()}%)${retryDetail}`,
        photosPerSecond: Math.round(progress.photosPerSecond),
        eta,
      });
    },
    [onProgress, updateScanProgress],
  );

  const scanMutation = useScanPhotos(handleProgress);
  const deepScanMutation = useDeepScan(handleDeepScanProgress);

  const requestPermission = useCallback(() => {
    requestPermissionMutation.mutate();
  }, [requestPermissionMutation]);

  const shouldAutoDeepScan = useCallback(async () => {
    if (
      !allowsAutomaticDeepScanFollowup(
        getResolvedVisitFoodDetectionStrategy(),
        isVisionVisitFoodValidationModeEnabled(),
      )
    ) {
      return false;
    }

    if (autoDeepScanRemainingPhotoThreshold !== undefined) {
      const remainingPhotoCount = await getUnanalyzedPhotoCount().catch(() => null);
      return (
        remainingPhotoCount !== null &&
        remainingPhotoCount > 0 &&
        remainingPhotoCount < autoDeepScanRemainingPhotoThreshold
      );
    }

    if (autoDeepScanPhotoThreshold === undefined || hasCompletedInitialScan) {
      return false;
    }

    const libraryPhotoCount = cameraRollCount ?? (await getPhotoCount().catch(() => null));
    return libraryPhotoCount !== null && libraryPhotoCount < autoDeepScanPhotoThreshold;
  }, [autoDeepScanPhotoThreshold, autoDeepScanRemainingPhotoThreshold, cameraRollCount, hasCompletedInitialScan]);

  const runScan = useCallback(
    async (mode: "scan" | "deep-scan") => {
      if (
        activeScanRef.current ||
        isStoreScanning ||
        isBackgroundPhotoScanRunning ||
        scanMutation.isPending ||
        deepScanMutation.isPending
      ) {
        return;
      }

      if (!hasPermission) {
        requestPermission();
        return;
      }

      if (!startScan()) {
        return;
      }
      activeScanRef.current = mode;

      try {
        start();
        logScanStarted();

        let photosProcessed: number;
        let resultsCreated: number;
        if (mode === "scan") {
          const result = await scanMutation.mutateAsync();
          if (await shouldAutoDeepScan()) {
            await deepScanMutation.mutateAsync(undefined);
          }
          photosProcessed = result?.photosProcessed ?? 0;
          resultsCreated = result?.visitsCreated ?? 0;
        } else {
          const result = await deepScanMutation.mutateAsync(undefined);
          photosProcessed = result?.processedPhotos ?? 0;
          // Deep scan reports food detections rather than newly created visits.
          resultsCreated = result?.foodPhotosFound ?? 0;
        }
        complete("Done!");
        completeScan("Done!");
        logScanCompleted(photosProcessed, resultsCreated);
      } catch (err) {
        console.error(mode === "scan" ? "Scan error:" : "Deep scan error:", err);
        const errorMessage = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
        error(errorMessage);
        failScan(errorMessage);
      } finally {
        activeScanRef.current = null;
      }
    },
    [
      hasPermission,
      isStoreScanning,
      isBackgroundPhotoScanRunning,
      requestPermission,
      start,
      startScan,
      scanMutation,
      shouldAutoDeepScan,
      deepScanMutation,
      complete,
      completeScan,
      error,
      failScan,
    ],
  );

  const scan = useCallback(() => runScan("scan"), [runScan]);
  const deepScan = useCallback(() => runScan("deep-scan"), [runScan]);

  return {
    // Permission state
    hasPermission,
    cameraRollCount,
    requestPermission,
    isRequestingPermission: requestPermissionMutation.isPending,

    // Scan state
    isScanning: scanMutation.isPending || (isStoreScanning && activeScanRef.current !== "deep-scan"),
    isBackgroundScanRunning: isBackgroundPhotoScanRunning,
    isComplete: scanProgress.phase === "complete",

    // Deep scan state
    isDeepScanning: deepScanMutation.isPending || activeScanRef.current === "deep-scan",

    // Actions
    scan,
    deepScan,

    // Progress for UI
    sharedValues,
  };
}
