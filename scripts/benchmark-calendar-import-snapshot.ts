#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  planCalendarImportFromSnapshots,
  type CalendarImportSnapshot,
  type CalendarImportSnapshotPlan,
} from "../utils/calendar-import-plan-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

interface Configuration {
  readonly eventCount: 8_167;
  readonly candidateCount: 139;
  iterations: number;
  samples: number;
  warmupSamples: number;
  outputPath: string;
}

interface SyntheticEventKitEvent {
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly location: string | null;
  readonly startDate: number;
  readonly endDate: number;
  readonly importCandidate: CalendarImportSnapshot | null;
}

interface TimingSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface Workload {
  readonly name: "single" | "all";
  readonly selectedSnapshots: readonly CalendarImportSnapshot[];
  readonly selectedEventIds: ReadonlySet<string>;
  readonly restaurantOverrides: ReadonlyMap<string, string>;
}

const DEFAULT_CONFIGURATION: Configuration = {
  eventCount: 8_167,
  candidateCount: 139,
  iterations: 250,
  samples: 15,
  warmupSamples: 3,
  outputPath: ".build/calendar-import-snapshot-profile.json",
};
const NOW = 1_800_000_000_000;

let benchmarkSink: CalendarImportSnapshotPlan | undefined;

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${option} must be a non-negative safe integer.`);
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
    if (!argument.startsWith("--") || separator < 3) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (option === "--iterations") {
      configuration.iterations = parsePositiveInteger(value, option);
    } else if (option === "--samples") {
      configuration.samples = parsePositiveInteger(value, option);
    } else if (option === "--warmup") {
      configuration.warmupSamples = parseNonNegativeInteger(value, option);
    } else if (option === "--output") {
      if (value.length === 0) {
        throw new RangeError("--output cannot be empty.");
      }
      configuration.outputPath = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function restaurant(index: number): MichelinRestaurantRecord {
  return {
    id: `restaurant-${index.toString().padStart(4, "0")}`,
    name: index % 17 === 0 ? `Café O'Brien 🍣 ${index}` : `Restaurant ${index}`,
    latitude: 25 + (index % 90) / 10,
    longitude: -125 + (index % 120) / 10,
    address: `${index} Synthetic Avenue`,
    location: `Synthetic City ${index % 32}`,
    cuisine: index % 2 === 0 ? "Japanese" : "Contemporary",
    latestAwardYear: 2026,
    award: index % 3 === 0 ? "1 Star" : "Selected",
  };
}

function createFixture(configuration: Configuration): {
  readonly events: SyntheticEventKitEvent[];
  readonly candidates: CalendarImportSnapshot[];
} {
  const candidateIndexes = new Set(
    Array.from({ length: configuration.candidateCount }, (_, index) =>
      Math.floor((index * configuration.eventCount) / configuration.candidateCount),
    ),
  );
  const candidates: CalendarImportSnapshot[] = [];
  let candidateIndex = 0;
  const events = Array.from({ length: configuration.eventCount }, (_, eventIndex): SyntheticEventKitEvent => {
    const id = `event-${eventIndex.toString().padStart(5, "0")}`;
    const startDate = NOW - (configuration.eventCount - eventIndex) * 3_600_000;
    let importCandidate: CalendarImportSnapshot | null = null;
    if (candidateIndexes.has(eventIndex)) {
      const primary = restaurant(candidateIndex * 2);
      const alternate = restaurant(candidateIndex * 2 + 1);
      importCandidate = {
        calendarEventId: id,
        calendarEventTitle: `Dinner at ${primary.name}`,
        calendarEventLocation: `${primary.address}, ${primary.location}`,
        startDate,
        endDate: startDate + 90 * 60 * 1_000,
        matchedRestaurants: [primary, alternate],
        matchedRestaurant: primary,
      };
      candidates.push(importCandidate);
      candidateIndex += 1;
    }
    return {
      id,
      title: importCandidate?.calendarEventTitle ?? `Ordinary Calendar Event ${eventIndex}`,
      notes: eventIndex % 4 === 0 ? `Synthetic note ${eventIndex}` : null,
      location: importCandidate?.calendarEventLocation ?? (eventIndex % 3 === 0 ? `Location ${eventIndex}` : null),
      startDate,
      endDate: startDate + 60 * 60 * 1_000,
      importCandidate,
    };
  });
  assert.equal(candidates.length, configuration.candidateCount);
  return { events, candidates };
}

