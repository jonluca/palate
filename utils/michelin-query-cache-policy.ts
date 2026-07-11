import type { QueryClient } from "@tanstack/query-core";

export interface MichelinInitializationResult {
  readonly loaded: number;
  readonly skipped: boolean;
}

export const MICHELIN_INITIALIZATION_QUERY_KEY = ["static", "michelinInitialization"] as const;

/** Static guide-derived projections remain valid until their dataset-version key changes. */
export const MICHELIN_STATIC_QUERY_CACHE_POLICY = {
  staleTime: Infinity,
  gcTime: Infinity,
} as const;

/**
 * Cache initialization in QueryClient itself so concurrent consumers dedupe,
 * while Reset Everything's queryClient.clear() removes the success marker and
 * makes the next consumer import the guide again.
 */
export async function ensureMichelinDataInitialized(
  queryClient: QueryClient,
  initialize: () => Promise<MichelinInitializationResult>,
  invalidatePendingReview: () => Promise<unknown>,
): Promise<MichelinInitializationResult> {
  return queryClient.ensureQueryData({
    queryKey: MICHELIN_INITIALIZATION_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const result = await initialize();
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Michelin initialization was cancelled");
      }
      if (result.loaded > 0) {
        await invalidatePendingReview();
      }
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Michelin initialization was cancelled");
      }
      return result;
    },
    ...MICHELIN_STATIC_QUERY_CACHE_POLICY,
  });
}
