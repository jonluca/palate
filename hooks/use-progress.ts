import { useCallback } from "react";
import { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";

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
      if (data.status !== undefined) {
        statusRef.set(data.status);
      }
      if (data.speed !== undefined) {
        speedRef.set(data.speed);
      }
      if (data.eta !== undefined) {
        etaRef.set(data.eta);
      }
      if (data.progress !== undefined) {
        progressRef.set(withTiming(data.progress, { duration: 200 }));
      }
      if (data.isActive !== undefined) {
        isActiveRef.set(data.isActive);
      }
    },
    [statusRef, speedRef, etaRef, progressRef, isActiveRef],
  );

  const updateProgress = useCallback(
    (data: Partial<ProgressData>) => {
      scheduleOnUI(updateProgressWorklet, data);
    },
    [updateProgressWorklet],
  );

  return updateProgress;
}

/**
 * Hook for scan progress with worklet-safe callbacks
 */
export function useScanProgress() {
  const sharedValues = useProgressSharedValues();
  const updateProgress = useProgressUpdater(sharedValues);

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
  };
}
