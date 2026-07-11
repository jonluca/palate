import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { QueryClient } from "@tanstack/query-core";
import {
  CONFIRMED_RESTAURANTS_QUERY_KEY,
  CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY,
  CONFIRMED_RESTAURANT_SEARCH_SQL,
  filterConfirmedRestaurantSearchRows,
  shouldLoadConfirmedRestaurantSearch,
  type ConfirmedRestaurantSearchRow,
} from "../utils/db/confirmed-restaurant-search-core.ts";

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      googlePlaceId TEXT,
      cuisine TEXT,
      priceLevel INTEGER,
      rating REAL,
      notes TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL,
      startTime REAL NOT NULL,
      updatedAt REAL,
      awardAtVisit TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      visitId TEXT,
      uri TEXT NOT NULL,
      foodDetected INTEGER,
      creationTime REAL NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      award TEXT NOT NULL
    );
    CREATE INDEX idx_visits_restaurant_status_time
      ON visits(restaurantId, status, startTime DESC);
    CREATE INDEX idx_photos_visit_preview
      ON photos(
        visitId,
        (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
        creationTime,
        id
      );
  `);
}

function seedFixture(database: DatabaseSync): void {
  const restaurants = [
    ["google-alpha", "Alpha Café", 37.1, -122.1, "1 Main St", "Californian"],
    ["michelin-alpha", "Alpha Cafe", 37.2, -122.2, "2 Main St", "Modern"],
    ["michelin-elan", "Élan 東京", 48.8, 2.3, null, null],
    ["mapkit-diner", "Night Diner", 40.7, -74.0, "3 Main St", "Diner"],
    ["pending-only", "Pending Place", 1, 2, null, null],
    ["never-visited", "Never Visited", 3, 4, null, null],
  ] as const;
  const insertRestaurant = database.prepare(
    `INSERT INTO restaurants
       (id, name, latitude, longitude, address, cuisine)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const restaurant of restaurants) {
    insertRestaurant.run(...restaurant);
  }

  const visits = [
    ["v-alpha-old", "google-alpha", "confirmed", 100.25, 101, null],
    ["v-alpha-new", "google-alpha", "confirmed", 250.75, 251, "Selected"],
    ["v-alpha-rejected", "google-alpha", "rejected", 999, 999, null],
    ["v-michelin-alpha", "michelin-alpha", "confirmed", 325.125, 326, null],
    ["v-elan", "michelin-elan", "confirmed", 450.5, 451, "Selected"],
    ["v-diner", "mapkit-diner", "confirmed", 375.875, 376, null],
    ["v-pending", "pending-only", "pending", 700, 701, null],
    ["v-null", null, "confirmed", 800, 801, null],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits
       (id, restaurantId, status, startTime, updatedAt, awardAtVisit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const visit of visits) {
    insertVisit.run(...visit);
  }

  const insertAward = database.prepare("INSERT INTO michelin_restaurants (id, award) VALUES (?, ?)");
  insertAward.run("michelin-alpha", "Bib Gourmand");
  insertAward.run("michelin-elan", "1 Star");

  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, visitId, uri, foodDetected, creationTime) VALUES (?, ?, ?, ?, ?)",
  );
  insertPhoto.run("p-alpha-food", "v-alpha-new", "asset://alpha-food", 1, 250);
  insertPhoto.run("p-alpha-other", "v-alpha-old", "asset://alpha-other", 0, 100);
  insertPhoto.run("p-elan", "v-elan", "asset://elan", null, 450);
}

function literalOracle(database: DatabaseSync): ConfirmedRestaurantSearchRow[] {
  const restaurants = database
    .prepare("SELECT id, name, latitude, longitude, address, cuisine FROM restaurants")
    .all() as unknown as Array<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    address: string | null;
    cuisine: string | null;
  }>;
  const visits = database
    .prepare(
      `SELECT id, restaurantId, startTime
       FROM visits
       WHERE status = 'confirmed' AND restaurantId IS NOT NULL`,
    )
    .all() as unknown as Array<{ id: string; restaurantId: string; startTime: number }>;
  const awards = new Map(
    (
      database.prepare("SELECT id, award FROM michelin_restaurants").all() as unknown as Array<{
        id: string;
        award: string;
      }>
    ).map((row) => [row.id, row.award] as const),
  );

  const rows: ConfirmedRestaurantSearchRow[] = [];
  for (const restaurant of restaurants) {
    const confirmedVisits = visits.filter((visit) => visit.restaurantId === restaurant.id);
    if (confirmedVisits.length === 0) {
      continue;
    }
    rows.push({
      ...restaurant,
      visitCount: confirmedVisits.length,
      lastVisit: Math.max(...confirmedVisits.map((visit) => visit.startTime)),
      currentAward: awards.get(restaurant.id) ?? null,
    });
  }
  return rows.sort((left, right) => right.lastVisit - left.lastVisit);
}

