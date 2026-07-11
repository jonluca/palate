#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
  type QueryObserverOptions,
  type QueryKey,
} from "@tanstack/query-core";
import { invalidateVisitStatusQueries } from "../utils/query-cache-policy.ts";
import {
  REVIEW_QUERY_MOUNT_POLICY,
  REVIEW_STATUS_MUTATION_SCOPE,
  invalidatePendingReviewQuery,
  interruptPendingReviewRefreshForMutationSettlement,
  markPendingReviewQueryStale,
  restoreFailedPendingReviewMutation,
  reviewQueryKeys,
  type PendingReviewCacheData,
} from "../utils/review-query-policy.ts";

interface PendingReviewVisit {
  readonly id: string;
  readonly hydration: number;
}

interface PendingReviewExactMatch {
  readonly visitId: string;
  readonly hydration: number;
}

type PendingReviewData = PendingReviewCacheData<PendingReviewVisit, PendingReviewExactMatch>;

interface MountedQuery<T> {
  readonly observer: QueryObserver<T>;
  readonly unsubscribe: () => void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

type StatusProbeName =
  | "visits"
  | "confirmedRestaurants"
  | "stats"
  | "wrapped"
  | "michelinRestaurantSearch"
  | "michelinMapViewport";

const STATUS_PROBES: ReadonlyArray<{ readonly name: StatusProbeName; readonly queryKey: QueryKey }> = [
  { name: "visits", queryKey: ["visits", "all"] },
  { name: "confirmedRestaurants", queryKey: ["confirmedRestaurants"] },
  { name: "stats", queryKey: ["stats"] },
  { name: "wrapped", queryKey: ["wrapped", 2026] },
  { name: "michelinRestaurantSearch", queryKey: ["michelinRestaurantSearch", "sushi"] },
  { name: "michelinMapViewport", queryKey: ["michelinMapViewport", "fixture"] },
];

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createPendingReviewData(
  visitIds: readonly string[],
  hydration: number,
  exactMatchVisitIds: readonly string[] = visitIds,
): PendingReviewData {
  return {
    visits: visitIds.map((id) => ({ id, hydration })),
    exactMatches: exactMatchVisitIds.map((visitId) => ({ visitId, hydration })),
  };
}

function removePendingVisits(data: PendingReviewData, visitIds: readonly string[]): PendingReviewData {
  const identifiers = new Set(visitIds);
  return {
    visits: data.visits.filter((visit) => !identifiers.has(visit.id)),
    exactMatches: data.exactMatches.filter((match) => !identifiers.has(match.visitId)),
  };
}

function getVisitIds(data: PendingReviewData | undefined): string[] {
  return data?.visits.map((visit) => visit.id) ?? [];
}

function getExactMatchVisitIds(data: PendingReviewData | undefined): string[] {
  return data?.exactMatches.map((match) => match.visitId) ?? [];
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function mountAndWait<T>(queryClient: QueryClient, options: QueryObserverOptions<T>): Promise<MountedQuery<T>> {
  const observer = new QueryObserver<T>(queryClient, options);
  const unsubscribe = observer.subscribe(() => undefined);
  await waitFor(
    () => observer.getCurrentResult().status === "success" && observer.getCurrentResult().fetchStatus === "idle",
    `query ${JSON.stringify(options.queryKey)} to settle`,
  );
  return { observer, unsubscribe };
}

async function testSuccessfulStatusMutationKeepsOptimisticReviewData(): Promise<void> {
  const queryClient = createQueryClient();
  let pendingReviewCalls = 0;
  let serverVisitIds = ["visit-1", "visit-2"];
  const statusCalls: Record<StatusProbeName, number> = {
    visits: 0,
    confirmedRestaurants: 0,
    stats: 0,
    wrapped: 0,
    michelinRestaurantSearch: 0,
    michelinMapViewport: 0,
  };

  const pendingMount = await mountAndWait<PendingReviewData>(queryClient, {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => createPendingReviewData(serverVisitIds, ++pendingReviewCalls),
    ...REVIEW_QUERY_MOUNT_POLICY,
  });
  const statusMounts = await Promise.all(
    STATUS_PROBES.map((probe) =>
      mountAndWait<number>(queryClient, {
        queryKey: probe.queryKey,
        queryFn: async () => ++statusCalls[probe.name],
        staleTime: Number.POSITIVE_INFINITY,
      }),
    ),
  );

  try {
    assert.equal(pendingReviewCalls, 1, "the pending-review fixture should hydrate once on mount");
    assert.deepEqual(
      Object.values(statusCalls),
      [1, 1, 1, 1, 1, 1],
      "every status-derived fixture should hydrate once on mount",
    );

    const optimisticData = queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) => {
      assert.ok(current, "the pending-review cache must exist before the optimistic mutation");
      return removePendingVisits(current, ["visit-1"]);
    });
    assert.deepEqual(getVisitIds(optimisticData), ["visit-2"]);
    assert.deepEqual(
      getExactMatchVisitIds(optimisticData),
      ["visit-2"],
      "the optimistic mutation must remove the matching exact-match payload too",
    );

    // Model the successful database write and production's no-refetch stale mark.
    serverVisitIds = ["visit-2"];
    await markPendingReviewQueryStale(queryClient);
    assert.equal(pendingReviewCalls, 1, "marking an active optimistic query stale must not hydrate it");
    assert.strictEqual(
      queryClient.getQueryData(reviewQueryKeys.pendingReview),
      optimisticData,
      "the exact optimistic object must remain cached when it is marked stale",
    );
    assert.equal(queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated, true);

    invalidateVisitStatusQueries(queryClient);
    await waitFor(
      () =>
        STATUS_PROBES.every(
          (probe, index) =>
            statusCalls[probe.name] === 2 && statusMounts[index].observer.getCurrentResult().fetchStatus === "idle",
        ) && queryClient.isFetching({ queryKey: reviewQueryKeys.pendingReview, exact: true }) === 0,
      "status-derived invalidations to settle",
    );

    assert.equal(
      pendingReviewCalls,
      1,
      "a successful optimistic status mutation must not rehydrate the expensive pending-review query",
    );
    assert.strictEqual(
      queryClient.getQueryData(reviewQueryKeys.pendingReview),
      optimisticData,
      "the exact optimistic pending-review value should remain visible after success",
    );
    assert.equal(
      queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
      true,
      "the isolated optimistic result should remain stale for a later reconciliation",
    );
    assert.deepEqual(
      Object.values(statusCalls),
      [2, 2, 2, 2, 2, 2],
      "all other visit/status-derived active queries must still refetch",
    );
    assert.notEqual(
      reviewQueryKeys.pendingReview[0],
      "visits",
      "the pending-review key must be isolated from the broad visits invalidation prefix",
    );

    await invalidatePendingReviewQuery(queryClient);
    assert.equal(pendingReviewCalls, 2, "an explicit pending-review invalidation must rehydrate an active consumer");
    assert.deepEqual(queryClient.getQueryData(reviewQueryKeys.pendingReview), createPendingReviewData(["visit-2"], 2));

    pendingMount.unsubscribe();
    invalidateVisitStatusQueries(queryClient);
    await waitFor(
      () =>
        STATUS_PROBES.every(
          (probe, index) =>
            statusCalls[probe.name] === 3 && statusMounts[index].observer.getCurrentResult().fetchStatus === "idle",
        ),
      "second status-derived invalidation to settle",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pendingReviewCalls, 2, "a broad visit invalidation must not fetch an inactive pending-review query");
    assert.equal(
      queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
      false,
      "an unrelated broad visit invalidation must leave the isolated pending-review entry fresh",
    );

    await invalidatePendingReviewQuery(queryClient);
    assert.equal(pendingReviewCalls, 2, "an explicit invalidation must not fetch an inactive pending-review query");
    assert.equal(
      queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
      true,
      "an explicit inactive invalidation must mark pending-review data stale for its next mount",
    );
  } finally {
    pendingMount.unsubscribe();
    for (const mount of statusMounts) {
      mount.unsubscribe();
    }
    queryClient.clear();
  }
}

