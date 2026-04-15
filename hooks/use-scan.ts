import { useCallback, useRef } from "react";
import {
  usePermissions,
  usePhotoCount,
  useRequestPermission,
  useScanPhotos,
  useDeepScan,
  type DeepScanProgress,
} from "./queries";
import { useScanProgress, type ProgressSharedValues } from "./use-progress";
import { useAppStore, useHasCompletedInitialScan } from "@/store/app-store";
import { formatEta, getPhotoCount } from "@/services/scanner";
import { logScanStarted, logScanCompleted } from "@/services/analytics";

export interface UseScanReturn {
  // Permission state
  hasPermission: boolean | undefined;
  cameraRollCount: number | null | undefined;
  requestPermission: () => void;
  isRequestingPermission: boolean;

  // Scan state
  isScanning: boolean;
  isComplete: boolean;
  isError: boolean;
  isFirstScan: boolean;

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
}

export function useScan(options: UseScanOptions = {}): UseScanReturn {
  const { autoDeepScanPhotoThreshold } = options;
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
  } = useAppStore();
  const activeScanRef = useRef<"scan" | "deep-scan" | null>(null);

  // Worklet-based progress tracking for UI animations
  const { sharedValues, onProgress, start, complete, error } = useScanProgress();

  const handleProgress = useCallback(
    (progress: { phase: string; detail: string; photosPerSecond?: number; eta?: string; progress?: number }) => {
      onProgress(progress);
      updateScanProgress({
        phase: progress.phase as "scanning" | "analyzing-visits" | "enriching",
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

      onProgress({
        phase: "deep-scanning",
        detail: `Scanned ${progress.processedPhotos.toLocaleString()} of ${progress.totalPhotos.toLocaleString()} photos (${percent.toLocaleString()}%)`,
        photosPerSecond: Math.round(progress.photosPerSecond),
        eta,
        progress: progressValue,
      });
      updateScanProgress({
        phase: "scanning",
        detail: `Deep scanning: ${progress.processedPhotos.toLocaleString()} / ${progress.totalPhotos.toLocaleString()} (${percent.toLocaleString()}%)`,
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
    if (autoDeepScanPhotoThreshold === undefined || hasCompletedInitialScan) {
      return false;
    }

    const libraryPhotoCount = cameraRollCount ?? (await getPhotoCount().catch(() => null));
    return libraryPhotoCount !== null && libraryPhotoCount < autoDeepScanPhotoThreshold;
  }, [autoDeepScanPhotoThreshold, cameraRollCount, hasCompletedInitialScan]);

  const scan = useCallback(async () => {
    if (activeScanRef.current || isStoreScanning || scanMutation.isPending || deepScanMutation.isPending) {
      return;
    }

    if (!hasPermission) {
      requestPermission();
      return;
    }

    activeScanRef.current = "scan";

    try {
      start();
      startScan();
      logScanStarted();

      const result = await scanMutation.mutateAsync();
      if (await shouldAutoDeepScan()) {
        await deepScanMutation.mutateAsync(undefined);
      }
      const message = `Done!`;
      complete(message);
      completeScan(message);
      logScanCompleted(result?.photosProcessed ?? 0, result?.visitsCreated ?? 0);
    } catch (err) {
      console.error("Scan error:", err);
      const errorMessage = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      error(errorMessage);
      failScan(errorMessage);
    } finally {
      activeScanRef.current = null;
    }
  }, [
    hasPermission,
    isStoreScanning,
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
  ]);

  const deepScan = useCallback(async () => {
    if (activeScanRef.current || isStoreScanning || scanMutation.isPending || deepScanMutation.isPending) {
      return;
    }

    if (!hasPermission) {
      requestPermission();
      return;
    }

    activeScanRef.current = "deep-scan";

    try {
      start();
      startScan();
      logScanStarted();

      const result = await deepScanMutation.mutateAsync(undefined);
      const message = `Done!`;
      complete(message);
      completeScan(message);
      // Deep scan returns DeepScanProgress which tracks food detection, not visit creation
      logScanCompleted(result?.processedPhotos ?? 0, result?.foodPhotosFound ?? 0);
    } catch (err) {
      console.error("Deep scan error:", err);
      const errorMessage = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      error(errorMessage);
      failScan(errorMessage);
    } finally {
      activeScanRef.current = null;
    }
  }, [
    hasPermission,
    isStoreScanning,
    requestPermission,
    start,
    startScan,
    scanMutation,
    deepScanMutation,
    complete,
    completeScan,
    error,
    failScan,
  ]);

  return {
    // Permission state
    hasPermission,
    cameraRollCount,
    requestPermission,
    isRequestingPermission: requestPermissionMutation.isPending,

    // Scan state
    isScanning: scanMutation.isPending || (isStoreScanning && activeScanRef.current !== "deep-scan"),
    isComplete: scanProgress.phase === "complete",
    isError: scanProgress.phase === "error",
    isFirstScan: !hasCompletedInitialScan,

    // Deep scan state
    isDeepScanning: deepScanMutation.isPending || activeScanRef.current === "deep-scan",

    // Actions
    scan,
    deepScan,

    // Progress for UI
    sharedValues,
  };
}
