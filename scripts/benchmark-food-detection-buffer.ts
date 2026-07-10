#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  AsyncResultBuffer,
  DEFAULT_VISION_NATIVE_PAGE_SIZE,
  DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
} from "../utils/food-detection-buffer-core.ts";

interface BenchmarkResult {
  readonly sequence: number;
  readonly assetId: string;
  readonly containsFood: boolean;
}

interface BenchmarkConfiguration {
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly persistenceOperations: number;
  readonly checksum: number;
  readonly peakRetainedRows: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

const DEFAULT_CONFIGURATION: BenchmarkConfiguration = {
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/food-detection-buffer-profile.json",
};

const SHAPES = [
  { name: "onboarding", resultCount: 13_060 },
  { name: "deepScan", resultCount: 68_027 },
] as const;

function usage(): string {
  return `Usage: benchmark-food-detection-buffer.ts [options]

  --samples=N    Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N     Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
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

function parseConfiguration(arguments_: readonly string[]): BenchmarkConfiguration | null {
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

function createNativePages(resultCount: number): BenchmarkResult[][] {
  const pages: BenchmarkResult[][] = [];
  for (let offset = 0; offset < resultCount; offset += DEFAULT_VISION_NATIVE_PAGE_SIZE) {
    const count = Math.min(DEFAULT_VISION_NATIVE_PAGE_SIZE, resultCount - offset);
    pages.push(
      Array.from({ length: count }, (_, pageIndex) => {
        const sequence = offset + pageIndex;
        return {
          sequence,
          assetId: `asset-${sequence.toString().padStart(6, "0")}`,
          containsFood: sequence % 7 === 0,
        };
      }),
    );
  }
  return pages;
}

/** Independent row-by-row oracle; it does not use the buffer or Array.flat(). */
function concatenateOracle(pages: readonly (readonly BenchmarkResult[])[]): BenchmarkResult[] {
  let resultCount = 0;
  for (const page of pages) {
    resultCount += page.length;
  }

  const output = new Array<BenchmarkResult>(resultCount);
  let outputIndex = 0;
  for (const page of pages) {
    for (const result of page) {
      output[outputIndex] = result;
      outputIndex += 1;
    }
  }
  return output;
}

function updateChecksum(checksum: number, results: readonly BenchmarkResult[]): number {
  let next = checksum;
  for (const result of results) {
    next = Math.imul(next ^ (result.sequence + 1), 16_777_619) >>> 0;
    next = Math.imul(next ^ (result.containsFood ? 1 : 0), 16_777_619) >>> 0;
  }
  return next;
}

async function runNativePagePersistence(pages: readonly (readonly BenchmarkResult[])[]): Promise<Measurement> {
  let persistenceOperations = 0;
  let peakRetainedRows = 0;
  let checksum = 2_166_136_261;
  const startedAt = performance.now();
  for (const page of pages) {
    peakRetainedRows = Math.max(peakRetainedRows, page.length);
    await (async () => {
      persistenceOperations += 1;
      checksum = updateChecksum(checksum, page);
    })();
  }
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    persistenceOperations,
    checksum,
    peakRetainedRows,
  };
}

async function runBufferedPersistence(pages: readonly (readonly BenchmarkResult[])[]): Promise<Measurement> {
  let persistenceOperations = 0;
  let checksum = 2_166_136_261;
  const buffer = new AsyncResultBuffer<BenchmarkResult>({
    persist: async (results) => {
      persistenceOperations += 1;
      checksum = updateChecksum(checksum, results);
    },
  });

  const startedAt = performance.now();
  for (const page of pages) {
    await buffer.append(page);
  }
  await buffer.flush();
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    persistenceOperations,
    checksum,
    peakRetainedRows: buffer.maximumPendingCountObserved,
  };
}

async function validateExactConcatenation(
  pages: readonly (readonly BenchmarkResult[])[],
  oracle: readonly BenchmarkResult[],
): Promise<{ nativeOperations: number; bufferedOperations: number; bufferedBatchSizes: number[] }> {
  const nativeOutput: BenchmarkResult[] = [];
  let nativeOperations = 0;
  for (const page of pages) {
    nativeOperations += 1;
    nativeOutput.push(...page);
  }

  const bufferedOutput: BenchmarkResult[] = [];
  const bufferedBatchSizes: number[] = [];
  const buffer = new AsyncResultBuffer<BenchmarkResult>({
    persist: async (results) => {
      bufferedBatchSizes.push(results.length);
      bufferedOutput.push(...results);
    },
  });
  for (const page of pages) {
    await buffer.append(page);
  }
  await buffer.flush();

  assert.deepEqual(nativeOutput, oracle);
  assert.deepEqual(bufferedOutput, oracle);
  assert.equal(buffer.pendingCount, 0);
  return {
    nativeOperations,
    bufferedOperations: bufferedBatchSizes.length,
    bufferedBatchSizes,
  };
}

function summarize(samples: readonly number[]): MeasurementSummary {
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

async function benchmarkShape(shape: (typeof SHAPES)[number], configuration: BenchmarkConfiguration): Promise<object> {
  const pages = createNativePages(shape.resultCount);
  const oracle = concatenateOracle(pages);
  const validation = await validateExactConcatenation(pages, oracle);
  const expectedNativeOperations = Math.ceil(shape.resultCount / DEFAULT_VISION_NATIVE_PAGE_SIZE);
  const expectedBufferedOperations = Math.ceil(shape.resultCount / DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE);
  assert.equal(validation.nativeOperations, expectedNativeOperations);
  assert.equal(validation.bufferedOperations, expectedBufferedOperations);

  const nativeSamples: number[] = [];
  const bufferedSamples: number[] = [];
  let nativeMeasurement: Measurement | undefined;
  let bufferedMeasurement: Measurement | undefined;

  const totalIterations = configuration.warmupIterations + configuration.samples;
  for (let iteration = 0; iteration < totalIterations; iteration++) {
    const bufferedFirst = iteration % 2 === 1;
    if (bufferedFirst) {
      bufferedMeasurement = await runBufferedPersistence(pages);
      nativeMeasurement = await runNativePagePersistence(pages);
    } else {
      nativeMeasurement = await runNativePagePersistence(pages);
      bufferedMeasurement = await runBufferedPersistence(pages);
    }

    assert.equal(nativeMeasurement.checksum, bufferedMeasurement.checksum);
    assert.equal(nativeMeasurement.persistenceOperations, expectedNativeOperations);
    assert.equal(bufferedMeasurement.persistenceOperations, expectedBufferedOperations);
    if (iteration >= configuration.warmupIterations) {
      nativeSamples.push(nativeMeasurement.elapsedMilliseconds);
      bufferedSamples.push(bufferedMeasurement.elapsedMilliseconds);
    }
  }

  assert.ok(nativeMeasurement);
  assert.ok(bufferedMeasurement);
  return {
    name: shape.name,
    resultCount: shape.resultCount,
    nativePageCount: pages.length,
    exactConcatenationParity: true,
    finalBufferedBatchSize: validation.bufferedBatchSizes.at(-1),
    strategies: {
      nativePagePersistence: {
        persistenceOperations: nativeMeasurement.persistenceOperations,
        peakRetainedRows: nativeMeasurement.peakRetainedRows,
        timing: summarize(nativeSamples),
      },
      bufferedPersistence: {
        persistenceOperations: bufferedMeasurement.persistenceOperations,
        peakRetainedRows: bufferedMeasurement.peakRetainedRows,
        operationReductionRatio: nativeMeasurement.persistenceOperations / bufferedMeasurement.persistenceOperations,
        timing: summarize(bufferedSamples),
      },
    },
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const shapeReports = [];
for (const shape of SHAPES) {
  shapeReports.push(await benchmarkShape(shape, configuration));
}

const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.version,
  configuration: {
    nativePageSize: DEFAULT_VISION_NATIVE_PAGE_SIZE,
    persistenceFlushSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    maximumTheoreticalBufferedRows: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE + DEFAULT_VISION_NATIVE_PAGE_SIZE - 1,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
  },
  shapes: shapeReports,
  notes: [
    "Exact-order validation uses an independent row-by-row concatenation oracle.",
    "Elapsed time measures TypeScript orchestration only; persistence operation count models expensive database/bridge crossings.",
    "Peak retained rows counts the input page for page-at-a-time persistence and internal pending rows for buffered persistence.",
  ],
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
