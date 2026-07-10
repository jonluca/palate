#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/query-core";
import { REVIEW_QUERY_MOUNT_POLICY, reviewQueryKeys } from "../utils/review-query-policy.ts";

interface Configuration {
  readonly rowsPerQuery: number;
  readonly bytesPerQuery: number;
  readonly mountCycles: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface ModeledReviewRow {
  readonly id: number;
  readonly payload: string;
}

interface TraceMeasurement {
  readonly elapsedMilliseconds: number;
  readonly queryCalls: number;
  readonly transferredRows: number;
  readonly transferredBytes: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "legacyAlwaysRefetch" | "staleAware";

const DEFAULT_CONFIGURATION: Configuration = {
  rowsPerQuery: 6_511,
  bytesPerQuery: 7_883_042,
  mountCycles: 6,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/review-query-policy-profile.json",
};

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive safe integer; received ${value}`);
  }
  return parsed;
}

function parseArguments(argv: string[]): Configuration {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of argv) {
    if (argument.startsWith("--rows=")) {
      configuration.rowsPerQuery = parsePositiveInteger(argument.slice("--rows=".length), "rows");
    } else if (argument.startsWith("--bytes=")) {
      configuration.bytesPerQuery = parsePositiveInteger(argument.slice("--bytes=".length), "bytes");
    } else if (argument.startsWith("--mount-cycles=")) {
      configuration.mountCycles = parsePositiveInteger(argument.slice("--mount-cycles=".length), "mount-cycles");
    } else if (argument.startsWith("--samples=")) {
      configuration.samples = parsePositiveInteger(argument.slice("--samples=".length), "samples");
    } else if (argument.startsWith("--warmup=")) {
      configuration.warmupIterations = parsePositiveInteger(argument.slice("--warmup=".length), "warmup");
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
  assert.equal(Buffer.byteLength(payload), targetBytes, "modeled payload byte size must be exact");
  return payload;
}

async function waitForIdleSuccess(observer: QueryObserver<readonly ModeledReviewRow[]>): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (true) {
    const result = observer.getCurrentResult();
    if (result.status === "success" && result.fetchStatus === "idle") {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for the modeled review query");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function measureMountTrace(
  strategy: Strategy,
  configuration: Configuration,
  payload: string,
): Promise<TraceMeasurement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let queryCalls = 0;
  const options: QueryObserverOptions<readonly ModeledReviewRow[]> = {
    queryKey: reviewQueryKeys.pendingReview,
    queryFn: async () => {
      queryCalls += 1;
      return JSON.parse(payload) as ModeledReviewRow[];
    },
    ...(strategy === "legacyAlwaysRefetch"
      ? { staleTime: REVIEW_QUERY_MOUNT_POLICY.staleTime, refetchOnMount: "always" as const }
      : REVIEW_QUERY_MOUNT_POLICY),
  };

  const startedAt = performance.now();
  for (let mount = 0; mount < configuration.mountCycles; mount++) {
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);
    await waitForIdleSuccess(observer);
    assert.equal(observer.getCurrentResult().data?.length, configuration.rowsPerQuery);
    unsubscribe();
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  queryClient.clear();

  return {
    elapsedMilliseconds,
    queryCalls,
    transferredRows: queryCalls * configuration.rowsPerQuery,
    transferredBytes: queryCalls * configuration.bytesPerQuery,
  };
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function summarize(measurements: readonly TraceMeasurement[]): MeasurementSummary {
  const sorted = measurements.map((measurement) => measurement.elapsedMilliseconds).sort((a, b) => a - b);
  return {
    samplesMilliseconds: measurements.map((measurement) => Number(measurement.elapsedMilliseconds.toFixed(3))),
    minimumMilliseconds: Number(sorted[0].toFixed(3)),
    medianMilliseconds: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Milliseconds: Number(percentile(sorted, 0.95).toFixed(3)),
    maximumMilliseconds: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

const configuration = parseArguments(process.argv.slice(2));
const payload = createExactBytePayload(configuration.rowsPerQuery, configuration.bytesPerQuery);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  await measureMountTrace("legacyAlwaysRefetch", configuration, payload);
  await measureMountTrace("staleAware", configuration, payload);
}

const measurements: Record<Strategy, TraceMeasurement[]> = {
  legacyAlwaysRefetch: [],
  staleAware: [],
};
const measurementOrder: Strategy[][] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: Strategy[] =
    sample % 2 === 0 ? ["legacyAlwaysRefetch", "staleAware"] : ["staleAware", "legacyAlwaysRefetch"];
  measurementOrder.push(order);
  for (const strategy of order) {
    measurements[strategy].push(await measureMountTrace(strategy, configuration, payload));
  }
}

for (const measurement of measurements.legacyAlwaysRefetch) {
  assert.equal(measurement.queryCalls, configuration.mountCycles, "legacy policy should fetch on every mount");
}
for (const measurement of measurements.staleAware) {
  assert.equal(measurement.queryCalls, 1, "stale-aware policy should reuse the fresh cache after its first mount");
}

const legacySummary = summarize(measurements.legacyAlwaysRefetch);
const staleAwareSummary = summarize(measurements.staleAware);
const legacyCalls = configuration.mountCycles;
const staleAwareCalls = 1;
const avoidedCalls = legacyCalls - staleAwareCalls;
const report = {
  schemaVersion: 1,
  status: "ok",
  runtime: {
    node: process.version,
    tanstackQueryCore: "5.101.2",
  },
  configuration,
  modeledFixture: {
    rowsPerQuery: configuration.rowsPerQuery,
    bytesPerQuery: configuration.bytesPerQuery,
    exactPayloadBytes: Buffer.byteLength(payload),
    payloadShape: "JSON array with one independently allocated object and payload string per modeled row",
  },
  correctness: {
    observerBehaviorValidated: true,
    initialMountCalls: 1,
    freshRemounts: configuration.mountCycles - 1,
    legacyCallsPerTrace: legacyCalls,
    staleAwareCallsPerTrace: staleAwareCalls,
  },
  modeledTransferPerTrace: {
    legacy: {
      calls: legacyCalls,
      rows: legacyCalls * configuration.rowsPerQuery,
      bytes: legacyCalls * configuration.bytesPerQuery,
    },
    staleAware: {
      calls: staleAwareCalls,
      rows: staleAwareCalls * configuration.rowsPerQuery,
      bytes: staleAwareCalls * configuration.bytesPerQuery,
    },
    avoided: {
      calls: avoidedCalls,
      rows: avoidedCalls * configuration.rowsPerQuery,
      bytes: avoidedCalls * configuration.bytesPerQuery,
      percent: Number(((avoidedCalls / legacyCalls) * 100).toFixed(2)),
    },
  },
  timings: {
    legacyAlwaysRefetch: legacySummary,
    staleAware: staleAwareSummary,
    medianSpeedup: Number((legacySummary.medianMilliseconds / staleAwareSummary.medianMilliseconds).toFixed(2)),
  },
  measurementOrder,
  timingScope:
    "Node/V8 TanStack Query observer mount/unmount plus exact-size JSON parsing; excludes Expo SQLite, the native bridge, Hermes, React rendering, and Photos/Calendar access.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
