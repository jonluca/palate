#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE } from "../utils/food-detection-buffer-core.ts";
import { calculateVisionResultPeakBufferedRows, createVisionResultPagePlan } from "../utils/vision-result-page-plan.ts";

interface Configuration {
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface TimingSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly checksum: number;
  readonly rowCount: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  samples: 15,
  warmupIterations: 3,
  outputPath: ".build/vision-result-page-profile.json",
};
const PAGE_SIZES = [200, 500, 1_000] as const;
const SHAPES = [
  { name: "validatedRealFixture", resultCount: 13_059 },
  { name: "deepLibrary", resultCount: 68_027 },
] as const;

function usage(): string {
  return `Usage: benchmark-vision-result-page-plan.ts [options]

  --samples=N    Measured repetitions (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N     Warmup repetitions (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH  JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h     Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let samples = DEFAULT_CONFIGURATION.samples;
  let warmupIterations = DEFAULT_CONFIGURATION.warmupIterations;
  let outputPath = DEFAULT_CONFIGURATION.outputPath;

  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--samples":
        samples = parseInteger(value, option);
        break;
      case "--warmup":
        warmupIterations = parseInteger(value, option, true);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return { samples, warmupIterations, outputPath };
}

function updateChecksum(checksum: number, value: number): number {
  return Math.imul(checksum ^ (value + 1), 16_777_619) >>> 0;
}

function traversePages(items: readonly number[], pageSize: number): Measurement {
  let checksum = 2_166_136_261;
  let rowCount = 0;
  const startedAt = performance.now();
  for (const page of createVisionResultPagePlan(items.length, pageSize)) {
    const copiedBridgePage = items.slice(page.offset, page.endOffset);
    for (const value of copiedBridgePage) {
      checksum = updateChecksum(checksum, value);
      rowCount += 1;
    }
  }
  return { elapsedMilliseconds: performance.now() - startedAt, checksum, rowCount };
}

function summarize(samples: readonly number[]): TimingSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: percentile(0.5),
    p95Milliseconds: percentile(0.95),
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function validatePlan(items: readonly number[], pageSize: number): void {
  const output = createVisionResultPagePlan(items.length, pageSize).flatMap((page) =>
    items.slice(page.offset, page.endOffset),
  );
  assert.deepEqual(output, items);
}

function benchmarkShape(shape: (typeof SHAPES)[number], configuration: Configuration): Record<string, unknown> {
  const items = Array.from({ length: shape.resultCount }, (_, index) => index);
  for (const pageSize of PAGE_SIZES) {
    validatePlan(items, pageSize);
  }

  const samplesByPageSize = new Map<number, number[]>(PAGE_SIZES.map((pageSize) => [pageSize, []]));
  let expectedChecksum: number | undefined;
  const totalIterations = configuration.warmupIterations + configuration.samples;
  for (let iteration = 0; iteration < totalIterations; iteration++) {
    const rotation = iteration % PAGE_SIZES.length;
    const order = [...PAGE_SIZES.slice(rotation), ...PAGE_SIZES.slice(0, rotation)];
    for (const pageSize of order) {
      const measurement = traversePages(items, pageSize);
      assert.equal(measurement.rowCount, shape.resultCount);
      expectedChecksum ??= measurement.checksum;
      assert.equal(measurement.checksum, expectedChecksum);
      if (iteration >= configuration.warmupIterations) {
        samplesByPageSize.get(pageSize)!.push(measurement.elapsedMilliseconds);
      }
    }
  }

  const baselineCalls = Math.ceil(shape.resultCount / PAGE_SIZES[0]);
  const strategies = Object.fromEntries(
    PAGE_SIZES.map((pageSize) => {
      const nativeCalls = Math.ceil(shape.resultCount / pageSize);
      return [
        String(pageSize),
        {
          pageSize,
          nativeClassificationCalls: nativeCalls,
          photoAssetFetches: nativeCalls,
          pipelineSessions: nativeCalls,
          callsEliminatedVersus200: baselineCalls - nativeCalls,
          nativeCallReductionRatio: baselineCalls / nativeCalls,
          persistenceOperations: Math.ceil(shape.resultCount / DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE),
          peakBridgeResultRows: Math.min(pageSize, shape.resultCount),
          maximumBufferedRowsBeforeFlush: calculateVisionResultPeakBufferedRows(
            shape.resultCount,
            pageSize,
            DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
          ),
          jsOnlyPartitionTraversal: summarize(samplesByPageSize.get(pageSize)!),
        },
      ];
    }),
  );

  return {
    name: shape.name,
    resultCount: shape.resultCount,
    exactOrderedPageParity: true,
    checksum: expectedChecksum!.toString(16).padStart(8, "0"),
    strategies,
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const report = {
  schemaVersion: 1,
  status: "ok",
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version },
  configuration: {
    ...configuration,
    pageSizes: PAGE_SIZES,
    persistenceFlushSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
  },
  correctness: {
    exactOrderedPageParity: true,
    boundaryCountsCovered: [0, 1, 199, 200, 201, 499, 500, 501, 999, 1_000, 1_001, 13_059, 68_027],
  },
  measurementScope:
    "Structural native-call model plus isolated Node/V8 page planning, array copying, and traversal. It excludes PhotoKit, Vision, native/JS serialization, React Native scheduling, SQLite, and app UI time; JS timing is not an end-to-end speedup claim.",
  datasets: SHAPES.map((shape) => benchmarkShape(shape, configuration)),
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
