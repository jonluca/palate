import { useCallback } from "react";
import { useSharedValue, withTiming, runOnUI, type SharedValue } from "react-native-reanimated";

interface ProgressData {
  status: string;
  speed: number;
  eta: string;
  progress: number; // 0-1
  isActive: boolean;
}

export interface ProgressSharedValues {
  status: SharedValue<string>;
  speed: SharedValue<number>;
  eta: SharedValue<string>;
  progress: SharedValue<number>;
  isActive: SharedValue<boolean>;
}

/**
 * Hook that provides shared values for progress tracking.
 * Updates happen on the UI thread without blocking.
 */
function useProgressSharedValues(): ProgressSharedValues {
  const status = useSharedValue("");
  const speed = useSharedValue(0);
  const eta = useSharedValue("");
  const progress = useSharedValue(0);
  const isActive = useSharedValue(false);

  return { status, speed, eta, progress, isActive };
}

/**
 * Creates an update function that writes to shared values.
 * Safe to call from any thread.
 */
function useProgressUpdater(sharedValues: ProgressSharedValues) {
  const statusRef = sharedValues.status;
  const speedRef = sharedValues.speed;
  const etaRef = sharedValues.eta;
  const progressRef = sharedValues.progress;
  const isActiveRef = sharedValues.isActive;

  const updateProgressWorklet = useCallback(
    (data: Partial<ProgressData>) => {
      "worklet";
      // Shared values are designed to be mutated - disable react-compiler for this block
      /* eslint-disable react-compiler/react-compiler */
      if (data.status !== undefined) {
        statusRef.value = data.status;
      }
      if (data.speed !== undefined) {
        speedRef.value = data.speed;
      }
      if (data.eta !== undefined) {
        etaRef.value = data.eta;
      }
      if (data.progress !== undefined) {
        progressRef.value = withTiming(data.progress, { duration: 200 });
      }
      if (data.isActive !== undefined) {
        isActiveRef.value = data.isActive;
      }
      /* eslint-enable react-compiler/react-compiler */
    },
    [statusRef, speedRef, etaRef, progressRef, isActiveRef],
  );

  const updateProgress = useCallback(
    (data: Partial<ProgressData>) => {
      runOnUI(updateProgressWorklet)(data);
    },
    [updateProgressWorklet],
  );

  const resetWorklet = useCallback(() => {
    "worklet";
    statusRef.value = "";
    speedRef.value = 0;
    etaRef.value = "";
    progressRef.value = 0;
    isActiveRef.value = false;
  }, [statusRef, speedRef, etaRef, progressRef, isActiveRef]);

  const reset = useCallback(() => {
    runOnUI(resetWorklet)();
  }, [resetWorklet]);

  return { updateProgress, reset };
}

/**
 * Hook for scan progress with worklet-safe callbacks
 */
export function useScanProgress() {
  const sharedValues = useProgressSharedValues();
  const { updateProgress, reset } = useProgressUpdater(sharedValues);

  const onProgress = useCallback(
    (progress: { phase: string; detail: string; photosPerSecond?: number; eta?: string; progress?: number }) => {
      updateProgress({
        status: progress.detail,
        speed: progress.photosPerSecond ?? 0,
        eta: progress.eta ?? "",
        progress: progress.progress,
      });
    },
    [updateProgress],
  );

  const start = useCallback(() => {
    updateProgress({
      status: "Starting scan...",
      speed: 0,
      eta: "",
      progress: 0,
      isActive: true,
    });
  }, [updateProgress]);

  const complete = useCallback(
    (message: string) => {
      updateProgress({
        status: message,
        speed: 0,
        eta: "",
        progress: 1,
        isActive: false,
      });
    },
    [updateProgress],
  );

  const error = useCallback(
    (message: string) => {
      updateProgress({
        status: message,
        isActive: false,
      });
    },
    [updateProgress],
  );

  return {
    sharedValues,
    onProgress,
    start,
    complete,
    error,
    reset,
  };
}
