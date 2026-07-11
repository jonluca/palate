import type { QueryClient, QueryKey } from "@tanstack/query-core";

type QueryInvalidator = Pick<QueryClient, "invalidateQueries" | "resetQueries">;

export const WRAPPED_QUERY_KEY = ["wrapped"] as const;
export const VISIT_LIST_PAGE_QUERY_ROOT = ["visits", "pages"] as const;
export const VISIT_LIST_QUERY_POLICY = { staleTime: Infinity } as const;

export function isVisitListPageQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === VISIT_LIST_PAGE_QUERY_ROOT[0] && queryKey[1] === VISIT_LIST_PAGE_QUERY_ROOT[1];
}

/**
 * Drop every loaded continuation page before refreshing. TanStack otherwise
 * refetches all pages of an invalidated infinite query in sequence.
 */
export function resetVisitListPageQueries(queryClient: QueryInvalidator): Promise<void> {
  return queryClient.resetQueries({ queryKey: VISIT_LIST_PAGE_QUERY_ROOT });
}

/**
 * Refresh the whole query cache without retaining every loaded visit-list page.
 * Inactive page queries are cleared, while an active page query refetches only
 * its initial page before the remaining non-page queries are invalidated.
 */
export async function refreshAllQueriesWithVisitListPageReset(queryClient: QueryInvalidator): Promise<void> {
  await resetVisitListPageQueries(queryClient);
  await queryClient.invalidateQueries({ predicate: (query) => !isVisitListPageQueryKey(query.queryKey) });
}

function invalidateNonPagedVisitQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({
    queryKey: ["visits"],
    predicate: (query) => !isVisitListPageQueryKey(query.queryKey),
  });
}

/**
 * Reconcile general caches whose result can change when a visit changes status.
 * The large pending-review cache is intentionally outside this key family: its
 * mutations either update it exactly or invalidate it explicitly when they
 * cannot. Wrapped queries deliberately stay fresh forever between mutations.
 */
export function invalidateVisitStatusQueries(queryClient: QueryInvalidator): void {
  void resetVisitListPageQueries(queryClient);
  invalidateNonPagedVisitQueries(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["confirmedRestaurants"] });
  void queryClient.invalidateQueries({ queryKey: ["stats"] });
  void queryClient.invalidateQueries({ queryKey: WRAPPED_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["michelinRestaurantSearch"] });
  void queryClient.invalidateQueries({ queryKey: ["michelinMapViewport"] });
}

export function invalidateWrappedStatsQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({ queryKey: WRAPPED_QUERY_KEY });
}
