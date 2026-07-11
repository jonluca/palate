#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { QueryClient, QueryObserver, type QueryObserverOptions, type QueryKey } from "@tanstack/query-core";
import { invalidateVisitStatusQueries } from "../utils/query-cache-policy.ts";
import { markPendingReviewQueryStale, reviewQueryKeys } from "../utils/review-query-policy.ts";

interface Configuration {
  rowsPerHydration: number;
  bytesPerHydration: number;
  mutationCount: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface ModeledReviewRow {
  readonly id: number;
  readonly payload: string;
}

interface TraceMeasurement {
  readonly elapsedMilliseconds: number;
  readonly hydrationCalls: number;
  readonly parsedRows: number;
  readonly parsedBytes: number;
  readonly finalCachedRows: number;
  readonly finalCachedIds: readonly number[];
  readonly finalCachedIdSha256: string;
  readonly finalCacheInvalidated: boolean;
}

interface AggregateTiming {
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "legacyNestedKey" | "isolatedActualKey";

const LEGACY_NESTED_PENDING_REVIEW_KEY = ["visits", "pendingReview"] as const;
const DEFAULT_CONFIGURATION: Configuration = {
  rowsPerHydration: 6_511,
  bytesPerHydration: 7_883_042,
  mutationCount: 10,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/review-mutation-cache-policy-profile.json",
};

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive safe integer; received ${value}`);
  }
  return parsed;
}

function parseNonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer; received ${value}`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Configuration {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of argv) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--rows=")) {
      configuration.rowsPerHydration = parsePositiveInteger(argument.slice("--rows=".length), "rows");
    } else if (argument.startsWith("--bytes=")) {
      configuration.bytesPerHydration = parsePositiveInteger(argument.slice("--bytes=".length), "bytes");
    } else if (argument.startsWith("--mutations=")) {
      configuration.mutationCount = parsePositiveInteger(argument.slice("--mutations=".length), "mutations");
    } else if (argument.startsWith("--samples=")) {
      configuration.samples = parsePositiveInteger(argument.slice("--samples=".length), "samples");
    } else if (argument.startsWith("--warmup=")) {
      configuration.warmupIterations = parseNonnegativeInteger(argument.slice("--warmup=".length), "warmup");
    } else if (argument.startsWith("--output=")) {
      configuration.outputPath = argument.slice("--output=".length);
      if (!configuration.outputPath) {
        throw new RangeError("output must be non-empty");
      }
    } else {
      throw new RangeError(`Unknown argument: ${argument}`);
    }
  }
  return configuration;
}

function createExactBytePayload(rowCount: number, targetBytes: number): string {
  const rows: Array<{ id: number; payload: string }> = Array.from({ length: rowCount }, (_, id) => ({
    id,
    payload: "",
  }));
  const baseBytes = Buffer.byteLength(JSON.stringify(rows));
  if (targetBytes < baseBytes) {
    throw new RangeError(`bytes (${targetBytes}) must fit ${rowCount} modeled row objects; minimum is ${baseBytes}`);
  }

  const paddingBytes = targetBytes - baseBytes;
  const paddingPerRow = Math.floor(paddingBytes / rowCount);
  let remainder = paddingBytes % rowCount;
  for (const row of rows) {
    const rowPadding = paddingPerRow + (remainder > 0 ? 1 : 0);
    row.payload = "x".repeat(rowPadding);
    if (remainder > 0) {
      remainder -= 1;
    }
  }

  const payload = JSON.stringify(rows);
  assert.equal(Buffer.byteLength(payload), targetBytes, "the modeled JSON payload byte size must be exact");
  return payload;
}

