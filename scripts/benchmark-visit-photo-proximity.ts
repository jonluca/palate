#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { calculateVisitPhotoCentroid } from "../utils/visit-photo-centroid-core.ts";
import {
  areVisitPhotosNearbyWithPreparedThreshold,
  prepareVisitPhotoDistanceThreshold,
  type VisitPhotoCoordinate,
} from "../utils/visit-photo-proximity-core.ts";

const DEGREES_TO_RADIANS = Math.PI / 180;
const EARTH_RADIUS_METERS = 6_371_000;
const LEGACY_QUICK_REJECT_LATITUDE_DEGREES = 0.003;
const LEGACY_QUICK_REJECT_LONGITUDE_DEGREES = 0.006;
const MAX_LITERAL_PARITY_THRESHOLD_METERS = 200;

interface Configuration {
  pairs: number;
  iterations: number;
  samples: number;
  warmupIterations: number;
  thresholdMeters: number;
}

interface CoordinatePair {
  readonly coordinate1: VisitPhotoCoordinate;
  readonly coordinate2: VisitPhotoCoordinate;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly nearbyCount: number;
  readonly checksum: number;
}

interface CentroidMeasurement {
  readonly elapsedMilliseconds: number;
  readonly checksum: number;
}

type Strategy = "literalLegacy" | "safeCandidate";
type CentroidStrategy = "literalArithmetic" | "wrapAwareCandidate";

const DEFAULT_CONFIGURATION: Configuration = {
  pairs: 100_000,
  iterations: 10,
  samples: 21,
  warmupIterations: 3,
  thresholdMeters: 100,
};

/** Literal copy of the removed service path, including its fixed quick-reject constants. */
function literalLegacyArePhotosNearby(
  coordinate1: VisitPhotoCoordinate,
  coordinate2: VisitPhotoCoordinate,
  thresholdMeters: number,
): boolean {
  const latitudeDifference = coordinate2.latitude - coordinate1.latitude;
  const longitudeDifference = coordinate2.longitude - coordinate1.longitude;
  if (
    latitudeDifference > LEGACY_QUICK_REJECT_LATITUDE_DEGREES ||
    latitudeDifference < -LEGACY_QUICK_REJECT_LATITUDE_DEGREES ||
    longitudeDifference > LEGACY_QUICK_REJECT_LONGITUDE_DEGREES ||
    longitudeDifference < -LEGACY_QUICK_REJECT_LONGITUDE_DEGREES
  ) {
    return false;
  }

  const latitudeDeltaRadians = latitudeDifference * DEGREES_TO_RADIANS;
  const longitudeDeltaRadians = longitudeDifference * DEGREES_TO_RADIANS;
  const averageLatitudeRadians = ((coordinate1.latitude + coordinate2.latitude) / 2) * DEGREES_TO_RADIANS;
  const scaledLongitudeDeltaRadians = longitudeDeltaRadians * Math.cos(averageLatitudeRadians);
  return (
    EARTH_RADIUS_METERS *
      Math.sqrt(
        scaledLongitudeDeltaRadians * scaledLongitudeDeltaRadians + latitudeDeltaRadians * latitudeDeltaRadians,
      ) <=
    thresholdMeters
  );
}

