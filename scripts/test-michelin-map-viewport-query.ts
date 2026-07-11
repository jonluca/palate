#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildMichelinMapViewportQuery,
  finalizeMichelinMapViewportRows,
  selectMichelinMapViewport,
  type MichelinMapAwardFilter,
  type MichelinMapViewportQueryPlan,
  type MichelinMapViewportQueryRow,
  type MichelinMapViewportRequest,
  type MichelinMapViewportRestaurant,
  type MichelinMapViewportSelection,
  type MichelinMapVisitStatusFilter,
} from "../utils/db/michelin-map-viewport-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

const ACTIVE_DATASET_VERSION = "guide-current";
const MAX_MERCATOR_LATITUDE = 85.05112878;
const DEFAULT_MAXIMUM_RESULTS = 500;

interface FixtureRestaurant extends MichelinRestaurantRecord {
  readonly datasetVersion: string | null;
  readonly sourceOrder: number;
}

interface FixtureDefinition extends MichelinRestaurantRecord {
  readonly datasetVersion?: string | null;
}

interface FixtureVisit {
  readonly restaurantId: string;
  readonly status: "pending" | "confirmed" | "rejected";
}

interface ViewportBounds {
  readonly minimumLatitude: number;
  readonly maximumLatitude: number;
  readonly minimumLongitude: number;
  readonly maximumLongitude: number;
  readonly wrapsDateLine: boolean;
}

interface OracleCandidate {
  readonly restaurant: FixtureRestaurant;
  readonly visited: boolean;
  readonly centerDistanceScore: number;
}

interface DatabaseSnapshot {
  readonly restaurants: unknown[];
  readonly appMetadata: unknown[];
  readonly confirmedRestaurants: unknown[];
  readonly visits: unknown[];
  readonly spatialIndex: unknown[];
  readonly totalChanges: number;
}

function fixtureRestaurant(
  id: string,
  latitude: number,
  longitude: number,
  overrides: Partial<Omit<FixtureDefinition, "id" | "latitude" | "longitude">> = {},
): FixtureDefinition {
  return {
    id,
    name: overrides.name ?? id,
    latitude,
    longitude,
    address: overrides.address ?? `Address ${id}`,
    location: overrides.location ?? `Location ${id}`,
    cuisine: overrides.cuisine ?? `Cuisine ${id}`,
    latestAwardYear: overrides.latestAwardYear === undefined ? 2026 : overrides.latestAwardYear,
    award: overrides.award ?? "Selected",
    datasetVersion: overrides.datasetVersion === undefined ? ACTIVE_DATASET_VERSION : overrides.datasetVersion,
  };
}

function cloneRequest(request: MichelinMapViewportRequest): MichelinMapViewportRequest {
  return {
    ...request,
    camera: { ...request.camera },
  };
}

function worldRequest(
  overrides: Partial<Omit<MichelinMapViewportRequest, "camera">> & {
    readonly camera?: Partial<MichelinMapViewportRequest["camera"]>;
  } = {},
): MichelinMapViewportRequest {
  return {
    camera: {
      latitude: overrides.camera?.latitude ?? 0,
      longitude: overrides.camera?.longitude ?? 0,
      zoom: overrides.camera?.zoom ?? 0,
    },
    width: overrides.width ?? 512,
    height: overrides.height ?? 512,
    minimumAwardYear: overrides.minimumAwardYear ?? 2024,
    visitStatusFilter: overrides.visitStatusFilter ?? "all",
    awardFilter: overrides.awardFilter ?? "all",
    ...(overrides.maximumResults === undefined ? {} : { maximumResults: overrides.maximumResults }),
  };
}

function clampLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function mercatorScale(zoom: number): number {
  return 256 * Math.pow(2, Math.max(0, zoom));
}

function longitudeToPixelX(longitude: number, zoom: number): number {
  return ((normalizeLongitude(longitude) + 180) / 360) * mercatorScale(zoom);
}

function latitudeToPixelY(latitude: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const sine = Math.sin((clampLatitude(latitude) * Math.PI) / 180);
  return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale;
}

function pixelXToLongitude(pixelX: number, zoom: number): number {
  return normalizeLongitude((pixelX / mercatorScale(zoom)) * 360 - 180);
}

