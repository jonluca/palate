#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { RestaurantViewportIndex, type RestaurantViewportEntry } from "../utils/restaurant-viewport-index.ts";

interface Configuration {
  readonly samples: number;
  readonly warmupIterations: number;
  readonly traceRepetitions: number;
  readonly minimumAwardYear: number | null;
}

interface CameraSnapshot {
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
}

interface ViewportQuery {
  readonly label: string;
  readonly camera: CameraSnapshot;
  readonly width: number;
  readonly height: number;
}

interface ViewportBounds {
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly wrapsDateLine: boolean;
}

interface MapRestaurant {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly award: string;
  readonly latestAwardYear: number | null;
  readonly visited: boolean;
}

interface DatabaseRestaurantRow {
  readonly id: number;
  readonly name: string | null;
  readonly latitude: string;
  readonly longitude: string;
  readonly latest_distinction: string | null;
  readonly latest_year: number | null;
  readonly has_green_star: number | null;
}

interface Dataset {
  readonly restaurants: MapRestaurant[];
  readonly databaseRows: number;
  readonly validCoordinateRows: number;
  readonly latestAwardYear: number;
  readonly minimumAwardYear: number;
  readonly simulatedVisitedRows: number;
}

interface ViewportSelection {
  readonly ids: string[];
  readonly totalInView: number;
}

