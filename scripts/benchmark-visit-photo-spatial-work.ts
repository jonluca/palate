#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MichelinLocationIndex } from "../utils/michelin-location-index.ts";
import { hasVisitPhotosForSpatialWork } from "../utils/visit-photo-spatial-work.ts";

interface Configuration {
  guideRows: number;
  samples: number;
  warmupIterations: number;
}

interface GuideRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number;
  readonly award: string;
}

interface Counters {
  calls: number;
  rows: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly counters: Counters;
  readonly resultIds: string[];
}

type Strategy = "legacyEager" | "photoGated";

const DEFAULT_CONFIGURATION: Configuration = {
  guideRows: 28_785,
  samples: 21,
  warmupIterations: 3,
};

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a positive integer; received ${value}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive safe integer; received ${value}.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === "--") {
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (option === "--guide-rows") {
      configuration.guideRows = parsePositiveInteger(value, option);
    } else if (option === "--samples") {
      configuration.samples = parsePositiveInteger(value, option);
    } else if (option === "--warmup") {
      configuration.warmupIterations = parsePositiveInteger(value, option);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function usage(): string {
  return `Usage: benchmark-visit-photo-spatial-work.ts [--guide-rows=${DEFAULT_CONFIGURATION.guideRows}] [--samples=${DEFAULT_CONFIGURATION.samples}] [--warmup=${DEFAULT_CONFIGURATION.warmupIterations}]`;
}

function createGuideRows(count: number): GuideRow[] {
  return Array.from({ length: count }, (_, index) => {
    const latitude = -80 + ((index * 37) % 160_000) / 1000;
    const longitude = -180 + ((index * 101) % 360_000) / 1000;
    return {
      id: `guide-${index.toString().padStart(5, "0")}`,
      name: `Restaurant ${index}`,
      latitude,
      longitude,
      address: `${index} Benchmark Street`,
      location: `Location ${index % 500}`,
      cuisine: `Cuisine ${index % 40}`,
      latestAwardYear: 2026,
      award: index % 5 === 0 ? "1 Star" : "Selected Restaurants",
    };
  });
}

function createLoader(
  sourceRows: readonly GuideRow[],
  counters: Counters,
): () => Promise<MichelinLocationIndex<GuideRow>> {
  return async () => {
    counters.calls += 1;
    counters.rows += sourceRows.length;
    const materializedRows = sourceRows.map((row) => ({ ...row }));
    return new MichelinLocationIndex(materializedRows);
  };
}

async function measure(strategy: Strategy, photoCount: number, sourceRows: readonly GuideRow[]): Promise<Measurement> {
  const counters: Counters = { calls: 0, rows: 0 };
  const loadIndex = createLoader(sourceRows, counters);
  const startedAt = performance.now();
  let index: MichelinLocationIndex<GuideRow> | null = null;
  if (strategy === "legacyEager") {
    index = await loadIndex();
    if (photoCount === 0) {
      index = null;
    }
  } else if (hasVisitPhotosForSpatialWork(photoCount)) {
    index = await loadIndex();
  }

  const resultIds = index
    ? index
        .findNearby({
          latitude: sourceRows[0]!.latitude,
          longitude: sourceRows[0]!.longitude,
          radiusMeters: 500,
          limit: 5,
        })
        .map(({ restaurant }) => restaurant.id)
    : [];
  return { elapsedMilliseconds: performance.now() - startedAt, counters, resultIds };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const guideRows = createGuideRows(configuration.guideRows);
for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  await measure("legacyEager", 0, guideRows);
  await measure("photoGated", 0, guideRows);
  await measure("legacyEager", 1, guideRows);
  await measure("photoGated", 1, guideRows);
}

const emptySamples: Record<Strategy, Measurement[]> = { legacyEager: [], photoGated: [] };
const nonEmptySamples: Record<Strategy, Measurement[]> = { legacyEager: [], photoGated: [] };
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: Strategy[] = sample % 2 === 0 ? ["legacyEager", "photoGated"] : ["photoGated", "legacyEager"];
  for (const strategy of order) {
    emptySamples[strategy].push(await measure(strategy, 0, guideRows));
    nonEmptySamples[strategy].push(await measure(strategy, 1, guideRows));
  }
}

for (const sample of emptySamples.legacyEager) {
  assert.deepEqual(sample.counters, { calls: 1, rows: configuration.guideRows });
  assert.deepEqual(sample.resultIds, []);
}
for (const sample of emptySamples.photoGated) {
  assert.deepEqual(sample.counters, { calls: 0, rows: 0 });
  assert.deepEqual(sample.resultIds, []);
}
for (let index = 0; index < configuration.samples; index++) {
  const legacy = nonEmptySamples.legacyEager[index]!;
  const candidate = nonEmptySamples.photoGated[index]!;
  assert.deepEqual(legacy.counters, { calls: 1, rows: configuration.guideRows });
  assert.deepEqual(candidate.counters, { calls: 1, rows: configuration.guideRows });
  assert.deepEqual(candidate.resultIds, legacy.resultIds);
}

const summarize = (samples: readonly Measurement[]) => {
  const milliseconds = samples.map(({ elapsedMilliseconds }) => elapsedMilliseconds);
  return {
    minimumMilliseconds: Number(Math.min(...milliseconds).toFixed(3)),
    medianMilliseconds: Number(median(milliseconds).toFixed(3)),
    maximumMilliseconds: Number(Math.max(...milliseconds).toFixed(3)),
  };
};
const legacyEmpty = summarize(emptySamples.legacyEager);
const gatedEmpty = summarize(emptySamples.photoGated);
const legacyNonEmpty = summarize(nonEmptySamples.legacyEager);
const gatedNonEmpty = summarize(nonEmptySamples.photoGated);

console.log(
  JSON.stringify(
    {
      schemaVersion: 2,
      status: "ok",
      runtime: { node: process.version },
      configuration,
      modeledPreconditions: {
        guideInitializationComplete: true,
        pendingSuggestionDatasetVersionCurrent: true,
      },
      fixture: {
        guideRows: guideRows.length,
        guidePayloadBytes: Buffer.byteLength(JSON.stringify(guideRows)),
      },
      correctness: {
        emptyResultParity: true,
        nonEmptyExactResultParity: true,
        measuredSamplesValidated: configuration.samples,
      },
      emptyPhotos: {
        legacy: { guideIndexCalls: 1, guideRowsMaterialized: configuration.guideRows, timing: legacyEmpty },
        photoGated: { guideIndexCalls: 0, guideRowsMaterialized: 0, timing: gatedEmpty },
        eliminatedGuideIndexCalls: 1,
        eliminatedGuideRows: configuration.guideRows,
        medianSpeedup: Number(
          (legacyEmpty.medianMilliseconds / Math.max(gatedEmpty.medianMilliseconds, 0.001)).toFixed(2),
        ),
      },
      nonEmptyPhotos: {
        legacy: { guideIndexCalls: 1, guideRowsMaterialized: configuration.guideRows, timing: legacyNonEmpty },
        photoGated: { guideIndexCalls: 1, guideRowsMaterialized: configuration.guideRows, timing: gatedNonEmpty },
      },
      timingScope:
        "Isolated direct per-scan Node/V8 guide-object materialization plus production MichelinLocationIndex construction and lookup after required guide initialization and versioned pending-suggestion refresh are current; excludes SQLite, Expo bridge, Photos, React Native, and app rendering. Direct call/row elimination is the primary claim.",
    },
    null,
    2,
  ),
);