/** Literal benchmark oracle; it intentionally imports no production planner helpers. */
function literalLegacyPlan(
  snapshots: readonly CalendarImportSnapshot[],
  restaurantOverrides: ReadonlyMap<string, string>,
): CalendarImportSnapshotPlan {
  const seenEventIds = new Set<string>();
  const visitsToCreate: CalendarImportSnapshotPlan["visitsToCreate"] = [];
  for (const event of snapshots) {
    if (seenEventIds.has(event.calendarEventId) || event.startDate > NOW) {
      continue;
    }
    seenEventIds.add(event.calendarEventId);
    const overrideId = restaurantOverrides.get(event.calendarEventId);
    const selectedRestaurant = overrideId
      ? event.matchedRestaurants.find((restaurant) => restaurant.id === overrideId)
      : event.matchedRestaurant;
    assert.ok(selectedRestaurant, `benchmark override ${overrideId} must be an original match`);
    visitsToCreate.push({
      id: `cal-${event.calendarEventId}-${Math.floor(event.startDate / 3_600_000)}`,
      calendarEventId: event.calendarEventId,
      calendarEventTitle: event.calendarEventTitle,
      calendarEventLocation: event.calendarEventLocation,
      startTime: event.startDate,
      endTime: event.endDate,
      matchedRestaurantIds: [...new Set(event.matchedRestaurants.map((restaurant) => restaurant.id))],
      matchedRestaurant: {
        id: selectedRestaurant.id,
        name: selectedRestaurant.name,
        latitude: selectedRestaurant.latitude,
        longitude: selectedRestaurant.longitude,
        address: selectedRestaurant.address,
        cuisine: selectedRestaurant.cuisine,
      },
    });
  }
  return { visitsToCreate };
}

/** Synthetic model of the removed mutation path's full discovery traversal. */
function legacyRefetchModel(events: readonly SyntheticEventKitEvent[], workload: Workload): CalendarImportSnapshotPlan {
  const discoveredCandidates: CalendarImportSnapshot[] = [];
  for (const event of events) {
    if (event.importCandidate) {
      discoveredCandidates.push(event.importCandidate);
    }
  }
  const requestedCandidates = discoveredCandidates.filter((candidate) =>
    workload.selectedEventIds.has(candidate.calendarEventId),
  );
  return literalLegacyPlan(requestedCandidates, workload.restaurantOverrides);
}

function resolvedSnapshotModel(workload: Workload): CalendarImportSnapshotPlan {
  return planCalendarImportFromSnapshots(workload.selectedSnapshots, {
    now: NOW,
    restaurantOverrides: workload.restaurantOverrides,
  });
}

