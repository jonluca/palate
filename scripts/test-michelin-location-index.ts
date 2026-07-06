#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  calculateGeodesicDistanceMeters,
  MichelinLocationIndex,
  type MichelinLocation,
  type MichelinLocationMatch,
  type MichelinLocationSearchOptions,
} from "../utils/michelin-location-index.ts";

const EARTH_RADIUS_METERS = 6_371_000;

interface TestRestaurant extends MichelinLocation {
  readonly name: string;
}

function restaurant(id: string, latitude: number, longitude: number): TestRestaurant {
  return { id, name: id, latitude, longitude };
}

function resultIds(results: readonly MichelinLocationMatch<TestRestaurant>[]): string[] {
  return results.map(({ restaurant: result }) => result.id);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bruteForce(
  restaurants: readonly TestRestaurant[],
  options: MichelinLocationSearchOptions,
): MichelinLocationMatch<TestRestaurant>[] {
  const matches = restaurants
    .map((candidate, inputIndex) => ({
      restaurant: candidate,
      inputIndex,
      distanceMeters: calculateGeodesicDistanceMeters(
        options.latitude,
        options.longitude,
        candidate.latitude,
        candidate.longitude,
      ),
    }))
    .filter(({ distanceMeters }) => distanceMeters <= options.radiusMeters + 1e-7)
    .sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters ||
        compareIds(left.restaurant.id, right.restaurant.id) ||
        left.inputIndex - right.inputIndex,
    )
    .slice(0, options.limit);

  return matches.map(({ restaurant: match, distanceMeters }) => ({ restaurant: match, distanceMeters }));
}

function assertParity(
  index: MichelinLocationIndex<TestRestaurant>,
  restaurants: readonly TestRestaurant[],
  options: MichelinLocationSearchOptions,
): void {
  const actual = index.findNearby(options);
  const expected = bruteForce(restaurants, options);
  assert.deepEqual(resultIds(actual), resultIds(expected));
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i].distanceMeters - expected[i].distanceMeters) < 1e-7);
  }
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const zeroIndex = new MichelinLocationIndex([
  restaurant("origin", 0, 0),
  restaurant("north", 0.0005, 0),
  restaurant("east", 0, 0.0005),
]);
assert.deepEqual(resultIds(zeroIndex.findNearby({ latitude: 0, longitude: 0, radiusMeters: 100 })), [
  "origin",
  "east",
  "north",
]);

const antimeridianIndex = new MichelinLocationIndex([
  restaurant("across-date-line", 0, -179.999),
  restaurant("same-side", 0, 179.9995),
  restaurant("far", 0, 179),
]);
assert.deepEqual(resultIds(antimeridianIndex.findNearby({ latitude: 0, longitude: 179.999, radiusMeters: 250 })), [
  "same-side",
  "across-date-line",
]);

const poleIndex = new MichelinLocationIndex([
  restaurant("pole-b", 90, -120),
  restaurant("pole-a", 90, 120),
  restaurant("near-pole", 89.999, 0),
]);
assert.deepEqual(resultIds(poleIndex.findNearby({ latitude: 90, longitude: 0, radiusMeters: 120 })), [
  "pole-a",
  "pole-b",
  "near-pole",
]);

const boundaryLongitude = (1000 / EARTH_RADIUS_METERS) * (180 / Math.PI);
const boundaryIndex = new MichelinLocationIndex([
  restaurant("boundary", 0, boundaryLongitude),
  restaurant("outside", 0, boundaryLongitude * 1.00001),
]);
const boundaryResults = boundaryIndex.findNearby({ latitude: 0, longitude: 0, radiusMeters: 1000 });
assert.deepEqual(resultIds(boundaryResults), ["boundary"]);
assert.ok(Math.abs(boundaryResults[0].distanceMeters - 1000) < 1e-7);

const deterministicIndex = new MichelinLocationIndex([
  restaurant("z", 10, 20),
  restaurant("a", 10, 20),
  restaurant("m", 10, 20),
]);
for (let iteration = 0; iteration < 20; iteration++) {
  assert.deepEqual(
    resultIds(deterministicIndex.findNearby({ latitude: 10, longitude: 20, radiusMeters: 0, limit: 2 })),
    ["a", "m"],
  );
}

const random = createRandom(0x5eed1234);
const randomRestaurants = Array.from({ length: 2000 }, (_, index) =>
  restaurant(`random-${index.toString().padStart(4, "0")}`, random() * 180 - 90, random() * 360 - 180),
);
const parityRestaurants = [
  ...randomRestaurants,
  restaurant("zero-zero", 0, 0),
  restaurant("date-line-east", 12, 179.9999),
  restaurant("date-line-west", 12, -179.9999),
  restaurant("north-pole", 90, 0),
  restaurant("south-pole", -90, 0),
];
const parityIndex = new MichelinLocationIndex(parityRestaurants);
const parityQueries: MichelinLocationSearchOptions[] = [
  { latitude: 0, longitude: 0, radiusMeters: 1000, limit: 10 },
  { latitude: 12, longitude: 180, radiusMeters: 1000, limit: 10 },
  { latitude: 90, longitude: -180, radiusMeters: 1000, limit: 10 },
  { latitude: -90, longitude: 180, radiusMeters: 1000, limit: 10 },
];
for (let index = 0; index < 200; index++) {
  parityQueries.push({
    latitude: random() * 180 - 90,
    longitude: random() * 360 - 180,
    radiusMeters: random() * 2_000_000,
    limit: 1 + Math.floor(random() * 20),
  });
}
for (const options of parityQueries) {
  assertParity(parityIndex, parityRestaurants, options);
}

assert.throws(
  () => parityIndex.findNearby({ latitude: 91, longitude: 0, radiusMeters: 100 }),
  /latitude must be a finite number/,
);
assert.throws(
  () => parityIndex.findNearby({ latitude: 0, longitude: 0, radiusMeters: -1 }),
  /radiusMeters must be a finite non-negative number/,
);

console.log(
  `MichelinLocationIndex tests passed (${parityQueries.length} brute-force parity queries, ${parityRestaurants.length} indexed points).`,
);
