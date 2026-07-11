#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY,
  resolveProviderReservationLocations,
  type LocatedProviderReservation,
  type ProviderReservationLocationCandidate,
  type ProviderReservationLocationInput,
} from "../utils/provider-reservation-location-core.ts";

interface BenchmarkReservation extends ProviderReservationLocationInput {
  readonly id: string;
  readonly queryOrdinal: number | null;
}

interface LookupMetrics {
  readonly calls: string[];
  readonly maxInFlight: number;
}

interface ScenarioResult {
  readonly scale: number;
  readonly requestedDuplicateRatio: number;
  readonly effectiveDuplicateRatio: number;
  readonly directCoordinateCount: number;
  readonly missingCoordinateCount: number;
  readonly uniqueExactQueryCount: number;
  readonly initialEmptyExactQueryCount: number;
  readonly duplicateRetryRequestCount: number;
  readonly legacySequential: {
    readonly requests: number;
    readonly maxInFlight: number;
    readonly criticalPathLatencyUnits: number;
    readonly outputSha256: string;
  };
  readonly planned: {
    readonly requests: number;
    readonly maxInFlight: number;
    readonly criticalPathLatencyUnits: number;
    readonly outputSha256: string;
  };
  readonly requestReductionPercent: number;
  readonly criticalPathSpeedup: number;
  readonly modeledThreeReplaysPlusApproval: {
    readonly legacyRequests: number;
    readonly plannedRequests: number;
    readonly reductionPercent: number;
  };
}

interface TockCaptureRequestScenario {
  readonly capturedReservations: number;
  readonly historyPages: number;
  readonly legacyGraphqlRequests: number;
  readonly plannedGraphqlRequests: number;
  readonly graphqlRequestReductionPercent: number;
  readonly shortFirstLegacyGraphqlRequests: number;
  readonly shortFirstPlannedGraphqlRequests: number;
  readonly shortFirstGraphqlRequestReductionPercent: number;
  readonly completeFirstNativePayloadPosts: number;
  readonly shortFirstNativeRetryStatusPosts: number;
  readonly shortFirstNativePayloadPosts: number;
}

const SCALES = [139, 256, 1_000] as const;
const DUPLICATE_RATIOS = [0, 0.5, 0.9] as const;
const MODELED_CAPTURE_DELIVERIES = 3;
const TOCK_HISTORY_PAGE_SIZE = 1_000;
const DEFAULT_OUTPUT = ".build/provider-reservation-location-profile.json";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSha256(relativePath: string): string {
  return sha256(readFileSync(new URL(relativePath, import.meta.url)));
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function modelTockCaptureRequests(capturedReservations: number): TockCaptureRequestScenario {
  const historyPages = Math.max(1, Math.ceil(capturedReservations / TOCK_HISTORY_PAGE_SIZE));
  const requestsPerCapture = 1 + historyPages;
  const legacyGraphqlRequests = MODELED_CAPTURE_DELIVERIES * requestsPerCapture;
  const plannedGraphqlRequests = requestsPerCapture;
  const shortFirstCaptureRequests = 2;
  const shortFirstLegacyGraphqlRequests =
    shortFirstCaptureRequests + (MODELED_CAPTURE_DELIVERIES - 1) * requestsPerCapture;
  const shortFirstPlannedGraphqlRequests = shortFirstCaptureRequests + requestsPerCapture;
  return {
    capturedReservations,
    historyPages,
    legacyGraphqlRequests,
    plannedGraphqlRequests,
    graphqlRequestReductionPercent: round((1 - plannedGraphqlRequests / legacyGraphqlRequests) * 100),
    shortFirstLegacyGraphqlRequests,
    shortFirstPlannedGraphqlRequests,
    shortFirstGraphqlRequestReductionPercent: round(
      (1 - shortFirstPlannedGraphqlRequests / shortFirstLegacyGraphqlRequests) * 100,
    ),
    completeFirstNativePayloadPosts: MODELED_CAPTURE_DELIVERIES,
    shortFirstNativeRetryStatusPosts: 1,
    shortFirstNativePayloadPosts: MODELED_CAPTURE_DELIVERIES - 1,
  };
}

function queryLatencyUnits(query: string): number {
  const ordinal = Number(query.match(/^Restaurant (\d+)/)?.[1] ?? 0);
  return 1 + ((ordinal * 7 + 3) % 13);
}

function placeResults(query: string): readonly ProviderReservationLocationCandidate[] {
  const ordinal = Number(query.match(/^Restaurant (\d+)/)?.[1] ?? 0);
  if (ordinal % 17 === 0) {
    return [];
  }
  return [
    {
      latitude: -70 + (ordinal % 140) + 0.125,
      longitude: -170 + (ordinal % 340) + 0.25,
      address: `Google ${ordinal}`,
    },
    { latitude: 89, longitude: 179, address: "Ignored second result" },
  ];
}

function fallbackResult(input: BenchmarkReservation): ProviderReservationLocationCandidate | null {
  const ordinal = input.queryOrdinal;
  if (ordinal === null || ordinal % 34 !== 0) {
    return null;
  }
  return {
    latitude: -60 + (ordinal % 120) + 0.5,
    longitude: -150 + (ordinal % 300) + 0.75,
    address: `Michelin ${ordinal}`,
  };
}

function createInputs(scale: number, requestedDuplicateRatio: number): BenchmarkReservation[] {
  const directCoordinateCount = Math.ceil(scale / 5);
  const missingCoordinateCount = scale - directCoordinateCount;
  const uniqueQueryCount = Math.max(1, Math.ceil(missingCoordinateCount * (1 - requestedDuplicateRatio)));
  let missingOrdinal = 0;
  return Array.from({ length: scale }, (_, index) => {
    if (index % 5 === 0) {
      return {
        id: `reservation-${index}`,
        queryOrdinal: null,
        restaurantName: `Direct ${index}`,
        address: null,
        latitude: 30 + (index % 50) / 100,
        longitude: -120 - (index % 50) / 100,
      };
    }

    const queryOrdinal = missingOrdinal % uniqueQueryCount;
    missingOrdinal += 1;
    return {
      id: `reservation-${index}`,
      queryOrdinal,
      restaurantName: `Restaurant ${queryOrdinal}`,
      address: `${queryOrdinal} Benchmark Road`,
      latitude: index % 19 === 0 ? 45 : null,
      longitude: null,
    };
  });
}

function createLookup(): {
  readonly searchPlaces: (query: string) => Promise<readonly ProviderReservationLocationCandidate[]>;
  readonly metrics: () => LookupMetrics;
} {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    searchPlaces: async (query) => {
      calls.push(query);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const latencyUnits = queryLatencyUnits(query);
        for (let unit = 0; unit < latencyUnits; unit++) {
          await Promise.resolve();
        }
        return placeResults(query);
      } finally {
        inFlight -= 1;
      }
    },
    metrics: () => ({ calls: [...calls], maxInFlight }),
  };
}

