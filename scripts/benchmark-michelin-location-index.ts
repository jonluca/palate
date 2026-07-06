#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  calculateGeodesicDistanceMeters,
  MichelinLocationIndex,
  type MichelinLocation,
  type MichelinLocationMatch,
} from "../utils/michelin-location-index.ts";

interface Restaurant extends MichelinLocation {
  readonly name: string;
}

interface Query {
  readonly latitude: number;
  readonly longitude: number;
}

interface DatabaseRow {
  readonly id: number;
  readonly name: string | null;
  readonly latitude: string;
  readonly longitude: string;
}

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_METERS = 6_371_000;
const SEARCH_RADIUS_METERS = 200;
const RESULT_LIMIT = 5;

function fastDistanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const latitudeDelta = (latitude2 - latitude1) * DEG_TO_RAD;
  const longitudeDelta = (longitude2 - longitude1) * DEG_TO_RAD;
  const averageLatitude = ((latitude1 + latitude2) / 2) * DEG_TO_RAD;
  const x = longitudeDelta * Math.cos(averageLatitude);
  return EARTH_RADIUS_METERS * Math.sqrt(x * x + latitudeDelta * latitudeDelta);
}

function legacyLinearSearch(query: Query, restaurants: readonly Restaurant[]): MichelinLocationMatch<Restaurant>[] {
  const latitudeThreshold = SEARCH_RADIUS_METERS / 111_000;
  const longitudeThreshold = SEARCH_RADIUS_METERS / 80_000;
  const nearby: Array<{ restaurant: Restaurant; distanceMeters: number }> = [];

  for (const candidate of restaurants) {
    const latitudeDifference = candidate.latitude - query.latitude;
    const longitudeDifference = candidate.longitude - query.longitude;
    if (
      latitudeDifference > latitudeThreshold ||
      latitudeDifference < -latitudeThreshold ||
      longitudeDifference > longitudeThreshold ||
      longitudeDifference < -longitudeThreshold
    ) {
      continue;
    }

    const distanceMeters = fastDistanceMeters(query.latitude, query.longitude, candidate.latitude, candidate.longitude);
    if (distanceMeters <= SEARCH_RADIUS_METERS) {
      nearby.push({ restaurant: candidate, distanceMeters });
    }
  }

  return nearby.sort((left, right) => left.distanceMeters - right.distanceMeters).slice(0, RESULT_LIMIT);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bruteForceGeodesicSearch(
  query: Query,
  restaurants: readonly Restaurant[],
): MichelinLocationMatch<Restaurant>[] {
  const nearby: Array<MichelinLocationMatch<Restaurant> & { inputIndex: number }> = [];
  for (let inputIndex = 0; inputIndex < restaurants.length; inputIndex++) {
    const restaurant = restaurants[inputIndex];
    const distanceMeters = calculateGeodesicDistanceMeters(
      query.latitude,
      query.longitude,
      restaurant.latitude,
      restaurant.longitude,
    );
    if (distanceMeters <= SEARCH_RADIUS_METERS + 1e-7) {
      nearby.push({ restaurant, distanceMeters, inputIndex });
    }
  }

  return nearby
    .sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters ||
        compareIds(left.restaurant.id, right.restaurant.id) ||
        left.inputIndex - right.inputIndex,
    )
    .slice(0, RESULT_LIMIT)
    .map(({ restaurant, distanceMeters }) => ({ restaurant, distanceMeters }));
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeQueries(
  search: (query: Query) => readonly MichelinLocationMatch<Restaurant>[],
  queries: readonly Query[],
): number {
  let checksum = 0;
  const startedAt = performance.now();
  for (const query of queries) {
    const results = search(query);
    checksum += results.length;
    if (results[0]) {
      checksum += results[0].restaurant.id.length;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  if (checksum === Number.MIN_SAFE_INTEGER) {
    throw new Error("Unreachable checksum");
  }
  return elapsedMs;
}

function parseQueryCount(arguments_: readonly string[]): number | null {
  let queryCount = 5000;
  for (const argument of arguments_) {
    // Accept the separator retained by some pnpm versions while rejecting
    // every other unknown argument so benchmark typos cannot silently run.
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (!argument.startsWith("--queries=")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = argument.slice("--queries=".length);
    if (!/^\d+$/.test(value)) {
      throw new RangeError(`--queries must be a positive integer; received ${value}`);
    }
    queryCount = Number(value);
    if (!Number.isSafeInteger(queryCount) || queryCount <= 0) {
      throw new RangeError(`--queries must be a positive safe integer; received ${value}`);
    }
  }
  return queryCount;
}

const queryCount = parseQueryCount(process.argv.slice(2));
if (queryCount === null) {
  console.log("Usage: pnpm profile:location [--queries=5000]");
  process.exit(0);
}

const database = new DatabaseSync(fileURLToPath(new URL("../assets/michelin.db", import.meta.url)), { readOnly: true });
const rows = database
  .prepare(
    `SELECT id, name, latitude, longitude
     FROM restaurants
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND latitude != '' AND longitude != ''`,
  )
  .all() as unknown as DatabaseRow[];
database.close();

const restaurants = rows
  .map((row) => ({
    id: `michelin-${row.id}`,
    name: row.name ?? "",
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }))
  .filter(
    ({ latitude, longitude }) =>
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180 &&
      !(latitude === 0 && longitude === 0),
  );

const buildStartedAt = performance.now();
const locationIndex = new MichelinLocationIndex(restaurants);
const indexBuildMs = performance.now() - buildStartedAt;
const random = createRandom(0xbadc0de);
const queries = Array.from({ length: queryCount }, (_, index) => {
  const source = restaurants[Math.floor((index / queryCount) * restaurants.length)];
  return {
    latitude: Math.max(-90, Math.min(90, source.latitude + (random() - 0.5) * 0.001)),
    longitude: Math.max(-180, Math.min(180, source.longitude + (random() - 0.5) * 0.001)),
  };
});

const indexedSearch = (query: Query): MichelinLocationMatch<Restaurant>[] =>
  locationIndex.findNearby({ ...query, radiusMeters: SEARCH_RADIUS_METERS, limit: RESULT_LIMIT });
const bruteForceSearch = (query: Query): MichelinLocationMatch<Restaurant>[] =>
  bruteForceGeodesicSearch(query, restaurants);
const legacySearch = (query: Query): MichelinLocationMatch<Restaurant>[] => legacyLinearSearch(query, restaurants);

for (const query of queries) {
  const expected = bruteForceSearch(query);
  const actual = indexedSearch(query);
  assert.deepEqual(
    actual.map(({ restaurant }) => restaurant.id),
    expected.map(({ restaurant }) => restaurant.id),
  );
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Math.abs(actual[index].distanceMeters - expected[index].distanceMeters) < 1e-7);
  }
}

timeQueries(legacySearch, queries.slice(0, 50));
timeQueries(bruteForceSearch, queries.slice(0, 50));
timeQueries(indexedSearch, queries.slice(0, 50));

const legacyLinearSamples: number[] = [];
const equivalentBruteForceSamples: number[] = [];
const indexedSamples: number[] = [];
for (let sample = 0; sample < 5; sample++) {
  legacyLinearSamples.push(timeQueries(legacySearch, queries));
  equivalentBruteForceSamples.push(timeQueries(bruteForceSearch, queries));
  indexedSamples.push(timeQueries(indexedSearch, queries));
}

const legacyLinearMedianMs = median(legacyLinearSamples);
const equivalentBruteForceMedianMs = median(equivalentBruteForceSamples);
const indexedGeodesicMedianMs = median(indexedSamples);
const result = {
  restaurants: restaurants.length,
  queries: queryCount,
  radiusMeters: SEARCH_RADIUS_METERS,
  resultLimit: RESULT_LIMIT,
  samples: 5,
  parityQueries: queries.length,
  indexBuildMs: Number(indexBuildMs.toFixed(3)),
  legacyApproximateLinearMedianMs: Number(legacyLinearMedianMs.toFixed(3)),
  equivalentGeodesicBruteForceMedianMs: Number(equivalentBruteForceMedianMs.toFixed(3)),
  indexedGeodesicMedianMs: Number(indexedGeodesicMedianMs.toFixed(3)),
  speedupVersusLegacyApproximateLinear: Number((legacyLinearMedianMs / indexedGeodesicMedianMs).toFixed(2)),
  speedupVersusEquivalentGeodesicBruteForce: Number(
    (equivalentBruteForceMedianMs / indexedGeodesicMedianMs).toFixed(2),
  ),
};

console.log(JSON.stringify(result, null, 2));