function pixelYToLatitude(pixelY: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const n = Math.PI - (2 * Math.PI * pixelY) / scale;
  return clampLatitude((180 / Math.PI) * Math.atan(Math.sinh(n)));
}

function literalViewportBounds(request: MichelinMapViewportRequest): ViewportBounds | null {
  if (!request.width || !request.height) {
    return null;
  }
  const zoom = Math.max(0, request.camera.zoom);
  const scale = mercatorScale(zoom);
  const centerX = longitudeToPixelX(request.camera.longitude, zoom);
  const centerY = latitudeToPixelY(request.camera.latitude, zoom);
  const minimumX = centerX - request.width / 2;
  const maximumX = centerX + request.width / 2;
  const minimumY = centerY - request.height / 2;
  const maximumY = centerY + request.height / 2;
  const latitudeCoversWorld = request.height >= scale;
  const longitudeCoversWorld = request.width >= scale;
  const latitudeA = latitudeCoversWorld
    ? -MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, maximumY)), zoom);
  const latitudeB = latitudeCoversWorld
    ? MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, minimumY)), zoom);
  const minimumLongitude = longitudeCoversWorld ? -180 : pixelXToLongitude(minimumX, zoom);
  const maximumLongitude = longitudeCoversWorld ? 180 : pixelXToLongitude(maximumX, zoom);
  return {
    minimumLatitude: Math.min(latitudeA, latitudeB),
    maximumLatitude: Math.max(latitudeA, latitudeB),
    minimumLongitude,
    maximumLongitude,
    wrapsDateLine: !longitudeCoversWorld && minimumLongitude > maximumLongitude,
  };
}

function hasValidCoordinate(restaurant: FixtureRestaurant): boolean {
  return (
    Number.isFinite(restaurant.latitude) &&
    restaurant.latitude >= -90 &&
    restaurant.latitude <= 90 &&
    Number.isFinite(restaurant.longitude) &&
    restaurant.longitude >= -180 &&
    restaurant.longitude <= 180
  );
}

function isInBounds(restaurant: FixtureRestaurant, bounds: ViewportBounds): boolean {
  if (restaurant.latitude < bounds.minimumLatitude || restaurant.latitude > bounds.maximumLatitude) {
    return false;
  }
  return bounds.wrapsDateLine
    ? restaurant.longitude >= bounds.minimumLongitude || restaurant.longitude <= bounds.maximumLongitude
    : restaurant.longitude >= bounds.minimumLongitude && restaurant.longitude <= bounds.maximumLongitude;
}

function awardStarCount(award: string): number {
  const lower = award.toLowerCase();
  if (lower.includes("3 stars") || lower.includes("3 star")) {
    return 3;
  }
  if (lower.includes("2 stars") || lower.includes("2 star")) {
    return 2;
  }
  if (lower.includes("1 star")) {
    return 1;
  }
  return 0;
}

function awardMatches(award: string, filter: MichelinMapAwardFilter): boolean {
  switch (filter) {
    case "1star":
      return awardStarCount(award) === 1;
    case "2star":
      return awardStarCount(award) === 2;
    case "3star":
      return awardStarCount(award) === 3;
    case "bib":
      return award.toLowerCase().includes("bib gourmand");
    case "selected":
      return award.toLowerCase().includes("selected");
    case "green":
      return award.toLowerCase().includes("green star");
    case "all":
      return true;
  }
}

function awardPriority(award: string): number {
  const lower = award.toLowerCase();
  let priority =
    lower.includes("3 stars") || lower.includes("3 star")
      ? 300
      : lower.includes("2 stars") || lower.includes("2 star")
        ? 200
        : lower.includes("1 star")
          ? 100
          : lower.includes("bib gourmand")
            ? 60
            : lower.includes("selected")
              ? 30
              : 0;
  if (lower.includes("green star")) {
    priority += 10;
  }
  return priority;
}

