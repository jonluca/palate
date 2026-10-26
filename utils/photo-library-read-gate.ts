/** A {@link createPhotoLibraryReadGate} read exceeded its caller's deadline. */
export class PhotoLibraryReadTimeoutError extends Error {
  /** Stable identifier for a read whose underlying work may still be running. */
  readonly code = "PHOTO_LIBRARY_READ_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`Photo library read did not finish within ${timeoutMs} ms`);
    this.name = "PhotoLibraryReadTimeoutError";
  }
}

/** A {@link createPhotoLibraryReadGate} cannot admit another underlying read. */
export class PhotoLibraryReadBusyError extends Error {
  /** Stable identifier for a rejected read that was never started. */
  readonly code = "PHOTO_LIBRARY_READ_BUSY";

  constructor() {
    super("Photo library reads are still pending");
    this.name = "PhotoLibraryReadBusyError";
  }
}

/** Identifies timeout or admission failures from {@link createPhotoLibraryReadGate}. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This predicate narrows arbitrary caught rejection values.
export function isPhotoLibraryReadUnavailableError(error: unknown): boolean {
  return error instanceof PhotoLibraryReadTimeoutError || error instanceof PhotoLibraryReadBusyError;
}

/** Returned by {@link createPhotoLibraryReadGate} to bound callers and outstanding work. */
export interface PhotoLibraryReadGate {
  /**
   * Starts a read immediately, or rejects with {@link PhotoLibraryReadBusyError}.
   * A timeout releases the caller, but keeps admission until the underlying read
   * and any late-result disposal settle. Successful callers own their result.
   */
  read<Result>(
    operation: () => Promise<Result>,
    options?: {
      /** Releases a result delivered after this caller has already timed out. */
      disposeLateResult?: (result: Result) => Promise<void>;
      /** Reports a disposal failure; reporting failures cannot retain admission. */
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values have no guaranteed error type.
      onLateCleanupError?: (error: unknown) => void;
    },
  ): Promise<Result>;
  /** Whether every admission slot is occupied, including late-result disposal. */
  isBusy(): boolean;
}

/**
 * Creates a gate for reads that cannot be cancelled. Requests are never queued.
 * Use only for reads: a caller timeout does not stop the underlying operation.
 */
export function createPhotoLibraryReadGate(options: {
  /** Positive integer limit, counting timed-out work until it actually settles. */
  maximumOutstanding: number;
  /** Positive, finite caller deadline in milliseconds. */
  timeoutMs: number;
}): PhotoLibraryReadGate {
  const { maximumOutstanding, timeoutMs } = options;
  if (!Number.isSafeInteger(maximumOutstanding) || maximumOutstanding < 1) {
    throw new RangeError("maximumOutstanding must be a positive safe integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  let outstanding = 0;

  return {
    isBusy: () => outstanding >= maximumOutstanding,
    read(operation, readOptions) {
      if (outstanding >= maximumOutstanding) {
        return Promise.reject(new PhotoLibraryReadBusyError());
      }
      outstanding += 1;

      return new Promise((resolve, reject) => {
        let state: "pending" | "timed-out" = "pending";
        let timer: ReturnType<typeof setTimeout>;
        const armDeadline = (remainingMs: number) => {
          // Large finite durations must not overflow platform timers into 1 ms.
          const intervalMs = Math.min(remainingMs, 2_147_483_647);
          timer = setTimeout(() => {
            if (remainingMs > intervalMs) {
              armDeadline(remainingMs - intervalMs);
              return;
            }
            state = "timed-out";
            reject(new PhotoLibraryReadTimeoutError(timeoutMs));
          }, intervalMs);
        };
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the underlying rejection without assuming it is an Error.
        const rejectOperation = (error: unknown) => {
          clearTimeout(timer);
          outstanding -= 1;
          if (state === "pending") {
            reject(error);
          }
        };

        armDeadline(timeoutMs);
        let result: ReturnType<typeof operation>;
        try {
          result = operation();
        } catch (error) {
          rejectOperation(error);
          return;
        }

        void Promise.resolve(result).then(async (value) => {
          clearTimeout(timer);
          if (state === "pending") {
            outstanding -= 1;
            resolve(value);
            return;
          }
          try {
            await readOptions?.disposeLateResult?.(value);
          } catch (error) {
            try {
              // oxlint-disable-next-line promise/no-nesting -- Diagnostics must not extend ownership of a settled read.
              void Promise.resolve(readOptions?.onLateCleanupError?.(error)).catch(() => {
                // Also consume rejected async reporters without waiting on them.
              });
            } catch {
              // Reporting cannot prevent release after failed disposal.
            }
          } finally {
            outstanding -= 1;
          }
        }, rejectOperation);
      });
    },
  };
}
