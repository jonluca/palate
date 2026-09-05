export interface TransactionRetryPolicy {
  readonly retryWindowMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface TransactionRetryRuntime {
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_TRANSACTION_RETRY_RUNTIME: TransactionRetryRuntime = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export const TRANSACTION_RETRY_POLICY = {
  retryWindowMs: 5_000,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
} as const satisfies TransactionRetryPolicy;

export function isSQLiteBusyError(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }
  const message = cause.message.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy");
}

/**
 * Retry one complete atomic transaction across SQLite writer contention.
 *
 * Expo exclusive connections do not inherit the main connection busy timeout.
 * Retry after rollback with a fresh read snapshot, including SQLITE_BUSY_SNAPSHOT.
 * The deadline uses a monotonic clock while `updatedAt` uses wall time. Runtime
 * injection keeps the production policy deterministic and instant in tests.
 */
export async function runTransactionWithBusyRetry<T>(
  operation: (updatedAt: number) => Promise<T>,
  runtime: TransactionRetryRuntime = DEFAULT_TRANSACTION_RETRY_RUNTIME,
  policy: TransactionRetryPolicy = TRANSACTION_RETRY_POLICY,
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
      if (!isSQLiteBusyError(error)) {
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
