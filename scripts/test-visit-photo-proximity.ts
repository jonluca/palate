#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateVisitPhotoCentroid } from "../utils/visit-photo-centroid-core.ts";
import {
  areVisitPhotosNearby,
  areVisitPhotosNearbyWithPreparedThreshold,
  calculateVisitPhotoDistanceMeters,
  prepareVisitPhotoDistanceThreshold,
  type VisitPhotoCoordinate,
} from "../utils/visit-photo-proximity-core.ts";

const DEGREES_TO_RADIANS = Math.PI / 180;
const EARTH_RADIUS_METERS = 6_371_000;
const LEGACY_QUICK_REJECT_LATITUDE_DEGREES = 0.003;
const LEGACY_QUICK_REJECT_LONGITUDE_DEGREES = 0.006;

function coordinate(latitude: number, longitude: number): VisitPhotoCoordinate {
  return { latitude, longitude };
}

/** Literal copy of the former service implementation, retained only as an ordinary-input oracle. */
function legacyArePhotosNearby(
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
  const distanceMeters =
    EARTH_RADIUS_METERS *
    Math.sqrt(scaledLongitudeDeltaRadians * scaledLongitudeDeltaRadians + latitudeDeltaRadians * latitudeDeltaRadians);
  return distanceMeters <= thresholdMeters;
}

function legacyArithmeticCentroid(coordinates: readonly VisitPhotoCoordinate[]): VisitPhotoCoordinate {
  const latitudeSum = coordinates.reduce((sum, item) => sum + item.latitude, 0);
  const longitudeSum = coordinates.reduce((sum, item) => sum + item.longitude, 0);
  return {
    latitude: latitudeSum / coordinates.length,
    longitude: longitudeSum / coordinates.length,
  };
}

