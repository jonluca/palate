import type { QueryClient } from "@tanstack/query-core";

/**
 * Review data is expensive to materialize, so a fresh cache entry should be
 * reused across navigation remounts. Relevant mutations explicitly invalidate
 * this key when the underlying visit/photo state changes.
 */
export const REVIEW_QUERY_MOUNT_POLICY = {
  staleTime: 30_000,
  refetchOnMount: true,
} as const;

export const reviewQueryKeys = {
  pendingReview: ["visits", "pendingReview"] as const,
  unanalyzedPhotoCount: ["unanalyzedPhotoCount"] as const,
};

export const REVIEW_REFRESH_QUERY_KEYS = [reviewQueryKeys.pendingReview, reviewQueryKeys.unanalyzedPhotoCount] as const;

/**
 * Reconcile the expensive review query after a mutation changes one of its rows.
 * Active consumers refresh immediately; inactive data stays invalidated so the
 * stale-aware mount policy refreshes it on the next visit to Review.
 */
export async function invalidatePendingReviewQuery(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pendingReview,
    exact: true,
    refetchType: "active",
  });
}

/** Refresh only data rendered by the Review screen, preserving unrelated caches. */
export async function refreshReviewQueries(queryClient: Pick<QueryClient, "refetchQueries">): Promise<void> {
  await Promise.all(
    REVIEW_REFRESH_QUERY_KEYS.map((queryKey) =>
      queryClient.refetchQueries({
        queryKey,
        exact: true,
        type: "active",
      }),
    ),
  );
}
