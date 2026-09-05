import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { QueryClient } from "@tanstack/query-core";
import {
  PENDING_QUICK_ACTIONS_SQL,
  aggregatePendingVisitFoodLabelArrays,
  createPendingQuickActionsData,
  parseLegacyPendingVisitFoodLabels,
  parsePendingQuickActionRows,
  type PendingQuickActionExactMatch,
  type PendingQuickActionQueryRow,
  type PendingQuickActionsData,
  type PendingQuickActionSuggestion,
  type PendingQuickActionVisit,
} from "../utils/db/quick-actions-core.ts";
import {
  PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL,
  PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL,
} from "../utils/db/visit-review-core.ts";
import { BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS } from "./calendar-title-matching-benchmark-core.ts";
import {
  removePendingReviewInfiniteVisits,
  reviewQueryKeys,
  type PendingReviewInfiniteData,
} from "../utils/review-query-policy.ts";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "../utils/runtime-json.ts";

const FRACTIONAL_START_TIME = Number("1657669852199.4983");
const REVIEW_PRIORITIES = [1, 2, 3, 4] as const;
type SQLiteRow = ReturnType<StatementSync["all"]>[number];

interface IndependentFoodLabel {
  readonly label: string;
  readonly confidence: number;
}

interface IndependentAggregatedFoodLabel {
  readonly label: string;
  readonly maxConfidence: number;
  readonly photoCount: number;
}

interface BaseQuickActionRow {
  readonly id: string;
  readonly photoCount: number;
  readonly foodProbable: number;
  readonly suggestedRestaurantId: string | null;
  readonly calendarEventTitle: string | null;
  readonly startTime: number;
}

interface SuggestionVisitRow extends PendingQuickActionSuggestion {
  readonly visitId: string;
}

interface FoodLabelsRow {
  readonly visitId: string;
  readonly foodLabels: string;
}

function isSQLiteString(value: SQLOutputValue): value is string {
  return typeof value === "string";
}

function isSQLiteNumber(value: SQLOutputValue): value is number {
  return typeof value === "number";
}

function requiredString(value: SQLOutputValue, column: string): string {
  assert.ok(isSQLiteString(value), `${column} must be a SQLite TEXT value`);
  return value;
}

function nullableString(value: SQLOutputValue, column: string): string | null {
  return value === null ? null : requiredString(value, column);
}

function requiredNumber(value: SQLOutputValue, column: string): number {
  assert.ok(isSQLiteNumber(value), `${column} must be a SQLite numeric value`);
  return value;
}

function parseBaseQuickActionRow(row: SQLiteRow): BaseQuickActionRow {
  return {
    id: requiredString(row.id, "visits.id"),
    photoCount: requiredNumber(row.photoCount, "visits.photoCount"),
    foodProbable: requiredNumber(row.foodProbable, "visits.foodProbable"),
    suggestedRestaurantId: nullableString(row.suggestedRestaurantId, "visits.suggestedRestaurantId"),
    calendarEventTitle: nullableString(row.calendarEventTitle, "visits.calendarEventTitle"),
    startTime: requiredNumber(row.startTime, "visits.startTime"),
  };
}

function parseSuggestionVisitRow(row: SQLiteRow): SuggestionVisitRow {
  return {
    visitId: requiredString(row.visitId, "visit_suggested_restaurants.visitId"),
    id: requiredString(row.id, "michelin_restaurants.id"),
    name: requiredString(row.name, "michelin_restaurants.name"),
    latitude: requiredNumber(row.latitude, "michelin_restaurants.latitude"),
    longitude: requiredNumber(row.longitude, "michelin_restaurants.longitude"),
  };
}

function parseFoodLabelsRow(row: SQLiteRow): FoodLabelsRow {
  return {
    visitId: requiredString(row.visitId, "photos.visitId"),
    foodLabels: requiredString(row.foodLabels, "photos.foodLabels"),
  };
}

