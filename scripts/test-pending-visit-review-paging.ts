#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "../utils/db/visit-review-core.ts";
import {
  DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
  MAX_PENDING_VISIT_REVIEW_PAGE_SIZE,
  PENDING_VISIT_REVIEW_MANIFEST_SQL,
  PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL,
  PENDING_VISIT_REVIEW_PAGE_SQL,
  createPendingVisitReviewGeneration,
  getNextPendingVisitReviewPageRequest,
  hydratePendingVisitReviewPages,
  parsePendingVisitReviewManifest,
  parsePendingVisitReviewOrderedKeys,
  partitionPendingVisitReviewKeys,
  serializePendingVisitReviewPageKeys,
  validatePendingVisitReviewPageSize,
  type PendingVisitReviewOrderedKeysRow,
  type PendingVisitReviewFilters,
  type PendingVisitReviewManifestRow,
  type PendingVisitReviewMatchTools,
  type PendingVisitReviewPageKey,
} from "../utils/db/visit-review-paging-core.ts";
import {
  removePendingReviewInfiniteVisits,
  restoreFailedPendingReviewInfiniteMutation,
  type PendingReviewInfiniteData,
} from "../utils/review-query-policy.ts";
import {
  BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS,
  assertCalendarTitleMatchingSourceContract,
} from "./calendar-title-matching-benchmark-core.ts";

type ReviewStatement = ReturnType<DatabaseSync["prepare"]>;

interface FixtureStatements {
  readonly insertVisit: ReviewStatement;
  readonly insertMichelin: ReviewStatement;
  readonly insertRestaurant: ReviewStatement;
  readonly insertSuggestion: ReviewStatement;
  readonly insertPhoto: ReviewStatement;
}