const database = new DatabaseSync(":memory:");
try {
  createSchema(database);
  seedFixture(database);

  const projectedRows = database
    .prepare(CONFIRMED_RESTAURANT_SEARCH_SQL)
    .all()
    .map((row) => ({ ...row })) as unknown as ConfirmedRestaurantSearchRow[];
  const oracleRows = literalOracle(database);
  assert.deepEqual(projectedRows, oracleRows);
  assert.deepEqual(
    Object.keys(projectedRows[0]),
    ["id", "name", "latitude", "longitude", "address", "cuisine", "visitCount", "lastVisit", "currentAward"],
    "the bridge projection must not grow beyond fields consumed by the modal plus lastVisit ordering",
  );
  assert.deepEqual(
    projectedRows.map((row) => row.id),
    ["michelin-elan", "mapkit-diner", "michelin-alpha", "google-alpha"],
  );

  assert.equal(shouldLoadConfirmedRestaurantSearch(false, "alpha"), false, "closed modal must not query");
  assert.equal(shouldLoadConfirmedRestaurantSearch(true, ""), false, "open blank modal must not query");
  assert.equal(shouldLoadConfirmedRestaurantSearch(true, " \t "), false, "whitespace must not query");
  assert.equal(shouldLoadConfirmedRestaurantSearch(true, "alpha"), true, "typed search must query");

  assert.deepEqual(
    filterConfirmedRestaurantSearchRows(projectedRows, "ALPHA").map((row) => row.id),
    ["michelin-alpha", "google-alpha"],
    "matching must retain JavaScript lower/includes behavior and database ordering",
  );
  assert.deepEqual(
    filterConfirmedRestaurantSearchRows(projectedRows, "ÉL").map((row) => row.id),
    ["michelin-elan"],
    "non-ASCII matching must remain in JavaScript",
  );
  assert.deepEqual(filterConfirmedRestaurantSearchRows(projectedRows, " alpha "), []);
  assert.deepEqual(filterConfirmedRestaurantSearchRows(projectedRows, "   "), []);

  assert.deepEqual(
    CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY.slice(0, CONFIRMED_RESTAURANTS_QUERY_KEY.length),
    CONFIRMED_RESTAURANTS_QUERY_KEY,
    "search projection must remain a descendant of every confirmed-restaurants invalidation",
  );
  const queryClient = new QueryClient();
  queryClient.setQueryData(CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY, projectedRows);
  await queryClient.invalidateQueries({ queryKey: CONFIRMED_RESTAURANTS_QUERY_KEY });
  assert.equal(
    queryClient.getQueryState(CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY)?.isInvalidated,
    true,
    "TanStack parent-key invalidation must mark the search projection stale",
  );

  const modalSource = readFileSync(new URL("../components/restaurant-search-modal.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
  const databaseSource = readFileSync(new URL("../utils/db/restaurants.ts", import.meta.url), "utf8");
  assert.match(modalSource, /useConfirmedRestaurantSearch\(visible, searchQuery\)/);
  assert.doesNotMatch(modalSource, /useConfirmedRestaurants/);
  assert.match(modalSource, /return sortBySimilarity\(options, sortTerm\)/);
  assert.match(
    modalSource,
    /sortBySimilarity\(replaceSameNameWithMichelin\(options, michelinOptionsByName\), sortTerm\)/,
  );
  assert.match(
    modalSource,
    /sortBySimilarity\(replaceSameNameWithMichelin\(filtered, michelinOptionsByName\), sortTerm\)/,
  );
  assert.match(hookSource, /enabled: shouldLoadConfirmedRestaurantSearch\(visible, searchQuery\)/);
  assert.match(databaseSource, /getAllAsync<ConfirmedRestaurantSearchRow>\(CONFIRMED_RESTAURANT_SEARCH_SQL\)/);

  console.log("confirmed restaurant search projection tests passed");
} finally {
  database.close();
}
