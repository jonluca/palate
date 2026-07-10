#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/query-core";
import {
  REVIEW_QUERY_MOUNT_POLICY,
  invalidatePendingReviewQuery,
  refreshReviewQueries,
  reviewQueryKeys,
} from "../utils/review-query-policy.ts";

interface GenerationData {
  readonly generation: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
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

async function mountAndWait<T>(
  queryClient: QueryClient,
  options: QueryObserverOptions<T>,
): Promise<{ observer: QueryObserver<T>; unsubscribe: () => void }> {
  const observer = new QueryObserver<T>(queryClient, options);
  const unsubscribe = observer.subscribe(() => undefined);
  await waitFor(
    () => observer.getCurrentResult().status === "success" && observer.getCurrentResult().fetchStatus === "idle",
    `query ${JSON.stringify(options.queryKey)} to settle`,
  );
  return { observer, unsubscribe };
}

async function testStaleAwareMountPolicy(): Promise<void> {
  const queryClient = createQueryClient();
  let calls = 0;
  const options: QueryObserverOptions<GenerationData> = {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => ({ generation: ++calls }),
    ...REVIEW_QUERY_MOUNT_POLICY,
  };

  const initialMount = await mountAndWait(queryClient, options);
  assert.equal(calls, 1, "initial mount should fetch exactly once");
  assert.deepEqual(initialMount.observer.getCurrentResult().data, { generation: 1 });
  initialMount.unsubscribe();

  for (let remount = 0; remount < 5; remount++) {
    const observer = new QueryObserver(queryClient, options);
    assert.deepEqual(
      observer.getCurrentResult().data,
      { generation: 1 },
      "fresh cached data should be available before subscribe",
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "fresh remounts must not refetch");
    assert.deepEqual(observer.getCurrentResult().data, { generation: 1 });
    unsubscribe();
  }

  await queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pendingReview,
    exact: true,
    refetchType: "none",
  });
  const invalidatedMount = await mountAndWait(queryClient, options);
  assert.equal(calls, 2, "an invalidated remount should refetch once");
  assert.deepEqual(invalidatedMount.observer.getCurrentResult().data, { generation: 2 });
  invalidatedMount.unsubscribe();

  queryClient.setQueryData<GenerationData>(
    reviewQueryKeys.pendingReview,
    { generation: 2 },
    { updatedAt: Date.now() - REVIEW_QUERY_MOUNT_POLICY.staleTime - 1 },
  );
  const staleMount = await mountAndWait(queryClient, options);
  assert.equal(calls, 3, "an age-stale remount should refetch once");
  assert.deepEqual(staleMount.observer.getCurrentResult().data, { generation: 3 });
  staleMount.unsubscribe();

  queryClient.clear();
}

