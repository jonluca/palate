#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/query-core";
import { mutationKeys, queryKeys, type FilterType } from "../utils/query-keys.ts";
import {
  CONFIRMED_RESTAURANTS_QUERY_KEY,
  CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
} from "../utils/db/confirmed-restaurant-search-core.ts";
import type { MichelinMapViewportRequest } from "../utils/db/michelin-map-viewport-core.ts";
import { invalidateVisitStatusQueries, VISIT_LIST_PAGE_QUERY_ROOT } from "../utils/query-cache-policy.ts";
import { reviewQueryKeys } from "../utils/review-query-policy.ts";

// Importing these contracts directly in Node also proves they do not initialize
// React hooks, SQLite, Expo services, or native modules.
assert.strictEqual(queryKeys.pendingReview, reviewQueryKeys.pendingReview);
assert.strictEqual(queryKeys.unanalyzedPhotoCount, reviewQueryKeys.unanalyzedPhotoCount);
assert.strictEqual(queryKeys.confirmedRestaurants, CONFIRMED_RESTAURANTS_QUERY_KEY);
assert.strictEqual(queryKeys.confirmedRestaurantSearch, CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY);
assert.deepEqual(mutationKeys.photoAnalysis, ["photoAnalysis"]);

const filters = ["all", "pending", "confirmed", "rejected", "food"] satisfies FilterType[];
for (const filter of filters) {
  assert.deepEqual(queryKeys.visits(filter), ["visits", filter]);
  assert.deepEqual(queryKeys.visitPages(filter), [...VISIT_LIST_PAGE_QUERY_ROOT, filter]);
}
assert.deepEqual(queryKeys.visits(), ["visits", undefined]);
assert.deepEqual(queryKeys.visitDetail("visit-1"), ["visits", "visit", "visit-1"]);
assert.deepEqual(queryKeys.visitPhotos("visit-1"), ["visitPhotos", "visit-1"]);
assert.deepEqual(queryKeys.restaurantVisits("restaurant-1"), ["visits", "restaurantVisits", "restaurant-1"]);
assert.deepEqual(queryKeys.restaurantDetail("restaurant-1"), ["restaurants", "detail", "restaurant-1"]);
assert.deepEqual(queryKeys.mergeableVisits("visit-1"), ["visits", "mergeableVisits", "visit-1"]);
assert.deepEqual(queryKeys.mergeableSameRestaurantVisits, ["visits", "mergeableSameRestaurantVisits"]);
assert.deepEqual(queryKeys.visitsAtLocation(34, -118, 100), ["visits", "visitsAtLocation", 34, -118, 100]);

for (const year of [undefined, null, 0]) {
  assert.deepEqual(queryKeys.wrapped(year), ["wrapped"]);
}
assert.deepEqual(queryKeys.wrapped(2026), ["wrapped", 2026]);
assert.deepEqual(queryKeys.wrappedMichelinBucketRestaurants(null, "three-stars"), [
  "wrapped",
  "michelinAwardRestaurants",
  "all",
  "three-stars",
]);
assert.deepEqual(queryKeys.wrappedMichelinBucketRestaurants(2026, "selected"), [
  "wrapped",
  "michelinAwardRestaurants",
  2026,
  "selected",
]);
assert.deepEqual(queryKeys.michelinRestaurants, ["static", "michelinRestaurants"]);
assert.deepEqual(queryKeys.michelinRestaurantDetail("michelin-1"), [
  "static",
  "michelinRestaurants",
  "detail",
  "michelin-1",
]);
assert.deepEqual(queryKeys.michelinRestaurantSearch("café"), ["michelinRestaurantSearch", "café"]);
assert.deepEqual(queryKeys.michelinUnicodeNameIndex(null), ["static", "michelinUnicodeNameIndex", "unversioned"]);
assert.deepEqual(queryKeys.michelinUnicodeNameIndex("v1"), ["static", "michelinUnicodeNameIndex", "v1"]);
assert.deepEqual(queryKeys.nearbyMichelin(34, -118), ["static", "nearbyMichelin", 34, -118]);
assert.deepEqual(queryKeys.mapKitNearby(34.12345, -118.12345, 200), [
  "static",
  "mapKitNearby",
  "34.1234",
  "-118.1235",
  200,
]);
assert.deepEqual(queryKeys.reverseGeocode(34.12345, -118.12345), ["reverseGeocode", "34.1234", "-118.1235"]);
assert.deepEqual(queryKeys.placeTextSearch("café"), ["placeTextSearch", "café", undefined, undefined]);
assert.deepEqual(queryKeys.placeTextSearch("café", 34.12345, -118.12345), [
  "placeTextSearch",
  "café",
  "34.1234",
  "-118.1235",
]);

const viewport: MichelinMapViewportRequest = {
  minimumAwardYear: 2024,
  visitStatusFilter: "visited",
  awardFilter: "green",
  camera: { latitude: 34, longitude: -118, zoom: 10 },
  width: 390,
  height: 844,
};
assert.deepEqual(queryKeys.michelinMapViewport(viewport), [
  "michelinMapViewport",
  2024,
  "visited",
  "green",
  500,
  34,
  -118,
  10,
  390,
  844,
]);
assert.deepEqual(queryKeys.michelinMapViewport({ ...viewport, maximumResults: 100 }), [
  "michelinMapViewport",
  2024,
  "visited",
  "green",
  100,
  34,
  -118,
  10,
  390,
  844,
]);

// The neutral registry must still match the independently owned mutation cache
// policy, including the deliberate isolation of pending review and static data.
const client = new QueryClient();
const invalidatedKeys = [
  queryKeys.visitPages("confirmed"),
  queryKeys.visitDetail("visit-1"),
  queryKeys.restaurantVisits("restaurant-1"),
  queryKeys.confirmedRestaurants,
  queryKeys.confirmedRestaurantSearch,
  queryKeys.stats,
  queryKeys.wrapped(2026),
  queryKeys.wrappedMichelinBucketRestaurants(2026, "three-stars"),
  queryKeys.michelinRestaurantSearch("café"),
  queryKeys.michelinMapViewport(viewport),
];
const preservedKeys = [queryKeys.pendingReview, queryKeys.michelinRestaurants, queryKeys.permissions];
try {
  for (const key of [...invalidatedKeys, ...preservedKeys]) {
    client.setQueryData(key, { pages: [{ visits: [] }], pageParams: [null] });
  }
  await invalidateVisitStatusQueries(client);
  for (const key of invalidatedKeys) {
    assert.equal(client.getQueryState(key)?.isInvalidated, true, `Mutation must invalidate ${JSON.stringify(key)}`);
  }
  for (const key of preservedKeys) {
    assert.equal(client.getQueryState(key)?.isInvalidated, false, `Mutation must preserve ${JSON.stringify(key)}`);
  }
} finally {
  client.clear();
}

console.log(
  "Query key contracts passed: pure imports, tuple compatibility, filter types, aliases, and mutation invalidation families.",
);
