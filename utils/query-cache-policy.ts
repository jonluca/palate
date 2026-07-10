import type { QueryClient } from "@tanstack/query-core";

type QueryInvalidator = Pick<QueryClient, "invalidateQueries">;

export const WRAPPED_QUERY_KEY = ["wrapped"] as const;

/**
 * Reconcile every cache whose result can change when a visit changes status.
 * Wrapped queries deliberately stay fresh forever between these mutations.
 */
export function invalidateVisitStatusQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({ queryKey: ["visits"] });
  void queryClient.invalidateQueries({ queryKey: ["confirmedRestaurants"] });
  void queryClient.invalidateQueries({ queryKey: ["stats"] });
  void queryClient.invalidateQueries({ queryKey: WRAPPED_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["michelinRestaurantSearch"] });
}

export function invalidateWrappedStatsQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({ queryKey: WRAPPED_QUERY_KEY });
}