/** Independent semantic and request-shape oracle for the prior sequential loop. */
async function executeLiteralSequentialOracle(
  inputs: readonly BenchmarkReservation[],
  searchPlaces: (query: string) => Promise<readonly ProviderReservationLocationCandidate[]>,
): Promise<Array<LocatedProviderReservation<BenchmarkReservation> | null>> {
  const output: Array<LocatedProviderReservation<BenchmarkReservation> | null> = [];
  for (const input of inputs) {
    if (input.latitude !== null && input.longitude !== null) {
      output.push(input as LocatedProviderReservation<BenchmarkReservation>);
      continue;
    }

    const query = [input.restaurantName, input.address].filter(Boolean).join(" ");
    let places: readonly ProviderReservationLocationCandidate[] = [];
    if (query) {
      try {
        places = await searchPlaces(query);
      } catch {
        places = [];
      }
    }
    const location = places[0] ?? fallbackResult(input);
    output.push(
      location
        ? {
            ...input,
            latitude: location.latitude,
            longitude: location.longitude,
            address: input.address ?? location.address ?? null,
          }
        : null,
    );
  }
  return output;
}

function concurrentCriticalPath(queries: readonly string[], concurrency: number): number {
  if (queries.length === 0) {
    return 0;
  }
  const availableAt = Array.from({ length: Math.min(concurrency, queries.length) }, () => 0);
  for (const query of queries) {
    let firstAvailableWorker = 0;
    for (let worker = 1; worker < availableAt.length; worker++) {
      if (availableAt[worker]! < availableAt[firstAvailableWorker]!) {
        firstAvailableWorker = worker;
      }
    }
    availableAt[firstAvailableWorker] += queryLatencyUnits(query);
  }
  return Math.max(...availableAt);
}

function outputHash(output: readonly (LocatedProviderReservation<BenchmarkReservation> | null)[]): string {
  return sha256(JSON.stringify(output));
}

