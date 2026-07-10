export interface VisitMergeRetryPolicy {
  readonly retryWindowMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface VisitMergeRetryRuntime {
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export const VISIT_MERGE_RETRY_POLICY = {
  retryWindowMs: 5_000,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
} as const satisfies VisitMergeRetryPolicy;

export function isVisitMergeDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy");
}

/**
 * Retry one atomic visit-merge operation across SQLite writer contention.
 *
 * The deadline uses a monotonic clock while `updatedAt` uses wall time. Runtime
 * injection keeps the production policy deterministic and instant in tests.
 */
export async function runVisitMergeWithBusyRetry<T>(
  operation: (updatedAt: number) => Promise<T>,
  runtime: VisitMergeRetryRuntime,
  policy: VisitMergeRetryPolicy = VISIT_MERGE_RETRY_POLICY,
): Promise<T> {
  const retryDeadline = runtime.monotonicNow() + policy.retryWindowMs;
  let retryDelayMs = policy.baseDelayMs;

  while (true) {
    // One timestamp represents the atomic attempt. Refresh it after lock waits
    // so a successful retry cannot appear older than the contention interval.
    const updatedAt = runtime.wallNow();
    try {
      return await operation(updatedAt);
    } catch (error) {
      if (!isVisitMergeDatabaseBusyError(error)) {
        throw error;
      }
      const remainingRetryMs = retryDeadline - runtime.monotonicNow();
      if (remainingRetryMs <= 0) {
        throw error;
      }
      await runtime.sleep(Math.min(retryDelayMs, remainingRetryMs));
      retryDelayMs = Math.min(retryDelayMs * 2, policy.maxDelayMs);
    }
  }
}
