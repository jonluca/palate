#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { validateCalendarVisitsForNativeMatching } from "../modules/calendar-matching/src/request-core.ts";

interface Configuration {
  readonly visits: number;
  readonly suggestions: number;
  readonly iterations: number;
  readonly samples: number;
  readonly warmupSamples: number;
  readonly outputPath: string;
}

interface BenchmarkVisit {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly suggestedRestaurants: readonly BenchmarkRestaurant[];
}

interface BenchmarkRestaurant {
  readonly id: string;
  readonly name: string;
}

interface Summary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 4_511,
  suggestions: 2_967,
  iterations: 100,
  samples: 15,
  warmupSamples: 3,
  outputPath: ".build/calendar-matching-request-profile.json",
};

let benchmarkSink: readonly BenchmarkVisit[] | undefined;

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${option} must be a non-negative integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--visits":
        configuration.visits = parsePositiveInteger(value, option);
        break;
      case "--suggestions":
        configuration.suggestions = parseNonNegativeInteger(value, option);
        break;
      case "--iterations":
        configuration.iterations = parsePositiveInteger(value, option);
        break;
      case "--samples":
        configuration.samples = parsePositiveInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupSamples = parseNonNegativeInteger(value, option);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function buildVisits(visitCount: number, suggestionCount: number): BenchmarkVisit[] {
  const suggestionsPerVisit = Math.floor(suggestionCount / visitCount);
  let extraSuggestions = suggestionCount % visitCount;
  let nextSuggestionIndex = 0;

  return Array.from({ length: visitCount }, (_, visitIndex) => {
    const count = suggestionsPerVisit + (extraSuggestions > 0 ? 1 : 0);
    if (extraSuggestions > 0) {
      extraSuggestions -= 1;
    }
    const suggestedRestaurants = Array.from({ length: count }, () => {
      const suggestionIndex = nextSuggestionIndex++;
      return {
        id: `restaurant-${suggestionIndex.toString().padStart(6, "0")}`,
        name: suggestionIndex === 0 ? "O'Brien's 🍣" : `Restaurant ${suggestionIndex} Café`,
      };
    });
    const startTime = 1_700_000_000_000 + visitIndex * 86_400_000;
    return {
      id: `visit-${visitIndex.toString().padStart(6, "0")}`,
      startTime,
      endTime: startTime + 3_600_000,
      suggestedRestaurants,
    };
  });
}

function legacyCloneAndValidate(visits: readonly BenchmarkVisit[]): BenchmarkVisit[] {
  return visits.map((visit) => {
    if (!Number.isFinite(visit.startTime) || Math.abs(visit.startTime) > 8_640_000_000_000_000) {
      throw new TypeError("visit.startTime must be a valid ECMAScript Date timestamp in milliseconds.");
    }
    if (!Number.isFinite(visit.endTime) || Math.abs(visit.endTime) > 8_640_000_000_000_000) {
      throw new TypeError("visit.endTime must be a valid ECMAScript Date timestamp in milliseconds.");
    }
    if (visit.endTime < visit.startTime) {
      throw new RangeError(`Visit ${visit.id} has an endTime before its startTime.`);
    }
    return {
      ...visit,
      suggestedRestaurants: visit.suggestedRestaurants.map((restaurant) => ({ ...restaurant })),
    };
  });
}

function measure(
  visits: readonly BenchmarkVisit[],
  iterations: number,
  prepare: (input: readonly BenchmarkVisit[]) => readonly BenchmarkVisit[],
): number {
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    benchmarkSink = prepare(visits);
  }
  const elapsed = performance.now() - startedAt;
  assert.equal(benchmarkSink?.length, visits.length);
  return elapsed / iterations;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0],
    medianMilliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  const visits = buildVisits(configuration.visits, configuration.suggestions);

  const legacyResult = legacyCloneAndValidate(visits);
  const productionResult = validateCalendarVisitsForNativeMatching(visits);
  assert.deepEqual(productionResult, legacyResult);
  assert.strictEqual(productionResult, visits);

  for (let sample = 0; sample < configuration.warmupSamples; sample++) {
    measure(visits, configuration.iterations, legacyCloneAndValidate);
    measure(visits, configuration.iterations, validateCalendarVisitsForNativeMatching);
  }

  const legacySamples: number[] = [];
  const productionSamples: number[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    if (sample % 2 === 0) {
      legacySamples.push(measure(visits, configuration.iterations, legacyCloneAndValidate));
      productionSamples.push(measure(visits, configuration.iterations, validateCalendarVisitsForNativeMatching));
    } else {
      productionSamples.push(measure(visits, configuration.iterations, validateCalendarVisitsForNativeMatching));
      legacySamples.push(measure(visits, configuration.iterations, legacyCloneAndValidate));
    }
  }

  const legacy = summarize(legacySamples);
  const production = summarize(productionSamples);
  const avoidedAllocationsPerCall = 1 + configuration.visits * 2 + configuration.suggestions;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration,
    correctness: {
      exactSerializedValueParity: true,
      productionRetainsInputIdentity: true,
    },
    allocationModel: {
      legacyContainersAndObjectsPerCall: avoidedAllocationsPerCall,
      productionContainersAndObjectsPerCall: 0,
      avoidedContainersAndObjectsPerCall: avoidedAllocationsPerCall,
    },
    strategies: {
      legacyCloneAndValidate: legacy,
      productionValidateWithoutClone: production,
    },
    comparison: {
      medianSpeedup: legacy.medianMilliseconds / production.medianMilliseconds,
      medianMillisecondsSaved: legacy.medianMilliseconds - production.medianMilliseconds,
      medianPercentReduction:
        ((legacy.medianMilliseconds - production.medianMilliseconds) / legacy.medianMilliseconds) * 100,
    },
  };

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main();
