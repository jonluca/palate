import {
  AsyncResultBuffer,
  DEFAULT_VISION_NATIVE_PAGE_SIZE,
  DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
} from "./food-detection-buffer-core.ts";

/** Configures {@linkcode runBufferedResultPersistence}. */
export interface BufferedResultPersistenceOptions<T, Result> {
  /**
   * Produces ordered result pages. Await `appendResults` for every page so a
   * persistence rejection stops further production.
   */
  readonly process: (appendResults: (results: readonly T[]) => Promise<void>) => Promise<Result>;

  /**
   * Atomically persists one ordered batch. A rejection is never automatically
   * retried by the orchestration lifecycle.
   */
  readonly persist: (results: readonly T[]) => Promise<void>;

  /**
   * Refreshes state derived from persisted results. It runs after every normal
   * completion and after a failed run when at least one persistence operation
   * succeeded.
   */
  readonly synchronize?: () => Promise<void>;

  /**
   * Runs only after processing, the final force-flush, and synchronization all
   * succeed. This is the safe place to emit terminal progress.
   */
  readonly onComplete?: (result: Result) => void | Promise<void>;

  /**
   * Number of pending results persisted by each full operation.
   *
   * @default DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE
   */
  readonly persistenceFlushSize?: number;

  /**
   * Largest result page accepted from {@linkcode process}.
   *
   * @default DEFAULT_VISION_NATIVE_PAGE_SIZE
   */
  readonly maximumPageSize?: number;
}

function createAggregateFailure(primaryError: unknown, additionalErrors: readonly unknown[]): AggregateError {
  return new AggregateError(
    [primaryError, ...additionalErrors],
    "Buffered result processing failed with additional persistence or synchronization errors.",
  );
}

/**
 * Runs an ordered producer with bounded persistence and derived-state recovery.
 * A processing failure force-flushes its successful pending prefix. A persistence
 * rejection stops the lifecycle without retrying that batch. If any earlier
 * persistence succeeded, derived state is synchronized before the error escapes.
 *
 * Multiple failures are reported as an `AggregateError` whose first item is the
 * primary processing or persistence failure.
 */
export async function runBufferedResultPersistence<T, Result>(
  options: BufferedResultPersistenceOptions<T, Result>,
): Promise<Result> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Buffered result persistence options must be an object.");
  }
  if (typeof options.process !== "function") {
    throw new TypeError("Buffered result processing must be a function.");
  }
  if (typeof options.persist !== "function") {
    throw new TypeError("Buffered result persistence must be a function.");
  }
  if (options.synchronize !== undefined && typeof options.synchronize !== "function") {
    throw new TypeError("Buffered result synchronization must be a function when provided.");
  }
  if (options.onComplete !== undefined && typeof options.onComplete !== "function") {
    throw new TypeError("Buffered result completion must be a function when provided.");
  }

  let didPersistenceFail = false;
  let persistenceFailure: unknown;
  let successfulPersistenceOperations = 0;
  const buffer = new AsyncResultBuffer<T>({
    maximumPageSize: options.maximumPageSize ?? DEFAULT_VISION_NATIVE_PAGE_SIZE,
    persistenceFlushSize: options.persistenceFlushSize ?? DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    persist: async (results) => {
      try {
        await options.persist(results);
        successfulPersistenceOperations += 1;
      } catch (error) {
        didPersistenceFail = true;
        persistenceFailure = error;
        throw error;
      }
    },
  });

  const appendResults = async (results: readonly T[]): Promise<void> => {
    if (didPersistenceFail) {
      throw persistenceFailure;
    }
    await buffer.append(results);
  };

  let result: Result;
  try {
    result = await options.process(appendResults);
    if (didPersistenceFail) {
      throw persistenceFailure;
    }
    await buffer.flush();
  } catch (primaryError) {
    const additionalErrors: unknown[] = [];

    if (!didPersistenceFail && buffer.pendingCount > 0) {
      try {
        await buffer.flush();
      } catch (flushError) {
        additionalErrors.push(flushError);
      }
    } else if (didPersistenceFail && !Object.is(primaryError, persistenceFailure)) {
      additionalErrors.push(persistenceFailure);
    }

    if (successfulPersistenceOperations > 0 && options.synchronize) {
      try {
        await options.synchronize();
      } catch (synchronizationError) {
        additionalErrors.push(synchronizationError);
      }
    }

    if (additionalErrors.length > 0) {
      throw createAggregateFailure(primaryError, additionalErrors);
    }
    throw primaryError;
  }

  await options.synchronize?.();
  await options.onComplete?.(result);
  return result;
}