async function testScopedManualRefresh(): Promise<void> {
  const queryClient = createQueryClient();
  const pendingRefresh = createDeferred<GenerationData>();
  const calls = {
    pendingReview: 0,
    unanalyzedPhotoCount: 0,
    unrelatedStats: 0,
    pendingReviewChild: 0,
  };

  const pendingOptions: QueryObserverOptions<GenerationData> = {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => {
      calls.pendingReview += 1;
      return calls.pendingReview === 1 ? { generation: 1 } : pendingRefresh.promise;
    },
    ...REVIEW_QUERY_MOUNT_POLICY,
  };
  const unanalyzedOptions: QueryObserverOptions<number> = {
    queryKey: reviewQueryKeys.unanalyzedPhotoCount,
    queryFn: async () => ++calls.unanalyzedPhotoCount,
    ...REVIEW_QUERY_MOUNT_POLICY,
  };
  const statsOptions: QueryObserverOptions<number> = {
    queryKey: ["stats"],
    queryFn: async () => ++calls.unrelatedStats,
    staleTime: REVIEW_QUERY_MOUNT_POLICY.staleTime,
  };
  const childOptions: QueryObserverOptions<number> = {
    queryKey: [...reviewQueryKeys.pendingReview, "child"],
    queryFn: async () => ++calls.pendingReviewChild,
    staleTime: REVIEW_QUERY_MOUNT_POLICY.staleTime,
  };

  const [pendingMount, unanalyzedMount, statsMount, childMount] = await Promise.all([
    mountAndWait(queryClient, pendingOptions),
    mountAndWait(queryClient, unanalyzedOptions),
    mountAndWait(queryClient, statsOptions),
    mountAndWait(queryClient, childOptions),
  ]);
  assert.deepEqual(calls, {
    pendingReview: 1,
    unanalyzedPhotoCount: 1,
    unrelatedStats: 1,
    pendingReviewChild: 1,
  });

  const refreshPromise = refreshReviewQueries(queryClient);
  await waitFor(
    () => calls.pendingReview === 2 && pendingMount.observer.getCurrentResult().fetchStatus === "fetching",
    "scoped pending-review refresh to begin",
  );

  assert.deepEqual(
    pendingMount.observer.getCurrentResult().data,
    { generation: 1 },
    "cached review data should remain visible while its refresh is in flight",
  );
  assert.equal(calls.unanalyzedPhotoCount, 2, "manual refresh should refetch the displayed count");
  assert.equal(calls.unrelatedStats, 1, "manual refresh must not touch unrelated queries");
  assert.equal(calls.pendingReviewChild, 1, "exact key matching must not refetch descendants");
  assert.equal(queryClient.getQueryData<number>(["stats"]), 1, "unrelated cached data should remain intact");

  pendingRefresh.resolve({ generation: 2 });
  await refreshPromise;
  assert.deepEqual(pendingMount.observer.getCurrentResult().data, { generation: 2 });

  pendingMount.unsubscribe();
  unanalyzedMount.unsubscribe();
  statsMount.unsubscribe();
  childMount.unsubscribe();
  queryClient.clear();
}

async function testNotesMutationInvalidatesExactPendingReviewQuery(): Promise<void> {
  const queryClient = createQueryClient();
  const calls = {
    pendingReview: 0,
    pendingReviewChild: 0,
    unrelatedStats: 0,
  };
  const pendingOptions: QueryObserverOptions<GenerationData> = {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => ({ generation: ++calls.pendingReview }),
    ...REVIEW_QUERY_MOUNT_POLICY,
  };
  const childOptions: QueryObserverOptions<number> = {
    queryKey: [...reviewQueryKeys.pendingReview, "child"],
    queryFn: async () => ++calls.pendingReviewChild,
    ...REVIEW_QUERY_MOUNT_POLICY,
  };
  const statsOptions: QueryObserverOptions<number> = {
    queryKey: ["stats"],
    queryFn: async () => ++calls.unrelatedStats,
    ...REVIEW_QUERY_MOUNT_POLICY,
  };

  const [pendingMount, childMount, statsMount] = await Promise.all([
    mountAndWait(queryClient, pendingOptions),
    mountAndWait(queryClient, childOptions),
    mountAndWait(queryClient, statsOptions),
  ]);

  await invalidatePendingReviewQuery(queryClient);
  assert.deepEqual(calls, {
    pendingReview: 2,
    pendingReviewChild: 1,
    unrelatedStats: 1,
  });
  assert.deepEqual(pendingMount.observer.getCurrentResult().data, { generation: 2 });

  pendingMount.unsubscribe();
  childMount.unsubscribe();
  statsMount.unsubscribe();

  await invalidatePendingReviewQuery(queryClient);
  assert.equal(calls.pendingReview, 2, "an inactive review query should be invalidated without fetching");
  assert.equal(
    queryClient.getQueryState(reviewQueryKeys.pendingReview)?.isInvalidated,
    true,
    "the fresh inactive cache entry must remain invalidated for its next mount",
  );

  const remounted = await mountAndWait(queryClient, pendingOptions);
  assert.equal(calls.pendingReview, 3, "the stale-aware mount policy should refresh the invalidated notes data");
  assert.deepEqual(remounted.observer.getCurrentResult().data, { generation: 3 });
  remounted.unsubscribe();
  queryClient.clear();
}

await testStaleAwareMountPolicy();
await testScopedManualRefresh();
await testNotesMutationInvalidatesExactPendingReviewQuery();

console.log(
  "Review query policy tests passed: stale-aware remounts, scoped refresh, notes-mutation invalidation, and cached-data visibility.",
);