function measure(iterations: number, run: () => CalendarImportSnapshotPlan): number {
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    benchmarkSink = run();
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.ok(benchmarkSink);
  return elapsedMilliseconds / iterations;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summarize(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function benchmarkWorkload(
  configuration: Configuration,
  events: readonly SyntheticEventKitEvent[],
  workload: Workload,
): object {
  const legacyResult = legacyRefetchModel(events, workload);
  const snapshotResult = resolvedSnapshotModel(workload);
  assert.deepEqual(snapshotResult, legacyResult);

  for (let sample = 0; sample < configuration.warmupSamples; sample++) {
    measure(configuration.iterations, () => legacyRefetchModel(events, workload));
    measure(configuration.iterations, () => resolvedSnapshotModel(workload));
  }

  const legacySamples: number[] = [];
  const snapshotSamples: number[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    if (sample % 2 === 0) {
      legacySamples.push(measure(configuration.iterations, () => legacyRefetchModel(events, workload)));
      snapshotSamples.push(measure(configuration.iterations, () => resolvedSnapshotModel(workload)));
    } else {
      snapshotSamples.push(measure(configuration.iterations, () => resolvedSnapshotModel(workload)));
      legacySamples.push(measure(configuration.iterations, () => legacyRefetchModel(events, workload)));
    }
  }

  const legacy = summarize(legacySamples);
  const snapshot = summarize(snapshotSamples);
  return {
    selectedCandidateCount: workload.selectedSnapshots.length,
    exactPlanParity: true,
    planSha256: digest(snapshotResult),
    strategies: {
      legacySyntheticRefetch: {
        eventKitDiscoveryCallsPerMutation: 1,
        syntheticEventRowsTraversedPerMutation: configuration.eventCount,
        timing: legacy,
      },
      resolvedRenderedSnapshots: {
        eventKitDiscoveryCallsPerMutation: 0,
        syntheticEventRowsTraversedPerMutation: 0,
        timing: snapshot,
      },
    },
    comparison: {
      syntheticMedianSpeedup: legacy.medianMilliseconds / snapshot.medianMilliseconds,
      syntheticMedianMillisecondsSaved: legacy.medianMilliseconds - snapshot.medianMilliseconds,
      eventKitDiscoveryCallsEliminatedPerMutation: 1,
      syntheticEventRowsAvoidedPerMutation: configuration.eventCount,
    },
  };
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  const fixture = createFixture(configuration);
  const singleSnapshot = fixture.candidates[Math.floor(fixture.candidates.length / 2)]!;
  const allOverrides = new Map<string, string>();
  fixture.candidates.forEach((candidate, index) => {
    if (index % 17 === 0) {
      allOverrides.set(candidate.calendarEventId, candidate.matchedRestaurants[1]!.id);
    }
  });
  const workloads: Workload[] = [
    {
      name: "single",
      selectedSnapshots: [singleSnapshot],
      selectedEventIds: new Set([singleSnapshot.calendarEventId]),
      restaurantOverrides: new Map(),
    },
    {
      name: "all",
      selectedSnapshots: fixture.candidates,
      selectedEventIds: new Set(fixture.candidates.map((candidate) => candidate.calendarEventId)),
      restaurantOverrides: allOverrides,
    },
  ];

  const benchmarkResults = Object.fromEntries(
    workloads.map((workload) => [workload.name, benchmarkWorkload(configuration, fixture.events, workload)]),
  );
  const report = {
    schemaVersion: 1,
    status: "ok",
    benchmark: "calendar-import-rendered-snapshot-reuse",
    generatedAt: new Date().toISOString(),
    configuration,
    fixture: {
      eventKitEventCount: fixture.events.length,
      importCandidateCount: fixture.candidates.length,
      aggregateShapeSource: "existing privacy-safe Mac Calendar profile and signed Calendar Imports count",
      containsRealCalendarData: false,
    },
    measurementModel: {
      scope: "deterministic synthetic JavaScript orchestration and pure import-plan construction",
      includes: [
        "legacy-model traversal of 8,167 synthetic eligible EventKit rows",
        "selection of 139 synthetic import candidates",
        "production pure snapshot planner and override mapping",
      ],
      excludes: [
        "EventKit and Calendar I/O",
        "the React Native/Expo bridge",
        "Michelin SQLite discovery and hydration",
        "linked/dismissed SQLite recheck",
        "visit and suggestion persistence",
        "React rendering and mutation lifecycle",
      ],
      interpretation:
        "Timing is a synthetic orchestration model, not an EventKit or signed-app speedup claim. The production structural result is one full EventKit discovery call eliminated per import mutation.",
    },
    correctness: {
      exactPlanParityBeforeTiming: true,
      baselinePlanner: "independent literal implementation of the removed mapping",
      comparedFields: [
        "ordered visit IDs and Calendar fields",
        "selected restaurant identity and coordinates",
        "ordered original matched-restaurant IDs used by the transactional conflict recheck",
      ],
    },
    workloads: benchmarkResults,
  };

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