function checksumIds(ids: readonly number[]): string {
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function mountPendingReview(
  queryClient: QueryClient,
  options: QueryObserverOptions<readonly ModeledReviewRow[]>,
): Promise<{ readonly observer: QueryObserver<readonly ModeledReviewRow[]>; readonly unsubscribe: () => void }> {
  const observer = new QueryObserver(queryClient, options);
  const unsubscribe = observer.subscribe(() => undefined);
  await waitFor(
    () => observer.getCurrentResult().status === "success" && observer.getCurrentResult().fetchStatus === "idle",
    "initial pending-review hydration",
  );
  return { observer, unsubscribe };
}

async function measureMutationTrace(
  strategy: Strategy,
  configuration: Configuration,
  payload: string,
): Promise<TraceMeasurement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey: QueryKey =
    strategy === "legacyNestedKey" ? LEGACY_NESTED_PENDING_REVIEW_KEY : reviewQueryKeys.pendingReview;
  let hydrationCalls = 0;
  const serverRemovedIds = new Set<number>();
  const pendingMount = await mountPendingReview(queryClient, {
    queryKey,
    queryFn: async () => {
      hydrationCalls += 1;
      const fullyParsedRows = JSON.parse(payload) as ModeledReviewRow[];
      return fullyParsedRows.filter((row) => !serverRemovedIds.has(row.id));
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const startedAt = performance.now();
  for (let mutation = 0; mutation < configuration.mutationCount; mutation++) {
    const removedId = mutation % configuration.rowsPerHydration;
    queryClient.setQueryData<readonly ModeledReviewRow[]>(queryKey, (current) =>
      current?.filter((row) => row.id !== removedId),
    );
    serverRemovedIds.add(removedId);
    invalidateVisitStatusQueries(queryClient);
    if (strategy === "isolatedActualKey") {
      await markPendingReviewQueryStale(queryClient);
    }

    const expectedHydrations = strategy === "legacyNestedKey" ? mutation + 2 : 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await waitFor(
      () => hydrationCalls === expectedHydrations && pendingMount.observer.getCurrentResult().fetchStatus === "idle",
      `${strategy} mutation ${mutation + 1} to settle`,
    );
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  const finalCachedRows = pendingMount.observer.getCurrentResult().data?.length;
  if (finalCachedRows === undefined) {
    throw new Error("The pending-review cache should remain populated");
  }
  const finalCachedIds = pendingMount.observer.getCurrentResult().data?.map((row) => row.id);
  if (finalCachedIds === undefined) {
    throw new Error("The pending-review IDs should remain available for parity validation");
  }
  const finalCacheInvalidated = queryClient.getQueryState(queryKey)?.isInvalidated === true;

  pendingMount.unsubscribe();
  queryClient.clear();
  return {
    elapsedMilliseconds,
    hydrationCalls,
    parsedRows: hydrationCalls * configuration.rowsPerHydration,
    parsedBytes: hydrationCalls * configuration.bytesPerHydration,
    finalCachedRows,
    finalCachedIds,
    finalCachedIdSha256: checksumIds(finalCachedIds),
    finalCacheInvalidated,
  };
}

function median(sortedValues: readonly number[]): number {
  const midpoint = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2
    : sortedValues[midpoint];
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(measurements: readonly TraceMeasurement[]): AggregateTiming {
  const sorted = measurements.map((measurement) => measurement.elapsedMilliseconds).sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    minimumMilliseconds: round(sorted[0]),
    medianMilliseconds: round(median(sorted)),
    meanMilliseconds: round(mean),
    p95Milliseconds: round(sorted[p95Index]),
    maximumMilliseconds: round(sorted[sorted.length - 1]),
  };
}

assert.notEqual(
  reviewQueryKeys.pendingReview[0],
  "visits",
  "This benchmark requires the production pending-review key to be isolated from ['visits'] invalidation.",
);

const configuration = parseArguments(process.argv.slice(2));
const payload = createExactBytePayload(configuration.rowsPerHydration, configuration.bytesPerHydration);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  await measureMutationTrace("legacyNestedKey", configuration, payload);
  await measureMutationTrace("isolatedActualKey", configuration, payload);
}

const measurements: Record<Strategy, TraceMeasurement[]> = {
  legacyNestedKey: [],
  isolatedActualKey: [],
};
let legacyFirstSamples = 0;
let isolatedFirstSamples = 0;
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: Strategy[] =
    sample % 2 === 0 ? ["legacyNestedKey", "isolatedActualKey"] : ["isolatedActualKey", "legacyNestedKey"];
  if (order[0] === "legacyNestedKey") {
    legacyFirstSamples += 1;
  } else {
    isolatedFirstSamples += 1;
  }
  for (const strategy of order) {
    measurements[strategy].push(await measureMutationTrace(strategy, configuration, payload));
  }
}

const uniqueOptimisticRemovals = Math.min(configuration.mutationCount, configuration.rowsPerHydration);
const expectedFinalIds = Array.from({ length: configuration.rowsPerHydration }, (_, id) => id).filter(
  (id) => id >= uniqueOptimisticRemovals,
);
const expectedFinalCachedIdSha256 = checksumIds(expectedFinalIds);
for (const measurement of measurements.legacyNestedKey) {
  assert.equal(
    measurement.hydrationCalls,
    configuration.mutationCount + 1,
    "the legacy nested key should fully hydrate once per mutation plus its initial mount",
  );
  assert.equal(
    measurement.finalCachedRows,
    configuration.rowsPerHydration - uniqueOptimisticRemovals,
    "the legacy refetch should return the successful server state after every mutation",
  );
  assert.deepEqual(measurement.finalCachedIds, expectedFinalIds, "legacy cache IDs must match successful server state");
  assert.equal(measurement.finalCacheInvalidated, false, "the legacy refetch should finish fresh");
}
for (const measurement of measurements.isolatedActualKey) {
  assert.equal(measurement.hydrationCalls, 1, "the isolated actual key should hydrate only on its initial mount");
  assert.equal(
    measurement.finalCachedRows,
    configuration.rowsPerHydration - uniqueOptimisticRemovals,
    "the isolated actual key should preserve all unique optimistic removals",
  );
  assert.deepEqual(
    measurement.finalCachedIds,
    expectedFinalIds,
    "isolated cache IDs must match successful server state",
  );
  assert.equal(
    measurement.finalCacheInvalidated,
    true,
    "the isolated cache should remain stale for its next reconciliation boundary",
  );
}
for (let sample = 0; sample < configuration.samples; sample++) {
  const legacyMeasurement = measurements.legacyNestedKey[sample];
  const isolatedMeasurement = measurements.isolatedActualKey[sample];
  assert.deepEqual(
    legacyMeasurement.finalCachedIds,
    isolatedMeasurement.finalCachedIds,
    `sample ${sample + 1} must end with exact legacy/isolated ID parity`,
  );
  assert.equal(
    legacyMeasurement.finalCachedIdSha256,
    isolatedMeasurement.finalCachedIdSha256,
    `sample ${sample + 1} must end with matching legacy/isolated ID checksums`,
  );
}

for (const measurement of [...measurements.legacyNestedKey, ...measurements.isolatedActualKey]) {
  assert.equal(
    measurement.finalCachedIdSha256,
    expectedFinalCachedIdSha256,
    "every counterbalanced trace must produce the successful server state's final ID checksum",
  );
}

const legacyTiming = summarize(measurements.legacyNestedKey);
const isolatedTiming = summarize(measurements.isolatedActualKey);
const pairedIsolatedWins = measurements.isolatedActualKey.reduce(
  (wins, measurement, index) =>
    wins + (measurement.elapsedMilliseconds < measurements.legacyNestedKey[index].elapsedMilliseconds ? 1 : 0),
  0,
);
const avoidedHydrations = configuration.mutationCount;
const medianMillisecondsAvoided = legacyTiming.medianMilliseconds - isolatedTiming.medianMilliseconds;
const report = {
  schemaVersion: 1,
  status: "ok",
  benchmarkKind: "modeled-review-mutation-cache-policy",
  runtime: {
    node: process.version,
    tanstackQueryCore: "5.101.2",
  },
  configuration,
  modeledFixture: {
    rowsPerHydration: configuration.rowsPerHydration,
    bytesPerHydration: configuration.bytesPerHydration,
    exactPayloadBytes: Buffer.byteLength(payload),
    payloadShape: "Synthetic JSON array with one independently allocated object and payload string per row",
    provenance:
      "Defaults reproduce the observed live-library row and byte scale; the benchmark reads and emits no Photos, Calendar, or database content.",
  },
  policyUnderTest: {
    actualPendingReviewQueryKey: reviewQueryKeys.pendingReview,
    legacyBaselineQueryKey: LEGACY_NESTED_PENDING_REVIEW_KEY,
    invalidator: "invalidateVisitStatusQueries from utils/query-cache-policy.ts",
    isolatedSettlement: "markPendingReviewQueryStale with exact refetchType none",
    optimisticOperation: "TanStack Query setQueryData array filter before each successful mutation invalidation",
    successfulServerState:
      "Each mutation records its removed ID before invalidation; every hydration parses the complete exact-size payload before filtering those server-removed IDs.",
  },
  correctness: {
    initialHydrationsPerTrace: 1,
    legacyHydrationsPerTrace: configuration.mutationCount + 1,
    isolatedHydrationsPerTrace: 1,
    uniqueOptimisticRemovals: uniqueOptimisticRemovals,
    finalCacheParity: {
      exactIdArrayParityAcrossAllSamples: true,
      matchingSha256AcrossAllSamples: true,
      exactSuccessfulServerIdSetAcrossAllSamples: true,
      isolatedCacheMarkedStaleAcrossAllSamples: true,
      finalCachedRows: configuration.rowsPerHydration - uniqueOptimisticRemovals,
      finalCachedIdSha256: expectedFinalCachedIdSha256,
    },
  },
  aggregate: {
    sampleCountPerStrategy: configuration.samples,
    timingMilliseconds: {
      legacyNestedKey: legacyTiming,
      isolatedActualKey: isolatedTiming,
      comparison: {
        medianMillisecondsAvoided: round(medianMillisecondsAvoided),
        medianPercentAvoided: round((medianMillisecondsAvoided / legacyTiming.medianMilliseconds) * 100),
        medianSpeedup: round(legacyTiming.medianMilliseconds / isolatedTiming.medianMilliseconds),
        pairedIsolatedWins,
      },
    },
    modeledWorkAvoidedPerMutationTrace: {
      fullHydrations: avoidedHydrations,
      parsedRows: avoidedHydrations * configuration.rowsPerHydration,
      parsedBytes: avoidedHydrations * configuration.bytesPerHydration,
    },
    counterbalancing: {
      scheme: "AB/BA alternating by sample index",
      legacyFirstSamples,
      isolatedFirstSamples,
    },
  },
  modeledScope:
    "Node/V8 TanStack Query active-observer invalidation and optimistic cache edits using the production invalidator, plus exact-size synthetic JSON parsing. Excludes Expo SQLite execution, native bridge transfer, Hermes, React rendering, and Photos/Calendar access.",
  reportPrivacy:
    "Aggregate timings and synthetic fixture dimensions only; no per-sample timings or user-library records.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Review mutation cache benchmark complete: isolated median ${isolatedTiming.medianMilliseconds} ms vs legacy ${legacyTiming.medianMilliseconds} ms; ${avoidedHydrations.toLocaleString()} full ${configuration.bytesPerHydration.toLocaleString()}-byte hydrations avoided per trace.`,
);
