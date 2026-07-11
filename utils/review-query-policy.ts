import type { InfiniteData, QueryClient } from "@tanstack/query-core";
import {
  summarizePendingVisitReviewGeneration,
  type PendingVisitReviewGeneration,
  type PendingVisitReviewPage,
  type PendingVisitReviewPageRequest,
} from "./db/visit-review-paging-core.ts";

export interface PendingReviewCacheData<
  Visit extends { readonly id: string },
  ExactMatch extends { readonly visitId: string },
> {
  readonly visits: Visit[];
  readonly exactMatches: ExactMatch[];
}

export type PendingReviewInfiniteData<Visit> = InfiniteData<
  PendingVisitReviewPage<Visit>,
  PendingVisitReviewPageRequest | null
>;

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
  // Keep this expensive, independently reconciled payload outside the broad
  // ["visits"] family. Confirm/reject mutations update it optimistically; a
  // prefix invalidation for ordinary visit lists must not immediately replace
  // that exact cache update with another full Review materialization.
  pendingReview: ["review", "pendingVisits"] as const,
  pendingReviewPagesRoot: ["review", "pendingVisits", "pages"] as const,
  pendingReviewPages: (food: "on" | "off", restaurantMatches: "on" | "off") =>
    ["review", "pendingVisits", "pages", food, restaurantMatches] as const,
  unanalyzedPhotoCount: ["unanalyzedPhotoCount"] as const,
};

export const REVIEW_REFRESH_QUERY_KEYS = [reviewQueryKeys.pendingReview, reviewQueryKeys.unanalyzedPhotoCount] as const;

/** Serialize the database phase while still allowing every queued optimistic update to paint immediately. */
export const REVIEW_STATUS_MUTATION_SCOPE = { id: "pending-review-status" } as const;

function restoreItemsFromSnapshot<Item>(
  currentItems: readonly Item[],
  previousItems: readonly Item[],
  identifiersToRestore: ReadonlySet<string>,
  getIdentifier: (item: Item) => string,
): Item[] {
  const currentIndexByIdentifier = new Map(currentItems.map((item, index) => [getIdentifier(item), index]));
  const previousCurrentIndices = previousItems.map((item) => currentIndexByIdentifier.get(getIdentifier(item)) ?? -1);
  const predecessorIndices = new Array<number>(previousItems.length).fill(-1);
  const successorIndices = new Array<number>(previousItems.length).fill(-1);
  let nearestCurrentIndex = -1;
  for (let index = 0; index < previousItems.length; index++) {
    predecessorIndices[index] = nearestCurrentIndex;
    if (previousCurrentIndices[index] !== -1) {
      nearestCurrentIndex = previousCurrentIndices[index];
    }
  }
  nearestCurrentIndex = -1;
  for (let index = previousItems.length - 1; index >= 0; index--) {
    successorIndices[index] = nearestCurrentIndex;
    if (previousCurrentIndices[index] !== -1) {
      nearestCurrentIndex = previousCurrentIndices[index];
    }
  }

  const before = Array.from({ length: currentItems.length }, () => [] as Item[]);
  const after = Array.from({ length: currentItems.length }, () => [] as Item[]);
  const unanchored: Item[] = [];
  for (const [previousIndex, previousItem] of previousItems.entries()) {
    const identifier = getIdentifier(previousItem);
    if (!identifiersToRestore.has(identifier) || currentIndexByIdentifier.has(identifier)) {
      continue;
    }
    const successorIndex = successorIndices[previousIndex];
    if (successorIndex !== -1) {
      before[successorIndex].push(previousItem);
      continue;
    }
    const predecessorIndex = predecessorIndices[previousIndex];
    if (predecessorIndex !== -1) {
      after[predecessorIndex].push(previousItem);
      continue;
    }
    unanchored.push(previousItem);
  }

  const restored: Item[] = [];
  for (const [index, currentItem] of currentItems.entries()) {
    restored.push(...before[index], currentItem, ...after[index]);
  }
  restored.push(...unanchored);
  return restored;
}

