import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as nameMatching from "../utils/restaurant-name-matching.ts";
import * as michelinMatching from "../utils/provider-michelin-matching-core.ts";
import * as locations from "../utils/provider-reservation-location-core.ts";
import * as awards from "../utils/reservation-award-batch-core.ts";
import * as dedupe from "../utils/provider-reservation-dedupe-core.ts";
import type {
  ImportableReservation,
  ReservationImportResult,
  ReservationReviewFilterResult,
} from "../services/reservation-import.ts";
import type { ReservationOnlyVisitInput } from "../utils/db/types.ts";

interface ProviderImportApi {
  filterProviderReservationReviewCandidates(
    reservations: ImportableReservation[],
    options: { sourceDisplayName: string },
  ): Promise<ReservationReviewFilterResult>;
  importReservationVisitHistory(
    reservations: ImportableReservation[],
    options: { sourceDisplayName: string },
  ): Promise<ReservationImportResult>;
}

function loadService() {
  const inserted: ReservationOnlyVisitInput[] = [];
  const calls = { globalMergeReads: 0, globalMerges: 0, inserted };
  const modules = new Map<string, object>([
    ["@/utils/restaurant-name-matching", nameMatching],
    ["@/utils/provider-michelin-matching-core", michelinMatching],
    ["@/utils/provider-reservation-location-core", locations],
    ["@/utils/reservation-award-batch-core", awards],
    ["@/utils/provider-reservation-dedupe-core", dedupe],
    ["@/services/michelin", {}],
    ["@/services/places", { searchPlaceByText: async () => [] }],
    [
      "@/utils/db",
      {
        getProviderReservationReviewPrefilterSnapshot: async () => ({
          dismissedSourceEventIds: new Set(),
          excludedSourceEventIds: new Set(),
          exactConfirmedSourceEventIds: new Set(),
          sameDateConfirmedSourceEventIds: new Set(),
        }),
        getReservationOnlyVisitsMappedToConfirmedVisitSourceIds: async () => new Set(),
        selectMichelinProviderSpatialCandidates: async (points: unknown[]) => points.map(() => null),
        insertReservationOnlyVisits: async (visits: ReservationOnlyVisitInput[]) => {
          calls.inserted.push(...visits);
          return {
            insertedCount: visits.length,
            linkedExistingCount: 0,
            confirmedExistingCount: 0,
            skippedDuplicateCount: 0,
            skippedConflictCount: 0,
          };
        },
        getMergeableSameRestaurantVisitGroups: async () => {
          calls.globalMergeReads += 1;
          return [{ visits: [{ id: "unrelated-lunch" }, { id: "unrelated-dinner" }] }];
        },
        batchMergeSameRestaurantVisits: async () => {
          calls.globalMerges += 1;
          return 1;
        },
      },
    ],
  ]);
  const compiled = ts.transpileModule(
    readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports: Partial<ProviderImportApi> = {};
  runInNewContext(compiled, {
    exports,
    __DEV__: false,
    console,
    require(name: string) {
      const dependency = modules.get(name);
      if (!dependency) {
        throw new Error(`Unexpected provider import dependency: ${name}`);
      }
      return dependency;
    },
  });
  assert.ok(exports.filterProviderReservationReviewCandidates);
  assert.ok(exports.importReservationVisitHistory);
  return {
    review: exports.filterProviderReservationReviewCandidates,
    importHistory: exports.importReservationVisitHistory,
    calls,
  };
}

function reservation(id: string, hour: number, restaurantId = "resy-cafe"): ImportableReservation {
  const startTime = new Date(2026, 8, 5, hour).getTime();
  return {
    id,
    sourceEventId: `resy:${id}`,
    sourceName: "resy",
    restaurantId,
    restaurantName: "Neighborhood Cafe",
    address: null,
    startTime,
    endTime: startTime + 2 * 60 * 60 * 1000,
    partySize: 2,
    latitude: 34,
    longitude: -118,
  };
}

const options = { sourceDisplayName: "Resy" };
const service = loadService();
const lunch = reservation("lunch", 12);
const dinner = reservation("dinner", 19);
const otherLocation = reservation("other-location", 12, "resy-cafe-second-location");
const review = await service.review([lunch, dinner, otherLocation], options);
assert.equal(review.reservations.length, 3, "Distinct meals and same-name restaurant locations remain reviewable");
assert.equal(review.skippedDuplicateCount, 0);

const richerLunch = { ...lunch, id: "richer-lunch", sourceEventId: "resy:richer-lunch", address: "123 Main St" };
const duplicateReview = await service.review([lunch, lunch, richerLunch], options);
assert.equal(duplicateReview.reservations.length, 1, "Repeated source IDs and exact reservation copies still dedupe");
assert.equal(duplicateReview.skippedDuplicateCount, 2);
assert.equal(duplicateReview.reservations[0]?.sourceEventId, richerLunch.sourceEventId);

const imported = await service.importHistory([lunch, dinner], options);
assert.equal(imported.importedCount, 2);
assert.equal(service.calls.inserted.length, 2);
assert.equal(service.calls.globalMergeReads, 0, "An import must not scan unrelated confirmed visits for merging");
assert.equal(service.calls.globalMerges, 0, "An import must not merge unrelated confirmed visits");
const locationsService = loadService();
const importedLocations = await locationsService.importHistory([lunch, otherLocation], options);
assert.equal(importedLocations.importedCount, 2, "Same-name restaurants with different provider IDs both import");
assert.equal(importedLocations.skippedDuplicateCount, 0);
assert.deepEqual(
  locationsService.calls.inserted.map((visit) => visit.restaurant.id).sort(),
  [lunch.restaurantId, otherLocation.restaurantId].sort(),
);
const copiesService = loadService();
const importedCopies = await copiesService.importHistory([lunch, richerLunch], options);
assert.equal(importedCopies.importedCount, 1, "Copies of the same restaurant reservation still deduplicate");
assert.equal(importedCopies.skippedDuplicateCount, 1);
assert.equal(copiesService.calls.inserted[0]?.sourceEventId, richerLunch.sourceEventId);
await service.importHistory([], options);
assert.equal(service.calls.globalMergeReads, 0, "An empty import must leave existing visit history alone");

console.log(
  "Provider import isolation passed: distinct meals, restaurant locations, exact copies, and no global merging.",
);