interface ReferenceCandidate {
  readonly restaurant: MapRestaurant;
  readonly centerDistanceScore: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly resultGuard: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface CorrectnessSummary {
  readonly checksum: string;
  readonly selectedResults: number;
  readonly totalCandidates: number;
}

const MAX_RESTAURANTS_IN_VIEW = 500;
const SYNTHETIC_VISITED_MODULUS = 29;
const DEFAULT_CONFIGURATION: Configuration = {
  samples: 20,
  warmupIterations: 2,
  traceRepetitions: 4,
  minimumAwardYear: null,
};

const EDGE_CASE_NAMES = [
  "zero-sized viewport",
  "inclusive latitude and longitude bounds",
  "whole-world viewport bounds",
  "antimeridian-wrapping viewport",
  "distance, award, visited, and name ranking",
  "stable top-500 truncation for complete ties",
] as const;

// A fixed camera-event trace representative of a macOS Designed-for-iPhone/iPad
// map session. Keeping every event literal makes runs and result checksums repeatable.
const REPRESENTATIVE_CAMERA_TRACE: readonly ViewportQuery[] = [
  { label: "launch-world", camera: { latitude: 20, longitude: 0, zoom: 2.5 }, width: 1180, height: 720 },
  { label: "world-pan-1", camera: { latitude: 22.4, longitude: -8.5, zoom: 2.62 }, width: 1180, height: 720 },
  { label: "world-pan-2", camera: { latitude: 26.8, longitude: -20.25, zoom: 2.82 }, width: 1180, height: 720 },
  { label: "atlantic", camera: { latitude: 35.2, longitude: -38.1, zoom: 3.15 }, width: 1180, height: 720 },
  { label: "north-america", camera: { latitude: 39.3, longitude: -98.4, zoom: 4.1 }, width: 1180, height: 720 },
  { label: "california", camera: { latitude: 37.9, longitude: -121.4, zoom: 5.8 }, width: 1180, height: 720 },
  { label: "bay-area-wide", camera: { latitude: 37.7749, longitude: -122.4194, zoom: 7.1 }, width: 1180, height: 720 },
  { label: "san-francisco", camera: { latitude: 37.7749, longitude: -122.4194, zoom: 10.2 }, width: 1180, height: 720 },
  {
    label: "san-francisco-pan",
    camera: { latitude: 37.7924, longitude: -122.3971, zoom: 11.35 },
    width: 1180,
    height: 720,
  },
  {
    label: "san-francisco-mobile",
    camera: { latitude: 37.784, longitude: -122.4075, zoom: 12.1 },
    width: 390,
    height: 700,
  },
  { label: "continental-pan", camera: { latitude: 40.5, longitude: -95.2, zoom: 4.8 }, width: 1180, height: 720 },
  { label: "new-york-wide", camera: { latitude: 40.7128, longitude: -74.006, zoom: 7.2 }, width: 1180, height: 720 },
  { label: "new-york", camera: { latitude: 40.7128, longitude: -74.006, zoom: 10.6 }, width: 1180, height: 720 },
  { label: "new-york-pan", camera: { latitude: 40.735, longitude: -73.985, zoom: 11.7 }, width: 1180, height: 720 },
  { label: "new-york-mobile", camera: { latitude: 40.721, longitude: -73.997, zoom: 12.3 }, width: 390, height: 700 },
  { label: "transatlantic", camera: { latitude: 46.2, longitude: -32.5, zoom: 4.15 }, width: 1180, height: 720 },
  { label: "western-europe", camera: { latitude: 49.5, longitude: 3.2, zoom: 5.7 }, width: 1180, height: 720 },
  { label: "london", camera: { latitude: 51.5072, longitude: -0.1276, zoom: 10.4 }, width: 1180, height: 720 },
  { label: "paris", camera: { latitude: 48.8566, longitude: 2.3522, zoom: 10.55 }, width: 1180, height: 720 },
  { label: "rome", camera: { latitude: 41.9028, longitude: 12.4964, zoom: 10.3 }, width: 1180, height: 720 },
  { label: "east-asia", camera: { latitude: 35.2, longitude: 124.1, zoom: 4.65 }, width: 1180, height: 720 },
  { label: "tokyo-wide", camera: { latitude: 35.6762, longitude: 139.6503, zoom: 7.4 }, width: 1180, height: 720 },
  { label: "tokyo", camera: { latitude: 35.6762, longitude: 139.6503, zoom: 11.15 }, width: 1180, height: 720 },
  { label: "tokyo-pan", camera: { latitude: 35.6895, longitude: 139.6917, zoom: 12.05 }, width: 1180, height: 720 },
  { label: "southeast-asia", camera: { latitude: 13.7, longitude: 100.5, zoom: 5.2 }, width: 1180, height: 720 },
  { label: "singapore", camera: { latitude: 1.3521, longitude: 103.8198, zoom: 10.8 }, width: 1180, height: 720 },
  { label: "australia", camera: { latitude: -27.1, longitude: 134.2, zoom: 4.2 }, width: 1180, height: 720 },
  { label: "sydney", camera: { latitude: -33.8688, longitude: 151.2093, zoom: 10.55 }, width: 1180, height: 720 },
  { label: "dateline-east", camera: { latitude: 20.5, longitude: 179.35, zoom: 4.6 }, width: 1180, height: 720 },
  { label: "dateline-west", camera: { latitude: 20.5, longitude: -179.35, zoom: 4.6 }, width: 1180, height: 720 },
  { label: "northern-latitudes", camera: { latitude: 67.4, longitude: 18.2, zoom: 5.1 }, width: 1180, height: 720 },
  { label: "return-world", camera: { latitude: 20, longitude: 0, zoom: 2.5 }, width: 1180, height: 720 },
];

function usage(): string {
  return `Usage: benchmark-restaurant-map-viewport.ts [options]

  --samples=N                  Measured sample pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N                   Warmup sample pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --trace-repetitions=N        Trace repetitions per sample (default: ${DEFAULT_CONFIGURATION.traceRepetitions})
  --minimum-award-year=N       Override the default of latest bundled guide year minus one
  --help, -h                   Print this help`;
}

function parseInteger(option: string, value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be an integer; received ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${option} must be between ${minimum} and ${maximum}; received ${value}`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const values = { ...DEFAULT_CONFIGURATION };
  const seenOptions = new Set<string>();

  for (const argument of arguments_) {
    // Some pnpm versions preserve this separator. It is the only positional
    // token accepted so misspelled options cannot silently use defaults.
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }

    const separatorIndex = argument.indexOf("=");
    if (!argument.startsWith("--") || separatorIndex <= 2 || separatorIndex === argument.length - 1) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const option = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);
    if (seenOptions.has(option)) {
      throw new Error(`Duplicate option: ${option}`);
    }
    seenOptions.add(option);

    switch (option) {
      case "--samples":
        values.samples = parseInteger(option, value, 1, 101);
        break;
      case "--warmup":
        values.warmupIterations = parseInteger(option, value, 0, 100);
        break;
      case "--trace-repetitions":
        values.traceRepetitions = parseInteger(option, value, 1, 1_000);
        break;
      case "--minimum-award-year":
        values.minimumAwardYear = parseInteger(option, value, 1_900, 3_000);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return values;
}

// The reference implementation below intentionally duplicates the current
// restaurants-map.tsx algorithm instead of importing candidate helpers. It is
// the exhaustive behavior oracle: linear bounds scan, full candidate sort,
// stable ties, then top-500 truncation.
function referenceClampLatitude(latitude: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, latitude));
}

function referenceNormalizeLongitude(longitude: number): number {
  let normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180) {
    normalized = 180;
  }
  return normalized;
}

function referenceMercatorScale(zoom: number): number {
  return 256 * Math.pow(2, Math.max(0, zoom));
}

function referenceLongitudeToPixelX(longitude: number, zoom: number): number {
  const scale = referenceMercatorScale(zoom);
  return ((referenceNormalizeLongitude(longitude) + 180) / 360) * scale;
}

function referenceLatitudeToPixelY(latitude: number, zoom: number): number {
  const scale = referenceMercatorScale(zoom);
  const clamped = referenceClampLatitude(latitude);
  const sine = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
  return y * scale;
}

function referencePixelXToLongitude(pixelX: number, zoom: number): number {
  const scale = referenceMercatorScale(zoom);
  return referenceNormalizeLongitude((pixelX / scale) * 360 - 180);
}

function referencePixelYToLatitude(pixelY: number, zoom: number): number {
  const scale = referenceMercatorScale(zoom);
  const n = Math.PI - (2 * Math.PI * pixelY) / scale;
  return referenceClampLatitude((180 / Math.PI) * Math.atan(Math.sinh(n)));
}

function referenceViewportBounds(query: ViewportQuery): ViewportBounds | null {
  if (!query.width || !query.height) {
    return null;
  }

  const zoom = Math.max(0, query.camera.zoom);
  const centerX = referenceLongitudeToPixelX(query.camera.longitude, zoom);
  const centerY = referenceLatitudeToPixelY(query.camera.latitude, zoom);
  const halfWidth = query.width / 2;
  const halfHeight = query.height / 2;
  const scale = referenceMercatorScale(zoom);
  const minX = centerX - halfWidth;
  const maxX = centerX + halfWidth;
  const minY = centerY - halfHeight;
  const maxY = centerY + halfHeight;
  const latitudeCoversWholeWorld = query.height >= scale;
  const longitudeCoversWholeWorld = query.width >= scale;
  const minLatitude = latitudeCoversWholeWorld
    ? -85.05112878
    : referencePixelYToLatitude(Math.min(scale, Math.max(0, maxY)), zoom);
  const maxLatitude = latitudeCoversWholeWorld
    ? 85.05112878
    : referencePixelYToLatitude(Math.min(scale, Math.max(0, minY)), zoom);
  const minLongitude = longitudeCoversWholeWorld ? -180 : referencePixelXToLongitude(minX, zoom);
  const maxLongitude = longitudeCoversWholeWorld ? 180 : referencePixelXToLongitude(maxX, zoom);

  return {
    minLatitude: Math.min(minLatitude, maxLatitude),
    maxLatitude: Math.max(minLatitude, maxLatitude),
    minLongitude,
    maxLongitude,
    wrapsDateLine: !longitudeCoversWholeWorld && minLongitude > maxLongitude,
  };
}

function referenceRestaurantIsInBounds(restaurant: MapRestaurant, bounds: ViewportBounds): boolean {
  const latitudeInRange = restaurant.latitude >= bounds.minLatitude && restaurant.latitude <= bounds.maxLatitude;
  if (!latitudeInRange) {
    return false;
  }
  if (!bounds.wrapsDateLine) {
    return restaurant.longitude >= bounds.minLongitude && restaurant.longitude <= bounds.maxLongitude;
  }
  return restaurant.longitude >= bounds.minLongitude || restaurant.longitude <= bounds.maxLongitude;
}

function referenceCenterDistanceScore(restaurant: MapRestaurant, camera: CameraSnapshot): number {
  const zoom = Math.max(0, camera.zoom);
  const scale = referenceMercatorScale(zoom);
  const centerX = referenceLongitudeToPixelX(camera.longitude, zoom);
  const centerY = referenceLatitudeToPixelY(camera.latitude, zoom);
  const restaurantX = referenceLongitudeToPixelX(restaurant.longitude, zoom);
  const restaurantY = referenceLatitudeToPixelY(restaurant.latitude, zoom);
  let deltaX = Math.abs(restaurantX - centerX);
  deltaX = Math.min(deltaX, scale - deltaX);
  const deltaY = restaurantY - centerY;
  return deltaX * deltaX + deltaY * deltaY;
}

function referenceAwardPriority(award: string): number {
  const lower = award.toLowerCase();
  let score = 0;
  if (lower.includes("3 stars") || lower.includes("3 star")) {
    score += 300;
  } else if (lower.includes("2 stars") || lower.includes("2 star")) {
    score += 200;
  } else if (lower.includes("1 star")) {
    score += 100;
  } else if (lower.includes("bib gourmand")) {
    score += 60;
  } else if (lower.includes("selected")) {
    score += 30;
  }
  if (lower.includes("green star")) {
    score += 10;
  }
  return score;
}

function selectViewportExhaustively(restaurants: readonly MapRestaurant[], query: ViewportQuery): ViewportSelection {
  const bounds = referenceViewportBounds(query);
  if (!bounds) {
    return { ids: [], totalInView: 0 };
  }

  const candidates: ReferenceCandidate[] = [];
  for (const restaurant of restaurants) {
    if (referenceRestaurantIsInBounds(restaurant, bounds)) {
      candidates.push({
        restaurant,
        centerDistanceScore: referenceCenterDistanceScore(restaurant, query.camera),
      });
    }
  }

  candidates.sort((left, right) => {
    const distanceDifference = left.centerDistanceScore - right.centerDistanceScore;
    if (distanceDifference !== 0) {
      return distanceDifference;
    }
    const awardDifference =
      referenceAwardPriority(right.restaurant.award) - referenceAwardPriority(left.restaurant.award);
    if (awardDifference !== 0) {
      return awardDifference;
    }
    const visitedDifference = Number(right.restaurant.visited) - Number(left.restaurant.visited);
    if (visitedDifference !== 0) {
      return visitedDifference;
    }
    return left.restaurant.name.localeCompare(right.restaurant.name);
  });

  return {
    ids: candidates.slice(0, MAX_RESTAURANTS_IN_VIEW).map(({ restaurant }) => restaurant.id),
    totalInView: candidates.length,
  };
}

class IndexedViewportSelector {
  readonly indexBuildMilliseconds: number;

  private readonly viewportIndex: RestaurantViewportIndex<MapRestaurant>;

  constructor(restaurants: readonly MapRestaurant[]) {
    const startedAt = performance.now();
    const entries: RestaurantViewportEntry<MapRestaurant>[] = restaurants.map((restaurant) => ({
      restaurant,
      visited: restaurant.visited,
    }));
    this.viewportIndex = new RestaurantViewportIndex(entries, MAX_RESTAURANTS_IN_VIEW);
    this.indexBuildMilliseconds = performance.now() - startedAt;
  }

  select(query: ViewportQuery): ViewportSelection {
    const selection = this.viewportIndex.select(query);
    return {
      ids: selection.entries.map(({ restaurant }) => restaurant.id),
      totalInView: selection.totalInView,
    };
  }
}

function fixtureRestaurant(
  id: string,
  latitude: number,
  longitude: number,
  overrides: Partial<Pick<MapRestaurant, "name" | "award" | "visited">> = {},
): MapRestaurant {
  return {
    id,
    name: overrides.name ?? id,
    latitude,
    longitude,
    award: overrides.award ?? "Selected",
    latestAwardYear: 2026,
    visited: overrides.visited ?? false,
  };
}

function assertSelectionParity(
  restaurants: readonly MapRestaurant[],
  query: ViewportQuery,
  expectedIds?: readonly string[],
  expectedTotal?: number,
): ViewportSelection {
  const expected = selectViewportExhaustively(restaurants, query);
  const actual = new IndexedViewportSelector(restaurants).select(query);
  assert.deepEqual(actual, expected, `${query.label}: indexed result differed from exhaustive reference`);
  if (expectedIds) {
    assert.deepEqual(expected.ids, expectedIds, `${query.label}: exhaustive reference order changed`);
  }
  if (expectedTotal !== undefined) {
    assert.equal(expected.totalInView, expectedTotal, `${query.label}: exhaustive reference count changed`);
  }
  return expected;
}

function assertEdgeCases(): { readonly queryCount: number; readonly checksum: string } {
  const selections: Array<{ query: ViewportQuery; selection: ViewportSelection }> = [];

  const zeroSizedQuery: ViewportQuery = {
    label: "zero-sized",
    camera: { latitude: 0, longitude: 0, zoom: 8 },
    width: 0,
    height: 700,
  };
  selections.push({
    query: zeroSizedQuery,
    selection: assertSelectionParity([fixtureRestaurant("origin", 0, 0)], zeroSizedQuery, [], 0),
  });

  const boundsQuery: ViewportQuery = {
    label: "inclusive-bounds",
    camera: { latitude: 0, longitude: 0, zoom: 5 },
    width: 512,
    height: 512,
  };
  const bounds = referenceViewportBounds(boundsQuery);
  assert.ok(bounds && !bounds.wrapsDateLine);
  const boundaryRestaurants = [
    fixtureRestaurant("at-min-latitude", bounds.minLatitude, 0),
    fixtureRestaurant("at-max-latitude", bounds.maxLatitude, 0),
    fixtureRestaurant("at-min-longitude", 0, bounds.minLongitude),
    fixtureRestaurant("at-max-longitude", 0, bounds.maxLongitude),
    fixtureRestaurant("outside-min-latitude", bounds.minLatitude - 1e-9, 0),
    fixtureRestaurant("outside-max-longitude", 0, bounds.maxLongitude + 1e-9),
  ];
  const boundarySelection = assertSelectionParity(boundaryRestaurants, boundsQuery, undefined, 4);
  assert.deepEqual(new Set(boundarySelection.ids), new Set(boundaryRestaurants.slice(0, 4).map(({ id }) => id)));
  selections.push({ query: boundsQuery, selection: boundarySelection });

  const worldQuery: ViewportQuery = {
    label: "whole-world",
    camera: { latitude: 20, longitude: 0, zoom: 1 },
    width: 1_024,
    height: 1_024,
  };
  const worldBounds = referenceViewportBounds(worldQuery);
  assert.deepEqual(worldBounds, {
    minLatitude: -85.05112878,
    maxLatitude: 85.05112878,
    minLongitude: -180,
    maxLongitude: 180,
    wrapsDateLine: false,
  });
  selections.push({
    query: worldQuery,
    selection: assertSelectionParity(
      [
        fixtureRestaurant("world-west", 0, -180),
        fixtureRestaurant("world-east", 0, 180),
        fixtureRestaurant("world-north", 85, 0),
        fixtureRestaurant("outside-mercator", 86, 0),
      ],
      worldQuery,
      undefined,
      3,
    ),
  });

  const datelineQuery: ViewportQuery = {
    label: "dateline-wrap",
    camera: { latitude: 0, longitude: 179.5, zoom: 5 },
    width: 512,
    height: 400,
  };
  const datelineBounds = referenceViewportBounds(datelineQuery);
  assert.ok(datelineBounds?.wrapsDateLine);
  const datelineRestaurants = [
    fixtureRestaurant("east-dateline", 0, 179.9),
    fixtureRestaurant("west-dateline", 0, -179.9),
    fixtureRestaurant("at-east-bound", 0, datelineBounds.minLongitude),
    fixtureRestaurant("at-west-bound", 0, datelineBounds.maxLongitude),
    fixtureRestaurant("greenwich-excluded", 0, 0),
  ];
  const datelineSelection = assertSelectionParity(datelineRestaurants, datelineQuery, undefined, 4);
  assert.ok(datelineSelection.ids.includes("east-dateline"));
  assert.ok(datelineSelection.ids.includes("west-dateline"));
  assert.ok(!datelineSelection.ids.includes("greenwich-excluded"));
  selections.push({ query: datelineQuery, selection: datelineSelection });

  const rankingQuery: ViewportQuery = {
    label: "ranking-ties",
    camera: { latitude: 0, longitude: 0, zoom: 12 },
    width: 500,
    height: 500,
  };
  const rankingRestaurants = [
    fixtureRestaurant("two-visited", 0, 0, { name: "Beta", award: "2 Stars", visited: true }),
    fixtureRestaurant("three-unvisited", 0, 0, { name: "Alpha", award: "3 Stars" }),
    fixtureRestaurant("three-visited-zulu", 0, 0, { name: "Zulu", award: "3 Stars", visited: true }),
    fixtureRestaurant("three-green", 0, 0, { name: "Zulu", award: "3 Stars, Green Star" }),
    fixtureRestaurant("three-visited-alpha", 0, 0, { name: "Alpha", award: "3 Stars", visited: true }),
  ];
  selections.push({
    query: rankingQuery,
    selection: assertSelectionParity(
      rankingRestaurants,
      rankingQuery,
      ["three-green", "three-visited-alpha", "three-visited-zulu", "three-unvisited", "two-visited"],
      5,
    ),
  });

  const stableTieQuery: ViewportQuery = {
    label: "stable-top-500",
    camera: { latitude: 0, longitude: 0, zoom: 10 },
    width: 500,
    height: 500,
  };
  const stableTieRestaurants = Array.from({ length: 520 }, (_, index) =>
    fixtureRestaurant(`stable-${index.toString().padStart(3, "0")}`, 0, 0, {
      name: "Complete Tie",
      award: "Selected",
      visited: false,
    }),
  );
  const expectedStableIds = stableTieRestaurants.slice(0, MAX_RESTAURANTS_IN_VIEW).map(({ id }) => id);
  selections.push({
    query: stableTieQuery,
    selection: assertSelectionParity(stableTieRestaurants, stableTieQuery, expectedStableIds, 520),
  });

  return {
    queryCount: selections.length,
    checksum: selectionChecksum(selections),
  };
}

function loadDataset(database: DatabaseSync, configuredMinimumAwardYear: number | null): Dataset {
  const rows = database
    .prepare(
      `SELECT
         r.id,
         r.name,
         r.latitude,
         r.longitude,
         a.distinction AS latest_distinction,
         a.year AS latest_year,
         a.green_star AS has_green_star
       FROM restaurants r
       LEFT JOIN (
         SELECT awards.*
         FROM restaurant_awards awards
         INNER JOIN (
           SELECT restaurant_id, MAX(year) AS max_year
           FROM restaurant_awards
           GROUP BY restaurant_id
         ) latest
           ON awards.restaurant_id = latest.restaurant_id
          AND awards.year = latest.max_year
       ) a ON r.id = a.restaurant_id
       WHERE r.latitude IS NOT NULL
         AND r.longitude IS NOT NULL
         AND r.latitude != ''
         AND r.longitude != ''
       ORDER BY r.id ASC`,
    )
    .all() as unknown as DatabaseRestaurantRow[];

  const latestAwardYear = rows.reduce(
    (latest, row) => (typeof row.latest_year === "number" ? Math.max(latest, row.latest_year) : latest),
    Number.NEGATIVE_INFINITY,
  );
  assert.ok(Number.isFinite(latestAwardYear), "bundled Michelin database has no award years");
  const minimumAwardYear = configuredMinimumAwardYear ?? latestAwardYear - 1;

  let validCoordinateRows = 0;
  const restaurants: MapRestaurant[] = [];
  for (const row of rows) {
    const latitude = Number.parseFloat(row.latitude);
    const longitude = Number.parseFloat(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) {
      continue;
    }
    validCoordinateRows++;
    if (typeof row.latest_year !== "number" || row.latest_year < minimumAwardYear) {
      continue;
    }

    let award = row.latest_distinction ?? "";
    if (row.has_green_star) {
      award = award ? `${award}, Green Star` : "Green Star";
    }
    restaurants.push({
      id: `michelin-${row.id}`,
      name: row.name ?? "",
      latitude,
      longitude,
      award,
      latestAwardYear: row.latest_year,
      visited: row.id % SYNTHETIC_VISITED_MODULUS === 0,
    });
  }

  assert.ok(
    restaurants.length > MAX_RESTAURANTS_IN_VIEW,
    "filtered Michelin dataset is too small for top-500 profiling",
  );
  return {
    restaurants,
    databaseRows: rows.length,
    validCoordinateRows,
    latestAwardYear,
    minimumAwardYear,
    simulatedVisitedRows: restaurants.filter(({ visited }) => visited).length,
  };
}

function updateChecksum(checksum: number, value: string): number {
  let updated = checksum;
  for (let index = 0; index < value.length; index++) {
    updated ^= value.charCodeAt(index);
    updated = Math.imul(updated, 16_777_619) >>> 0;
  }
  return updated;
}

function selectionChecksum(entries: readonly { query: ViewportQuery; selection: ViewportSelection }[]): string {
  let checksum = 2_166_136_261;
  for (const { query, selection } of entries) {
    checksum = updateChecksum(checksum, `${query.label}\0${selection.totalInView}\0`);
    for (const id of selection.ids) {
      checksum = updateChecksum(checksum, `${id}\0`);
    }
    checksum = updateChecksum(checksum, "\u0001");
  }
  return checksum.toString(16).padStart(8, "0");
}

function assertTraceParity(
  restaurants: readonly MapRestaurant[],
  selector: IndexedViewportSelector,
): CorrectnessSummary {
  const selections: Array<{ query: ViewportQuery; selection: ViewportSelection }> = [];
  let selectedResults = 0;
  let totalCandidates = 0;

  for (const query of REPRESENTATIVE_CAMERA_TRACE) {
    const expected = selectViewportExhaustively(restaurants, query);
    const actual = selector.select(query);
    assert.deepEqual(actual, expected, `${query.label}: real-data indexed result differed from exhaustive reference`);
    selections.push({ query, selection: expected });
    selectedResults += expected.ids.length;
    totalCandidates += expected.totalInView;
  }

  return {
    checksum: selectionChecksum(selections),
    selectedResults,
    totalCandidates,
  };
}

function expandTrace(repetitions: number): ViewportQuery[] {
  const expanded: ViewportQuery[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    expanded.push(...REPRESENTATIVE_CAMERA_TRACE);
  }
  return expanded;
}

function guardSelection(guard: number, selection: ViewportSelection): number {
  let updated = Math.imul(guard ^ selection.totalInView, 16_777_619) >>> 0;
  updated = Math.imul(updated ^ selection.ids.length, 16_777_619) >>> 0;
  if (selection.ids.length > 0) {
    updated = updateChecksum(updated, selection.ids[0]);
    updated = updateChecksum(updated, selection.ids[selection.ids.length - 1]);
  }
  return updated;
}

function runTrace(select: (query: ViewportQuery) => ViewportSelection, trace: readonly ViewportQuery[]): number {
  let guard = 2_166_136_261;
  for (const query of trace) {
    guard = guardSelection(guard, select(query));
  }
  return guard;
}

function measureTrace(
  select: (query: ViewportQuery) => ViewportSelection,
  trace: readonly ViewportQuery[],
): Measurement {
  const startedAt = performance.now();
  const resultGuard = runTrace(select, trace);
  return { elapsedMilliseconds: performance.now() - startedAt, resultGuard };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(samples: readonly number[]): MeasurementSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMilliseconds: samples.map(rounded),
    minimumMilliseconds: rounded(sorted[0]),
    medianMilliseconds: rounded(median(samples)),
    p95Milliseconds: rounded(percentile95(samples)),
    maximumMilliseconds: rounded(sorted[sorted.length - 1]),
  };
}

function benchmark(
  restaurants: readonly MapRestaurant[],
  selector: IndexedViewportSelector,
  configuration: Configuration,
): {
  readonly exhaustive: MeasurementSummary;
  readonly indexed: MeasurementSummary;
  readonly measurementOrder: string[];
  readonly resultGuard: string;
  readonly speedup: number;
} {
  const trace = expandTrace(configuration.traceRepetitions);
  const exhaustiveSelect = (query: ViewportQuery) => selectViewportExhaustively(restaurants, query);
  const indexedSelect = (query: ViewportQuery) => selector.select(query);
  const expectedGuard = runTrace(exhaustiveSelect, trace);
  assert.equal(runTrace(indexedSelect, trace), expectedGuard, "timed trace guard differed before warmup");

  for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
    const first = warmup % 2 === 0 ? exhaustiveSelect : indexedSelect;
    const second = warmup % 2 === 0 ? indexedSelect : exhaustiveSelect;
    assert.equal(runTrace(first, trace), expectedGuard);
    assert.equal(runTrace(second, trace), expectedGuard);
  }

  const exhaustiveSamples: number[] = [];
  const indexedSamples: number[] = [];
  const measurementOrder: string[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    const exhaustiveFirst = sample % 2 === 0;
    const strategies = exhaustiveFirst
      ? ([
          ["exhaustive", exhaustiveSelect, exhaustiveSamples],
          ["indexed", indexedSelect, indexedSamples],
        ] as const)
      : ([
          ["indexed", indexedSelect, indexedSamples],
          ["exhaustive", exhaustiveSelect, exhaustiveSamples],
        ] as const);

    measurementOrder.push(strategies.map(([name]) => name).join("-then-"));
    for (const [, select, samples] of strategies) {
      const measurement = measureTrace(select, trace);
      assert.equal(measurement.resultGuard, expectedGuard, "measured trace result guard changed");
      samples.push(measurement.elapsedMilliseconds);
    }
  }

  const exhaustiveMedian = median(exhaustiveSamples);
  const indexedMedian = median(indexedSamples);
  return {
    exhaustive: summarize(exhaustiveSamples),
    indexed: summarize(indexedSamples),
    measurementOrder,
    resultGuard: expectedGuard.toString(16).padStart(8, "0"),
    speedup: indexedMedian > 0 ? exhaustiveMedian / indexedMedian : 0,
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const edgeCases = assertEdgeCases();
const databasePath = fileURLToPath(new URL("../assets/michelin.db", import.meta.url));
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const sqliteVersion = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  const dataset = loadDataset(database, configuration.minimumAwardYear);
  const selector = new IndexedViewportSelector(dataset.restaurants);
  const correctness = assertTraceParity(dataset.restaurants, selector);
  const result = benchmark(dataset.restaurants, selector, configuration);

  const report = {
    schemaVersion: 1,
    status: "ok",
    runtime: {
      node: process.version,
      sqlite: sqliteVersion,
      spatialIndex: "kdbush",
    },
    configuration: {
      samples: configuration.samples,
      warmupIterations: configuration.warmupIterations,
      traceRepetitions: configuration.traceRepetitions,
      traceEvents: REPRESENTATIVE_CAMERA_TRACE.length,
      timedViewportQueriesPerSample: REPRESENTATIVE_CAMERA_TRACE.length * configuration.traceRepetitions,
      resultLimit: MAX_RESTAURANTS_IN_VIEW,
      minimumAwardYear: dataset.minimumAwardYear,
      visitStatusFilter: "all",
      quickAwardFilter: "all",
      syntheticVisitedModulus: SYNTHETIC_VISITED_MODULUS,
    },
    dataset: {
      source: "assets/michelin.db",
      databaseRows: dataset.databaseRows,
      validCoordinateRows: dataset.validCoordinateRows,
      latestAwardYear: dataset.latestAwardYear,
      filteredRestaurantRows: dataset.restaurants.length,
      simulatedVisitedRows: dataset.simulatedVisitedRows,
      indexBuildMilliseconds: rounded(selector.indexBuildMilliseconds),
    },
    correctness: {
      exactResultParity: true,
      edgeCases: EDGE_CASE_NAMES,
      edgeCaseQueries: edgeCases.queryCount,
      edgeCaseChecksum: edgeCases.checksum,
      representativeTraceQueries: REPRESENTATIVE_CAMERA_TRACE.length,
      representativeTraceChecksum: correctness.checksum,
      representativeTraceSelectedResults: correctness.selectedResults,
      representativeTraceTotalCandidates: correctness.totalCandidates,
      timedResultGuard: result.resultGuard,
    },
    algorithms: {
      exhaustive: "linear bounds scan + full stable sort + top-500 slice",
      indexed: "persistent KDBush bounds query + bounded max-heap top-500",
    },
    timingScope:
      "isolated Node/V8 viewport selection; excludes React rendering, marker construction, native bridging, and map drawing",
    measurementOrder: result.measurementOrder,
    exhaustive: result.exhaustive,
    indexedBoundedTopK: result.indexed,
    indexedSpeedup: Number(result.speedup.toFixed(2)),
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  database.close();
}
