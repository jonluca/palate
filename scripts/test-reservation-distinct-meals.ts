import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as restaurants from "../data/restaurants.ts";
import * as persistence from "../utils/db/calendar-persistence-core.ts";
import * as mutations from "../utils/calendar-batch-mutation-core.ts";
import * as enrichment from "../utils/db/calendar-enrichment-snapshot-core.ts";
import * as enrichmentCache from "../utils/db/calendar-enrichment-cache-core.ts";
import * as calendarImport from "../utils/db/calendar-import-transaction-core.ts";
import * as reservationImport from "../utils/db/reservation-import-transaction-core.ts";
import * as prefilter from "../utils/db/reservation-review-prefilter-core.ts";
import type * as CalendarApi from "../utils/db/calendar.ts";
import {
  initializeReservationImportPersistenceDatabase,
  insertReservationImportFixtureRestaurant,
  insertReservationImportFixtureVisit,
  makeReservationImportFixtureVisit,
} from "./test-reservation-import-persistence.ts";

function loadProductionCalendar(database: DatabaseSync) {
  const backend = {
    getAllAsync: async (sql: string, values: SQLInputValue[] = []) => database.prepare(sql).all(...values),
    getFirstAsync: async (sql: string, values: SQLInputValue[] = []) => database.prepare(sql).get(...values) ?? null,
    runAsync: async (sql: string, values: SQLInputValue[] = []) => database.prepare(sql).run(...values),
  };
  const adapter = {
    ...backend,
    async withExclusiveTransactionAsync(operation: (transaction: typeof backend) => Promise<void>) {
      database.exec("BEGIN");
      try {
        await operation(backend);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const dependencies = new Map<string, object>([
    ["./core", { getDatabase: async () => adapter }],
    ["@/data/restaurants", restaurants],
    ["./calendar-persistence-core", persistence],
    ["../calendar-batch-mutation-core", mutations],
    ["./calendar-enrichment-snapshot-core", enrichment],
    ["./calendar-enrichment-cache-core", enrichmentCache],
    ["./calendar-import-transaction-core", calendarImport],
    ["./reservation-import-transaction-core", reservationImport],
    ["./reservation-review-prefilter-core", prefilter],
  ]);
  const exports: Partial<typeof CalendarApi> = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../utils/db/calendar.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    __DEV__: false,
    console,
    require(name: string) {
      const dependency = dependencies.get(name);
      if (!dependency) {
        throw new Error(`Unexpected calendar dependency: ${name}`);
      }
      return dependency;
    },
  });
  const {
    insertReservationOnlyVisits,
    getProviderReservationReviewPrefilterSnapshot,
    getReservationOnlyVisitsMappedToConfirmedVisitSourceIds,
    excludeReservationImportReviews,
    getExcludedReservationImportReviewSourceEventIds,
  } = exports;
  assert.ok(insertReservationOnlyVisits);
  assert.ok(getProviderReservationReviewPrefilterSnapshot);
  assert.ok(getReservationOnlyVisitsMappedToConfirmedVisitSourceIds);
  assert.ok(excludeReservationImportReviews);
  assert.ok(getExcludedReservationImportReviewSourceEventIds);
  return {
    insertReservationOnlyVisits,
    getProviderReservationReviewPrefilterSnapshot,
    getReservationOnlyVisitsMappedToConfirmedVisitSourceIds,
    excludeReservationImportReviews,
    getExcludedReservationImportReviewSourceEventIds,
  };
}

const hour = 3_600_000;
const restaurant = { id: "resy-cafe", name: "Neighborhood Cafe", latitude: 34, longitude: -118 };
const noon = new Date(2026, 8, 5, 12).getTime();

for (const strategy of [undefined, "set-based-json-v1"] as const) {
  const database = new DatabaseSync(":memory:");
  try {
    initializeReservationImportPersistenceDatabase(database);
    database.exec(`
      CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
      CREATE TABLE dismissed_reservation_import_sources (sourceEventId TEXT PRIMARY KEY, dismissedAt INTEGER);
      CREATE TABLE reservation_import_review_exclusions (
        fingerprint TEXT PRIMARY KEY, source TEXT, restaurantName TEXT, visitDate TEXT, action TEXT, excludedAt INTEGER
      );
    `);
    insertReservationImportFixtureRestaurant(database, restaurant.id, restaurant.name, 34, -118);
    insertReservationImportFixtureVisit(database, {
      id: "lunch",
      restaurantId: restaurant.id,
      status: "confirmed",
      startTime: noon,
      latitude: 34,
      longitude: -118,
    });
    const api = loadProductionCalendar(database);
    const dinner = makeReservationImportFixtureVisit("dinner", "resy:dinner", noon + 7 * hour, restaurant);
    const duplicateLunch = makeReservationImportFixtureVisit("lunch-copy", "tock:lunch", noon, restaurant);
    const toCandidate = (visit: typeof dinner) => ({
      sourceEventId: visit.sourceEventId,
      sourceName: visit.sourceName,
      restaurantName: visit.restaurant.name,
      restaurantId: visit.restaurant.id,
      startTime: visit.startTime,
      endTime: visit.endTime,
    });

    const beforeReview = await api.getProviderReservationReviewPrefilterSnapshot([
      toCandidate(dinner),
      toCandidate(duplicateLunch),
    ]);
    assert.equal(
      beforeReview.sameDateConfirmedSourceEventIds.has(dinner.sourceEventId),
      false,
      "Dinner must survive early review after lunch",
    );
    assert.equal(
      beforeReview.sameDateConfirmedSourceEventIds.has(duplicateLunch.sourceEventId),
      true,
      "An overlapping lunch copy remains matched",
    );
    const locatedReview = await api.getReservationOnlyVisitsMappedToConfirmedVisitSourceIds([dinner, duplicateLunch]);
    assert.equal(locatedReview.has(dinner.sourceEventId), false, "Dinner must survive located review after lunch");
    assert.equal(locatedReview.has(duplicateLunch.sourceEventId), true);

    const inserted = await api.insertReservationOnlyVisits([dinner], { strategy });
    assert.equal(inserted.insertedCount, 1, `${strategy ?? "production default"}: dinner must create a distinct visit`);
    assert.equal(database.prepare("SELECT count(*) AS count FROM visits").get()?.count, 2);
    const repeated = await api.insertReservationOnlyVisits([dinner], { strategy });
    assert.equal(repeated.skippedDuplicateCount, 1, "The exact source ID must remain idempotent");
    const matched = await api.insertReservationOnlyVisits([duplicateLunch], { strategy });
    assert.equal(matched.linkedExistingCount, 1, "Actual lunch overlap must keep linking across providers");

    const tomorrowLunch = {
      ...toCandidate(duplicateLunch),
      sourceEventId: "dismissed-lunch",
      startTime: noon + 24 * hour,
      endTime: noon + 26 * hour,
    };
    await api.excludeReservationImportReviews([tomorrowLunch], "dismissed");
    const tomorrowDinner = {
      ...tomorrowLunch,
      sourceEventId: "tomorrow-dinner",
      startTime: noon + 31 * hour,
      endTime: noon + 33 * hour,
    };
    const exclusionReview = await api.getProviderReservationReviewPrefilterSnapshot([tomorrowLunch, tomorrowDinner]);
    assert.equal(exclusionReview.excludedSourceEventIds.has(tomorrowLunch.sourceEventId), true);
    assert.equal(
      exclusionReview.excludedSourceEventIds.has(tomorrowDinner.sourceEventId),
      false,
      "Dismissing lunch must not dismiss dinner",
    );
    const legacyExclusions = await api.getExcludedReservationImportReviewSourceEventIds([
      tomorrowLunch,
      tomorrowDinner,
    ]);
    assert.equal(legacyExclusions.has(tomorrowLunch.sourceEventId), true);
    assert.equal(legacyExclusions.has(tomorrowDinner.sourceEventId), false);
    const lunchCopy = { ...tomorrowLunch, sourceEventId: "dismissed-lunch-copy" };
    const exactCopyReview = await api.getProviderReservationReviewPrefilterSnapshot([lunchCopy]);
    assert.equal(
      exactCopyReview.excludedSourceEventIds.has(lunchCopy.sourceEventId),
      true,
      "An exact reservation copy still honors its dismissal",
    );

    insertReservationImportFixtureVisit(database, {
      id: "late-dinner",
      restaurantId: restaurant.id,
      status: "confirmed",
      startTime: noon + 35 * hour,
      latitude: 34,
      longitude: -118,
    });
    const afterMidnight = {
      ...tomorrowDinner,
      sourceEventId: "after-midnight",
      startTime: noon + 36 * hour,
      endTime: noon + 37 * hour,
    };
    const midnightReview = await api.getProviderReservationReviewPrefilterSnapshot([afterMidnight]);
    assert.equal(
      midnightReview.sameDateConfirmedSourceEventIds.has(afterMidnight.sourceEventId),
      true,
      "A real overlap across midnight remains matched",
    );
    const exactBoundary = {
      ...afterMidnight,
      sourceEventId: "exact-boundary",
      startTime: noon + 37.5 * hour,
      endTime: noon + 39 * hour,
    };
    const insideBoundary = {
      ...exactBoundary,
      sourceEventId: "inside-boundary",
      startTime: exactBoundary.startTime - 1,
    };
    const boundaryReview = await api.getProviderReservationReviewPrefilterSnapshot([exactBoundary, insideBoundary]);
    assert.equal(boundaryReview.sameDateConfirmedSourceEventIds.has(exactBoundary.sourceEventId), false);
    assert.equal(boundaryReview.sameDateConfirmedSourceEventIds.has(insideBoundary.sourceEventId), true);
    database.prepare("UPDATE visits SET endTime = ? WHERE id = 'late-dinner'").run(noon + 100 * hour);
    const longOverlap = {
      ...afterMidnight,
      sourceEventId: "long-overlap",
      startTime: noon + 95 * hour,
      endTime: noon + 96 * hour,
    };
    const longReview = await api.getProviderReservationReviewPrefilterSnapshot([longOverlap]);
    assert.equal(
      longReview.sameDateConfirmedSourceEventIds.has(longOverlap.sourceEventId),
      true,
      "Duration-based query bounds must preserve long existing visits",
    );
  } finally {
    database.close();
  }
}

console.log(
  "Distinct reservation meals passed: production default and set-based persistence, both review stages, source replay, dismissals, cross-provider and midnight overlaps.",
);
