#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasVisitPhotosForSpatialWork } from "../utils/visit-photo-spatial-work.ts";

interface Counters {
  calls: number;
  rows: number;
}

interface Photo {
  readonly id: string;
  readonly latitude: number;
}

interface TestIndex {
  readonly match: (photo: Photo) => string;
}

function createLoader(index: TestIndex, rowCount: number, counters: Counters): () => Promise<TestIndex> {
  return async () => {
    counters.calls += 1;
    counters.rows += rowCount;
    return index;
  };
}

function matchPhotos(photos: readonly Photo[], index: TestIndex): string[] {
  return photos.map((photo) => index.match(photo));
}

async function runLegacyEager(photos: readonly Photo[], loadIndex: () => Promise<TestIndex>): Promise<string[]> {
  const index = await loadIndex();
  return photos.length === 0 ? [] : matchPhotos(photos, index);
}

async function runCandidate(photos: readonly Photo[], loadIndex: () => Promise<TestIndex>): Promise<string[]> {
  if (!hasVisitPhotosForSpatialWork(photos.length)) {
    return [];
  }
  const index = await loadIndex();
  return matchPhotos(photos, index);
}

const guideRowCount = 28_785;
const testIndex: TestIndex = { match: (photo) => `${photo.id}:${Math.round(photo.latitude * 1000)}` };

assert.equal(hasVisitPhotosForSpatialWork(0), false);
assert.equal(hasVisitPhotosForSpatialWork(1), true);
assert.equal(hasVisitPhotosForSpatialWork(Number.MAX_SAFE_INTEGER), true);

const photos: Photo[] = [
  { id: "first", latitude: 37.7749 },
  { id: "second", latitude: -33.8688 },
];
const legacyEmptyCounters: Counters = { calls: 0, rows: 0 };
const candidateEmptyCounters: Counters = { calls: 0, rows: 0 };
assert.deepEqual(await runLegacyEager([], createLoader(testIndex, guideRowCount, legacyEmptyCounters)), []);
assert.deepEqual(await runCandidate([], createLoader(testIndex, guideRowCount, candidateEmptyCounters)), []);
assert.deepEqual(legacyEmptyCounters, { calls: 1, rows: guideRowCount });
assert.deepEqual(candidateEmptyCounters, { calls: 0, rows: 0 });

const legacyNonEmptyCounters: Counters = { calls: 0, rows: 0 };
const candidateNonEmptyCounters: Counters = { calls: 0, rows: 0 };
const legacyMatches = await runLegacyEager(photos, createLoader(testIndex, guideRowCount, legacyNonEmptyCounters));
const candidateMatches = await runCandidate(photos, createLoader(testIndex, guideRowCount, candidateNonEmptyCounters));
assert.deepEqual(candidateMatches, legacyMatches, "non-empty matching must preserve downstream results");
assert.deepEqual(legacyNonEmptyCounters, { calls: 1, rows: guideRowCount });
assert.deepEqual(candidateNonEmptyCounters, { calls: 1, rows: guideRowCount });

let failedLoaderCalls = 0;
await assert.rejects(
  runCandidate(photos, async () => {
    failedLoaderCalls += 1;
    throw new Error("guide load failed");
  }),
  /guide load failed/,
);
assert.equal(failedLoaderCalls, 1);

for (const invalidCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => hasVisitPhotosForSpatialWork(invalidCount), /non-negative safe integer/);
}

const servicePath = fileURLToPath(new URL("../services/visit.ts", import.meta.url));
const serviceSource = readFileSync(servicePath, "utf8");
const visitPhotosStart = serviceSource.indexOf("async function visitPhotos(");
const visitPhotosEnd = serviceSource.indexOf("interface DetectFoodOptions", visitPhotosStart);
assert.ok(visitPhotosStart >= 0 && visitPhotosEnd > visitPhotosStart, "visitPhotos source contract was not found");
const visitPhotosSource = serviceSource.slice(visitPhotosStart, visitPhotosEnd);
const initializationIndex = visitPhotosSource.indexOf("await initializeMichelinData()");
const suggestionRefreshIndex = visitPhotosSource.indexOf(
  "await recomputeSuggestedRestaurantsIfNeeded(getMichelinDatasetVersion())",
);
const photoLoadIndex = visitPhotosSource.indexOf("const [photoCounts, photos] = await Promise.all");
const spatialGateIndex = visitPhotosSource.indexOf("if (!hasVisitPhotosForSpatialWork(photos.length))");
const databaseIndex = visitPhotosSource.indexOf("const database = await getDatabase()");
const guideIndexBuildIndex = visitPhotosSource.indexOf("ensureRestaurantLocationIndex(database, __DEV__)");
assert.ok(initializationIndex >= 0, "visitPhotos must preserve guide initialization before photo work");
assert.ok(
  suggestionRefreshIndex > initializationIndex,
  "visitPhotos must preserve pending-suggestion refresh after guide initialization",
);
assert.ok(
  photoLoadIndex > suggestionRefreshIndex,
  "visitPhotos must load counts and photos after versioned guide work",
);
assert.ok(spatialGateIndex > photoLoadIndex, "the spatial gate must run only after the photo query resolves");
assert.ok(databaseIndex > spatialGateIndex, "the empty-photo return must precede the direct database access");
assert.ok(guideIndexBuildIndex > databaseIndex, "the direct scan guide index must be built only after the photo gate");
assert.doesNotMatch(visitPhotosSource, /photoCounts,\s*photos,\s*restaurantLocationIndex/);

console.log(
  "Visit photo spatial-work tests passed: empty work loads 0 direct scan guide rows, non-empty output parity, failure propagation, validation, and version-preflight ordering.",
);