function literalArithmeticCentroid(coordinates: readonly VisitPhotoCoordinate[]): VisitPhotoCoordinate {
  const latitudeSum = coordinates.reduce((sum, coordinate) => sum + coordinate.latitude, 0);
  const longitudeSum = coordinates.reduce((sum, coordinate) => sum + coordinate.longitude, 0);
  return {
    latitude: latitudeSum / coordinates.length,
    longitude: longitudeSum / coordinates.length,
  };
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a positive integer; received ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive safe integer; received ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive finite number; received ${value}`);
  }
  if (parsed > MAX_LITERAL_PARITY_THRESHOLD_METERS) {
    throw new RangeError(
      `${option} must be at most ${MAX_LITERAL_PARITY_THRESHOLD_METERS} meters so the literal legacy bounds remain a valid ordinary-coordinate baseline; received ${value}`,
    );
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
    if (option === "--pairs") {
      configuration.pairs = parsePositiveInteger(value, option);
    } else if (option === "--iterations") {
      configuration.iterations = parsePositiveInteger(value, option);
    } else if (option === "--samples") {
      configuration.samples = parsePositiveInteger(value, option);
    } else if (option === "--warmup") {
      configuration.warmupIterations = parsePositiveInteger(value, option);
    } else if (option === "--threshold") {
      configuration.thresholdMeters = parsePositiveNumber(value, option);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function usage(): string {
  return `Usage: benchmark-visit-photo-proximity.ts [--pairs=${DEFAULT_CONFIGURATION.pairs}] [--iterations=${DEFAULT_CONFIGURATION.iterations}] [--samples=${DEFAULT_CONFIGURATION.samples}] [--warmup=${DEFAULT_CONFIGURATION.warmupIterations}] [--threshold=${DEFAULT_CONFIGURATION.thresholdMeters}]`;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function referenceGreatCircleDistanceMeters(
  coordinate1: VisitPhotoCoordinate,
  coordinate2: VisitPhotoCoordinate,
): number {
  if (
    coordinate1.latitude === coordinate2.latitude &&
    (coordinate1.longitude === coordinate2.longitude ||
      Math.abs(coordinate1.longitude - coordinate2.longitude) === 360 ||
      coordinate1.latitude === 90 ||
      coordinate1.latitude === -90)
  ) {
    return 0;
  }

  const latitude1 = coordinate1.latitude * DEGREES_TO_RADIANS;
  const latitude2 = coordinate2.latitude * DEGREES_TO_RADIANS;
  const longitude1 = coordinate1.longitude * DEGREES_TO_RADIANS;
  const longitude2 = coordinate2.longitude * DEGREES_TO_RADIANS;
  const coordinate1X = Math.cos(latitude1) * Math.cos(longitude1);
  const coordinate1Y = Math.cos(latitude1) * Math.sin(longitude1);
  const coordinate1Z = Math.sin(latitude1);
  const coordinate2X = Math.cos(latitude2) * Math.cos(longitude2);
  const coordinate2Y = Math.cos(latitude2) * Math.sin(longitude2);
  const coordinate2Z = Math.sin(latitude2);
  const crossX = coordinate1Y * coordinate2Z - coordinate1Z * coordinate2Y;
  const crossY = coordinate1Z * coordinate2X - coordinate1X * coordinate2Z;
  const crossZ = coordinate1X * coordinate2Y - coordinate1Y * coordinate2X;
  const sine = Math.hypot(crossX, crossY, crossZ);
  const cosine = Math.max(
    -1,
    Math.min(1, coordinate1X * coordinate2X + coordinate1Y * coordinate2Y + coordinate1Z * coordinate2Z),
  );
  return EARTH_RADIUS_METERS * Math.atan2(sine, cosine);
}

function createOrdinaryPairs(count: number): CoordinatePair[] {
  const random = createRandom(0x51a7_2026);
  return Array.from({ length: count }, (_, index) => {
    const latitude = random() * 130 - 65;
    const longitude = random() * 300 - 150;
    const sign = index % 2 === 0 ? 1 : -1;
    const mode = index % 6;
    let latitudeDelta: number;
    let longitudeDelta: number;
    if (mode === 0) {
      latitudeDelta = sign * random() * 0.0005;
      longitudeDelta = -sign * random() * 0.0005;
    } else if (mode === 1) {
      latitudeDelta = sign * (0.001 + random() * 0.0015);
      longitudeDelta = sign * random() * 0.0002;
    } else if (mode === 2) {
      latitudeDelta = sign * (0.0031 + random() * 0.0028);
      longitudeDelta = 0;
    } else if (mode === 3) {
      latitudeDelta = sign * random() * 0.0002;
      longitudeDelta = -sign * (0.001 + random() * 0.002);
    } else if (mode === 4) {
      latitudeDelta = 0;
      longitudeDelta = sign * (0.0061 + random() * 0.003);
    } else {
      latitudeDelta = sign * random() * 0.0001;
      longitudeDelta = -sign * random() * 0.0001;
    }
    return {
      coordinate1: { latitude, longitude },
      coordinate2: { latitude: latitude + latitudeDelta, longitude: longitude + longitudeDelta },
    };
  });
}

function createOrdinaryCentroidGroups(count: number): VisitPhotoCoordinate[][] {
  const random = createRandom(0xc37_2026);
  return Array.from({ length: count }, (_, groupIndex) => {
    const latitude = random() * 130 - 65;
    const longitude = random() * 300 - 150;
    return Array.from({ length: 4 }, (_, coordinateIndex) => {
      const signedIndex = coordinateIndex - 1.5;
      return {
        latitude: latitude + signedIndex * 0.000_1 + groupIndex * Number.EPSILON,
        longitude: longitude - signedIndex * 0.000_12,
      };
    });
  });
}

function runStrategy(
  strategy: Strategy,
  pairs: readonly CoordinatePair[],
  iterations: number,
  thresholdMeters: number,
): Measurement {
  const preparedThreshold = prepareVisitPhotoDistanceThreshold(thresholdMeters);
  assert.ok(preparedThreshold !== null);
  const implementation =
    strategy === "literalLegacy"
      ? (coordinate1: VisitPhotoCoordinate, coordinate2: VisitPhotoCoordinate) =>
          literalLegacyArePhotosNearby(coordinate1, coordinate2, thresholdMeters)
      : (coordinate1: VisitPhotoCoordinate, coordinate2: VisitPhotoCoordinate) =>
          areVisitPhotosNearbyWithPreparedThreshold(coordinate1, coordinate2, preparedThreshold);
  let nearbyCount = 0;
  let checksum = 0;
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index]!;
      if (implementation(pair.coordinate1, pair.coordinate2)) {
        nearbyCount += 1;
        checksum = (checksum + Math.imul(index + 1, iteration + 1)) >>> 0;
      }
    }
  }
  return { elapsedMilliseconds: performance.now() - startedAt, nearbyCount, checksum };
}

function runCentroidStrategy(
  strategy: CentroidStrategy,
  groups: readonly (readonly VisitPhotoCoordinate[])[],
  iterations: number,
): CentroidMeasurement {
  const implementation = strategy === "literalArithmetic" ? literalArithmeticCentroid : calculateVisitPhotoCentroid;
  let checksum = 0;
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const group of groups) {
      const centroid = implementation(group);
      assert.ok(centroid !== null);
      checksum += centroid.latitude * 0.25 + centroid.longitude * 0.125;
    }
  }
  return { elapsedMilliseconds: performance.now() - startedAt, checksum };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(samples: readonly { readonly elapsedMilliseconds: number }[]) {
  const milliseconds = samples.map(({ elapsedMilliseconds }) => elapsedMilliseconds);
  return {
    minimumMilliseconds: Number(Math.min(...milliseconds).toFixed(3)),
    medianMilliseconds: Number(percentile(milliseconds, 0.5).toFixed(3)),
    p95Milliseconds: Number(percentile(milliseconds, 0.95).toFixed(3)),
    maximumMilliseconds: Number(Math.max(...milliseconds).toFixed(3)),
  };
}

function elapsedChangePercent(candidateMilliseconds: number, baselineMilliseconds: number): number {
  return Number((((candidateMilliseconds - baselineMilliseconds) / baselineMilliseconds) * 100).toFixed(2));
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const pairs = createOrdinaryPairs(configuration.pairs);
const expected = runStrategy("literalLegacy", pairs, 1, configuration.thresholdMeters);
const actual = runStrategy("safeCandidate", pairs, 1, configuration.thresholdMeters);
assert.deepEqual(
  { nearbyCount: actual.nearbyCount, checksum: actual.checksum },
  { nearbyCount: expected.nearbyCount, checksum: expected.checksum },
  "ordinary-coordinate fixture must preserve literal legacy output",
);

const correctedCases: ReadonlyArray<{
  coordinate1: VisitPhotoCoordinate;
  coordinate2: VisitPhotoCoordinate;
  thresholdMeters: number;
}> = [
  {
    coordinate1: { latitude: 0, longitude: 179.9996 },
    coordinate2: { latitude: 0, longitude: -179.9996 },
    thresholdMeters: 100,
  },
  {
    coordinate1: { latitude: 89.9995, longitude: 0 },
    coordinate2: { latitude: 89.9995, longitude: 120 },
    thresholdMeters: 100,
  },
  { coordinate1: { latitude: 0, longitude: 0 }, coordinate2: { latitude: 0.004, longitude: 0 }, thresholdMeters: 500 },
];
for (const correctedCase of correctedCases) {
  assert.ok(
    referenceGreatCircleDistanceMeters(correctedCase.coordinate1, correctedCase.coordinate2) <=
      correctedCase.thresholdMeters,
  );
  assert.equal(
    literalLegacyArePhotosNearby(correctedCase.coordinate1, correctedCase.coordinate2, correctedCase.thresholdMeters),
    false,
  );
  assert.equal(
    areVisitPhotosNearbyWithPreparedThreshold(
      correctedCase.coordinate1,
      correctedCase.coordinate2,
      prepareVisitPhotoDistanceThreshold(correctedCase.thresholdMeters)!,
    ),
    true,
  );
}

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  runStrategy("literalLegacy", pairs, configuration.iterations, configuration.thresholdMeters);
  runStrategy("safeCandidate", pairs, configuration.iterations, configuration.thresholdMeters);
}

const samples: Record<Strategy, Measurement[]> = { literalLegacy: [], safeCandidate: [] };
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: Strategy[] = sample % 2 === 0 ? ["literalLegacy", "safeCandidate"] : ["safeCandidate", "literalLegacy"];
  for (const strategy of order) {
    samples[strategy].push(runStrategy(strategy, pairs, configuration.iterations, configuration.thresholdMeters));
  }
}

for (let sample = 0; sample < configuration.samples; sample++) {
  assert.equal(samples.literalLegacy[sample]!.nearbyCount, samples.safeCandidate[sample]!.nearbyCount);
  assert.equal(samples.literalLegacy[sample]!.checksum, samples.safeCandidate[sample]!.checksum);
}

const legacyTiming = summarize(samples.literalLegacy);
const candidateTiming = summarize(samples.safeCandidate);

const centroidGroups = createOrdinaryCentroidGroups(Math.min(configuration.pairs, 20_000));
for (const group of centroidGroups) {
  const literalCentroid = literalArithmeticCentroid(group);
  const candidateCentroid = calculateVisitPhotoCentroid(group);
  assert.ok(candidateCentroid !== null);
  assert.equal(Object.is(candidateCentroid.latitude, literalCentroid.latitude), true);
  assert.equal(Object.is(candidateCentroid.longitude, literalCentroid.longitude), true);
}
const crossingGroup = [
  { latitude: 10.25, longitude: 179.9996 },
  { latitude: 10.75, longitude: -179.9996 },
];
const crossingCentroid = calculateVisitPhotoCentroid(crossingGroup);
assert.ok(crossingCentroid !== null);
assert.equal(Object.is(crossingCentroid.latitude, literalArithmeticCentroid(crossingGroup).latitude), true);
assert.ok(Math.abs(Math.abs(crossingCentroid.longitude) - 180) < 1e-12);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  runCentroidStrategy("literalArithmetic", centroidGroups, configuration.iterations);
  runCentroidStrategy("wrapAwareCandidate", centroidGroups, configuration.iterations);
}
const centroidSamples: Record<CentroidStrategy, CentroidMeasurement[]> = {
  literalArithmetic: [],
  wrapAwareCandidate: [],
};
for (let sample = 0; sample < configuration.samples; sample++) {
  const order: CentroidStrategy[] =
    sample % 2 === 0 ? ["literalArithmetic", "wrapAwareCandidate"] : ["wrapAwareCandidate", "literalArithmetic"];
  for (const strategy of order) {
    centroidSamples[strategy].push(runCentroidStrategy(strategy, centroidGroups, configuration.iterations));
  }
}
for (let sample = 0; sample < configuration.samples; sample++) {
  assert.equal(
    centroidSamples.literalArithmetic[sample]!.checksum,
    centroidSamples.wrapAwareCandidate[sample]!.checksum,
  );
}
const literalCentroidTiming = summarize(centroidSamples.literalArithmetic);
const candidateCentroidTiming = summarize(centroidSamples.wrapAwareCandidate);

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      status: "ok",
      runtime: { node: process.version },
      configuration,
      fixture: {
        ordinaryCoordinatePairs: pairs.length,
        latitudeRange: [-65, 65],
        longitudeRange: [-150, 150],
        maximumLiteralParityThresholdMeters: MAX_LITERAL_PARITY_THRESHOLD_METERS,
        timedComparisonsPerSample: pairs.length * configuration.iterations,
      },
      correctness: {
        ordinaryExactResultParity: true,
        measuredSamplesValidated: configuration.samples,
        authoritativeCorrectedAntimeridianPoleAndConfigurableThresholdCases: correctedCases.length,
      },
      literalLegacy: { timing: legacyTiming },
      safeCandidate: { timing: candidateTiming },
      medianElapsedChangePercent: elapsedChangePercent(
        candidateTiming.medianMilliseconds,
        legacyTiming.medianMilliseconds,
      ),
      timingScope:
        "Isolated Node/V8 execution of adjacent-photo proximity checks over deterministic ordinary coordinates. The candidate threshold is prepared before timing, matching the production grouping loop. The baseline is the literal removed service implementation; excludes SQLite, Photos, React Native, visit persistence, and rendering. Authoritative spherical correctness, not a timing win, is the primary claim.",
      centroid: {
        fixture: {
          ordinaryGroups: centroidGroups.length,
          coordinatesPerGroup: 4,
          timedGroupsPerSample: centroidGroups.length * configuration.iterations,
        },
        correctness: {
          ordinaryBitExactArithmeticParity: true,
          antimeridianCrossingLongitudeCorrected: true,
          arithmeticLatitudePreservedForCrossingGroups: true,
        },
        literalArithmetic: { timing: literalCentroidTiming },
        wrapAwareCandidate: { timing: candidateCentroidTiming },
        medianElapsedChangePercent: elapsedChangePercent(
          candidateCentroidTiming.medianMilliseconds,
          literalCentroidTiming.medianMilliseconds,
        ),
        timingScope:
          "Isolated Node/V8 centroid calculation over deterministic four-photo ordinary groups. Both implementations retain literal arithmetic latitude/longitude output on this timed fixture; the candidate additionally validates coordinates and detects antimeridian crossings. Crossing correction is asserted separately and is not represented as a timing win.",
      },
    },
    null,
    2,
  ),
);