function createDatabase(path = ":memory:", withIndexes = true, useWal = false): DatabaseSync {
  const database = new DatabaseSync(path);
  if (useWal) {
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL,
      location TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      latestAwardYear INTEGER,
      award TEXT NOT NULL,
      datasetVersion TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL,
      foodProbable INTEGER NOT NULL,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      notes TEXT,
      updatedAt INTEGER,
      exportedToCalendarId TEXT,
      awardAtVisit TEXT,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );
  `);
  if (withIndexes) {
    database.exec(`
      CREATE INDEX idx_visits_status ON visits(status);
      CREATE INDEX idx_visits_pending_priority
        ON visits(status, foodProbable DESC, suggestedRestaurantId, startTime DESC);
      CREATE INDEX idx_photos_visit ON photos(visitId);
      CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
      CREATE INDEX idx_photos_visit_preview ON photos(
        visitId,
        (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
        creationTime,
        id
      );
      CREATE INDEX idx_photos_food_labels ON photos(visitId)
        WHERE foodDetected = 1 AND foodLabels IS NOT NULL;
      CREATE INDEX idx_visit_suggested_restaurants_visit ON visit_suggested_restaurants(visitId);
      CREATE INDEX idx_visit_suggested_distance ON visit_suggested_restaurants(visitId, distance);
    `);
  }
  return database;
}

function fixtureStatements(database: DatabaseSync): FixtureStatements {
  return {
    insertRestaurant: database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)"),
    insertMichelin: database.prepare(`
      INSERT INTO michelin_restaurants (
        id, name, latitude, longitude, address, location, cuisine,
        latestAwardYear, award, datasetVersion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertVisit: database.prepare(`
      INSERT INTO visits (
        id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
        centerLat, centerLon, photoCount, foodProbable, calendarEventId,
        calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
        notes, updatedAt, exportedToCalendarId, awardAtVisit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertSuggestion: database.prepare(`
      INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
      VALUES (?, ?, ?)
    `),
    insertPhoto: database.prepare(`
      INSERT INTO photos (id, uri, creationTime, visitId, foodDetected, foodLabels, foodConfidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

function insertVisit(
  statements: FixtureStatements,
  input: {
    readonly id: string;
    readonly status?: "pending" | "confirmed" | "rejected";
    readonly startTime: number;
    readonly foodProbable: number;
    readonly photoCount?: number;
    readonly restaurantId?: string | null;
    readonly suggestedRestaurantId?: string | null;
    readonly calendarEventTitle?: string | null;
  },
): void {
  statements.insertVisit.run(
    input.id,
    input.restaurantId ?? null,
    input.suggestedRestaurantId ?? null,
    input.status ?? "pending",
    input.startTime,
    input.startTime + 3_600_000,
    34.0522,
    -118.2437,
    input.photoCount ?? 0,
    input.foodProbable,
    input.calendarEventTitle ? `event-${input.id}` : null,
    input.calendarEventTitle ?? null,
    input.calendarEventTitle ? "München, Deutschland" : null,
    input.calendarEventTitle ? 0 : null,
    input.id.includes("unicode") ? "雪, apostrophe ' and emoji 🍮" : null,
    input.startTime + 1,
    input.status === "confirmed" ? `export-${input.id}` : null,
    input.status === "confirmed" ? "Historic Award" : null,
  );
}

function insertMichelinRows(statements: FixtureStatements, count = 6): void {
  for (let index = 0; index < count; index++) {
    statements.insertMichelin.run(
      `michelin-${index}`,
      index === 0 ? 'Café "雪" 🍽️' : `Guide Restaurant ${index}`,
      34 + index / 100,
      -118 - index / 100,
      `${index + 1} Quoted "Street"`,
      index === 0 ? "東京, 日本" : `Fixture City ${index}`,
      index === 0 ? "Crème brûlée" : `Cuisine ${index}`,
      index % 2 === 0 ? 2026 : null,
      index % 3 === 0 ? "1 Star" : index % 3 === 1 ? "Bib Gourmand" : "Selected",
      "paging-fixture-v1",
    );
  }
}

function seedFocusedFixture(database: DatabaseSync): void {
  const statements = fixtureStatements(database);
  database.exec("BEGIN");
  try {
    statements.insertRestaurant.run("local-restaurant", 'Local "Bistro" 東京');
    insertMichelinRows(statements);
    statements.insertMichelin.run(
      "michelin-branch-a-far",
      "Twin Branch",
      34.8,
      -118.8,
      "Far Branch Address",
      "Far Branch City",
      "Branch Cuisine",
      2026,
      "Selected",
      "paging-fixture-v1",
    );
    statements.insertMichelin.run(
      "michelin-branch-z-near",
      "Twin Branch",
      34.9,
      -118.9,
      "Near Branch Address",
      "Near Branch City",
      "Branch Cuisine",
      2026,
      "Selected",
      "paging-fixture-v1",
    );

    insertVisit(statements, {
      id: "priority-1-direct-unicode",
      startTime: 9_000,
      foodProbable: 1,
      photoCount: 5,
      restaurantId: "local-restaurant",
      suggestedRestaurantId: "michelin-0",
      calendarEventTitle: 'Dinner at Café "雪"',
    });
    insertVisit(statements, { id: "priority-1-near", startTime: 8_000, foodProbable: 1, photoCount: 2 });
    insertVisit(statements, {
      id: "priority-2-direct",
      startTime: 7_000,
      foodProbable: 0,
      suggestedRestaurantId: "michelin-1",
      photoCount: 1,
    });
    insertVisit(statements, {
      id: "priority-2-duplicate-name-exact",
      startTime: 6_500,
      foodProbable: 0,
      calendarEventTitle: "Dinner at Twin Branch",
    });
    insertVisit(statements, { id: "priority-2-near", startTime: 6_000, foodProbable: 0, photoCount: 1 });
    insertVisit(statements, { id: "priority-3-food", startTime: 5_000, foodProbable: 1, photoCount: 3 });
    // Reverse insertion makes the final ID key observable instead of inheriting row insertion order.
    insertVisit(statements, { id: "priority-4-tie-b", startTime: 4_000, foodProbable: 0, photoCount: 1 });
    insertVisit(statements, { id: "priority-4-tie-a", startTime: 4_000, foodProbable: 0, photoCount: 1 });
    insertVisit(statements, { id: "priority-4-empty", startTime: 3_000, foodProbable: 0 });
    insertVisit(statements, {
      id: "confirmed-excluded",
      status: "confirmed",
      startTime: 20_000,
      foodProbable: 1,
      photoCount: 1,
    });
    insertVisit(statements, {
      id: "rejected-excluded",
      status: "rejected",
      startTime: 19_000,
      foodProbable: 1,
      photoCount: 1,
    });

    for (const [visitId, restaurantId, distance] of [
      ["priority-1-direct-unicode", "michelin-0", 1.25],
      ["priority-1-direct-unicode", "michelin-2", 7.5],
      ["priority-1-near", "michelin-3", 2.5],
      ["priority-2-duplicate-name-exact", "michelin-branch-a-far", 20],
      ["priority-2-duplicate-name-exact", "michelin-branch-z-near", 1],
      ["priority-2-near", "michelin-4", 3.75],
      ["priority-2-near", "michelin-5", 5.25],
    ] as const) {
      statements.insertSuggestion.run(visitId, restaurantId, distance);
    }

    const labelsA = JSON.stringify([
      { label: 'crème "brûlée" 🍮', confidence: 0.91 },
      { label: "寿司", confidence: 0.82 },
    ]);
    const labelsB = JSON.stringify([{ label: "寿司", confidence: 0.97 }]);
    for (const row of [
      ["focused-food-b", "ph://food-'b'-雪", 100, "priority-1-direct-unicode", 1, labelsA, 0.91],
      ["focused-food-a", 'ph://food-"a"-🍣', 100, "priority-1-direct-unicode", 1, labelsB, 0.97],
      ["focused-false", "ph://false", 50, "priority-1-direct-unicode", 0, null, null],
      ["focused-null", "ph://null", 25, "priority-1-direct-unicode", null, null, null],
      ["focused-late", "ph://late", 500, "priority-1-direct-unicode", 1, labelsA, 0.8],
      ["near-food", "ph://near-food", 1, "priority-1-near", 1, labelsA, 0.9],
      ["near-null", "ph://near-null", 2, "priority-1-near", null, null, null],
      ["p2-direct", "ph://p2-direct", 1, "priority-2-direct", 0, null, null],
      ["p2-near", "ph://p2-near", 1, "priority-2-near", null, null, null],
      ["p3-food-a", "ph://p3-food-a", 1, "priority-3-food", 1, labelsB, 0.97],
      ["p3-food-b", "ph://p3-food-b", 2, "priority-3-food", 1, labelsA, 0.91],
      ["p3-null", "ph://p3-null", 3, "priority-3-food", null, null, null],
      ["tie-b-photo", "ph://tie-b", 1, "priority-4-tie-b", 0, null, null],
      ["tie-a-photo", "ph://tie-a", 1, "priority-4-tie-a", 0, null, null],
      ["confirmed-photo", "ph://confirmed", 1, "confirmed-excluded", 1, labelsA, 0.9],
      ["rejected-photo", "ph://rejected", 1, "rejected-excluded", 1, labelsA, 0.9],
    ] as const) {
      statements.insertPhoto.run(...row);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedRandomFixture(database: DatabaseSync, seed: number): void {
  const statements = fixtureStatements(database);
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  database.exec("BEGIN");
  try {
    statements.insertRestaurant.run("random-local", "Random Local 雪");
    insertMichelinRows(statements, 8);
    let creation = 1;
    for (let index = 0; index < 113; index++) {
      const id = `random-${index.toString().padStart(3, "0")}`;
      const priorityClass = index % 4;
      const foodProbable = priorityClass === 0 || priorityClass === 2 ? 1 : 0;
      const hasSuggestion = priorityClass === 0 || priorityClass === 1;
      const directSuggestion = hasSuggestion && index % 3 === 0 ? `michelin-${index % 8}` : null;
      const photoCount = Math.floor(random() * 8);
      // Every seventeenth pair shares a timestamp to exercise the final ID key.
      const startOrdinal = index % 17 === 1 ? index - 1 : index;
      insertVisit(statements, {
        id,
        startTime: 1_000_000 - startOrdinal * 1_000,
        foodProbable,
        photoCount,
        restaurantId: index % 19 === 0 ? "random-local" : null,
        suggestedRestaurantId: directSuggestion,
        calendarEventTitle: index % 11 === 0 ? `Dinner ${index} 雪` : null,
      });
      if (hasSuggestion && directSuggestion === null) {
        const suggestionCount = 1 + (index % 3);
        for (let suggestion = 0; suggestion < suggestionCount; suggestion++) {
          statements.insertSuggestion.run(id, `michelin-${(index + suggestion) % 8}`, 1 + random() * 50);
        }
      }
      for (let photo = 0; photo < photoCount; photo++) {
        const detectionBucket = Math.floor(random() * 10);
        const foodDetected = detectionBucket < 4 ? 1 : detectionBucket < 8 ? 0 : null;
        const labels =
          foodProbable === 1 && foodDetected === 1 && photo % 2 === 0
            ? JSON.stringify([
                { label: index % 2 === 0 ? "ramen 🍜" : 'quoted "taco"', confidence: 0.5 + random() / 2 },
              ])
            : null;
        statements.insertPhoto.run(
          `${id}-photo-${photo.toString().padStart(2, "0")}`,
          `ph://${id}/雪/${photo}`,
          creation++,
          id,
          foodDetected,
          labels,
          foodDetected === 1 ? 0.5 + random() / 2 : null,
        );
      }
    }
    for (let index = 0; index < 7; index++) {
      insertVisit(statements, {
        id: `excluded-${index}`,
        status: index % 2 === 0 ? "confirmed" : "rejected",
        startTime: 2_000_000 + index,
        foodProbable: index % 2,
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function orderedKeys(database: DatabaseSync): PendingVisitReviewPageKey[] {
  const row = database.prepare(PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL).get() as
    | PendingVisitReviewOrderedKeysRow
    | undefined;
  assert.ok(row, "ordered-key query must return its aggregate row");
  return parsePendingVisitReviewOrderedKeys(row);
}

function canonicalReviewOrder(rows: readonly PendingVisitReviewQueryRow[]): PendingVisitReviewQueryRow[] {
  return [...rows].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.startTime !== right.startTime) {
      return right.startTime - left.startTime;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

interface LegacyReviewSuggestion {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

function legacyReviewSelectionOracle(
  rows: readonly PendingVisitReviewQueryRow[],
  filters: PendingVisitReviewFilters,
  tools: PendingVisitReviewMatchTools,
) {
  const visits = rows.map((row) => ({
    row,
    suggestions: row.suggestedRestaurantsJson
      ? (JSON.parse(row.suggestedRestaurantsJson) as LegacyReviewSuggestion[])
      : [],
  }));
  const fuzzyMatches: typeof visits = [];
  const remaining: typeof visits = [];
  for (const visit of visits) {
    const cleanedTitle = visit.row.calendarEventTitle
      ? tools.cleanCalendarEventTitle(visit.row.calendarEventTitle)
      : "";
    const hasFuzzyMatch =
      cleanedTitle.length > 0 &&
      visit.suggestions.some((restaurant) => tools.isFuzzyRestaurantMatch(cleanedTitle, restaurant.name));
    (hasFuzzyMatch ? fuzzyMatches : remaining).push(visit);
  }
  const backendOrdered = [...fuzzyMatches, ...remaining];
  const exactConfirmations: Array<{
    visitId: string;
    restaurantId: string;
    restaurantName: string;
    latitude: number;
    longitude: number;
    calendarTitle: string;
    startTime: number;
  }> = [];
  const exactIds = new Set<string>();
  for (const visit of backendOrdered) {
    if (!visit.row.calendarEventTitle) {
      continue;
    }
    const restaurant = visit.suggestions.find((suggestion) =>
      tools.compareRestaurantAndCalendarTitle(visit.row.calendarEventTitle!, suggestion.name),
    );
    if (!restaurant) {
      continue;
    }
    exactIds.add(visit.row.id);
    exactConfirmations.push({
      visitId: visit.row.id,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      calendarTitle: visit.row.calendarEventTitle,
      startTime: visit.row.startTime,
    });
  }
  const manual = backendOrdered.filter(
    (visit) =>
      !exactIds.has(visit.row.id) &&
      (filters.food === "off" || visit.row.foodProbable === 1) &&
      (filters.restaurantMatches === "off" || visit.suggestions.length > 0),
  );
  const manualWithCalendar = manual.filter((visit) => Boolean(visit.row.calendarEventTitle));
  const manualWithoutCalendar = manual.filter((visit) => !visit.row.calendarEventTitle);
  return {
    exactConfirmations,
    selectedIds: [
      ...exactConfirmations.map((confirmation) => confirmation.visitId),
      ...manualWithCalendar.map((visit) => visit.row.id),
      ...manualWithoutCalendar.map((visit) => visit.row.id),
    ],
  };
}

async function executePaged(
  database: DatabaseSync,
  pageSize: number,
  keys: readonly PendingVisitReviewPageKey[] = orderedKeys(database),
): Promise<PendingVisitReviewQueryRow[]> {
  const pageStatement = database.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
  return hydratePendingVisitReviewPages(
    keys,
    async (serializedKeys) => pageStatement.all(serializedKeys) as unknown as PendingVisitReviewQueryRow[],
    pageSize,
  );
}

async function assertFixtureParity(database: DatabaseSync, pageSizes: readonly number[], expectLegacyOrder = false) {
  const productionRows = database
    .prepare(PENDING_VISITS_FOR_REVIEW_SQL)
    .all() as unknown as PendingVisitReviewQueryRow[];
  // The literal production SQL does not define order inside equal
  // (priority,startTime) groups. Compare every raw field after applying only
  // the paging contract's explicit ID refinement to those otherwise unordered ties.
  const expected = canonicalReviewOrder(productionRows);
  const keys = orderedKeys(database);
  assert.deepEqual(
    keys,
    expected.map(({ id, priority }) => ({ id, priority })),
    "ordered keys must match every production raw row under the explicit deterministic tie refinement",
  );
  assert.equal(new Set(keys.map((key) => key.id)).size, keys.length, "ordered keys must not contain duplicates");

  for (const pageSize of pageSizes) {
    const rows = await executePaged(database, pageSize, keys);
    assert.deepEqual(
      rows,
      expected,
      `page size ${pageSize} must reconstruct every production raw field under the deterministic tie refinement`,
    );
    assert.equal(rows.length, productionRows.length);
    assert.deepEqual(
      rows.map((row) => row.id),
      keys.map((key) => key.id),
      `page size ${pageSize} must preserve every key ordinal`,
    );
  }
  if (expectLegacyOrder) {
    assert.deepEqual(
      productionRows,
      expected,
      "fixtures without tied visit times must retain literal production order",
    );
  }
}

assert.equal(PENDING_VISIT_REVIEW_PAGE_SQL.match(/\?/g)?.length, 1, "page hydration must use exactly one bind");
assert.equal(PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL.includes("?"), false);
assert.equal(validatePendingVisitReviewPageSize(1), 1);
assert.equal(
  validatePendingVisitReviewPageSize(MAX_PENDING_VISIT_REVIEW_PAGE_SIZE),
  MAX_PENDING_VISIT_REVIEW_PAGE_SIZE,
);
for (const invalid of [0, -1, 1.5, Number.NaN, MAX_PENDING_VISIT_REVIEW_PAGE_SIZE + 1]) {
  assert.throws(() => validatePendingVisitReviewPageSize(invalid), /page size/i);
}
assert.throws(
  () =>
    serializePendingVisitReviewPageKeys([
      { id: "duplicate", priority: 1 },
      { id: "duplicate", priority: 1 },
    ]),
  /duplicate visit id/,
);
assert.throws(() => parsePendingVisitReviewOrderedKeys({ keysJson: '[{"id":"visit","priority":5}]' }), /priority/);
assert.throws(() => parsePendingVisitReviewOrderedKeys({ keysJson: "not-json" }), /not valid JSON/);
const calendarTitleSourceContract = assertCalendarTitleMatchingSourceContract();
assert.equal(calendarTitleSourceContract.sourceContractMatched, true);
assert.equal(
  BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.cleanCalendarEventTitle("Dinner at Le Bernardin (2 guests)"),
  "Le Bernardin",
);
assert.equal(
  BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.compareRestaurantAndCalendarTitle("Dinner at Le Bernardin", "Le Bernardin"),
  true,
);
assert.equal(BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.isFuzzyRestaurantMatch("Café Snow", 'Café "Snow" 雪'), true);

for (const withIndexes of [false, true]) {
  const focused = createDatabase(":memory:", withIndexes);
  try {
    seedFocusedFixture(focused);
    const count = orderedKeys(focused).length;
    await assertFixtureParity(focused, [1, 2, 3, 4, count - 1, count, count + 1]);
    const keys = orderedKeys(focused);
    assert.deepEqual(
      keys.map((key) => key.priority),
      [1, 1, 2, 2, 2, 3, 4, 4, 4],
      "focused fixture must exercise every priority class",
    );
    assert.ok(
      keys.findIndex((key) => key.id === "priority-4-tie-a") < keys.findIndex((key) => key.id === "priority-4-tie-b"),
    );

    const rows = await executePaged(focused, 2, keys);
    const focusedFood = rows.find((row) => row.id === "priority-1-direct-unicode");
    assert.ok(focusedFood);
    assert.deepEqual(JSON.parse(focusedFood.previewPhotosJson ?? "null"), [
      'ph://food-"a"-🍣',
      "ph://food-'b'-雪",
      "ph://late",
    ]);
    assert.equal(focusedFood.restaurantName, 'Local "Bistro" 東京');
    assert.equal(focusedFood.hasUnanalyzedPhotos, 1);
    assert.ok((focusedFood.suggestedRestaurantsJson ?? "").includes("東京"));
    const nestedLabels = JSON.parse(focusedFood.foodLabelsJson ?? "null") as Array<
      Array<{ readonly label: string; readonly confidence: number }>
    >;
    assert.ok(nestedLabels.flat().some((label) => label.label === 'crème "brûlée" 🍮'));
    assert.equal(
      rows.some((row) => row.id.includes("excluded")),
      false,
    );
  } finally {
    focused.close();
  }

  for (const seed of [0x51a7_2026, 0xcafe_babe, 0x0bad_f00d]) {
    const randomized = createDatabase(":memory:", withIndexes);
    try {
      seedRandomFixture(randomized, seed);
      await assertFixtureParity(randomized, [1, 7, 16, 31, 64, 113, 114]);
    } finally {
      randomized.close();
    }
  }
}

const empty = createDatabase();
try {
  assert.deepEqual(orderedKeys(empty), []);
  assert.deepEqual(await executePaged(empty, 1), []);
  assert.deepEqual(partitionPendingVisitReviewKeys([], 1), []);
  assert.deepEqual(empty.prepare(PENDING_VISIT_REVIEW_PAGE_SQL).all("[]"), []);
  const emptyManifestRow = empty.prepare(PENDING_VISIT_REVIEW_MANIFEST_SQL).get() as
    | PendingVisitReviewManifestRow
    | undefined;
  assert.ok(emptyManifestRow);
  assert.deepEqual(parsePendingVisitReviewManifest(emptyManifestRow), []);
} finally {
  empty.close();
}

const progressive = createDatabase();
try {
  seedFocusedFixture(progressive);
  progressive
    .prepare("UPDATE visits SET calendarEventTitle = ? WHERE id = ?")
    .run("Unrelated calendar title", "priority-4-empty");
  const manifestRow = progressive.prepare(PENDING_VISIT_REVIEW_MANIFEST_SQL).get() as
    | PendingVisitReviewManifestRow
    | undefined;
  assert.ok(manifestRow);
  const manifestItems = parsePendingVisitReviewManifest(manifestRow);
  assert.equal(manifestItems.length, 9);
  const tools = {
    cleanCalendarEventTitle: (title: string) => title.toLocaleLowerCase().replace(/^dinner at /, ""),
    isFuzzyRestaurantMatch: (title: string, restaurantName: string) =>
      title.includes(restaurantName.toLocaleLowerCase().replace(" 🍽️", "")),
    compareRestaurantAndCalendarTitle: (title: string, restaurantName: string) =>
      title.toLocaleLowerCase().includes(restaurantName.toLocaleLowerCase().replace(" 🍽️", "")),
  } satisfies PendingVisitReviewMatchTools;
  const unfilteredGeneration = createPendingVisitReviewGeneration(
    manifestItems,
    { food: "off", restaurantMatches: "off" },
    tools,
    manifestRow.manifestJson,
  );
  const filteredGeneration = createPendingVisitReviewGeneration(
    manifestItems,
    { food: "on", restaurantMatches: "on" },
    tools,
    manifestRow.manifestJson,
  );
  assert.equal(DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE, 128);
  assert.deepEqual(unfilteredGeneration.summary, {
    totalPending: 9,
    exactMatchCount: 2,
    reviewableCount: 7,
    filteredManualCount: 7,
    reviewableFoodCount: 2,
  });
  assert.deepEqual(filteredGeneration.summary, {
    totalPending: 9,
    exactMatchCount: 2,
    reviewableCount: 7,
    filteredManualCount: 1,
    reviewableFoodCount: 2,
  });
  assert.deepEqual(
    filteredGeneration.selectedKeys.map((key) => key.id),
    ["priority-1-direct-unicode", "priority-2-duplicate-name-exact", "priority-1-near"],
    "global exact matches must remain selected ahead of correctly DB-filtered manual rows",
  );
  assert.equal(
    unfilteredGeneration.selectedKeys[2]?.id,
    "priority-4-empty",
    "manual visits with calendar titles must retain the UI's global title-first ordering",
  );
  assert.equal(
    filteredGeneration.records.find((record) => record.id === "priority-2-direct")?.hasRestaurantMatches,
    false,
    "the Restaurant Match filter must preserve the UI's suggested-restaurants-array semantics",
  );
  assert.equal(
    createPendingVisitReviewGeneration(
      manifestItems,
      { food: "on", restaurantMatches: "on" },
      tools,
      manifestRow.manifestJson,
    ).generationId,
    filteredGeneration.generationId,
    "the same manifest and filters must produce one deterministic generation",
  );

  const legacyRows = canonicalReviewOrder(
    progressive.prepare(PENDING_VISITS_FOR_REVIEW_SQL).all() as unknown as PendingVisitReviewQueryRow[],
  );
  for (const filters of [
    { food: "off", restaurantMatches: "off" },
    { food: "off", restaurantMatches: "on" },
    { food: "on", restaurantMatches: "off" },
    { food: "on", restaurantMatches: "on" },
  ] as const) {
    const oracle = legacyReviewSelectionOracle(legacyRows, filters, tools);
    const generation = createPendingVisitReviewGeneration(manifestItems, filters, tools, manifestRow.manifestJson);
    assert.deepEqual(
      generation.selectedKeys.map((key) => key.id),
      oracle.selectedIds,
      `${filters.food}/${filters.restaurantMatches} progressive order must match the legacy UI order`,
    );
    assert.deepEqual(
      generation.exactConfirmations,
      oracle.exactConfirmations,
      `${filters.food}/${filters.restaurantMatches} exact confirmation identity must match the legacy query`,
    );
  }

  const duplicateBranchConfirmation = unfilteredGeneration.exactConfirmations.find(
    (confirmation) => confirmation.visitId === "priority-2-duplicate-name-exact",
  );
  assert.deepEqual(duplicateBranchConfirmation, {
    visitId: "priority-2-duplicate-name-exact",
    restaurantId: "michelin-branch-z-near",
    restaurantName: "Twin Branch",
    latitude: 34.9,
    longitude: -118.9,
    calendarTitle: "Dinner at Twin Branch",
    startTime: 6_500,
  });
  const duplicateBranchKey = unfilteredGeneration.selectedKeys.find(
    (key) => key.id === "priority-2-duplicate-name-exact",
  );
  assert.ok(duplicateBranchKey);
  const duplicateBranchPage = progressive
    .prepare(PENDING_VISIT_REVIEW_PAGE_SQL)
    .all(serializePendingVisitReviewPageKeys([duplicateBranchKey])) as unknown as PendingVisitReviewQueryRow[];
  assert.equal(duplicateBranchPage.length, 1);
  const progressiveSuggestionIds = (
    JSON.parse(duplicateBranchPage[0]!.suggestedRestaurantsJson ?? "[]") as LegacyReviewSuggestion[]
  ).map((restaurant) => restaurant.id);
  const legacySuggestionIds = (
    JSON.parse(
      legacyRows.find((row) => row.id === "priority-2-duplicate-name-exact")?.suggestedRestaurantsJson ?? "[]",
    ) as LegacyReviewSuggestion[]
  ).map((restaurant) => restaurant.id);
  assert.deepEqual(progressiveSuggestionIds, ["michelin-branch-z-near", "michelin-branch-a-far"]);
  assert.deepEqual(legacySuggestionIds, progressiveSuggestionIds);

  interface Visit {
    readonly id: string;
  }
  const exactKey = filteredGeneration.selectedKeys[0]!;
  const secondExactKey = filteredGeneration.selectedKeys[1]!;
  const manualKey = filteredGeneration.selectedKeys[2]!;
  const baseline: PendingReviewInfiniteData<Visit> = {
    pageParams: [null, { generationId: filteredGeneration.generationId, keys: [manualKey] }],
    pages: [
      {
        generationId: filteredGeneration.generationId,
        requestedKeys: [exactKey, secondExactKey],
        visits: [{ id: exactKey.id }, { id: secondExactKey.id }],
        manifest: filteredGeneration,
      },
      {
        generationId: filteredGeneration.generationId,
        requestedKeys: [manualKey],
        visits: [{ id: manualKey.id }],
        manifest: null,
      },
    ],
  };
  const afterExactRemoval = removePendingReviewInfiniteVisits(baseline, [exactKey.id]);
  assert.ok(afterExactRemoval);
  assert.deepEqual(
    afterExactRemoval.pages.flatMap((page) => page.visits.map((visit) => visit.id)),
    [secondExactKey.id, manualKey.id],
  );
  assert.deepEqual(afterExactRemoval.pages[0]?.manifest?.summary, {
    totalPending: 8,
    exactMatchCount: 1,
    reviewableCount: 7,
    filteredManualCount: 1,
    reviewableFoodCount: 2,
  });
  const afterIndependentManualRemoval = removePendingReviewInfiniteVisits(afterExactRemoval, [manualKey.id]);
  const restoredExact = restoreFailedPendingReviewInfiniteMutation(afterIndependentManualRemoval, baseline, [
    exactKey.id,
  ]);
  assert.ok(restoredExact);
  assert.deepEqual(
    restoredExact.pages.flatMap((page) => page.visits.map((visit) => visit.id)),
    [exactKey.id, secondExactKey.id],
  );
  assert.deepEqual(
    restoredExact.pages[0]?.manifest?.selectedKeys.map((key) => key.id),
    [exactKey.id, secondExactKey.id],
    "rolling back one page removal must not resurrect an independently successful removal",
  );

  const firstPageOnly: PendingReviewInfiniteData<Visit> = {
    pages: [baseline.pages[0]!],
    pageParams: [null],
  };
  const firstPageAfterRemoval = removePendingReviewInfiniteVisits(firstPageOnly, [exactKey.id]);
  assert.ok(firstPageAfterRemoval);
  assert.deepEqual(
    getNextPendingVisitReviewPageRequest(firstPageAfterRemoval.pages, 1)?.keys,
    [manualKey],
    "an optimistic removal before a page boundary must not skip the next unrequested key",
  );
} finally {
  progressive.close();
}

const malformed = createDatabase();
try {
  seedFocusedFixture(malformed);
  malformed.prepare("UPDATE photos SET foodLabels = ? WHERE id = ?").run("{not-valid-json", "focused-food-a");
  assert.throws(() => malformed.prepare(PENDING_VISITS_FOR_REVIEW_SQL).all(), /malformed JSON/i);
  await assert.rejects(() => executePaged(malformed, 1), /malformed JSON/i);
} finally {
  malformed.close();
}

const failureDatabase = createDatabase();
try {
  seedFocusedFixture(failureDatabase);
  const keys = orderedKeys(failureDatabase);
  const pageStatement = failureDatabase.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
  let calls = 0;
  let exposedResult: PendingVisitReviewQueryRow[] | null = null;
  await assert.rejects(
    hydratePendingVisitReviewPages(
      keys,
      async (serializedKeys) => {
        calls++;
        if (calls === 2) {
          throw new Error("injected later-page failure");
        }
        return pageStatement.all(serializedKeys) as unknown as PendingVisitReviewQueryRow[];
      },
      2,
    ).then((rows) => {
      exposedResult = rows;
      return rows;
    }),
    /injected later-page failure/,
  );
  assert.equal(calls, 2);
  assert.equal(exposedResult, null, "a failed full hydration must not expose its completed earlier page");
  await assert.rejects(
    hydratePendingVisitReviewPages(keys, async () => [], 2),
    /returned 0 rows for 2 keys/,
  );
} finally {
  failureDatabase.close();
}

// A caller-owned read transaction gives all pages one snapshot while a WAL writer commits.
const snapshotDirectory = mkdtempSync(join(tmpdir(), "palate-review-paging-"));
const snapshotPath = join(snapshotDirectory, "fixture.db");
const snapshotReaderSeed = createDatabase(snapshotPath, true, true);
seedFocusedFixture(snapshotReaderSeed);
snapshotReaderSeed.close();
const snapshotReader = new DatabaseSync(snapshotPath);
const snapshotWriter = new DatabaseSync(snapshotPath);
try {
  snapshotReader.exec("PRAGMA query_only = ON; BEGIN");
  const snapshotOracle = canonicalReviewOrder(
    snapshotReader.prepare(PENDING_VISITS_FOR_REVIEW_SQL).all() as unknown as PendingVisitReviewQueryRow[],
  );
  const snapshotKeys = orderedKeys(snapshotReader);
  const snapshotPage = snapshotReader.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
  let snapshotPageCalls = 0;
  const snapshotRows = await hydratePendingVisitReviewPages(
    snapshotKeys,
    async (serializedKeys) => {
      snapshotPageCalls++;
      if (snapshotPageCalls === 2) {
        snapshotWriter.prepare("UPDATE visits SET status = 'confirmed' WHERE id = ?").run("priority-4-empty");
      }
      return snapshotPage.all(serializedKeys) as unknown as PendingVisitReviewQueryRow[];
    },
    2,
  );
  assert.deepEqual(
    snapshotRows,
    snapshotOracle,
    "all pages inside one read transaction must retain its first snapshot",
  );
  snapshotReader.exec("COMMIT");
  assert.equal(
    orderedKeys(snapshotReader).length,
    snapshotKeys.length - 1,
    "the committed writer must appear after the snapshot",
  );
} finally {
  try {
    snapshotReader.exec("ROLLBACK");
  } catch {
    // The successful path already committed.
  }
  snapshotReader.close();
  snapshotWriter.close();
  rmSync(snapshotDirectory, { recursive: true, force: true });
}

console.log(
  "Pending Review paging tests passed: deterministic manifests, global exact/filter counts, progressive cache mutation rollback, one-bind ordered pages, full raw-field parity, boundaries, randomized fixtures, failure isolation, and WAL snapshot consistency.",
);