function testGranularRollbackPreservesIndependentSuccessAndStableOrder(): void {
  const beforeMutations = createPendingReviewData(["visit-a", "visit-b", "visit-c", "visit-d"], 1, [
    "visit-c",
    "visit-a",
    "visit-d",
    "visit-b",
  ]);
  const afterFailedMutationOptimism = removePendingVisits(beforeMutations, ["visit-a"]);
  const afterIndependentSuccess = removePendingVisits(afterFailedMutationOptimism, ["visit-c"]);
  const currentWithIndependentRefresh: PendingReviewData = {
    visits: [
      ...afterIndependentSuccess.visits.map((visit) => ({ ...visit, hydration: 2 })),
      { id: "visit-e", hydration: 2 },
    ],
    exactMatches: [
      ...afterIndependentSuccess.exactMatches.map((match) => ({ ...match, hydration: 2 })),
      { visitId: "visit-e", hydration: 2 },
    ],
  };

  const restored = restoreFailedPendingReviewMutation(currentWithIndependentRefresh, beforeMutations, ["visit-a"]);
  assert.ok(restored);
  assert.deepEqual(
    getVisitIds(restored),
    ["visit-a", "visit-b", "visit-d", "visit-e"],
    "rolling back A must preserve C's successful removal and append a refresh-introduced row",
  );
  assert.deepEqual(
    getExactMatchVisitIds(restored),
    ["visit-a", "visit-d", "visit-b", "visit-e"],
    "visit and exact-match collections must each retain their own snapshot ordering",
  );
  assert.equal(restored.visits[0].hydration, 1, "the failed mutation's row must come from its snapshot");
  assert.equal(restored.visits[1].hydration, 2, "an independently refreshed current row must win over its snapshot");
  assert.equal(restored.visits.at(-1)?.id, "visit-e", "post-snapshot rows must not be discarded by rollback");

  const laterSameIdSnapshot = removePendingVisits(beforeMutations, ["visit-a"]);
  const alreadyRestoredByEarlierFailure = beforeMutations;
  assert.strictEqual(
    restoreFailedPendingReviewMutation(alreadyRestoredByEarlierFailure, laterSameIdSnapshot, ["visit-a"]),
    alreadyRestoredByEarlierFailure,
    "a queued same-ID failure with no row in its snapshot must not reorder an earlier rollback",
  );

  const beforeTwoFailures = createPendingReviewData(["visit-a", "visit-b", "visit-c"], 1, [
    "visit-c",
    "visit-a",
    "visit-b",
  ]);
  const beforeSecondFailure = removePendingVisits(beforeTwoFailures, ["visit-a"]);
  const afterBothOptimisticRemovals = removePendingVisits(beforeSecondFailure, ["visit-b"]);
  const afterFirstFailure = restoreFailedPendingReviewMutation(afterBothOptimisticRemovals, beforeTwoFailures, [
    "visit-a",
  ]);
  const afterBothFailures = restoreFailedPendingReviewMutation(afterFirstFailure, beforeTwoFailures, ["visit-b"]);
  assert.ok(afterBothFailures);
  assert.deepEqual(
    getVisitIds(afterBothFailures),
    getVisitIds(beforeTwoFailures),
    "two queued failures must restore the original visit order",
  );
  assert.deepEqual(
    getExactMatchVisitIds(afterBothFailures),
    getExactMatchVisitIds(beforeTwoFailures),
    "two queued failures must restore the independently ordered exact-match collection",
  );
}

