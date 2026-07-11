#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { runOrderedPagePipeline, type OrderedPagePipelineStrategy } from "../utils/ordered-page-pipeline-core.ts";

interface Configuration {
  readonly pageCount: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface DelayShape {
  readonly name: string;
  readonly classificationMilliseconds: number;
  readonly consumptionMilliseconds: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly maximumResidentPages: number;
  readonly checksum: number;
}

interface TimingSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  pageCount: 10,
  samples: 7,
  warmupIterations: 2,
  outputPath: ".build/vision-page-orchestration-profile.json",
};
const STRATEGIES = ["serial", "lookahead"] as const;
const DELAY_SHAPES: readonly DelayShape[] = [
  { name: "classification-dominant", classificationMilliseconds: 8, consumptionMilliseconds: 2 },
  { name: "balanced", classificationMilliseconds: 5, consumptionMilliseconds: 5 },
  { name: "persistence-dominant", classificationMilliseconds: 2, consumptionMilliseconds: 8 },
];

function usage(): string {
  return `Usage: benchmark-ordered-page-pipeline.ts [options]

  --pages=N     Ordered pages per run (default: ${DEFAULT_CONFIGURATION.pageCount})
  --samples=N   Measured repetitions (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N    Warmup repetitions (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h    Show this help`;
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
  let pageCount = DEFAULT_CONFIGURATION.pageCount;
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
      case "--pages":
        pageCount = parseInteger(value, option);
        break;
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

  return { pageCount, samples, warmupIterations, outputPath };
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

function idealElapsedMilliseconds(pageCount: number, shape: DelayShape, strategy: OrderedPagePipelineStrategy): number {
  if (strategy === "serial") {
    return pageCount * (shape.classificationMilliseconds + shape.consumptionMilliseconds);
  }
  return (
    shape.classificationMilliseconds +
    (pageCount - 1) * Math.max(shape.classificationMilliseconds, shape.consumptionMilliseconds) +
    shape.consumptionMilliseconds
  );
}

async function measure(
  pageCount: number,
  shape: DelayShape,
  strategy: OrderedPagePipelineStrategy,
): Promise<Measurement> {
  const pages = Array.from({ length: pageCount }, (_, index) => index);
  const consumed: number[] = [];
  let residentPages = 0;
  let maximumResidentPages = 0;
  let checksum = 2_166_136_261;
  const startedAt = performance.now();

  await runOrderedPagePipeline({
    pages,
    strategy,
    produce: async (page) => {
      await delay(shape.classificationMilliseconds);
      residentPages += 1;
      maximumResidentPages = Math.max(maximumResidentPages, residentPages);
      return page;
    },
    consume: async (produced) => {
      await delay(shape.consumptionMilliseconds);
      consumed.push(produced);
      checksum = Math.imul(checksum ^ (produced + 1), 16_777_619) >>> 0;
      residentPages -= 1;
    },
  });

  assert.deepEqual(consumed, pages);
  assert.equal(residentPages, 0);
  assert.ok(maximumResidentPages <= (strategy === "serial" ? 1 : 2));
  return { elapsedMilliseconds: performance.now() - startedAt, maximumResidentPages, checksum };
}

async function benchmarkShape(shape: DelayShape, configuration: Configuration): Promise<Record<string, unknown>> {
  const samplesByStrategy = new Map<OrderedPagePipelineStrategy, number[]>(
    STRATEGIES.map((strategy) => [strategy, []]),
  );
  const maximumResidentPagesByStrategy = new Map<OrderedPagePipelineStrategy, number>();
  let expectedChecksum: number | undefined;
  const totalIterations = configuration.warmupIterations + configuration.samples;

  for (let iteration = 0; iteration < totalIterations; iteration++) {
    const order = iteration % 2 === 0 ? STRATEGIES : (["lookahead", "serial"] as const);
    for (const strategy of order) {
      const measurement = await measure(configuration.pageCount, shape, strategy);
      expectedChecksum ??= measurement.checksum;
      assert.equal(measurement.checksum, expectedChecksum);
      maximumResidentPagesByStrategy.set(
        strategy,
        Math.max(maximumResidentPagesByStrategy.get(strategy) ?? 0, measurement.maximumResidentPages),
      );
      if (iteration >= configuration.warmupIterations) {
        samplesByStrategy.get(strategy)!.push(measurement.elapsedMilliseconds);
      }
    }
  }

  const serialIdeal = idealElapsedMilliseconds(configuration.pageCount, shape, "serial");
  const lookaheadIdeal = idealElapsedMilliseconds(configuration.pageCount, shape, "lookahead");
  const serialTiming = summarize(samplesByStrategy.get("serial")!);
  const lookaheadTiming = summarize(samplesByStrategy.get("lookahead")!);

  return {
    name: shape.name,
    delaysMilliseconds: {
      classification: shape.classificationMilliseconds,
      transformAndPersistence: shape.consumptionMilliseconds,
    },
    exactOrderedParity: true,
    checksum: expectedChecksum!.toString(16).padStart(8, "0"),
    idealModel: {
      serialElapsedMilliseconds: serialIdeal,
      lookaheadElapsedMilliseconds: lookaheadIdeal,
      lookaheadSpeedupRatio: serialIdeal / lookaheadIdeal,
      overlappedMilliseconds: serialIdeal - lookaheadIdeal,
    },
    strategies: {
      serial: {
        timing: serialTiming,
        maximumResidentPages: maximumResidentPagesByStrategy.get("serial"),
      },
      lookahead: {
        timing: lookaheadTiming,
        maximumResidentPages: maximumResidentPagesByStrategy.get("lookahead"),
      },
    },
    observedMedianSpeedupRatio: serialTiming.medianMilliseconds / lookaheadTiming.medianMilliseconds,
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const datasets: Record<string, unknown>[] = [];
for (const shape of DELAY_SHAPES) {
  // Keep every timing sample isolated from the other modeled workloads.
  datasets.push(await benchmarkShape(shape, configuration));
}

const report = {
  schemaVersion: 1,
  status: "ok",
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version },
  configuration,
  correctness: {
    exactOrderedParity: true,
    maximumLookaheadPages: 1,
    maximumResidentResultPages: 2,
  },
  measurementScope:
    "Isolated Node timer model of asynchronous native classification and ordered transform/persistence delays. It validates orchestration overlap and bounds, but excludes PhotoKit, Vision, React Native bridge serialization, SQLite, app UI work, and real-library scheduling; it is not an end-to-end speedup claim.",
  datasets,
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