function removeIdsFromGeneration(
  generation: PendingVisitReviewGeneration,
  identifiers: ReadonlySet<string>,
): PendingVisitReviewGeneration {
  const records = generation.records.filter((record) => !identifiers.has(record.id));
  const selectedKeys = generation.selectedKeys.filter((key) => !identifiers.has(key.id));
  const exactConfirmations = generation.exactConfirmations.filter(
    (confirmation) => !identifiers.has(confirmation.visitId),
  );
  return {
    ...generation,
    records,
    selectedKeys,
    exactConfirmations,
    summary: summarizePendingVisitReviewGeneration(records, selectedKeys, exactConfirmations),
  };
}

function restoreGenerationIds(
  current: PendingVisitReviewGeneration,
  previous: PendingVisitReviewGeneration,
  identifiers: ReadonlySet<string>,
): PendingVisitReviewGeneration {
  if (current.generationId !== previous.generationId) {
    return current;
  }
  const records = restoreItemsFromSnapshot(current.records, previous.records, identifiers, (record) => record.id);
  const selectedKeys = restoreItemsFromSnapshot(
    current.selectedKeys,
    previous.selectedKeys,
    identifiers,
    (key) => key.id,
  );
  const exactConfirmations = restoreItemsFromSnapshot(
    current.exactConfirmations,
    previous.exactConfirmations,
    identifiers,
    (confirmation) => confirmation.visitId,
  );
  return {
    ...current,
    records,
    selectedKeys,
    exactConfirmations,
    summary: summarizePendingVisitReviewGeneration(records, selectedKeys, exactConfirmations),
  };
}

/** Remove optimistic status changes from every loaded page and its global manifest. */
export function removePendingReviewInfiniteVisits<Visit extends { readonly id: string }>(
  current: PendingReviewInfiniteData<Visit> | undefined,
  visitIds: readonly string[],
): PendingReviewInfiniteData<Visit> | undefined {
  if (!current || visitIds.length === 0) {
    return current;
  }
  const identifiers = new Set(visitIds);
  return {
    pageParams: current.pageParams,
    pages: current.pages.map((page, index) => ({
      ...page,
      visits: page.visits.filter((visit) => !identifiers.has(visit.id)),
      manifest: index === 0 && page.manifest ? removeIdsFromGeneration(page.manifest, identifiers) : page.manifest,
    })),
  };
}

/** Selectively restore a failed optimistic removal without undoing independent successes. */
export function restoreFailedPendingReviewInfiniteMutation<Visit extends { readonly id: string }>(
  current: PendingReviewInfiniteData<Visit> | undefined,
  previous: PendingReviewInfiniteData<Visit> | undefined,
  visitIds: readonly string[],
): PendingReviewInfiniteData<Visit> | undefined {
  if (!current || !previous || visitIds.length === 0) {
    return current;
  }
  const currentManifest = current.pages[0]?.manifest;
  const previousManifest = previous.pages[0]?.manifest;
  if (!currentManifest || !previousManifest || currentManifest.generationId !== previousManifest.generationId) {
    return current;
  }

  const identifiers = new Set(visitIds);
  const previousVisits = new Map(previous.pages.flatMap((page) => page.visits).map((visit) => [visit.id, visit]));
  return {
    pageParams: current.pageParams,
    pages: current.pages.map((page, pageIndex) => {
      const visitById = new Map(page.visits.map((visit) => [visit.id, visit]));
      for (const key of page.requestedKeys) {
        if (identifiers.has(key.id) && !visitById.has(key.id)) {
          const previousVisit = previousVisits.get(key.id);
          if (previousVisit) {
            visitById.set(key.id, previousVisit);
          }
        }
      }
      return {
        ...page,
        visits: page.requestedKeys.flatMap((key) => {
          const visit = visitById.get(key.id);
          return visit ? [visit] : [];
        }),
        manifest:
          pageIndex === 0 && page.manifest
            ? restoreGenerationIds(page.manifest, previousManifest, identifiers)
            : page.manifest,
      };
    }),
  };
}