function centerDistanceScore(restaurant: FixtureRestaurant, request: MichelinMapViewportRequest): number {
  const zoom = Math.max(0, request.camera.zoom);
  const scale = mercatorScale(zoom);
  const centerX = longitudeToPixelX(request.camera.longitude, zoom);
  const centerY = latitudeToPixelY(request.camera.latitude, zoom);
  const restaurantX = longitudeToPixelX(restaurant.longitude, zoom);
  const restaurantY = latitudeToPixelY(restaurant.latitude, zoom);
  let deltaX = Math.abs(restaurantX - centerX);
  deltaX = Math.min(deltaX, scale - deltaX);
  const deltaY = restaurantY - centerY;
  return deltaX * deltaX + deltaY * deltaY;
}

function toViewportRestaurant(restaurant: FixtureRestaurant, visited: boolean): MichelinMapViewportRestaurant {
  return {
    id: restaurant.id,
    name: restaurant.name,
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    address: restaurant.address,
    location: restaurant.location,
    cuisine: restaurant.cuisine,
    latestAwardYear: restaurant.latestAwardYear,
    award: restaurant.award,
    visited,
  };
}

/** Literal copy of the removed map filter, exhaustive bounds scan, full stable sort, and top-K truncation. */
function selectWithLiteralOracle(
  restaurants: readonly FixtureRestaurant[],
  visits: readonly FixtureVisit[],
  activeDatasetVersion: string | null,
  request: MichelinMapViewportRequest,
): MichelinMapViewportSelection {
  const bounds = literalViewportBounds(request);
  if (!bounds) {
    return { restaurants: [], totalInView: 0, nativeCandidateRows: 0 };
  }
  const confirmedRestaurantIds = new Set(
    visits.filter((visit) => visit.status === "confirmed").map((visit) => visit.restaurantId),
  );
  const candidates: OracleCandidate[] = [];
  for (const restaurant of restaurants) {
    if (activeDatasetVersion !== null && restaurant.datasetVersion !== activeDatasetVersion) {
      continue;
    }
    const visited = confirmedRestaurantIds.has(restaurant.id);
    if (request.visitStatusFilter === "visited" && !visited) {
      continue;
    }
    if (request.visitStatusFilter === "unvisited" && visited) {
      continue;
    }
    if (typeof restaurant.latestAwardYear !== "number" || restaurant.latestAwardYear < request.minimumAwardYear) {
      continue;
    }
    if (!awardMatches(restaurant.award, request.awardFilter)) {
      continue;
    }
    if (!hasValidCoordinate(restaurant) || !isInBounds(restaurant, bounds)) {
      continue;
    }
    candidates.push({ restaurant, visited, centerDistanceScore: centerDistanceScore(restaurant, request) });
  }
  candidates.sort((left, right) => {
    const distanceDifference = left.centerDistanceScore - right.centerDistanceScore;
    if (distanceDifference !== 0) {
      return distanceDifference;
    }
    const awardDifference = awardPriority(right.restaurant.award) - awardPriority(left.restaurant.award);
    if (awardDifference !== 0) {
      return awardDifference;
    }
    const visitedDifference = Number(right.visited) - Number(left.visited);
    if (visitedDifference !== 0) {
      return visitedDifference;
    }
    const nameDifference = left.restaurant.name.localeCompare(right.restaurant.name);
    return nameDifference !== 0 ? nameDifference : left.restaurant.sourceOrder - right.restaurant.sourceOrder;
  });
  const maximumResults = request.maximumResults ?? DEFAULT_MAXIMUM_RESULTS;
  return {
    restaurants: candidates
      .slice(0, maximumResults)
      .map(({ restaurant, visited }) => toViewportRestaurant(restaurant, visited)),
    totalInView: candidates.length,
    // The removed implementation had no native candidate count. Tests compare
    // this field separately against the bounded-query invariants.
    nativeCandidateRows: 0,
  };
}

function numericValue(database: DatabaseSync, source: string): number {
  const row = database.prepare(source).get() as { readonly value: number } | undefined;
  assert.ok(row && Number.isSafeInteger(row.value));
  return row.value;
}

