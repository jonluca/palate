import { useCallback } from "react";
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

export function useScan(): UseScanReturn {
  const { data: hasPermission } = usePermissions();
  const { data: cameraRollCount } = usePhotoCount(hasPermission === true);
  const requestPermissionMutation = useRequestPermission();
  const hasCompletedInitialScan = useHasCompletedInitialScan();

  // Zustand store for scan state
  const { startScan, updateScanProgress, completeScan, failScan, scanProgress } = useAppStore();

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
      const eta =
        progress.etaMs !== null && progress.etaMs > 0
          ? `${Math.ceil(progress.etaMs / 1000).toLocaleString()}s`
          : progress.isComplete
            ? "Done"
            : "calculating...";

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

  const scan = useCallback(async () => {
    if (!hasPermission) {
      requestPermission();
      return;
    }

    start();
    startScan();

    try {
      await scanMutation.mutateAsync();
      const message = `Done!`;
      complete(message);
      completeScan(message);
    } catch (err) {
      console.error("Scan error:", err);
      const errorMessage = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      error(errorMessage);
      failScan(errorMessage);
    }
  }, [hasPermission, requestPermission, start, startScan, scanMutation, complete, completeScan, error, failScan]);

  const deepScan = useCallback(async () => {
    if (!hasPermission) {
      requestPermission();
      return;
    }

    start();
    startScan();

    try {
      await deepScanMutation.mutateAsync();
      const message = `Done!`;
      complete(message);
      completeScan(message);
    } catch (err) {
      console.error("Deep scan error:", err);
      const errorMessage = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
      error(errorMessage);
      failScan(errorMessage);
    }
  }, [hasPermission, requestPermission, start, startScan, deepScanMutation, complete, completeScan, error, failScan]);

  return {
    // Permission state
    hasPermission,
    cameraRollCount,
    requestPermission,
    isRequestingPermission: requestPermissionMutation.isPending,

    // Scan state
    isScanning: scanMutation.isPending,
    isComplete: scanProgress.phase === "complete",
    isError: scanProgress.phase === "error",
    isFirstScan: !hasCompletedInitialScan,

    // Deep scan state
    isDeepScanning: deepScanMutation.isPending,

    // Actions
    scan,
    deepScan,

    // Progress for UI
    sharedValues,
  };
}