async function testStaleMarkPreservesOptimisticDataWithoutRefetch(): Promise<void> {
  const queryClient = createQueryClient();
  let hydrationCalls = 0;
  const pendingMount = await mountAndWait<PendingReviewData>(queryClient, {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => createPendingReviewData(["visit-a", "visit-b"], ++hydrationCalls),
    ...REVIEW_QUERY_MOUNT_POLICY,
  });

  try {
    await markPendingReviewQueryStale(queryClient);
    assert.equal(hydrationCalls, 1, "the no-refetch stale mark must not fetch an active observer");
    assert.equal(queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated, true);

    const optimisticData = queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) => {
      assert.ok(current);
      return removePendingVisits(current, ["visit-a"]);
    });
    assert.equal(
      queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
      false,
      "setQueryData clears a prior invalidation and therefore requires a post-mutation stale mark",
    );

    await markPendingReviewQueryStale(queryClient);
    assert.equal(hydrationCalls, 1, "re-establishing stale state must still avoid an active refetch");
    assert.equal(queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated, true);
    assert.strictEqual(
      queryClient.getQueryData(reviewQueryKeys.pendingReview),
      optimisticData,
      "marking stale must preserve the exact optimistic cache value",
    );
    assert.deepEqual(getVisitIds(optimisticData), ["visit-b"]);
    assert.deepEqual(getExactMatchVisitIds(optimisticData), ["visit-b"]);
  } finally {
    pendingMount.unsubscribe();
    queryClient.clear();
  }
}