function snapshotDatabase(database: DatabaseSync): DatabaseSnapshot {
  return {
    restaurants: database.prepare("SELECT rowid, * FROM michelin_restaurants ORDER BY rowid").all(),
    appMetadata: database.prepare("SELECT * FROM app_metadata ORDER BY key").all(),
    confirmedRestaurants: database.prepare("SELECT * FROM restaurants ORDER BY id").all(),
    visits: database.prepare("SELECT * FROM visits ORDER BY id").all(),
    spatialIndex: database
      .prepare(
        `SELECT restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude
         FROM michelin_restaurant_spatial_index ORDER BY restaurantRowId`,
      )
      .all(),
    totalChanges: numericValue(database, "SELECT total_changes() AS value"),
  };
}

class TestDatabase {
  readonly database: DatabaseSync;
  readonly restaurants: readonly FixtureRestaurant[];
  readonly visits: readonly FixtureVisit[];
  readonly activeDatasetVersion: string | null;
  queryCalls = 0;
  readTransactionCalls = 0;

  private readonly sourceSnapshot: DatabaseSnapshot;

  constructor(
    definitions: readonly FixtureDefinition[],
    visits: readonly FixtureVisit[] = [],
    activeDatasetVersion: string | null = ACTIVE_DATASET_VERSION,
  ) {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(`
      PRAGMA foreign_keys = ON;
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
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE restaurants (id TEXT PRIMARY KEY);
      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        restaurantId TEXT,
        status TEXT NOT NULL,
        FOREIGN KEY (restaurantId) REFERENCES restaurants(id)
      );
      CREATE VIRTUAL TABLE michelin_restaurant_spatial_index USING rtree(
        restaurantRowId,
        minimumLatitude,
        maximumLatitude,
        minimumLongitude,
        maximumLongitude
      );
    `);
    const insertRestaurant = this.database.prepare(
      `INSERT INTO michelin_restaurants
       (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted: FixtureRestaurant[] = [];
    this.database.exec("BEGIN");
    try {
      for (const definition of definitions) {
        const result = insertRestaurant.run(
          definition.id,
          definition.name,
          definition.latitude,
          definition.longitude,
          definition.address,
          definition.location,
          definition.cuisine,
          definition.latestAwardYear,
          definition.award,
          definition.datasetVersion ?? null,
        );
        const sourceOrder = Number(result.lastInsertRowid);
        assert.ok(Number.isSafeInteger(sourceOrder) && sourceOrder > 0);
        inserted.push({ ...definition, datasetVersion: definition.datasetVersion ?? null, sourceOrder });
      }
      if (activeDatasetVersion !== null) {
        this.database
          .prepare("INSERT INTO app_metadata (key, value) VALUES ('michelin_dataset_version', ?)")
          .run(activeDatasetVersion);
      }
      const restaurantIds = new Set(visits.map((visit) => visit.restaurantId));
      const insertConfirmedRestaurant = this.database.prepare("INSERT INTO restaurants (id) VALUES (?)");
      for (const restaurantId of restaurantIds) {
        insertConfirmedRestaurant.run(restaurantId);
      }
      const insertVisit = this.database.prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, ?)");
      for (const [index, visit] of visits.entries()) {
        insertVisit.run(`visit-${index}`, visit.restaurantId, visit.status);
      }
      this.database.exec(`
        INSERT INTO michelin_restaurant_spatial_index
          (restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude)
        SELECT rowid, latitude, latitude, longitude, longitude
        FROM michelin_restaurants
        WHERE latitude BETWEEN -90.0 AND 90.0
          AND longitude BETWEEN -180.0 AND 180.0
          AND NOT (latitude = 0.0 AND longitude = 0.0);
        COMMIT;
      `);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.restaurants = inserted;
    this.visits = visits.map((visit) => ({ ...visit }));
    this.activeDatasetVersion = activeDatasetVersion;
    this.sourceSnapshot = snapshotDatabase(this.database);
    this.database.exec("PRAGMA query_only = ON");
  }

  async getAllAsync<T>(source: string, parameters: readonly (number | string)[]): Promise<T[]> {
    this.queryCalls += 1;
    assert.match(source.trimStart(), /^WITH\b/i, "viewport execution must remain one read-only CTE query");
    assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i);
    return this.database.prepare(source).all(...parameters) as T[];
  }

  async withReadTransaction<T>(task: (transaction: TestDatabase) => Promise<T>): Promise<T> {
    this.readTransactionCalls += 1;
    this.database.exec("BEGIN");
    try {
      const result = await task(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  assertUnchanged(): void {
    assert.deepEqual(
      snapshotDatabase(this.database),
      this.sourceSnapshot,
      "viewport reads must not mutate source tables",
    );
  }

  close(): void {
    this.assertUnchanged();
    this.database.close();
  }
}

async function assertSelectionMatchesOracle(
  fixture: TestDatabase,
  request: MichelinMapViewportRequest,
): Promise<MichelinMapViewportSelection> {
  const requestBefore = cloneRequest(request);
  const restaurantsBefore = structuredClone(fixture.restaurants);
  const visitsBefore = structuredClone(fixture.visits);
  const expected = selectWithLiteralOracle(fixture.restaurants, fixture.visits, fixture.activeDatasetVersion, request);
  const actual = await selectMichelinMapViewport(fixture, request);
  assert.deepEqual(actual.restaurants, expected.restaurants, "native query must preserve every field and exact order");
  assert.equal(actual.totalInView, expected.totalInView);
  assert.ok(actual.nativeCandidateRows >= actual.restaurants.length);
  assert.ok(actual.nativeCandidateRows <= actual.totalInView);
  assert.deepEqual(request, requestBefore, "selection must not mutate the request");
  assert.deepEqual(fixture.restaurants, restaurantsBefore, "selection must not mutate source restaurants");
  assert.deepEqual(fixture.visits, visitsBefore, "selection must not mutate source visits");
  fixture.assertUnchanged();
  return actual;
}

const filterRestaurants = [
  fixtureRestaurant("active-1star", 1, 1, { award: "1 Star", latestAwardYear: 2026 }),
  fixtureRestaurant("active-2star", 2, 2, { award: "2 Stars", latestAwardYear: 2025 }),
  fixtureRestaurant("active-3green", 3, 3, { award: "3 Stars, Green Star", latestAwardYear: 2026 }),
  fixtureRestaurant("active-bib", 4, 4, { award: "Bib Gourmand", latestAwardYear: 2024 }),
  fixtureRestaurant("active-selected", 5, 5, { award: "Selected", latestAwardYear: 2024 }),
  fixtureRestaurant("active-green", 6, 6, { award: "Green Star", latestAwardYear: 2025 }),
  fixtureRestaurant("active-unlisted", 7, 7, { award: "Recommended", latestAwardYear: 2026 }),
  fixtureRestaurant("active-old", 8, 8, { award: "3 Stars", latestAwardYear: 2023 }),
  fixtureRestaurant("active-null-year", 9, 9, { award: "Selected", latestAwardYear: null }),
  fixtureRestaurant("historical-current-year", 10, 10, {
    award: "3 Stars",
    latestAwardYear: 2026,
    datasetVersion: "guide-historical",
  }),
] as const;
const filterVisits: FixtureVisit[] = [
  { restaurantId: "active-1star", status: "confirmed" },
  { restaurantId: "active-3green", status: "confirmed" },
  { restaurantId: "active-selected", status: "confirmed" },
  { restaurantId: "active-2star", status: "rejected" },
  { restaurantId: "historical-current-year", status: "confirmed" },
];
const visitFilters: MichelinMapVisitStatusFilter[] = ["visited", "unvisited", "all"];
const awardFilters: MichelinMapAwardFilter[] = ["all", "1star", "2star", "3star", "bib", "selected", "green"];

const activeFilterFixture = new TestDatabase(filterRestaurants, filterVisits);
try {
  for (const visitStatusFilter of visitFilters) {
    for (const awardFilter of awardFilters) {
      await assertSelectionMatchesOracle(
        activeFilterFixture,
        worldRequest({ visitStatusFilter, awardFilter, minimumAwardYear: 2024 }),
      );
    }
  }
  const allActive = await assertSelectionMatchesOracle(activeFilterFixture, worldRequest());
  assert.ok(
    allActive.restaurants.some(({ id }) => id === "active-bib"),
    "minimum award year must be inclusive",
  );
  assert.equal(
    allActive.restaurants.some(({ id }) => id === "active-old"),
    false,
  );
  assert.equal(
    allActive.restaurants.some(({ id }) => id === "active-null-year"),
    false,
  );
  assert.equal(
    allActive.restaurants.some(({ id }) => id === "historical-current-year"),
    false,
  );
} finally {
  activeFilterFixture.close();
}

const historicalFallbackFixture = new TestDatabase(filterRestaurants, filterVisits, null);
try {
  const fallback = await assertSelectionMatchesOracle(historicalFallbackFixture, worldRequest());
  assert.ok(
    fallback.restaurants.some(({ id }) => id === "historical-current-year"),
    "without dataset metadata, historical rows retain legacy visibility",
  );
} finally {
  historicalFallbackFixture.close();
}

const inclusiveLatitude = 11.178401873711794;
const geometryRestaurants = [
  fixtureRestaurant("origin", 0, 0),
  fixtureRestaurant("minimum-latitude", -inclusiveLatitude, 0),
  fixtureRestaurant("maximum-latitude", inclusiveLatitude, 0),
  fixtureRestaurant("minimum-longitude", 0, -11.25),
  fixtureRestaurant("maximum-longitude", 0, 11.25),
  fixtureRestaurant("outside-latitude", inclusiveLatitude + 1e-9, 0),
  fixtureRestaurant("outside-longitude", 0, 11.25 + 1e-9),
  fixtureRestaurant("date-east", 0, 179.9),
  fixtureRestaurant("date-west", 0, -179.9),
  fixtureRestaurant("date-east-edge", 0, 168.25),
  fixtureRestaurant("date-west-edge", 0, -169.25),
  fixtureRestaurant("west-meridian", 0, -180),
  fixtureRestaurant("east-meridian", 0, 180),
  fixtureRestaurant("north", 85, 0),
  fixtureRestaurant("south", -85, 0),
  fixtureRestaurant("outside-mercator", 86, 0),
  fixtureRestaurant("invalid-latitude", 91, 0),
  fixtureRestaurant("invalid-longitude", 0, 181),
] as const;
const geometryFixture = new TestDatabase(geometryRestaurants);
try {
  const callsBeforeZeroViewport = geometryFixture.queryCalls;
  for (const request of [worldRequest({ width: 0 }), worldRequest({ height: 0 }), worldRequest({ width: -1 })]) {
    assert.deepEqual(await selectMichelinMapViewport(geometryFixture, request), {
      restaurants: [],
      totalInView: 0,
      nativeCandidateRows: 0,
    });
  }
  assert.equal(geometryFixture.queryCalls, callsBeforeZeroViewport, "empty viewports must not execute SQLite");

  const inclusiveRequest = worldRequest({
    camera: { latitude: 0, longitude: 0, zoom: 5 },
    width: 512,
    height: 512,
  });
  const inclusive = await assertSelectionMatchesOracle(geometryFixture, inclusiveRequest);
  assert.deepEqual(
    new Set(inclusive.restaurants.map(({ id }) => id)),
    new Set(["origin", "minimum-latitude", "maximum-latitude", "minimum-longitude", "maximum-longitude"]),
  );

  const antimeridianRequest = worldRequest({
    camera: { latitude: 0, longitude: 179.5, zoom: 5 },
    width: 512,
    height: 400,
  });
  const antimeridian = await assertSelectionMatchesOracle(geometryFixture, antimeridianRequest);
  assert.deepEqual(
    new Set(antimeridian.restaurants.map(({ id }) => id)),
    new Set(["date-east", "date-west", "date-east-edge", "date-west-edge", "west-meridian", "east-meridian"]),
  );

  const world = await assertSelectionMatchesOracle(geometryFixture, worldRequest({ minimumAwardYear: 2024 }));
  const worldIds = new Set(world.restaurants.map(({ id }) => id));
  assert.ok(worldIds.has("origin"), "0,0 is a valid map coordinate even though it is omitted from the R-Tree");
  assert.ok(worldIds.has("west-meridian") && worldIds.has("east-meridian"));
  for (const excluded of ["outside-mercator", "invalid-latitude", "invalid-longitude"]) {
    assert.equal(worldIds.has(excluded), false);
  }
} finally {
  geometryFixture.close();
}

const overscanDefinitions = Array.from({ length: 540 }, (_, index) =>
  fixtureRestaurant(`overscan-${index.toString().padStart(3, "0")}`, 0, index * 0.001, {
    name: `Overscan ${index}`,
    award: "Selected",
  }),
);
const overscanFixture = new TestDatabase(overscanDefinitions);
try {
  const overscanSelection = await assertSelectionMatchesOracle(overscanFixture, worldRequest());
  assert.equal(overscanSelection.totalInView, overscanDefinitions.length);
  assert.equal(overscanSelection.restaurants.length, DEFAULT_MAXIMUM_RESULTS);
  assert.equal(
    overscanSelection.nativeCandidateRows,
    DEFAULT_MAXIMUM_RESULTS + 32,
    "the ordinary non-tie path must retain the full native ranking cushion for JavaScript finalization",
  );
  assert.equal(overscanFixture.queryCalls, 1);
  assert.equal(overscanFixture.readTransactionCalls, 0);
} finally {
  overscanFixture.close();
}

const completeTieDefinitions: FixtureDefinition[] = [];
for (let index = 0; index < 520; index++) {
  completeTieDefinitions.push(
    fixtureRestaurant(`complete-${index.toString().padStart(3, "0")}`, 0, 0, {
      name: "Complete 🍣 Tie",
      award: "Selected",
    }),
  );
}
for (const [index, name] of [
  "Ångström",
  "Äther",
  "Éclair",
  "東京",
  "Zulu",
  "Alpha",
  "éclair",
  "Ωmega",
  "Ångström",
  "東京",
].entries()) {
  completeTieDefinitions.push(
    fixtureRestaurant(`unicode-${index.toString().padStart(2, "0")}`, 0, 0, { name, award: "Selected" }),
  );
}
const tieFixture = new TestDatabase(completeTieDefinitions);
try {
  const tieRequest = worldRequest({
    camera: { latitude: 0, longitude: 0, zoom: 12 },
    width: 500,
    height: 500,
  });
  const ties = await assertSelectionMatchesOracle(tieFixture, tieRequest);
  assert.equal(ties.totalInView, completeTieDefinitions.length);
  assert.equal(ties.restaurants.length, DEFAULT_MAXIMUM_RESULTS);
  assert.equal(
    ties.nativeCandidateRows,
    completeTieDefinitions.length,
    "the native prefix must retain the complete score group crossing the top-500 boundary",
  );
  assert.equal(tieFixture.readTransactionCalls, 1, "a boundary tie must expand inside one read transaction");
  assert.equal(tieFixture.queryCalls, 3, "a tie reruns its prefix and expansion on one stable snapshot");
  const returnedCompleteTieIds = ties.restaurants.filter(({ name }) => name === "Complete 🍣 Tie").map(({ id }) => id);
  const insertionOrderedCompleteTieIds = completeTieDefinitions
    .filter(({ name }) => name === "Complete 🍣 Tie")
    .map(({ id }) => id)
    .filter((id) => returnedCompleteTieIds.includes(id));
  assert.deepEqual(
    returnedCompleteTieIds,
    insertionOrderedCompleteTieIds,
    "final name ties must preserve source order",
  );

  const bounded = await assertSelectionMatchesOracle(tieFixture, { ...tieRequest, maximumResults: 7 });
  assert.equal(bounded.restaurants.length, 7);
  assert.equal(bounded.totalInView, completeTieDefinitions.length);
  assert.equal(tieFixture.readTransactionCalls, 2);
  assert.equal(tieFixture.queryCalls, 6);
} finally {
  tieFixture.close();
}

const parserRequest = worldRequest({ maximumResults: 2 });
const parserPlan = buildMichelinMapViewportQuery(parserRequest);
assert.ok(parserPlan);
const validRow = (overrides: Partial<MichelinMapViewportQueryRow> = {}): MichelinMapViewportQueryRow => ({
  sourceOrder: 1,
  id: "valid",
  name: "Valid",
  latitude: 0,
  longitude: 0,
  address: "Valid address",
  location: "Valid location",
  cuisine: "Valid cuisine",
  latestAwardYear: 2026,
  award: "Selected",
  visited: 0,
  totalInView: 1,
  centerDistanceScore: 0,
  awardPriority: 30,
  ...overrides,
});

assert.deepEqual(finalizeMichelinMapViewportRows([], parserPlan), {
  restaurants: [],
  totalInView: 0,
  nativeCandidateRows: 0,
});
for (const sourceOrder of [0, -1, 1.5, Number.NaN]) {
  assert.throws(() => finalizeMichelinMapViewportRows([validRow({ sourceOrder })], parserPlan), /invalid sourceOrder/);
}
for (const visited of [-1, 2, 0.5]) {
  assert.throws(() => finalizeMichelinMapViewportRows([validRow({ visited })], parserPlan), /invalid visited flag/);
}
for (const totalInView of [-1, 0, 1.5, Number.NaN]) {
  assert.throws(() => finalizeMichelinMapViewportRows([validRow({ totalInView })], parserPlan), /invalid totalInView/);
}
assert.throws(
  () =>
    finalizeMichelinMapViewportRows(
      [validRow({ totalInView: 2 }), validRow({ id: "duplicate", totalInView: 2 })],
      parserPlan,
    ),
  /duplicate sourceOrder/,
);
assert.throws(
  () =>
    finalizeMichelinMapViewportRows(
      [validRow({ totalInView: 2 }), validRow({ sourceOrder: 2, id: "second", totalInView: 3 })],
      parserPlan,
    ),
  /inconsistent totalInView/,
);
const frozenRows = [Object.freeze(validRow())] as const;
const frozenRowsBefore = structuredClone(frozenRows);
finalizeMichelinMapViewportRows(frozenRows, parserPlan);
assert.deepEqual(frozenRows, frozenRowsBefore, "row finalization must not mutate native query rows");

const finiteRequest = worldRequest();
for (const [field, request] of [
  ["camera.latitude", { ...finiteRequest, camera: { ...finiteRequest.camera, latitude: Number.NaN } }],
  ["camera.longitude", { ...finiteRequest, camera: { ...finiteRequest.camera, longitude: Number.POSITIVE_INFINITY } }],
  ["camera.zoom", { ...finiteRequest, camera: { ...finiteRequest.camera, zoom: Number.NEGATIVE_INFINITY } }],
  ["width", { ...finiteRequest, width: Number.NaN }],
  ["height", { ...finiteRequest, height: Number.POSITIVE_INFINITY }],
] as const) {
  assert.throws(() => buildMichelinMapViewportQuery(request), new RegExp(field.replace(".", "\\.")));
}
for (const minimumAwardYear of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => buildMichelinMapViewportQuery({ ...finiteRequest, minimumAwardYear }), /minimumAwardYear/);
}
assert.throws(
  () =>
    buildMichelinMapViewportQuery({
      ...finiteRequest,
      camera: { ...finiteRequest.camera, zoom: Number.MAX_VALUE },
    }),
  /Mercator scale/,
);
for (const maximumResults of [0, -1, 1.5, DEFAULT_MAXIMUM_RESULTS + 1]) {
  assert.throws(() => buildMichelinMapViewportQuery({ ...finiteRequest, maximumResults }), /maximumResults/);
}

const validPlan: MichelinMapViewportQueryPlan | null = buildMichelinMapViewportQuery(finiteRequest);
assert.ok(validPlan);
assert.equal(validPlan.parameters.length, 9);
assert.equal(validPlan.parameters.at(-1), DEFAULT_MAXIMUM_RESULTS + 32);
assert.equal(validPlan.maximumResults, DEFAULT_MAXIMUM_RESULTS);
assert.deepEqual(validPlan.request, finiteRequest);

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "Michelin map viewport native query",
      assertions: {
        activeAndHistoricalDatasetSemantics: true,
        everyVisitAndAwardFilterCombination: true,
        inclusiveAwardRecency: true,
        zeroWorldInclusiveAndAntimeridianViewports: true,
        invalidAndOriginCoordinates: true,
        exactFullFieldAndOrderParity: true,
        rankingOverscanReachesExactOracle: true,
        unicodeNameAndSourceOrderTiesBeyondFiveHundred: true,
        malformedNativeRowGuards: true,
        emptyResults: true,
        requestAndSourceImmutability: true,
        zeroDatabaseWrites: true,
      },
    },
    null,
    2,
  ),
);