function parsePendingQuickActionQueryRow(row: SQLiteRow): PendingQuickActionQueryRow {
  return {
    id: requiredString(row.id, "visits.id"),
    photoCount: requiredNumber(row.photoCount, "visits.photoCount"),
    foodProbable: requiredNumber(row.foodProbable, "visits.foodProbable"),
    suggestedRestaurantId: nullableString(row.suggestedRestaurantId, "visits.suggestedRestaurantId"),
    calendarEventTitle: nullableString(row.calendarEventTitle, "visits.calendarEventTitle"),
    startTime: requiredNumber(row.startTime, "visits.startTime"),
    suggestedRestaurantsJson: requiredString(row.suggestedRestaurantsJson, "suggestedRestaurantsJson"),
    foodLabelsJson: nullableString(row.foodLabelsJson, "foodLabelsJson"),
  };
}

function parseQueryPlanDetail(row: SQLiteRow): string {
  return requiredString(row.detail, "query plan.detail");
}

function isIndependentFoodLabel(value: JsonValue): value is JsonObject & IndependentFoodLabel {
  return isJsonObject(value) && isJsonString(value.label) && isJsonNumber(value.confidence);
}

function parseIndependentFoodLabels(serialized: string): IndependentFoodLabel[] {
  const parsed = parseJsonValue(serialized);
  assert.ok(Array.isArray(parsed) && parsed.every(isIndependentFoodLabel), "fixture food labels must be valid");
  return parsed.map(({ label, confidence }) => ({ label, confidence }));
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      photoCount INTEGER NOT NULL,
      foodProbable INTEGER NOT NULL,
      suggestedRestaurantId TEXT,
      calendarEventTitle TEXT,
      startTime REAL NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL
    );
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id),
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT
    );
    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_visit_suggested_distance
      ON visit_suggested_restaurants(visitId, distance);
    CREATE INDEX idx_photos_food_labels
      ON photos(visitId) WHERE foodDetected = 1 AND foodLabels IS NOT NULL;
  `);
}

function seedFixture(database: DatabaseSync): void {
  const restaurants = [
    ["m-alpha", "Alpha Café", 37.1, -122.1],
    // ID order deliberately opposes distance order.
    ["m-a-far", "Branch", 37.2, -122.2],
    ["m-z-near", "Branch", 37.2001, -122.2001],
    ["m-unicode", "Élan 東京", 48.8, 2.3],
  ] as const;
  const insertRestaurant = database.prepare(
    "INSERT INTO michelin_restaurants (id, name, latitude, longitude) VALUES (?, ?, ?, ?)",
  );
  for (const restaurant of restaurants) {
    insertRestaurant.run(...restaurant);
  }

  const visits = [
    ["v-exact", "pending", 7, 1, "m-alpha", "Reservation at Alpha Café", FRACTIONAL_START_TIME],
    ["v-fuzzy", "pending", 3, 1, null, "Alpha Café team dinner", 1_650_000_000_300.25],
    ["v-direct-only", "pending", 2, 0, "m-unicode", null, 1_650_000_000_200.5],
    ["v-branch", "pending", 11, 0, null, "Branch", 1_650_000_000_100.75],
    ["v-unmatched", "pending", 1, 0, null, null, 1_650_000_000_000.125],
    // Reverse ID insertion order so the SQL's explicit binary ID tie-break is exercised.
    ["v-tie-b", "pending", 5, 0, null, null, 1_640_000_000_000.5],
    ["v-tie-a", "pending", 5, 0, null, null, 1_640_000_000_000.5],
    ["v-rejected", "rejected", 99, 1, "m-alpha", "Alpha Café", 1_900_000_000_000.5],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits
       (id, status, photoCount, foodProbable, suggestedRestaurantId, calendarEventTitle, startTime)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const visit of visits) {
    insertVisit.run(...visit);
  }

  const suggestions = [
    ["v-exact", "m-alpha", 2],
    ["v-fuzzy", "m-alpha", 3],
    ["v-branch", "m-a-far", 8],
    ["v-branch", "m-z-near", 4],
    ["v-rejected", "m-alpha", 1],
  ] as const;
  const insertSuggestion = database.prepare(
    "INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES (?, ?, ?)",
  );
  for (const suggestion of suggestions) {
    insertSuggestion.run(...suggestion);
  }

  const photos = [
    [
      "p-1",
      "v-exact",
      1,
      JSON.stringify([
        { label: "pizza", confidence: 0.7 },
        { label: "tie-first", confidence: 0.5 },
        { label: "sushi", confidence: 0.6 },
        { label: "salad", confidence: 0.4 },
      ]),
    ],
    [
      "p-2",
      "v-exact",
      1,
      JSON.stringify([
        { label: "pizza", confidence: 0.95 },
        { label: "tie-second", confidence: 0.5 },
        { label: "pasta", confidence: 0.3 },
        { label: "bread", confidence: 0.2 },
      ]),
    ],
    ["p-3", "v-exact", 0, JSON.stringify([{ label: "ignored", confidence: 1 }])],
    ["p-4", "v-fuzzy", 1, JSON.stringify([{ label: "ramen", confidence: 0.88 }])],
    // Non-food visits retain no labels even if a stale labeled photo exists.
    ["p-5", "v-direct-only", 1, JSON.stringify([{ label: "ignored-non-food", confidence: 1 }])],
  ] as const;
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, visitId, foodDetected, foodLabels) VALUES (?, ?, ?, ?)",
  );
  for (const photo of photos) {
    insertPhoto.run(...photo);
  }
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function independentAggregateLabels(
  rawArrays: readonly (readonly IndependentFoodLabel[])[],
): IndependentAggregatedFoodLabel[] {
  const labels = new Map<string, { label: string; maxConfidence: number; photoCount: number }>();
  for (const rawArray of rawArrays) {
    for (const label of rawArray) {
      const existing = labels.get(label.label);
      if (existing) {
        existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
        existing.photoCount += 1;
      } else {
        labels.set(label.label, {
          label: label.label,
          maxConfidence: label.confidence,
          photoCount: 1,
        });
      }
    }
  }
  return [...labels.values()].sort((left, right) => right.maxConfidence - left.maxConfidence).slice(0, 5);
}

function independentOracle(database: DatabaseSync): PendingQuickActionsData {
  const baseRows = database
    .prepare(
      `SELECT id, photoCount, foodProbable, suggestedRestaurantId, calendarEventTitle, startTime
       FROM visits
       WHERE status = 'pending'`,
    )
    .all()
    .map(parseBaseQuickActionRow);
  const suggestionsByVisit = new Map<string, PendingQuickActionSuggestion[]>();
  const suggestionRows = database
    .prepare(
      `SELECT vsr.visitId, m.id, m.name, m.latitude, m.longitude
       FROM visit_suggested_restaurants vsr
       JOIN michelin_restaurants m ON m.id = vsr.restaurantId
       JOIN visits v ON v.id = vsr.visitId
       WHERE v.status = 'pending'
       ORDER BY vsr.visitId COLLATE BINARY, vsr.distance ASC, m.id COLLATE BINARY ASC`,
    )
    .all()
    .map(parseSuggestionVisitRow);
  for (const row of suggestionRows) {
    const suggestions = suggestionsByVisit.get(row.visitId) ?? [];
    suggestions.push({ id: row.id, name: row.name, latitude: row.latitude, longitude: row.longitude });
    suggestionsByVisit.set(row.visitId, suggestions);
  }

  const foodArraysByVisit = new Map<string, IndependentFoodLabel[][]>();
  const foodRows = database
    .prepare(
      `SELECT p.visitId, p.foodLabels
       FROM photos p
       JOIN visits v ON v.id = p.visitId
       WHERE v.status = 'pending'
         AND v.foodProbable = 1
         AND p.foodDetected = 1
         AND p.foodLabels IS NOT NULL
       ORDER BY p.rowid ASC`,
    )
    .all()
    .map(parseFoodLabelsRow);
  for (const row of foodRows) {
    const arrays = foodArraysByVisit.get(row.visitId) ?? [];
    arrays.push(parseIndependentFoodLabels(row.foodLabels));
    foodArraysByVisit.set(row.visitId, arrays);
  }

  const visits: PendingQuickActionVisit[] = baseRows
    .map((row) => ({
      id: row.id,
      photoCount: row.photoCount,
      foodProbable: row.foodProbable === 1,
      suggestedRestaurantId: row.suggestedRestaurantId,
      calendarEventTitle: row.calendarEventTitle,
      startTime: row.startTime,
      suggestedRestaurants: suggestionsByVisit.get(row.id) ?? [],
      foodLabels: row.foodProbable === 1 ? independentAggregateLabels(foodArraysByVisit.get(row.id) ?? []) : [],
    }))
    .sort((left, right) => {
      const priority = (visit: PendingQuickActionVisit): number => {
        const hasMatch = Boolean(visit.suggestedRestaurantId) || visit.suggestedRestaurants.length > 0;
        if (visit.foodProbable && hasMatch) {
          return 1;
        }
        if (hasMatch) {
          return 2;
        }
        return visit.foodProbable ? 3 : 4;
      };
      return priority(left) - priority(right) || right.startTime - left.startTime || compareBinary(left.id, right.id);
    });

  const fuzzyIds = new Set(
    visits.flatMap((visit) => {
      if (!visit.calendarEventTitle) {
        return [];
      }
      const cleaned = BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.cleanCalendarEventTitle(visit.calendarEventTitle);
      return cleaned &&
        visit.suggestedRestaurants.some((restaurant) =>
          BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.isFuzzyRestaurantMatch(cleaned, restaurant.name),
        )
        ? [visit.id]
        : [];
    }),
  );
  const orderedVisits = [
    ...visits.filter((visit) => fuzzyIds.has(visit.id)),
    ...visits.filter((visit) => !fuzzyIds.has(visit.id)),
  ];
  const exactMatches: PendingQuickActionExactMatch[] = [];
  for (const visit of orderedVisits) {
    if (!visit.calendarEventTitle) {
      continue;
    }
    const restaurant = visit.suggestedRestaurants.find((suggestion) =>
      BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.compareRestaurantAndCalendarTitle(
        visit.calendarEventTitle!,
        suggestion.name,
      ),
    );
    if (!restaurant) {
      continue;
    }
    exactMatches.push({
      visitId: visit.id,
      visit,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      calendarTitle: visit.calendarEventTitle,
      startTime: visit.startTime,
    });
  }
  return { visits: orderedVisits, exactMatches };
}

function rawRow(overrides: Partial<PendingQuickActionQueryRow> = {}): PendingQuickActionQueryRow {
  return {
    id: "valid",
    photoCount: 1,
    foodProbable: 1,
    suggestedRestaurantId: null,
    calendarEventTitle: null,
    startTime: FRACTIONAL_START_TIME,
    suggestedRestaurantsJson: "[]",
    foodLabelsJson: "[]",
    ...overrides,
  };
}

assert.ok(PENDING_QUICK_ACTIONS_SQL.includes(PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL));
assert.ok(PENDING_QUICK_ACTIONS_SQL.includes(PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL));
assert.doesNotMatch(PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL, /ORDER BY/);
for (const forbidden of ["previewPhotos", "p.uri", "pv.*", "notes", "Address", "Award"]) {
  assert.equal(PENDING_QUICK_ACTIONS_SQL.includes(forbidden), false, `slim SQL must exclude ${forbidden}`);
}
assert.match(PENDING_QUICK_ACTIONS_SQL, /pv\.startTime,/);
assert.doesNotMatch(PENDING_QUICK_ACTIONS_SQL, /json_(?:array|object)\([^)]*startTime/s);

const database = new DatabaseSync(":memory:");
try {
  createSchema(database);
  seedFixture(database);
  const rawRows = database.prepare(PENDING_QUICK_ACTIONS_SQL).all().map(parsePendingQuickActionQueryRow);
  const parsed = parsePendingQuickActionRows(rawRows);
  const actual = createPendingQuickActionsData(parsed, BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS);
  const expected = independentOracle(database);
  assert.deepEqual(actual, expected);
  assert.equal(actual.visits.length, 7);
  assert.equal(actual.exactMatches.length, 2);
  assert.equal(actual.exactMatches.find((match) => match.visitId === "v-branch")?.restaurantId, "m-z-near");
  assert.deepEqual(
    parsed.filter((visit) => visit.id.startsWith("v-tie")).map((visit) => visit.id),
    ["v-tie-a", "v-tie-b"],
  );
  const fractionalVisit = parsed.find((visit) => visit.id === "v-exact");
  assert.ok(fractionalVisit);
  assert.ok(Object.is(fractionalVisit.startTime, FRACTIONAL_START_TIME), "startTime must retain exact Float64 bits");
  assert.deepEqual(fractionalVisit.foodLabels, [
    { label: "pizza", maxConfidence: 0.95, photoCount: 2 },
    { label: "sushi", maxConfidence: 0.6, photoCount: 1 },
    { label: "tie-first", maxConfidence: 0.5, photoCount: 1 },
    { label: "tie-second", maxConfidence: 0.5, photoCount: 1 },
    { label: "salad", maxConfidence: 0.4, photoCount: 1 },
  ]);
  assert.deepEqual(parsed.find((visit) => visit.id === "v-direct-only")?.foodLabels, []);

  const queryClient = new QueryClient();
  queryClient.setQueryData(reviewQueryKeys.pendingReview, actual);
  const pageKey = reviewQueryKeys.pendingReviewPages("on", "on");
  const paged: PendingReviewInfiniteData<{ readonly id: string }> = {
    pageParams: [null],
    pages: [
      {
        generationId: "quick-actions-cache-test",
        requestedKeys: actual.visits.map((visit, index) => ({
          id: visit.id,
          priority: REVIEW_PRIORITIES[index % REVIEW_PRIORITIES.length]!,
        })),
        visits: actual.visits.map(({ id }) => ({ id })),
        manifest: null,
      },
    ],
  };
  queryClient.setQueryData(pageKey, paged);
  const removedId = actual.visits[0]!.id;
  queryClient.setQueryData<PendingQuickActionsData>(reviewQueryKeys.pendingReview, (current) =>
    current
      ? {
          visits: current.visits.filter((visit) => visit.id !== removedId),
          exactMatches: current.exactMatches.filter((match) => match.visitId !== removedId),
        }
      : current,
  );
  queryClient.setQueriesData<PendingReviewInfiniteData<{ readonly id: string }>>(
    { queryKey: reviewQueryKeys.pendingReviewPagesRoot },
    (current) => removePendingReviewInfiniteVisits(current, [removedId]),
  );
  assert.equal(
    queryClient
      .getQueryData<PendingQuickActionsData>(reviewQueryKeys.pendingReview)
      ?.visits.some(({ id }) => id === removedId),
    false,
  );
  assert.equal(
    queryClient
      .getQueryData<PendingReviewInfiniteData<{ readonly id: string }>>(pageKey)
      ?.pages.some((page) => page.visits.some(({ id }) => id === removedId)),
    false,
  );
  queryClient.clear();
  assert.deepEqual(
    Object.fromEntries(
      [2, 3, 5, 10, 20].map((threshold) => [
        threshold,
        actual.visits.filter((visit) => visit.photoCount < threshold).length,
      ]),
    ),
    { 2: 1, 3: 2, 5: 3, 10: 6, 20: 7 },
  );
  assert.equal(actual.visits.filter((visit) => !visit.foodProbable).length, 5);
  assert.equal(
    actual.visits.filter((visit) => !visit.suggestedRestaurantId && visit.suggestedRestaurants.length === 0).length,
    3,
  );

  const plan = database.prepare(`EXPLAIN QUERY PLAN ${PENDING_QUICK_ACTIONS_SQL}`).all().map(parseQueryPlanDetail);
  const planText = plan.join("\n");
  assert.match(planText, /idx_visit_suggested_distance|sqlite_autoindex_visit_suggested_restaurants_1/);
  assert.match(planText, /idx_photos_food_labels/);
  assert.doesNotMatch(planText, /CORRELATED SCALAR SUBQUERY/);
} finally {
  database.close();
}

assert.deepEqual(
  aggregatePendingVisitFoodLabelArrays([[{ label: "a", confidence: 0.1 }], [{ label: "a", confidence: 0.9 }]]),
  [{ label: "a", maxConfidence: 0.9, photoCount: 2 }],
);
assert.deepEqual(parseLegacyPendingVisitFoodLabels("not-json", true), []);
assert.deepEqual(parseLegacyPendingVisitFoodLabels(JSON.stringify([[{ label: "ignored", confidence: 1 }]]), false), []);

const toleratedFoodLabelPayloads = [
  { name: "missing aggregate", foodLabelsJson: null, foodProbable: 1 },
  { name: "malformed JSON", foodLabelsJson: "{", foodProbable: 1 },
  { name: "non-array JSON", foodLabelsJson: JSON.stringify({ label: "ignored" }), foodProbable: 1 },
  { name: "null photo entry", foodLabelsJson: JSON.stringify([null]), foodProbable: 1 },
  { name: "null label entry", foodLabelsJson: JSON.stringify([[null]]), foodProbable: 1 },
  {
    name: "missing confidence",
    foodLabelsJson: JSON.stringify([[{ label: "historical-missing-confidence" }]]),
    foodProbable: 1,
  },
  {
    name: "null confidence",
    foodLabelsJson: JSON.stringify([[{ label: "historical-null-confidence", confidence: null }]]),
    foodProbable: 1,
  },
  { name: "ignored for non-food visit", foodLabelsJson: "{", foodProbable: 0 },
] as const;
for (const { name, foodLabelsJson, foodProbable } of toleratedFoodLabelPayloads) {
  const parsed = parsePendingQuickActionRows([rawRow({ foodLabelsJson, foodProbable })]);
  assert.deepEqual(
    parsed[0]?.foodLabels,
    parseLegacyPendingVisitFoodLabels(foodLabelsJson, foodProbable === 1),
    `${name} must preserve legacy optional-label tolerance`,
  );
}

const invalidRows: Array<[string, PendingQuickActionQueryRow]> = [
  ["empty id", rawRow({ id: "" })],
  ["negative photo count", rawRow({ photoCount: -1 })],
  ["fractional photo count", rawRow({ photoCount: 1.5 })],
  ["invalid food flag", rawRow({ foodProbable: 2 })],
  ["empty direct suggestion", rawRow({ suggestedRestaurantId: "" })],
  ["non-finite start", rawRow({ startTime: Number.NaN })],
  ["malformed suggestions", rawRow({ suggestedRestaurantsJson: "{" })],
  ["wrong suggestion shape", rawRow({ suggestedRestaurantsJson: JSON.stringify([["id", "name", 1]]) })],
  ["invalid latitude", rawRow({ suggestedRestaurantsJson: JSON.stringify([["id", "name", 91, 1]]) })],
  [
    "duplicate suggestion",
    rawRow({
      suggestedRestaurantsJson: JSON.stringify([
        ["id", "name", 1, 1],
        ["id", "name", 1, 1],
      ]),
    }),
  ],
];
for (const [name, row] of invalidRows) {
  assert.throws(() => parsePendingQuickActionRows([row]), /./, name);
}
assert.throws(() => parsePendingQuickActionRows([rawRow(), rawRow()]), /duplicate visit id/);

const databaseBarrelSource = readFileSync(new URL("../utils/db.ts", import.meta.url), "utf8");
const hookSource = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
const screenSource = readFileSync(new URL("../app/(app)/quick-actions.tsx", import.meta.url), "utf8");
assert.match(databaseBarrelSource, /getPendingQuickActionsData/);
assert.match(hookSource, /export function usePendingQuickActions\(\)/);
assert.match(hookSource, /queryKey: queryKeys\.pendingReview/);
assert.match(hookSource, /queryFn: getPendingQuickActionsData/);
assert.match(hookSource, /reviewQueryKeys\.pendingReviewPagesRoot/);
assert.doesNotMatch(hookSource, /export function usePendingReview\(\)/);
assert.match(screenSource, /usePendingQuickActions\(\)/);
assert.doesNotMatch(screenSource, /usePendingReview\(\)/);

console.log(
  JSON.stringify({
    suite: "quick-actions-query",
    fixturePendingVisits: 7,
    exactMatches: 2,
    parserRejections: invalidRows.length + 1,
    toleratedOptionalFoodLabelPayloads: toleratedFoodLabelPayloads.length,
    independentOracleParity: true,
    deterministicDistanceAndIdOrder: true,
    exactFloat64StartTime: true,
    sharedFoodLabelSemantics: true,
    actionSetBoundaries: true,
    productionWiring: true,
  }),
);