/**
 * Roll back only the rows owned by one failed optimistic mutation.
 * Whole-cache restoration can resurrect rows removed by another successful
 * mutation. The caller supplies the shared pre-group baseline so every queued
 * rollback retains the same visit and exact-match order.
 */
export function restoreFailedPendingReviewMutation<
  Visit extends { readonly id: string },
  ExactMatch extends { readonly visitId: string },
>(
  current: PendingReviewCacheData<Visit, ExactMatch> | undefined,
  previous: PendingReviewCacheData<Visit, ExactMatch> | undefined,
  visitIds: readonly string[],
): PendingReviewCacheData<Visit, ExactMatch> | undefined {
  if (!current || !previous || visitIds.length === 0) {
    return current;
  }
  const identifiersToRestore = new Set(visitIds);
  const currentVisitIds = new Set(current.visits.map((visit) => visit.id));
  const currentExactMatchIds = new Set(current.exactMatches.map((match) => match.visitId));
  const hasVisitToRestore = previous.visits.some(
    (visit) => identifiersToRestore.has(visit.id) && !currentVisitIds.has(visit.id),
  );
  const hasExactMatchToRestore = previous.exactMatches.some(
    (match) => identifiersToRestore.has(match.visitId) && !currentExactMatchIds.has(match.visitId),
  );
  if (!hasVisitToRestore && !hasExactMatchToRestore) {
    return current;
  }
  return {
    visits: restoreItemsFromSnapshot(current.visits, previous.visits, identifiersToRestore, (visit) => visit.id),
    exactMatches: restoreItemsFromSnapshot(
      current.exactMatches,
      previous.exactMatches,
      identifiersToRestore,
      (match) => match.visitId,
    ),
  };
}

/**
 * Reconcile the expensive review query after a mutation changes one of its rows.
 * Active consumers refresh immediately; inactive data stays invalidated so the
 * stale-aware mount policy refreshes it on the next visit to Review.
 */
export async function invalidatePendingReviewQuery(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pendingReview,
    exact: false,
    refetchType: "active",
  });
}

/**
 * Keep an exact optimistic result visible while ensuring it is reconciled on
 * the next mount, focus, or manual refresh. This intentionally does not fetch
 * an already-active observer.
 */
export async function markPendingReviewQueryStale(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pendingReview,
    exact: false,
    refetchType: "none",
  });
}

/** Cancel a refresh that began after optimistic mutation setup so it cannot publish a pre-write snapshot. */
export async function interruptPendingReviewRefreshForMutationSettlement(
  queryClient: Pick<QueryClient, "cancelQueries" | "getQueryCache">,
  refreshAlreadyNeedsReconciliation: boolean,
): Promise<boolean> {
  const refreshStartedDuringMutation = queryClient
    .getQueryCache()
    .findAll({ queryKey: reviewQueryKeys.pendingReview })
    .some((query) => query.state.fetchStatus === "fetching");
  if (refreshStartedDuringMutation) {
    await queryClient.cancelQueries({
      queryKey: reviewQueryKeys.pendingReview,
      exact: false,
    });
  }
  return refreshAlreadyNeedsReconciliation || refreshStartedDuringMutation;
}

/** Refresh only data rendered by the Review screen, preserving unrelated caches. */
export async function refreshReviewQueries(queryClient: Pick<QueryClient, "refetchQueries">): Promise<void> {
  await Promise.all([
    queryClient.refetchQueries({
      queryKey: reviewQueryKeys.pendingReview,
      exact: false,
      type: "active",
    }),
    queryClient.refetchQueries({
      queryKey: reviewQueryKeys.unanalyzedPhotoCount,
      exact: true,
      type: "active",
    }),
  ]);
}