async function testSettlementInterruptsRefreshThatStartedAfterOptimisticSetup(): Promise<void> {
  const queryClient = createQueryClient();
  const delayedRefreshStarted = createDeferred<void>();
  const releaseDelayedRefresh = createDeferred<void>();
  let hydrationCalls = 0;
  let serverVisitIds = ["visit-a", "visit-b"];
  const pendingMount = await mountAndWait<PendingReviewData>(queryClient, {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => {
      const hydration = ++hydrationCalls;
      const capturedVisitIds = [...serverVisitIds];
      if (hydration === 2) {
        delayedRefreshStarted.resolve();
        await releaseDelayedRefresh.promise;
      }
      return createPendingReviewData(capturedVisitIds, hydration);
    },
    ...REVIEW_QUERY_MOUNT_POLICY,
  });

  try {
    // Production onMutate observed a fresh, idle query and painted its removal.
    queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) => {
      assert.ok(current);
      return removePendingVisits(current, ["visit-a"]);
    });

    // A manual/remount refresh begins later and captures the pre-write database snapshot.
    const delayedRefresh = queryClient.refetchQueries({
      queryKey: reviewQueryKeys.pendingReview,
      exact: true,
      type: "active",
    });
    await delayedRefreshStarted.promise;

    // The status write commits while that stale hydration remains in flight.
    serverVisitIds = ["visit-b"];
    const refreshNeedsReconciliation = await interruptPendingReviewRefreshForMutationSettlement(queryClient, false);
    assert.equal(refreshNeedsReconciliation, true, "settlement must detect and cancel the refresh that began later");

    // Match production success settlement: reapply the postcondition, mark it
    // stale, then reconcile because a pre-write refresh was interrupted.
    queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) => {
      assert.ok(current);
      return removePendingVisits(current, ["visit-a"]);
    });
    await markPendingReviewQueryStale(queryClient);
    await invalidatePendingReviewQuery(queryClient);

    // Even if the canceled query function eventually returns its captured
    // pre-write value, QueryCore must not publish it over the reconciliation.
    releaseDelayedRefresh.resolve();
    await delayedRefresh;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(hydrationCalls, 3, "initial, interrupted, and reconciliation hydrations should be the only calls");
    assert.deepEqual(getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-b"]);
    assert.deepEqual(getExactMatchVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-b"]);
    assert.equal(
      queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
      false,
      "the post-write reconciliation must leave the cache fresh",
    );
  } finally {
    releaseDelayedRefresh.resolve();
    pendingMount.unsubscribe();
    queryClient.clear();
  }
}

type ScopedMutationToken = "first-a-fails" | "second-b-succeeds" | "third-a-succeeds";

interface ScopedMutationVariables {
  readonly token: ScopedMutationToken;
  readonly visitId: string;
  readonly shouldFail: boolean;
}

interface ScopedMutationContext {
  readonly previousPending: PendingReviewData | undefined;
}

