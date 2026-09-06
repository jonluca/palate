/** Keep each automatic queued Vision batch short enough not to monopolize PhotoKit while the app is in use. */
export const AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE = 24;

export type AutomaticPhotoQuickScanPhase =
  | "scanning"
  | "grouping-visits"
  | "calendar-events"
  | "calendar-only-visits"
  | "detecting-food"
  | "optimizing-database";

type ProgressRange = readonly [start: number, end: number];

const QUICK_SCAN_RANGES_WITH_DEEP_SCAN_RESERVE = {
  scanning: [0.06, 0.36],
  "grouping-visits": [0.36, 0.52],
  "calendar-events": [0.52, 0.64],
  "calendar-only-visits": [0.64, 0.68],
  "detecting-food": [0.68, 0.7],
  "optimizing-database": [0.7, 0.72],
} satisfies Record<AutomaticPhotoQuickScanPhase, ProgressRange>;

const QUICK_SCAN_RANGES_WITH_INLINE_FOOD_DETECTION = {
  scanning: [0.06, 0.43],
  "grouping-visits": [0.43, 0.6],
  "calendar-events": [0.6, 0.75],
  "calendar-only-visits": [0.75, 0.8],
  "detecting-food": [0.8, 0.95],
  "optimizing-database": [0.95, 0.98],
} satisfies Record<AutomaticPhotoQuickScanPhase, ProgressRange>;

function clampProgress(progress: number | undefined): number {
  if (progress === undefined || !Number.isFinite(progress)) {
    return 0;
  }
  return Math.min(1, Math.max(0, progress));
}

function scaleProgress(progress: number | undefined, [start, end]: ProgressRange): number {
  return start + (end - start) * clampProgress(progress);
}

/** Map per-phase quick-scan progress onto a stable, non-reversing overall bar. */
export function getAutomaticQuickScanOverallProgress(
  phase: AutomaticPhotoQuickScanPhase,
  phaseProgress: number | undefined,
  reserveForSeparateDeepScan: boolean,
): number {
  const ranges = reserveForSeparateDeepScan
    ? QUICK_SCAN_RANGES_WITH_DEEP_SCAN_RESERVE
    : QUICK_SCAN_RANGES_WITH_INLINE_FOOD_DETECTION;
  return scaleProgress(phaseProgress, ranges[phase]);
}

/** Map durable Vision work after the quick scan, or by itself on a later app open. */
export function getAutomaticDeepScanOverallProgress(
  processedPhotos: number,
  totalPhotos: number,
  followsQuickScan: boolean,
): number {
  const phaseProgress = totalPhotos > 0 ? processedPhotos / totalPhotos : 0;
  return scaleProgress(phaseProgress, followsQuickScan ? [0.72, 0.96] : [0.08, 0.96]);
}

export function shouldAutomaticallyRescanPhotos(pendingPhotoCount: number): boolean {
  return Number.isSafeInteger(pendingPhotoCount) && pendingPhotoCount > 0;
}

export function shouldRunAutomaticPhotoQuickScan(pendingPhotoCount: number, quickPipelineIncomplete: boolean): boolean {
  return (
    shouldAutomaticallyRescanPhotos(pendingPhotoCount) ||
    (quickPipelineIncomplete && Number.isSafeInteger(pendingPhotoCount) && pendingPhotoCount === 0)
  );
}

interface AutomaticPhotoScanSequenceDependencies<Result, DeepScanResult> {
  shouldRunQuickScan: boolean;
  scanPhotos: () => Promise<Result>;
  getDeepScanCandidates: (attemptedAssetIds: readonly string[]) => Promise<Array<{ id: string }>>;
  shouldContinue?: () => boolean;
  deepScanPhotos: (photos: Array<{ id: string }>) => Promise<DeepScanResult>;
  finalizeDeepScanQueue: () => Promise<void>;
}

