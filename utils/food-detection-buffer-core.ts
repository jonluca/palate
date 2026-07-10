/** Default maximum result page returned by the native Vision pipeline. */
export const DEFAULT_VISION_NATIVE_PAGE_SIZE = 1_000;

/** Conservative page size used by binaries that predate the advertised native constant. */
export const LEGACY_VISION_NATIVE_PAGE_SIZE = 50;

/** Largest supported native Vision result page used for controlled tuning. */
export const MAXIMUM_VISION_NATIVE_PAGE_SIZE = 2_000;

/** Default number of Vision results persisted in one database operation. */
export const DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE = 1_000;

/**
 * Accepts a bounded page size advertised by the installed native module.
 * Binaries that omit the constant and invalid values retain the legacy 50-row
 * boundary so an over-the-air JavaScript update cannot enlarge untested native work.
 */
export function resolveVisionNativePageSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAXIMUM_VISION_NATIVE_PAGE_SIZE
  ) {
    return LEGACY_VISION_NATIVE_PAGE_SIZE;
  }
  return value;
}

/** Configures an {@link AsyncResultBuffer}. */
export interface AsyncResultBufferOptions<T> {
  /**
   * Persists one ordered result batch. The operation should be atomic or
   * otherwise safe to retry when it rejects.
   */
  readonly persist: (results: readonly T[]) => Promise<void>;

  /**
   * Number of pending results written by each automatic persistence operation.
   *
   * @default DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE
   */
  readonly persistenceFlushSize?: number;

  /**
   * Largest result page accepted by {@link AsyncResultBuffer.append}.
   * Bounding each input page also bounds retained rows if persistence fails.
   *
   * @default DEFAULT_VISION_NATIVE_PAGE_SIZE
   */
  readonly maximumPageSize?: number;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer; received ${value}.`);
  }
}

/**
 * Buffers ordered result pages and persists them in bounded asynchronous batches.
 * Rows are removed only after their persistence operation resolves successfully,
 * so a rejected flush can be retried without reconstructing its input.
 *
 * Callers must await each operation. Concurrent append or flush calls reject to
 * prevent duplicate persistence of the same pending prefix.
 *
 * @example
 * ```ts
 * const buffer = new AsyncResultBuffer({ persist: saveResults });
 * await buffer.append(nativeResultsPage);
 * await buffer.flush();
 * ```
 */
export class AsyncResultBuffer<T> {
  /** Number of rows written by each full persistence operation. */
  readonly persistenceFlushSize: number;

  /** Largest result page accepted by {@link AsyncResultBuffer.append}. */
  readonly maximumPageSize: number;

  private readonly persistResults: (results: readonly T[]) => Promise<void>;
  private readonly pendingResults: T[] = [];
  private maximumPendingCount = 0;
  private operationInProgress = false;

  /** Creates an empty result buffer. */
  constructor(options: AsyncResultBufferOptions<T>) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Async result buffer options must be an object.");
    }
    if (typeof options.persist !== "function") {
      throw new TypeError("Async result buffer persistence must be a function.");
    }

    const persistenceFlushSize = options.persistenceFlushSize ?? DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE;
    const maximumPageSize = options.maximumPageSize ?? DEFAULT_VISION_NATIVE_PAGE_SIZE;
    assertPositiveSafeInteger(persistenceFlushSize, "Persistence flush size");
    assertPositiveSafeInteger(maximumPageSize, "Maximum page size");

    this.persistResults = options.persist;
    this.persistenceFlushSize = persistenceFlushSize;
    this.maximumPageSize = maximumPageSize;
  }

  /** Number of results currently waiting for successful persistence. */
  get pendingCount(): number {
    return this.pendingResults.length;
  }

  /** Largest number of results retained by this buffer since construction. */
  get maximumPendingCountObserved(): number {
    return this.maximumPendingCount;
  }

  /**
   * Appends one ordered result page and persists every newly completed full batch.
   * If persistence rejects, all rows from the rejected batch remain pending.
   *
   * @throws {RangeError} When `results` exceeds {@link maximumPageSize}.
   */
  async append(results: readonly T[]): Promise<void> {
    if (!Array.isArray(results)) {
      throw new TypeError("Async result buffer input must be an array.");
    }
    if (results.length > this.maximumPageSize) {
      throw new RangeError(
        `Async result buffer pages support at most ${this.maximumPageSize} rows; received ${results.length}.`,
      );
    }
    // Capture the page before any retry of an earlier failed full flush. This
    // prevents later caller mutation of the input array from changing its order.
    const page = results.slice();
    await this.runExclusive(async () => {
      if (page.length === 0) {
        return;
      }

      // A previous failed automatic flush may have left a complete batch. Retry
      // it before accepting more rows so repeated failures cannot grow the buffer.
      await this.flushCompleteBatches();

      // Avoid passing the complete page as function arguments; callers may
      // configure page sizes above a JavaScript engine's spread argument limit.
      for (const result of page) {
        this.pendingResults.push(result);
      }
      this.maximumPendingCount = Math.max(this.maximumPendingCount, this.pendingResults.length);
      await this.flushCompleteBatches();
    });
  }

  /**
   * Persists all pending results, including a final batch smaller than
   * {@link persistenceFlushSize}. A rejected batch remains pending for retry.
   */
  async flush(): Promise<void> {
    await this.runExclusive(async () => {
      while (this.pendingResults.length > 0) {
        await this.persistPendingPrefix(Math.min(this.persistenceFlushSize, this.pendingResults.length));
      }
    });
  }

  private async flushCompleteBatches(): Promise<void> {
    while (this.pendingResults.length >= this.persistenceFlushSize) {
      await this.persistPendingPrefix(this.persistenceFlushSize);
    }
  }

  private async persistPendingPrefix(count: number): Promise<void> {
    const batch = this.pendingResults.slice(0, count);
    await this.persistResults(batch);
    // Do not mutate pendingResults until persistence has fully succeeded.
    this.pendingResults.splice(0, count);
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    if (this.operationInProgress) {
      throw new Error("Async result buffer operations must be awaited and cannot overlap.");
    }

    this.operationInProgress = true;
    try {
      await operation();
    } finally {
      this.operationInProgress = false;
    }
  }
}
