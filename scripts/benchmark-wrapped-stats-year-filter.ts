#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  createWrappedStatsYearFilterDatabase,
  createWrappedStatsYearFilterHarness,
  seedWrappedStatsYearFilterBenchmark,
} from "./wrapped-stats-year-filter-harness.ts";

interface MeasurementSamples {
  legacy: number[];
  indexed: number[];
}

const database = createWrappedStatsYearFilterDatabase();
try {
  const visitCount = 40000;
  const samples = 7;
  seedWrappedStatsYearFilterBenchmark(database, visitCount);
  const indexed = createWrappedStatsYearFilterHarness(database, "indexed");
  const legacy = createWrappedStatsYearFilterHarness(database, "legacy");
  const year = 2025;
  const expected = JSON.stringify(await legacy.getWrappedStats(year));
  assert.equal(JSON.stringify(await indexed.getWrappedStats(year)), expected);
  const measurements: MeasurementSamples = { legacy: [], indexed: [] };
  for (let index = 0; index < samples; index++) {
    for (const strategy of index % 2 ? (["indexed", "legacy"] as const) : (["legacy", "indexed"] as const)) {
      const harness = strategy === "indexed" ? indexed : legacy;
      harness.queries.length = 0;
      const start = performance.now();
      const result = await harness.getWrappedStats(year);
      measurements[strategy].push(performance.now() - start);
      assert.equal(JSON.stringify(result), expected);
      assert.equal(harness.queries.length, 19);
    }
  }
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)]!,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      samplesMs: values,
    };
  };
  const legacySummary = summary(measurements.legacy);
  const indexedSummary = summary(measurements.indexed);
  console.log(
    JSON.stringify(
      {
        benchmark: "wrapped-stats-year-filter",
        fixture: "deterministic synthetic",
        runtime: process.version,
        sqlite: database.prepare("SELECT sqlite_version() AS version").get()?.version,
        visitCount,
        years: 20,
        selectedYear: year,
        queriesPerRefresh: 19,
        resultParity: true,
        legacy: legacySummary,
        indexed: indexedSummary,
        speedup: legacySummary.medianMs / indexedSummary.medianMs,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
