export const AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT = 1_000;
/** Leave the first foreground interaction window entirely to visible UI work. */
export const AUTOMATIC_PHOTO_RESCAN_START_DELAY_MS = 5_000;
/** Keep each automatic queued Vision batch short enough not to monopolize PhotoKit while the app is in use. */
export const AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE = 24;

export function shouldAutomaticallyRescanPhotos(
  pendingPhotoCount: number,
  exclusiveLimit: number = AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT,
): boolean {
  return (
    Number.isSafeInteger(pendingPhotoCount) &&
    Number.isSafeInteger(exclusiveLimit) &&
    pendingPhotoCount > 0 &&
    pendingPhotoCount < exclusiveLimit
  );
}

export function shouldRunAutomaticPhotoQuickScan(
  pendingPhotoCount: number,
  quickPipelineIncomplete: boolean,
  exclusiveLimit: number = AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT,
): boolean {
  return (
    shouldAutomaticallyRescanPhotos(pendingPhotoCount, exclusiveLimit) ||
    (quickPipelineIncomplete &&
      Number.isSafeInteger(pendingPhotoCount) &&
      Number.isSafeInteger(exclusiveLimit) &&
      pendingPhotoCount >= 0 &&
      pendingPhotoCount < exclusiveLimit)
  );
}

interface AutomaticPhotoScanSequenceDependencies<Result> {
  shouldRunQuickScan: boolean;
  scanPhotos: () => Promise<Result>;
  getDeepScanCandidates: () => Promise<Array<{ id: string }>>;
  deepScanPhotos: (photos: Array<{ id: string }>) => Promise<unknown>;
  finalizeDeepScanQueue: () => Promise<void>;
}

/** Run an optional quick import, then drain one durable deep-scan batch. */
export async function runAutomaticPhotoScanSequence<Result>(
  dependencies: AutomaticPhotoScanSequenceDependencies<Result>,
): Promise<Result | null> {
  let result: Result | null = null;
  let operationFailed = false;
  let operationError: unknown;

  try {
    if (dependencies.shouldRunQuickScan) {
      result = await dependencies.scanPhotos();
    }
    const deepScanCandidates = await dependencies.getDeepScanCandidates();
    if (deepScanCandidates.length > 0) {
      await dependencies.deepScanPhotos(deepScanCandidates);
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
  onError?: (error: unknown) => void;
}

export interface AutomaticPhotoRescanController {
  handleAppStateChange: (nextState: string) => void;
  dispose: () => void;
  waitForIdle: () => Promise<void>;
}

/**
 * Coordinates one automatic rescan attempt per active app cycle.
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

  const reportError = (error: unknown) => {
    try {
      dependencies.onError?.(error);
    } catch {
      // Error reporting must not create an unhandled rejection in a lifecycle callback.
    }
  };

  const startNextEligibleAttempt = () => {
    if (disposed || currentAppState !== "active" || activeRun !== null || attemptedCycle >= activeCycle) {
      return;
    }

    const cycle = activeCycle;
    attemptedCycle = cycle;

    const run = (async () => {
      if (!dependencies.canRun()) {
        return;
      }

      const hasPermission = await dependencies.hasPhotoLibraryPermission();
      if (disposed || currentAppState !== "active" || cycle !== activeCycle || !hasPermission) {
        return;
      }

      if (disposed || currentAppState !== "active" || cycle !== activeCycle || !dependencies.canRun()) {
        return;
      }

      await dependencies.runAttempt();
    })()
      .catch(reportError)
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