async function testScopedMutationsPaintImmediatelyAndSerializeDatabaseWork(): Promise<void> {
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    reviewQueryKeys.pendingReview,
    createPendingReviewData(["visit-a", "visit-b", "visit-c"], 1),
  );

  const gates = new Map<ScopedMutationToken, Deferred<void>>([
    ["first-a-fails", createDeferred<void>()],
    ["second-b-succeeds", createDeferred<void>()],
    ["third-a-succeeds", createDeferred<void>()],
  ]);
  const optimisticEvents: ScopedMutationToken[] = [];
  const databaseStarts: ScopedMutationToken[] = [];
  const completionEvents: string[] = [];
  let activeDatabaseMutations = 0;
  let maximumActiveDatabaseMutations = 0;

  const createObserver = () =>
    new MutationObserver<void, Error, ScopedMutationVariables, ScopedMutationContext>(queryClient, {
      scope: REVIEW_STATUS_MUTATION_SCOPE,
      mutationFn: async (variables) => {
        databaseStarts.push(variables.token);
        activeDatabaseMutations += 1;
        maximumActiveDatabaseMutations = Math.max(maximumActiveDatabaseMutations, activeDatabaseMutations);
        try {
          await gates.get(variables.token)!.promise;
          if (variables.shouldFail) {
            throw new Error(`${variables.token} failed as requested`);
          }
        } finally {
          activeDatabaseMutations -= 1;
        }
      },
      onMutate: (variables) => {
        optimisticEvents.push(variables.token);
        const previousPending = queryClient.getQueryData<PendingReviewData>(reviewQueryKeys.pendingReview);
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          current ? removePendingVisits(current, [variables.visitId]) : current,
        );
        return { previousPending };
      },
      onError: async (_error, variables, context) => {
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          restoreFailedPendingReviewMutation(current, context?.previousPending, [variables.visitId]),
        );
        await markPendingReviewQueryStale(queryClient);
        completionEvents.push(`error:${variables.token}`);
      },
      onSuccess: async (_data, variables) => {
        // Match production's post-success re-removal for a same-ID mutation whose
        // earlier queued predecessor may have restored the row on failure.
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          current ? removePendingVisits(current, [variables.visitId]) : current,
        );
        await markPendingReviewQueryStale(queryClient);
        completionEvents.push(`success:${variables.token}`);
      },
    });

  const firstObserver = createObserver();
  const secondObserver = createObserver();
  const thirdObserver = createObserver();
  const firstResult = firstObserver.mutate({ token: "first-a-fails", visitId: "visit-a", shouldFail: true }).then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
  const secondResult = secondObserver
    .mutate({ token: "second-b-succeeds", visitId: "visit-b", shouldFail: false })
    .then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
  const thirdResult = thirdObserver.mutate({ token: "third-a-succeeds", visitId: "visit-a", shouldFail: false }).then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );

  try {
    await waitFor(
      () => optimisticEvents.length === 3 && databaseStarts.length === 1,
      "all optimistic callbacks and only the first scoped database mutation",
    );
    assert.deepEqual(
      optimisticEvents,
      ["first-a-fails", "second-b-succeeds", "third-a-succeeds"],
      "scope queuing must not delay optimistic callbacks",
    );
    assert.deepEqual(databaseStarts, ["first-a-fails"], "only the first scoped mutation may enter database work");
    assert.deepEqual(getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-c"]);
    assert.deepEqual(getExactMatchVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-c"]);

    gates.get("first-a-fails")!.resolve();
    await waitFor(
      () => databaseStarts.length === 2 && completionEvents.includes("error:first-a-fails"),
      "the first rollback and second scoped database mutation",
    );
    assert.deepEqual(databaseStarts, ["first-a-fails", "second-b-succeeds"]);
    assert.deepEqual(
      getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)),
      ["visit-a", "visit-c"],
      "A's failure must restore A without resurrecting independently removed B",
    );
    assert.deepEqual(getExactMatchVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), [
      "visit-a",
      "visit-c",
    ]);

    gates.get("second-b-succeeds")!.resolve();
    await waitFor(
      () => databaseStarts.length === 3 && completionEvents.includes("success:second-b-succeeds"),
      "the second success and third scoped database mutation",
    );
    assert.deepEqual(databaseStarts, ["first-a-fails", "second-b-succeeds", "third-a-succeeds"]);
    assert.deepEqual(getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-a", "visit-c"]);

    gates.get("third-a-succeeds")!.resolve();
    assert.deepEqual(await Promise.all([firstResult, secondResult, thirdResult]), [
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    assert.deepEqual(
      getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)),
      ["visit-c"],
      "the later same-ID success must re-remove A after its predecessor restored it",
    );
    assert.deepEqual(getExactMatchVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-c"]);
    assert.deepEqual(completionEvents, [
      "error:first-a-fails",
      "success:second-b-succeeds",
      "success:third-a-succeeds",
    ]);
    assert.equal(maximumActiveDatabaseMutations, 1, "scoped mutation functions must never overlap");
    assert.equal(queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated, true);
  } finally {
    for (const gate of gates.values()) {
      gate.resolve();
    }
    queryClient.clear();
  }
}