async function runScenario(scale: number, requestedDuplicateRatio: number): Promise<ScenarioResult> {
  const inputs = createInputs(scale, requestedDuplicateRatio);
  const legacyLookup = createLookup();
  const legacyOutput = await executeLiteralSequentialOracle(inputs, legacyLookup.searchPlaces);
  const legacyMetrics = legacyLookup.metrics();

  const plannedLookup = createLookup();
  const plannedOutput = await resolveProviderReservationLocations(inputs, {
    searchPlaces: plannedLookup.searchPlaces,
    findLocalFallback: fallbackResult,
  });
  const plannedMetrics = plannedLookup.metrics();
  assert.deepEqual(plannedOutput, legacyOutput);

  const directCoordinateCount = inputs.filter((input) => input.latitude !== null && input.longitude !== null).length;
  const missingCoordinateCount = inputs.length - directCoordinateCount;
  const initialQueries = [...new Set(legacyMetrics.calls)];
  const uniqueExactQueryCount = initialQueries.length;
  const initialEmptyQueries = new Set(initialQueries.filter((query) => !placeResults(query)[0]));
  const seenQueryCounts = new Map<string, number>();
  const retryQueries: string[] = [];
  for (const query of legacyMetrics.calls) {
    const occurrence = (seenQueryCounts.get(query) ?? 0) + 1;
    seenQueryCounts.set(query, occurrence);
    if (occurrence > 1 && initialEmptyQueries.has(query)) {
      retryQueries.push(query);
    }
  }
  assert.equal(legacyMetrics.calls.length, missingCoordinateCount);
  assert.deepEqual(plannedMetrics.calls, [...initialQueries, ...retryQueries]);
  assert.ok(plannedMetrics.maxInFlight <= DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY);

  const legacyCriticalPath = legacyMetrics.calls.reduce((total, query) => total + queryLatencyUnits(query), 0);
  const plannedCriticalPath =
    concurrentCriticalPath(initialQueries, DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY) +
    concurrentCriticalPath(retryQueries, DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY);
  const legacyReplayRequests = legacyMetrics.calls.length * (MODELED_CAPTURE_DELIVERIES + 1);
  const plannedReplayRequests = plannedMetrics.calls.length;
  const legacyHash = outputHash(legacyOutput);
  const plannedHash = outputHash(plannedOutput);
  assert.equal(plannedHash, legacyHash);

  return {
    scale,
    requestedDuplicateRatio,
    effectiveDuplicateRatio: round(1 - uniqueExactQueryCount / missingCoordinateCount, 6),
    directCoordinateCount,
    missingCoordinateCount,
    uniqueExactQueryCount,
    initialEmptyExactQueryCount: initialEmptyQueries.size,
    duplicateRetryRequestCount: retryQueries.length,
    legacySequential: {
      requests: legacyMetrics.calls.length,
      maxInFlight: legacyMetrics.maxInFlight,
      criticalPathLatencyUnits: legacyCriticalPath,
      outputSha256: legacyHash,
    },
    planned: {
      requests: plannedMetrics.calls.length,
      maxInFlight: plannedMetrics.maxInFlight,
      criticalPathLatencyUnits: plannedCriticalPath,
      outputSha256: plannedHash,
    },
    requestReductionPercent: round((1 - plannedMetrics.calls.length / legacyMetrics.calls.length) * 100),
    criticalPathSpeedup: round(legacyCriticalPath / plannedCriticalPath),
    modeledThreeReplaysPlusApproval: {
      legacyRequests: legacyReplayRequests,
      plannedRequests: plannedReplayRequests,
      reductionPercent: round((1 - plannedReplayRequests / legacyReplayRequests) * 100),
    },
  };
}

function parseOutputPath(arguments_: readonly string[]): string {
  let outputPath = DEFAULT_OUTPUT;
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length);
      if (!outputPath) {
        throw new RangeError("--output cannot be empty");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return outputPath;
}

const outputPath = resolve(parseOutputPath(process.argv.slice(2)));
const scenarios: ScenarioResult[] = [];
for (const scale of SCALES) {
  for (const duplicateRatio of DUPLICATE_RATIOS) {
    scenarios.push(await runScenario(scale, duplicateRatio));
  }
}

const report = {
  schemaVersion: 4,
  strategy: "provider-location-preparation-v4",
  deterministicLatencyModel: {
    unitDefinition: "1 + ((queryOrdinal * 7 + 3) % 13)",
    plannedConcurrency: DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY,
    captureDeliveriesBeforeApproval: MODELED_CAPTURE_DELIVERIES,
    note: "Latency units are deterministic fixture work, not wall-clock network measurements. Planned critical paths include the initial shared-query phase plus independent duplicate retries after empty results.",
  },
  sourceSha256: {
    core: sourceSha256("../utils/provider-reservation-location-core.ts"),
    replayGate: sourceSha256("../utils/provider-reservation-replay-gate-core.ts"),
    serviceWiring: sourceSha256("../services/reservation-import.ts"),
    browserWiring: sourceSha256("../components/reservation-import-browser-screen.tsx"),
    tockBridgeWiring: sourceSha256("../app/(app)/tock-import.tsx"),
    correctnessTest: sourceSha256("./test-provider-reservation-location.ts"),
    benchmark: sourceSha256("./benchmark-provider-reservation-location.ts"),
  },
  tockThreeDeliveryCaptureRequestModel: {
    deliveries: MODELED_CAPTURE_DELIVERIES,
    historyPageSize: TOCK_HISTORY_PAGE_SIZE,
    legacyFormula: "R * (1 + pages)",
    plannedFormula: "1 + pages",
    shortFirstLegacyFormula: "2 + (R - 1) * (1 + pages)",
    shortFirstPlannedFormula: "2 + (1 + pages)",
    cacheEligibility: "Nonempty and either unknown total or purchases.length >= known total",
    note: "A short known-total capture posts retry status with count 0 and no payload, keeping native review closed. The first complete nonempty capture becomes reviewable and cached; remaining deliveries repost that cache.",
    scenarios: SCALES.map(modelTockCaptureRequests),
  },
  scenarios,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, serialized, { mode: 0o600 });
chmodSync(outputPath, 0o600);
console.log(serialized.trimEnd());
console.error(`Wrote ${outputPath}`);