/** Import new photos, then analyze each queued asset once in bounded batches. */
export async function runAutomaticPhotoScanSequence<Result, DeepScanResult>(
  dependencies: AutomaticPhotoScanSequenceDependencies<Result, DeepScanResult>,
): Promise<Result | null> {
  let result: Result | null = null;
  let operationFailed = false;
  let operationError: unknown;

  try {
    if (dependencies.shouldRunQuickScan && dependencies.shouldContinue?.() !== false) {
      result = await dependencies.scanPhotos();
    }
    const attemptedAssetIds = new Set<string>();
    while (dependencies.shouldContinue?.() !== false) {
      const candidates = await dependencies.getDeepScanCandidates([...attemptedAssetIds]);
      if (dependencies.shouldContinue?.() === false) {
        break;
      }
      const batch: Array<{ id: string }> = [];
      for (const candidate of candidates) {
        if (!attemptedAssetIds.has(candidate.id)) {
          attemptedAssetIds.add(candidate.id);
          batch.push(candidate);
        }
      }
      if (batch.length === 0) {
        break;
      }
      await dependencies.deepScanPhotos(batch);
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await dependencies.finalizeDeepScanQueue();
  } catch (cleanupError) {
    if (!operationFailed) {
      throw cleanupError;
    }
  }

  if (operationFailed) {
    throw operationError;
  }
  return result;
}

interface AutomaticPhotoRescanDependencies {
  canRun: () => boolean;
  hasPhotoLibraryPermission: () => Promise<boolean>;
  runAttempt: () => Promise<void>;
  onError?: (cause: unknown) => void;
}

export interface AutomaticPhotoRescanController {
  handleAppStateChange: (nextState: string) => void;
  handlePhotoLibraryChange: () => void;
  handleAvailabilityChange: () => void;
  isActive: () => boolean;
  dispose: () => void;
  waitForIdle: () => Promise<void>;
}

/**
 * Coalesces foreground and library changes, retrying deferred checks when scans become idle.
 *
 * The lifecycle and async policy live here so a cold launch, repeated active
 * events, and a quick background/foreground round trip cannot overlap scans.
 */
export function createAutomaticPhotoRescanController(
  dependencies: AutomaticPhotoRescanDependencies,
): AutomaticPhotoRescanController {
  let currentAppState: string | null = null;
  let activeCycle = 0;
  let attemptedCycle = 0;
  let activeRun: Promise<void> | null = null;
  let disposed = false;

  const reportError = (cause: unknown) => {
    try {
      dependencies.onError?.(cause);
    } catch {
      // Error reporting must not create an unhandled rejection in a lifecycle callback.
    }
  };

  const startNextEligibleAttempt = () => {
    if (disposed || currentAppState !== "active" || activeRun !== null || attemptedCycle >= activeCycle) {
      return;
    }

    if (!dependencies.canRun()) {
      return;
    }
    const cycle = activeCycle;

    const run = (async () => {
      const hasPermission = await dependencies.hasPhotoLibraryPermission();
      if (disposed || currentAppState !== "active" || cycle !== activeCycle) {
        return;
      }
      if (!hasPermission) {
        attemptedCycle = cycle;
        return;
      }
      if (!dependencies.canRun()) {
        return;
      }

      attemptedCycle = cycle;
      await dependencies.runAttempt();
    })()
      .catch((error) => {
        attemptedCycle = Math.max(attemptedCycle, cycle);
        reportError(error);
      })
      .finally(() => {
        if (activeRun === run) {
          activeRun = null;
        }
        // If another foreground cycle started while this attempt was winding
        // down, service that newer cycle now instead of losing the open event.
        startNextEligibleAttempt();
      });

    activeRun = run;
  };

  const handleAppStateChange = (nextState: string) => {
    const wasActive = currentAppState === "active";
    currentAppState = nextState;

    if (nextState === "active" && !wasActive) {
      activeCycle++;
      startNextEligibleAttempt();
    }
  };

  return {
    handleAppStateChange,
    handlePhotoLibraryChange: () => {
      activeCycle++;
      startNextEligibleAttempt();
    },
    handleAvailabilityChange: startNextEligibleAttempt,
    isActive: () => !disposed && currentAppState === "active",
    dispose: () => {
      disposed = true;
    },
    waitForIdle: async () => {
      while (activeRun) {
        await activeRun;
      }
    },
  };
}
