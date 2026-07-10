#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  mountWrappedQueries,
  readProductionPolicyContract,
  weightedSqlDelta,
  type ProductionPolicyContract,
} from "./tab-query-refetch-policy-core.ts";

interface Configuration {
  samples: number;
  warmupIterations: number;
  staleNavigationEvents: number;
  outputPath: string;
}

interface NavigationMeasurement {
  readonly elapsedMilliseconds: number;
  readonly navigationWeightedSqlCalls: number;
  readonly mutationInvalidationWeightedSqlCalls: number;
  readonly focusedRefreshWeightedSqlCalls: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "legacyPathnameSweep" | "candidateFocusedInvalidation";

const DEFAULT_CONFIGURATION: Configuration = {
  samples: 9,
  warmupIterations: 2,
  staleNavigationEvents: 6,
  outputPath: ".build/tab-query-refetch-policy-profile.json",
};

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer; received ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed === 0) {
    throw new RangeError(`${name} must be positive; received ${value}`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Configuration {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of argv) {
    if (argument.startsWith("--samples=")) {
      configuration.samples = parsePositiveInteger(argument.slice("--samples=".length), "samples");
    } else if (argument.startsWith("--warmup=")) {
      configuration.warmupIterations = parseNonNegativeInteger(argument.slice("--warmup=".length), "warmup");
    } else if (argument.startsWith("--navigation-events=")) {
      configuration.staleNavigationEvents = parsePositiveInteger(
        argument.slice("--navigation-events=".length),
        "navigation-events",
      );
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

async function measureLegacy(
  contract: ProductionPolicyContract,
  navigationEvents: number,
): Promise<NavigationMeasurement> {
  const mounted = await mountWrappedQueries(contract, "legacy");
  try {
    const beforeNavigation = mounted.snapshot();
    const startedAt = performance.now();
    for (let event = 0; event < navigationEvents; event++) {
      mounted.markBothAgeStale();
      const beforeEvent = mounted.snapshot();
      await mounted.legacyPathnameNavigation();
      assert.equal(weightedSqlDelta(beforeEvent, mounted.snapshot()), 39);
    }
    const elapsedMilliseconds = performance.now() - startedAt;
    return {
      elapsedMilliseconds,
      navigationWeightedSqlCalls: weightedSqlDelta(beforeNavigation, mounted.snapshot()),
      mutationInvalidationWeightedSqlCalls: 0,
      focusedRefreshWeightedSqlCalls: 0,
    };
  } finally {
    mounted.close();
  }
}

async function measureCandidate(
  contract: ProductionPolicyContract,
  navigationEvents: number,
): Promise<NavigationMeasurement> {
  const mounted = await mountWrappedQueries(contract, "candidate");
  try {
    const beforeNavigation = mounted.snapshot();
    const startedAt = performance.now();
    for (let event = 0; event < navigationEvents; event++) {
      mounted.markBothAgeStale();
      const beforeEvent = mounted.snapshot();
      await mounted.candidatePathnameNavigation();
      assert.equal(weightedSqlDelta(beforeEvent, mounted.snapshot()), 0);
    }
    const elapsedMilliseconds = performance.now() - startedAt;
    const navigationWeightedSqlCalls = weightedSqlDelta(beforeNavigation, mounted.snapshot());

    await mounted.setStatsFocused(false);
    const beforeInvalidation = mounted.snapshot();
    await mounted.invalidateForModeledMutation();
    const mutationInvalidationWeightedSqlCalls = weightedSqlDelta(beforeInvalidation, mounted.snapshot());
    assert.equal(mutationInvalidationWeightedSqlCalls, 0);
    assert.equal(mounted.bothQueriesInvalidated(), true);

    const beforeFocus = mounted.snapshot();
    await mounted.candidateStatsFocus();
    const focusedRefreshWeightedSqlCalls = weightedSqlDelta(beforeFocus, mounted.snapshot());
    assert.equal(focusedRefreshWeightedSqlCalls, 39);

    return {
      elapsedMilliseconds,
      navigationWeightedSqlCalls,
      mutationInvalidationWeightedSqlCalls,
      focusedRefreshWeightedSqlCalls,
    };
  } finally {
    mounted.close();
  }
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function summarize(measurements: readonly NavigationMeasurement[]): MeasurementSummary {
  const values = measurements.map(({ elapsedMilliseconds }) => elapsedMilliseconds);
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMilliseconds: values.map((value) => Number(value.toFixed(3))),
    minimumMilliseconds: Number(sorted[0].toFixed(3)),
    medianMilliseconds: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Milliseconds: Number(percentile(sorted, 0.95).toFixed(3)),
    maximumMilliseconds: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

const configuration = parseArguments(process.argv.slice(2));
const contract = readProductionPolicyContract();
const expectedCallsPerStaleNavigation = contract.allTimeSqlCalls + contract.selectedYearSqlCalls;
assert.equal(expectedCallsPerStaleNavigation, 39);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  await measureLegacy(contract, configuration.staleNavigationEvents);
  await measureCandidate(contract, configuration.staleNavigationEvents);
}

const measurements: Record<Strategy, NavigationMeasurement[]> = {
  legacyPathnameSweep: [],
  candidateFocusedInvalidation: [],
};
const measurementOrder: Strategy[][] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: Strategy[] =
    sample % 2 === 0
      ? ["legacyPathnameSweep", "candidateFocusedInvalidation"]
      : ["candidateFocusedInvalidation", "legacyPathnameSweep"];
  measurementOrder.push(order);
  for (const strategy of order) {
    measurements[strategy].push(
      strategy === "legacyPathnameSweep"
        ? await measureLegacy(contract, configuration.staleNavigationEvents)
        : await measureCandidate(contract, configuration.staleNavigationEvents),
    );
  }
}

const expectedLegacyCalls = expectedCallsPerStaleNavigation * configuration.staleNavigationEvents;
for (const measurement of measurements.legacyPathnameSweep) {
  assert.equal(measurement.navigationWeightedSqlCalls, expectedLegacyCalls);
}
for (const measurement of measurements.candidateFocusedInvalidation) {
  assert.equal(measurement.navigationWeightedSqlCalls, 0);
  assert.equal(measurement.mutationInvalidationWeightedSqlCalls, 0);
  assert.equal(measurement.focusedRefreshWeightedSqlCalls, 39);
}

const legacySummary = summarize(measurements.legacyPathnameSweep);
const candidateSummary = summarize(measurements.candidateFocusedInvalidation);
const report = {
  schemaVersion: 1,
  status: "ok",
  benchmark: "tab-navigation-query-refetch-policy",
  runtime: {
    node: process.version,
    tanstackQueryCore: "5.101.2",
  },
  configuration,
  sourceContract: contract,
  correctness: {
    weightedSqlCallsPerStaleLegacyNavigation: 39,
    weightedSqlCallsPerCandidateNavigation: 0,
    weightedSqlCallsAtCandidateMutationInvalidation: 0,
    weightedSqlCallsAtCandidateFocusedRefresh: 39,
  },
  navigationTrace: {
    legacyWeightedSqlCalls: expectedLegacyCalls,
    candidateWeightedSqlCalls: 0,
    avoidedWeightedSqlCalls: expectedLegacyCalls,
    avoidedPercent: 100,
  },
  timings: {
    legacyPathnameSweep: legacySummary,
    candidateFocusedInvalidation: candidateSummary,
    medianSpeedup: Number((legacySummary.medianMilliseconds / candidateSummary.medianMilliseconds).toFixed(2)),
  },
  measurementOrder,
  timingScope:
    "Node/V8 TanStack Query observer and refetch-policy overhead with source-derived logical SQLite-call weights; excludes SQLite execution, Expo scheduling, the React Native bridge, rendering, and navigation animation.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
