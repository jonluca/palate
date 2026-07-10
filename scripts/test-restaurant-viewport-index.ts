#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  clampRestaurantMapLatitude,
  normalizeRestaurantMapLongitude,
  RestaurantViewportIndex,
  type RestaurantViewportEntry,
  type RestaurantViewportQuery,
} from "../utils/restaurant-viewport-index.ts";

interface TestRestaurant {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly award: string;
}

function restaurant(
  id: string,
  latitude: number,
  longitude: number,
  overrides: Partial<Pick<TestRestaurant, "name" | "award">> = {},
): TestRestaurant {
  return {
    id,
    name: overrides.name ?? id,
    latitude,
    longitude,
    award: overrides.award ?? "Selected",
  };
}

function entry(value: TestRestaurant, visited = false): RestaurantViewportEntry<TestRestaurant> {
  return { restaurant: value, visited };
}

function ids(
  index: RestaurantViewportIndex<TestRestaurant>,
  query: RestaurantViewportQuery,
): { readonly ids: string[]; readonly totalInView: number } {
  const result = index.select(query);
  return {
    ids: result.entries.map(({ restaurant: value }) => value.id),
    totalInView: result.totalInView,
  };
}

const worldQuery: RestaurantViewportQuery = {
  camera: { latitude: 20, longitude: 0, zoom: 1 },
  width: 1_024,
  height: 1_024,
};

assert.equal(clampRestaurantMapLatitude(90), 85.05112878);
assert.equal(clampRestaurantMapLatitude(-90), -85.05112878);
assert.equal(normalizeRestaurantMapLongitude(540), 180);
assert.equal(normalizeRestaurantMapLongitude(-540), 180);
assert.equal(normalizeRestaurantMapLongitude(181), -179);

const empty = new RestaurantViewportIndex<TestRestaurant>([]);
assert.equal(empty.size, 0);
assert.deepEqual(ids(empty, worldQuery), { ids: [], totalInView: 0 });

const zeroSized = new RestaurantViewportIndex([entry(restaurant("origin", 0, 0))]);
assert.deepEqual(ids(zeroSized, { camera: { latitude: 0, longitude: 0, zoom: 8 }, width: 0, height: 700 }), {
  ids: [],
  totalInView: 0,
});

const world = new RestaurantViewportIndex([
  entry(restaurant("west", 0, -180)),
  entry(restaurant("east", 0, 180)),
  entry(restaurant("north", 85, 0)),
  entry(restaurant("south", -85, 0)),
  entry(restaurant("outside-mercator", 86, 0)),
  entry(restaurant("invalid-latitude", 91, 0)),
  entry(restaurant("invalid-longitude", 0, 181)),
  entry(restaurant("not-a-number", Number.NaN, 0)),
]);
assert.equal(world.size, 5);
const wholeWorld = ids(world, worldQuery);
assert.equal(wholeWorld.totalInView, 4);
assert.deepEqual(new Set(wholeWorld.ids), new Set(["west", "east", "north", "south"]));

const inclusiveQuery: RestaurantViewportQuery = {
  camera: { latitude: 0, longitude: 0, zoom: 5 },
  width: 512,
  height: 512,
};
const inclusive = new RestaurantViewportIndex([
  entry(restaurant("minimum-latitude", -11.178401873711794, 0)),
  entry(restaurant("maximum-latitude", 11.178401873711794, 0)),
  entry(restaurant("minimum-longitude", 0, -11.25)),
  entry(restaurant("maximum-longitude", 0, 11.25)),
  entry(restaurant("outside-latitude", 11.178401874711794, 0)),
  entry(restaurant("outside-longitude", 0, 11.250000001)),
]);
const inclusiveResult = ids(inclusive, inclusiveQuery);
assert.equal(inclusiveResult.totalInView, 4);
assert.deepEqual(
  new Set(inclusiveResult.ids),
  new Set(["minimum-latitude", "maximum-latitude", "minimum-longitude", "maximum-longitude"]),
);

const datelineQuery: RestaurantViewportQuery = {
  camera: { latitude: 0, longitude: 179.5, zoom: 5 },
  width: 512,
  height: 400,
};
const dateline = new RestaurantViewportIndex([
  entry(restaurant("east", 0, 179.9)),
  entry(restaurant("west", 0, -179.9)),
  entry(restaurant("east-edge", 0, 168.25)),
  entry(restaurant("west-edge", 0, -169.25)),
  entry(restaurant("greenwich", 0, 0)),
]);
const datelineResult = ids(dateline, datelineQuery);
assert.equal(datelineResult.totalInView, 4);
assert.deepEqual(new Set(datelineResult.ids), new Set(["east", "west", "east-edge", "west-edge"]));
assert.deepEqual(datelineResult.ids.slice(0, 2), ["east", "west"]);

const rankingQuery: RestaurantViewportQuery = {
  camera: { latitude: 0, longitude: 0, zoom: 12 },
  width: 500,
  height: 500,
};
const ranking = new RestaurantViewportIndex([
  entry(restaurant("two-visited", 0, 0, { name: "Beta", award: "2 Stars" }), true),
  entry(restaurant("three-unvisited", 0, 0, { name: "Alpha", award: "3 Stars" })),
  entry(restaurant("three-visited-zulu", 0, 0, { name: "Zulu", award: "3 Stars" }), true),
  entry(restaurant("three-green", 0, 0, { name: "Zulu", award: "3 Stars, Green Star" })),
  entry(restaurant("three-visited-alpha", 0, 0, { name: "Alpha", award: "3 Stars" }), true),
]);
assert.deepEqual(ids(ranking, rankingQuery), {
  ids: ["three-green", "three-visited-alpha", "three-visited-zulu", "three-unvisited", "two-visited"],
  totalInView: 5,
});

const completeTies = Array.from({ length: 520 }, (_, index) =>
  entry(
    restaurant(`tie-${index.toString().padStart(3, "0")}`, 0, 0, {
      name: "Complete Tie",
      award: "Selected",
    }),
  ),
);
const top500 = new RestaurantViewportIndex(completeTies);
assert.deepEqual(ids(top500, rankingQuery), {
  ids: completeTies.slice(0, 500).map(({ restaurant: value }) => value.id),
  totalInView: 520,
});

const countOnly = new RestaurantViewportIndex(completeTies, 0);
assert.deepEqual(ids(countOnly, rankingQuery), { ids: [], totalInView: 520 });
assert.throws(() => new RestaurantViewportIndex(completeTies, -1), RangeError);
assert.throws(() => new RestaurantViewportIndex(completeTies, 1.5), RangeError);

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "restaurant viewport index",
      assertions: {
        geometryAndCoordinateNormalization: true,
        zeroAndWholeWorldViewports: true,
        inclusiveBounds: true,
        antimeridianWrapping: true,
        exactRankingPrecedence: true,
        stableTop500: true,
        countOnlyMode: true,
        invalidInputGuards: true,
      },
    },
    null,
    2,
  ),
);