function referenceDistanceMeters(coordinate1: VisitPhotoCoordinate, coordinate2: VisitPhotoCoordinate): number {
  const rawLongitudeDelta = coordinate2.longitude - coordinate1.longitude;
  const wrappedLongitudeDelta = ((((rawLongitudeDelta + 180) % 360) + 360) % 360) - 180;
  if (
    coordinate1.latitude === coordinate2.latitude &&
    (wrappedLongitudeDelta === 0 || coordinate1.latitude === 90 || coordinate1.latitude === -90)
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

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function assertDistanceClose(actual: number | null, expected: number): asserts actual is number {
  assert.ok(actual !== null);
  const tolerance = Math.max(1e-7, expected * 1e-13);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `distance mismatch: expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

const samePoint = coordinate(37.7749, -122.4194);
assert.equal(calculateVisitPhotoDistanceMeters(samePoint, samePoint), 0);
assert.equal(areVisitPhotosNearby(samePoint, samePoint, 0), true, "zero distance must include its boundary");

const acrossAntimeridian1 = coordinate(0, 179.9996);
const acrossAntimeridian2 = coordinate(0, -179.9996);
const antimeridianDistance = calculateVisitPhotoDistanceMeters(acrossAntimeridian1, acrossAntimeridian2);
assert.ok(antimeridianDistance !== null && antimeridianDistance > 88 && antimeridianDistance < 90);
assert.equal(legacyArePhotosNearby(acrossAntimeridian1, acrossAntimeridian2, 100), false);
assert.equal(areVisitPhotosNearby(acrossAntimeridian1, acrossAntimeridian2, 100), true);
assert.equal(
  calculateVisitPhotoDistanceMeters(coordinate(10, -180), coordinate(10, 180)),
  0,
  "-180 and 180 are the same meridian",
);
const antimeridianCentroid = calculateVisitPhotoCentroid([acrossAntimeridian1, acrossAntimeridian2]);
assert.ok(antimeridianCentroid !== null);
assert.ok(Math.abs(antimeridianCentroid.latitude) < 1e-12);
assert.equal(
  Object.is(
    antimeridianCentroid.latitude,
    legacyArithmeticCentroid([acrossAntimeridian1, acrossAntimeridian2]).latitude,
  ),
  true,
);
assert.ok(Math.abs(Math.abs(antimeridianCentroid.longitude) - 180) < 1e-12);
assert.ok(referenceDistanceMeters(antimeridianCentroid, acrossAntimeridian1) < 100);
assert.ok(referenceDistanceMeters(antimeridianCentroid, acrossAntimeridian2) < 100);

const nearNorthPole1 = coordinate(89.999, 0);
const nearNorthPole2 = coordinate(89.999, 10);
const nearPoleDistance = calculateVisitPhotoDistanceMeters(nearNorthPole1, nearNorthPole2);
assert.ok(nearPoleDistance !== null && nearPoleDistance > 19 && nearPoleDistance < 20);
assert.equal(legacyArePhotosNearby(nearNorthPole1, nearNorthPole2, 25), false);
assert.equal(areVisitPhotosNearby(nearNorthPole1, nearNorthPole2, 25), true);
assert.equal(areVisitPhotosNearby(coordinate(90, -120), coordinate(90, 120), 0), true);
assert.equal(areVisitPhotosNearby(coordinate(-90, -120), coordinate(-90, 120), 0), true);

const largeLongitudeNearPole1 = coordinate(89.9995, 0);
const largeLongitudeNearPole2 = coordinate(89.9995, 120);
const largeLongitudeNearPoleReferenceDistance = referenceDistanceMeters(
  largeLongitudeNearPole1,
  largeLongitudeNearPole2,
);
assert.ok(largeLongitudeNearPoleReferenceDistance > 96 && largeLongitudeNearPoleReferenceDistance < 97);
assertDistanceClose(
  calculateVisitPhotoDistanceMeters(largeLongitudeNearPole1, largeLongitudeNearPole2),
  largeLongitudeNearPoleReferenceDistance,
);
assert.equal(legacyArePhotosNearby(largeLongitudeNearPole1, largeLongitudeNearPole2, 100), false);
assert.equal(areVisitPhotosNearby(largeLongitudeNearPole1, largeLongitudeNearPole2, 100), true);

const ordinaryCentroidCoordinates = [
  coordinate(37.7749 + Number.EPSILON * 32, -122.4194 - Number.EPSILON * 64),
  coordinate(37.7752 - Number.EPSILON * 32, -122.4191 + Number.EPSILON * 64),
  coordinate(37.7747 - Number.EPSILON * 32, -122.4196 - Number.EPSILON * 64),
  coordinate(37.775 + Number.EPSILON * 32, -122.4192 + Number.EPSILON * 64),
];
const ordinaryLegacyCentroid = legacyArithmeticCentroid(ordinaryCentroidCoordinates);
const ordinaryCandidateCentroid = calculateVisitPhotoCentroid(ordinaryCentroidCoordinates);
assert.deepEqual(ordinaryCandidateCentroid, ordinaryLegacyCentroid);
assert.ok(ordinaryCandidateCentroid !== null);
assert.equal(Object.is(ordinaryCandidateCentroid.latitude, ordinaryLegacyCentroid.latitude), true);
assert.equal(Object.is(ordinaryCandidateCentroid.longitude, ordinaryLegacyCentroid.longitude), true);
assert.deepEqual(calculateVisitPhotoCentroid([samePoint]), samePoint, "one-point centroids stay byte-stable");

const exactHalfWorldLongitudeRange = [coordinate(10.25, -10), coordinate(10.75, 170)];
assert.deepEqual(
  calculateVisitPhotoCentroid(exactHalfWorldLongitudeRange),
  legacyArithmeticCentroid(exactHalfWorldLongitudeRange),
  "a longitude range of exactly 180 degrees retains literal arithmetic behavior",
);

assert.deepEqual(
  calculateVisitPhotoCentroid([coordinate(1, 0), coordinate(2, 120), coordinate(3, -120)]),
  coordinate(2, 0),
  "a degenerate crossing set deterministically falls back to its first longitude",
);
assert.deepEqual(
  calculateVisitPhotoCentroid([coordinate(2, 120), coordinate(3, -120), coordinate(1, 0)]),
  coordinate(2, 120),
  "reversing a degenerate ordered set deterministically changes the fallback",
);
assert.equal(calculateVisitPhotoCentroid([]), null);
assert.equal(calculateVisitPhotoCentroid([samePoint, coordinate(Number.NaN, 0)]), null);

const largerLatitudeThreshold1 = coordinate(0, 0);
const largerLatitudeThreshold2 = coordinate(0.004, 0);
assert.equal(legacyArePhotosNearby(largerLatitudeThreshold1, largerLatitudeThreshold2, 500), false);
assert.equal(areVisitPhotosNearby(largerLatitudeThreshold1, largerLatitudeThreshold2, 500), true);
const largerLongitudeThreshold2 = coordinate(0, 0.007);
assert.equal(legacyArePhotosNearby(largerLatitudeThreshold1, largerLongitudeThreshold2, 800), false);
assert.equal(areVisitPhotosNearby(largerLatitudeThreshold1, largerLongitudeThreshold2, 800), true);

const exactBoundary1 = coordinate(12.5, -45.25);
const exactBoundary2 = coordinate(12.5005, -45.2495);
const exactBoundaryDistance = calculateVisitPhotoDistanceMeters(exactBoundary1, exactBoundary2);
assert.ok(exactBoundaryDistance !== null && exactBoundaryDistance > 0);
assert.equal(areVisitPhotosNearby(exactBoundary1, exactBoundary2, exactBoundaryDistance), true);
assert.equal(areVisitPhotosNearby(exactBoundary1, exactBoundary2, exactBoundaryDistance - 1e-9), false);
const preparedExactBoundary = prepareVisitPhotoDistanceThreshold(exactBoundaryDistance);
assert.ok(preparedExactBoundary !== null);
assert.equal(areVisitPhotosNearbyWithPreparedThreshold(exactBoundary1, exactBoundary2, preparedExactBoundary), true);

const halfWorld1 = coordinate(0, 0);
const halfWorld2 = coordinate(0, 180);
const halfWorldDistance = calculateVisitPhotoDistanceMeters(halfWorld1, halfWorld2);
assert.ok(halfWorldDistance !== null && halfWorldDistance > 20_000_000);
assert.equal(areVisitPhotosNearby(halfWorld1, halfWorld2, halfWorldDistance), true);
assert.equal(areVisitPhotosNearby(halfWorld1, halfWorld2, halfWorldDistance - 1), false);
assert.equal(areVisitPhotosNearby(halfWorld1, halfWorld2, 50_000_000), true);

const invalidCoordinates = [
  coordinate(Number.NaN, 0),
  coordinate(Number.POSITIVE_INFINITY, 0),
  coordinate(Number.NEGATIVE_INFINITY, 0),
  coordinate(-90.000_001, 0),
  coordinate(90.000_001, 0),
  coordinate(0, Number.NaN),
  coordinate(0, Number.POSITIVE_INFINITY),
  coordinate(0, Number.NEGATIVE_INFINITY),
  coordinate(0, -180.000_001),
  coordinate(0, 180.000_001),
];
for (const invalidCoordinate of invalidCoordinates) {
  assert.equal(calculateVisitPhotoDistanceMeters(invalidCoordinate, samePoint), null);
  assert.equal(calculateVisitPhotoDistanceMeters(samePoint, invalidCoordinate), null);
  assert.equal(areVisitPhotosNearby(invalidCoordinate, samePoint, 100), false);
  assert.equal(areVisitPhotosNearby(samePoint, invalidCoordinate, 100), false);
}
for (const invalidThreshold of [-1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
  assert.equal(prepareVisitPhotoDistanceThreshold(invalidThreshold), null);
  assert.equal(areVisitPhotosNearby(samePoint, samePoint, invalidThreshold), false);
}

// Exhaust every pair in a deliberately boundary-heavy coordinate grid and several threshold scales.
const boundaryLatitudes = [-90, -89.999, -70, 0, 70, 89.999, 90];
const boundaryLongitudes = [-180, -179.999, -1, 0, 1, 179.999, 180];
const boundaryCoordinates = boundaryLatitudes.flatMap((latitude) =>
  boundaryLongitudes.map((longitude) => coordinate(latitude, longitude)),
);
const boundaryThresholds = [0, 1, 100, 1_000, 1_000_000, 50_000_000];
let exhaustiveAssertions = 0;
for (const coordinate1 of boundaryCoordinates) {
  for (const coordinate2 of boundaryCoordinates) {
    const expectedDistance = referenceDistanceMeters(coordinate1, coordinate2);
    const forwardDistance = calculateVisitPhotoDistanceMeters(coordinate1, coordinate2);
    const reverseDistance = calculateVisitPhotoDistanceMeters(coordinate2, coordinate1);
    assertDistanceClose(forwardDistance, expectedDistance);
    assertDistanceClose(reverseDistance, expectedDistance);
    assert.equal(forwardDistance, reverseDistance);
    for (const threshold of boundaryThresholds) {
      assert.equal(
        areVisitPhotosNearby(coordinate1, coordinate2, threshold),
        expectedDistance <= threshold,
        `boundary parity failed for ${JSON.stringify({ coordinate1, coordinate2, threshold, expectedDistance })}`,
      );
      exhaustiveAssertions += 1;
    }
  }
}

// Preserve the literal former implementation for ordinary latitudes, deltas, and supported radii.
const ordinaryLatitudes = [-69, -30, 0, 30, 69];
const ordinaryLongitudes = [-170, -45, 0, 45, 170];
const ordinaryDeltas = [-0.0059, -0.003, -0.001, 0, 0.001, 0.003, 0.0059];
const ordinaryThresholds = [0, 25, 100, 200];
let ordinaryParityAssertions = 0;
for (const latitude of ordinaryLatitudes) {
  for (const longitude of ordinaryLongitudes) {
    const coordinate1 = coordinate(latitude, longitude);
    for (const latitudeDelta of ordinaryDeltas) {
      for (const longitudeDelta of ordinaryDeltas) {
        const coordinate2 = coordinate(latitude + latitudeDelta, longitude + longitudeDelta);
        for (const threshold of ordinaryThresholds) {
          assert.equal(
            areVisitPhotosNearby(coordinate1, coordinate2, threshold),
            legacyArePhotosNearby(coordinate1, coordinate2, threshold),
          );
          assert.equal(
            areVisitPhotosNearby(coordinate1, coordinate2, threshold),
            referenceDistanceMeters(coordinate1, coordinate2) <= threshold,
          );
          ordinaryParityAssertions += 1;
        }
      }
    }
  }
}

// Deterministic property sweep: symmetry, independently calculated distance, and inclusive boundaries.
const random = createRandom(0x51a7_2026);
const propertySamples = 20_000;
for (let sample = 0; sample < propertySamples; sample++) {
  const coordinate1 = coordinate(random() * 180 - 90, random() * 360 - 180);
  const coordinate2 = coordinate(random() * 180 - 90, random() * 360 - 180);
  const expectedDistance = referenceDistanceMeters(coordinate1, coordinate2);
  const actualDistance = calculateVisitPhotoDistanceMeters(coordinate1, coordinate2);
  const reverseDistance = calculateVisitPhotoDistanceMeters(coordinate2, coordinate1);
  assertDistanceClose(actualDistance, expectedDistance);
  assertDistanceClose(reverseDistance, expectedDistance);
  assert.equal(actualDistance, reverseDistance);
  assert.equal(areVisitPhotosNearby(coordinate1, coordinate2, actualDistance), true);
  if (actualDistance > 0) {
    const belowBoundary = actualDistance - Math.max(1e-9, actualDistance * 1e-12);
    assert.equal(areVisitPhotosNearby(coordinate1, coordinate2, belowBoundary), false);
  }
  const threshold = random() * 50_000_000;
  assert.equal(areVisitPhotosNearby(coordinate1, coordinate2, threshold), expectedDistance <= threshold);
}

const servicePath = fileURLToPath(new URL("../services/visit.ts", import.meta.url));
const serviceSource = readFileSync(servicePath, "utf8");
assert.match(serviceSource, /calculateVisitPhotoCentroid/);
assert.match(serviceSource, /prepareVisitPhotoDistanceThreshold/);
assert.match(
  serviceSource,
  /!areVisitPhotosNearbyWithPreparedThreshold\(prevPhoto, currentPhoto, preparedDistanceThreshold\)/,
  "visit grouping must call the prepared isolated proximity core",
);
assert.match(serviceSource, /calculateVisitPhotoCentroid\(groupPhotos\)/);
assert.match(serviceSource, /latitude: centroid\.lat,\s+longitude: centroid\.lon,/);
assert.match(serviceSource, /generateVisitHash\(visitStartTime, visitEndTime, centroid\.lat, centroid\.lon\)/);
assert.match(serviceSource, /centerLat: group\.centroid\.lat,\s+centerLon: group\.centroid\.lon,/);
assert.doesNotMatch(serviceSource, /QUICK_REJECT_(?:LAT|LON)_DEG|function arePhotosNearby|function fastDistanceMeters/);
assert.doesNotMatch(serviceSource, /function calculateCentroid|sumLon/);

console.log(
  `Visit photo proximity tests passed: ${exhaustiveAssertions.toLocaleString()} authoritative spherical boundary assertions, ${ordinaryParityAssertions.toLocaleString()} literal ordinary-path parity assertions, ${propertySamples.toLocaleString()} deterministic property samples, high-latitude/antimeridian distance, bit-exact ordinary and wrap-aware crossing centroids, exact thresholds, invalid inputs, and service integration.`,
);