type SameIdMutationToken = "first-a-succeeds" | "second-a-fails";

interface SameIdMutationVariables {
  readonly token: SameIdMutationToken;
  readonly shouldFail: boolean;
}

async function testSameIdSuccessPreventsLaterFailureRollback(): Promise<void> {
  const queryClient = createQueryClient();
  queryClient.setQueryData(reviewQueryKeys.pendingReview, createPendingReviewData(["visit-a", "visit-b"], 1));

  const gates = new Map<SameIdMutationToken, Deferred<void>>([
    ["first-a-succeeds", createDeferred<void>()],
    ["second-a-fails", createDeferred<void>()],
  ]);
  const successfulVisitIds = new Set<string>();
  let rollbackBaseline: PendingReviewData | undefined;
  let groupStarted = false;
  const databaseStarts: SameIdMutationToken[] = [];

  const createObserver = () =>
    new MutationObserver<void, Error, SameIdMutationVariables, ScopedMutationContext>(queryClient, {
      scope: REVIEW_STATUS_MUTATION_SCOPE,
      mutationFn: async (variables) => {
        databaseStarts.push(variables.token);
        await gates.get(variables.token)!.promise;
        if (variables.shouldFail) {
          throw new Error(`${variables.token} failed as requested`);
        }
      },
      onMutate: () => {
        if (!groupStarted) {
          rollbackBaseline = queryClient.getQueryData<PendingReviewData>(reviewQueryKeys.pendingReview);
          groupStarted = true;
        }
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          current ? removePendingVisits(current, ["visit-a"]) : current,
        );
        return { previousPending: rollbackBaseline };
      },
      onSuccess: async () => {
        successfulVisitIds.add("visit-a");
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          current ? removePendingVisits(current, ["visit-a"]) : current,
        );
        await markPendingReviewQueryStale(queryClient);
      },
      onError: async (_error, _variables, context) => {
        const visitIdsEligibleForRollback = successfulVisitIds.has("visit-a") ? [] : ["visit-a"];
        queryClient.setQueryData<PendingReviewData>(reviewQueryKeys.pendingReview, (current) =>
          restoreFailedPendingReviewMutation(current, context?.previousPending, visitIdsEligibleForRollback),
        );
        await markPendingReviewQueryStale(queryClient);
      },
    });

  const firstResult = createObserver()
    .mutate({ token: "first-a-succeeds", shouldFail: false })
    .then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
  const secondResult = createObserver()
    .mutate({ token: "second-a-fails", shouldFail: true })
    .then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );

  try {
    await waitFor(() => databaseStarts.length === 1, "the first same-ID database mutation");
    assert.deepEqual(getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-b"]);

    gates.get("first-a-succeeds")!.resolve();
    await waitFor(() => databaseStarts.length === 2, "the second same-ID database mutation");
    assert.deepEqual(
      getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)),
      ["visit-b"],
      "the first success must retain ownership while the later same-ID mutation is queued",
    );

    gates.get("second-a-fails")!.resolve();
    assert.deepEqual(await Promise.all([firstResult, secondResult]), ["fulfilled", "rejected"]);
    assert.deepEqual(
      getVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)),
      ["visit-b"],
      "a later same-ID failure must not resurrect a row already removed by a successful write",
    );
    assert.deepEqual(getExactMatchVisitIds(queryClient.getQueryData(reviewQueryKeys.pendingReview)), ["visit-b"]);
  } finally {
    for (const gate of gates.values()) {
      gate.resolve();
    }
    queryClient.clear();
  }
}

await testSuccessfulStatusMutationKeepsOptimisticReviewData();
testGranularRollbackPreservesIndependentSuccessAndStableOrder();
await testStaleMarkPreservesOptimisticDataWithoutRefetch();
await testSettlementInterruptsRefreshThatStartedAfterOptimisticSetup();
await testScopedMutationsPaintImmediatelyAndSerializeDatabaseWork();
await testSameIdSuccessPreventsLaterFailureRollback();

console.log(
  "Review mutation cache policy tests passed: production-shaped optimistic data, granular ordered rollback, no-refetch stale marking, scoped serialization, derived-cache invalidation, and explicit active/inactive refresh semantics hold.",
);
