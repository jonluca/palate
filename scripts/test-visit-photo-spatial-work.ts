#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { hasVisitPhotosForSpatialWork } from "../utils/visit-photo-spatial-work.ts";
import { calculateVisitPhotoCentroid } from "../utils/visit-photo-centroid-core.ts";
import * as proximity from "../utils/visit-photo-proximity-core.ts";

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
const photoLoadIndex = visitPhotosSource.indexOf("const [fullPhotoCounts, photos] = await Promise.all");
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

const compiledService = ts.transpileModule(`${serviceSource}\nexports.visitPhotos = visitPhotos;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const interruption of ["assignment", "progress"] as const) {
  const interruptionError = new Error(`injected ${interruption} interruption`);
  const assignedPhotoIds = new Set<string>();
  const persistedVisits = new Map<string, { id: string; photoCount: number }>();
  const libraryPhotos = [
    { id: "first", creationTime: 1_700_000_000_000, latitude: 37, longitude: -122 },
    { id: "second", creationTime: 1_700_000_060_000, latitude: 37, longitude: -122 },
  ];
  let failAssignment = interruption === "assignment";
  let indexLoads = 0;
  let completeNotifications = 0;
  const database = {
    getMichelinRestaurantCount: async () => 1_000,
    getImportedMichelinDatasetVersion: async () => "test-guide",
    recomputeSuggestedRestaurantsIfNeeded: async () => undefined,
    getVisitablePhotoCounts: async () => ({ total: libraryPhotos.length, visited: assignedPhotoIds.size }),
    getUnvisitedPhotos: async () => libraryPhotos.filter((photo) => !assignedPhotoIds.has(photo.id)),
    getDatabase: async () => ({}),
    insertVisits: async (visits: Array<{ id: string }>) => {
      for (const visit of visits) {
        if (!persistedVisits.has(visit.id)) {
          persistedVisits.set(visit.id, { id: visit.id, photoCount: 0 });
        }
      }
    },
    batchUpdatePhotoVisits: async (updates: Array<{ photoIds: string[] }>) => {
      if (failAssignment) {
        failAssignment = false;
        throw interruptionError;
      }
      for (const update of updates) {
        for (const photoId of update.photoIds) {
          assignedPhotoIds.add(photoId);
        }
      }
      for (const visit of persistedVisits.values()) {
        visit.photoCount = assignedPhotoIds.size;
      }
    },
  };
  const dependencies = new Map<string, object>([
    ["@/utils/db", database],
    ["./michelin", { getMichelinDatasetVersion: () => "test-guide" }],
    ["@/modules/batch-asset-info", { getVisionResultPageSize: () => 24 }],
    ["@/utils/visit-photo-spatial-work", { hasVisitPhotosForSpatialWork }],
    ["@/utils/visit-photo-centroid-core", { calculateVisitPhotoCentroid }],
    ["@/utils/visit-photo-proximity-core", proximity],
    [
      "@/utils/db/michelin-index",
      {
        MICHELIN_PRIMARY_MATCH_RADIUS_METERS: 100,
        MICHELIN_SUGGESTION_RADIUS_METERS: 500,
        ensureRestaurantLocationIndex: async () => {
          indexLoads++;
          return { findNearby: () => [] };
        },
      },
    ],
  ]);
  interface VisitProgress {
    phase: string;
    visitedPhotos: number;
    visitsCreated: number;
    isComplete: boolean;
  }
  interface VisitServiceExports {
    visitPhotos?: (options?: { onProgress?: (progress: VisitProgress) => void }) => Promise<VisitProgress>;
  }
  const exports: VisitServiceExports = {};
  runInNewContext(compiledService, {
    exports,
    require: (name: string) => dependencies.get(name) ?? {},
    __DEV__: false,
    console,
  });
  assert.ok(exports.visitPhotos);
  const visitPhotos = exports.visitPhotos;
  await assert.rejects(
    visitPhotos({
      onProgress: (progress) => {
        if (interruption === "progress" && progress.phase === "saving-visits" && progress.visitedPhotos > 0) {
          throw interruptionError;
        }
      },
    }),
    (error) => error === interruptionError,
  );
  assert.equal(assignedPhotoIds.size, interruption === "assignment" ? 0 : 2);
  assert.deepEqual(
    [...persistedVisits.values()].map((visit) => visit.photoCount),
    [interruption === "assignment" ? 0 : 2],
  );

  const onProgress = (progress: VisitProgress) => {
    if (progress.isComplete) {
      completeNotifications++;
    }
  };
  const result = await visitPhotos({ onProgress });
  assert.equal(result.visitsCreated, interruption === "assignment" ? 1 : 0);
  assert.equal(result.visitedPhotos, 2);
  assert.equal(result.isComplete, true);
  assert.equal(completeNotifications, 1);
  assert.deepEqual(
    [...persistedVisits.values()].map((visit) => visit.photoCount),
    [2],
  );
  assert.equal(indexLoads, interruption === "assignment" ? 2 : 1);
}

console.log(
  "Visit photo spatial-work tests passed: empty work loads 0 direct scan guide rows, non-empty output parity, atomic assignment recovery, failure propagation, validation, and version-preflight ordering.",
);
