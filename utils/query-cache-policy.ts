import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/query-core";

type QueryInvalidator = Pick<QueryClient, "cancelQueries" | "invalidateQueries" | "setQueriesData">;

export const WRAPPED_QUERY_KEY = ["wrapped"] as const;
export const VISIT_LIST_PAGE_QUERY_ROOT = ["visits", "pages"] as const;
export const VISIT_LIST_QUERY_POLICY = { staleTime: Infinity } as const;

export function isVisitListPageQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === VISIT_LIST_PAGE_QUERY_ROOT[0] && queryKey[1] === VISIT_LIST_PAGE_QUERY_ROOT[1];
}

/**
 * Retain one populated page for every filter while dropping continuations that
 * TanStack would otherwise refetch serially on the next navigation.
 */
function retainFirstVisitListPage(queryClient: QueryInvalidator): void {
  queryClient.setQueriesData<InfiniteData<unknown, unknown>>({ queryKey: VISIT_LIST_PAGE_QUERY_ROOT }, (current) =>
    current && current.pages.length > 1
      ? {
          ...current,
          pages: current.pages.slice(0, 1),
          pageParams: current.pageParams.slice(0, 1),
        }
      : current,
  );
}

/**
 * Cancel any continuation, preserve the first visible page, and reconcile only
 * that page for active screens. Inactive filters remain warm and stale until
 * they are opened again.
 */
export async function invalidateVisitListPageQueries(queryClient: QueryInvalidator): Promise<void> {
  await queryClient.cancelQueries({ queryKey: VISIT_LIST_PAGE_QUERY_ROOT });
  retainFirstVisitListPage(queryClient);
  await queryClient.invalidateQueries({ queryKey: VISIT_LIST_PAGE_QUERY_ROOT });
}

export function resetVisitListPageQueries(queryClient: QueryInvalidator): Promise<void> {
  return invalidateVisitListPageQueries(queryClient);
}

/**
 * Refresh the whole query cache without refetching every loaded active page.
 * Every page query stays populated with its first page, while an active query
 * refetches only that page before the remaining non-page queries are invalidated.
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
  void invalidateVisitListPageQueries(queryClient);
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
