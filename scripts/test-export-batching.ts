#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildExportPhotoCountsQuery,
  buildExportPhotosQuery,
  EXPORT_PHOTO_PAGE_SIZE,
  type ExportPhotoCursor,
  type ExportPhotosQuery,
} from "../utils/db/export-photos-core.ts";
import type { FoodLabel, PhotoRecord, RestaurantRecord, VisitRecord } from "../utils/db/types.ts";
import {
  buildExportDataFromVisits,
  buildExportVisits,
  exportDataToCSVString,
  exportDataToJSONString,
  type ExportData,
  withExactExportPhotoCounts,
} from "../utils/export-core.ts";

type StatusFilter = "all" | "confirmed" | "pending" | "rejected";

interface RawPhotoRow extends Omit<PhotoRecord, "foodDetected" | "foodLabels" | "allLabels" | "mediaType"> {
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly allLabels: string | null;
  readonly mediaType: string | null;
}

interface QueryPlanRow {
  readonly detail: string;
}

interface IndependentExportResult {
  readonly data: ExportData;
  readonly restaurantLookupCount: number;
  readonly photoLookupCount: number;
}

type VisitBooleanMode = "raw-legacy" | "json-schema";

interface CandidateResult {
  readonly data: ExportData;
  readonly photoLookupCount: number;
  readonly photoCountLookupCount: number;
  readonly paginationAudit: PaginationAudit | null;
}

interface PaginationAudit {
  readonly rawRowCounts: number[];
  readonly emittedRowCounts: number[];
  readonly continuationCursors: ExportPhotoCursor[];
  readonly orderedPhotoIds: string[];
  readonly lookaheadContinuityChecks: number;
}

interface RacePhotoRow {
  readonly id: string;
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly creationTime: number;
}

interface RaceResult {
  readonly duringConcurrentWrite: string[];
  readonly afterConcurrentWrite: string[];
}

const EXPORTED_AT = "2026-07-08T19:20:30.456Z";
const EDGE_VISIT_ID = "visit-雪'\"\\path\nline";
const TIE_ONLY_VISIT_ID = "visit-intentional-ordering-ties";
const TEST_PAGE_SIZE = 2;
const FILTERS: readonly StatusFilter[] = ["all", "confirmed", "pending", "rejected"];
const LEGACY_PHOTOS_SQL = `SELECT * FROM photos WHERE visitId = ? ORDER BY
  CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
  creationTime ASC`;

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
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
      exportedToCalendarId TEXT,
      notes TEXT,
      updatedAt INTEGER,
      awardAtVisit TEXT
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      mediaType TEXT,
      duration REAL
    );

    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
  `);
  return database;
}

function seedFixture(database: DatabaseSync): void {
  const insertRestaurant = database.prepare(`
    INSERT INTO restaurants (
      id, name, latitude, longitude, address, phone, website,
      googlePlaceId, cuisine, priceLevel, rating, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      exportedToCalendarId, notes, updatedAt, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPhoto = database.prepare(`
    INSERT INTO photos (
      id, uri, creationTime, latitude, longitude, visitId, foodDetected,
      foodLabels, foodConfidence, allLabels, mediaType, duration
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    insertRestaurant.run(
      "restaurant-repeat",
      'Café "雪",\nSushi',
      37.774_929,
      -122.419_416,
      "1 Main St\nSuite 'A'",
      "+1 (555) 010-雪",
      'https://example.test/menu?q="omakase"',
      "place-repeat",
      "Japanese, Fusion",
      4,
      4.875,
      'Chef said "hello"\nまたね',
    );
    insertRestaurant.run("restaurant-other", "Null Island Diner", 0, 0, null, null, null, null, null, null, null, null);
    insertRestaurant.run(
      "restaurant-unused",
      "Never Visited",
      12.5,
      -45.25,
      "Unused address",
      null,
      null,
      null,
      "Other",
      1,
      3.5,
      "Must not be exported",
    );

    const base = Date.UTC(2026, 5, 20, 12, 0, 0);
    insertVisit.run(
      "visit-confirmed-rich",
      "restaurant-repeat",
      "suggested-雪",
      "confirmed",
      base + 600_000,
      base + 7_800_000,
      37.774_9,
      -122.419_4,
      8,
      1,
      "calendar-confirmed",
      'Dinner, "birthday"\nline two',
      "Dining room\nUpstairs",
      0,
      "calendar-exported",
      "Confirmed notes\n🍣",
      base + 10_000,
      "Two Stars",
    );
    insertVisit.run(
      EDGE_VISIT_ID,
      "restaurant-repeat",
      null,
      "pending",
      base + 500_000,
      base + 5_900_000,
      -33.868_8,
      151.209_3,
      2,
      0,
      null,
      null,
      null,
      null,
      null,
      "Pending 'quoted' notes",
      0,
      null,
    );
    insertVisit.run(
      "visit-rejected-missing-restaurant",
      "restaurant-does-not-exist",
      "missing-suggestion",
      "rejected",
      base + 400_000,
      base + 3_700_000,
      51.507_2,
      -0.127_6,
      1,
      0,
      "calendar-rejected",
      "Rejected event",
      null,
      1,
      null,
      null,
      null,
      null,
    );
    insertVisit.run(
      "",
      "restaurant-other",
      null,
      "confirmed",
      base + 300_000,
      base + 3_000_000,
      0,
      -0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      "Empty visit ID and zero photos",
      null,
      null,
    );
    insertVisit.run(
      "visit-pending-no-restaurant",
      null,
      null,
      "pending",
      base + 200_000,
      base + 2_000_000,
      35.676_2,
      139.650_3,
      1,
      1,
      null,
      null,
      "東京",
      null,
      null,
      "No restaurant",
      base + 20_000,
      null,
    );
    insertVisit.run(
      "visit-confirmed-repeat-zero",
      "restaurant-repeat",
      null,
      "confirmed",
      base + 100_000,
      base + 100_000 + 59 * 60_000,
      48.856_6,
      2.352_2,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      base + 30_000,
      "Bib Gourmand",
    );

    // Keep equal-rank/equal-time rows on a synthetic visit that is deliberately
    // absent from the export-parity fixture. Legacy SQL did not define their
    // relative order; keyset paging now intentionally orders them by photo ID.
    const tieTime = base + 100;
    insertPhoto.run(
      "tie-z",
      "file:///Photos/Z.jpg",
      tieTime,
      37.1,
      -122.1,
      TIE_ONLY_VISIT_ID,
      1,
      JSON.stringify([{ label: "寿司 🍣", confidence: 0.99 }]),
      0.99,
      JSON.stringify([{ label: 'plate "blue"\nlarge', confidence: 0.7 }]),
      "photo",
      null,
    );
    insertPhoto.run(
      "tie-m",
      "file:///Photos/M.jpg",
      tieTime,
      null,
      null,
      TIE_ONLY_VISIT_ID,
      1,
      "[]",
      0,
      "[]",
      "video",
      12.5,
    );
    insertPhoto.run(
      "tie-a",
      'file:///Photos/A-"雪"\n.jpg',
      tieTime,
      37.2,
      -122.2,
      TIE_ONLY_VISIT_ID,
      1,
      JSON.stringify([{ label: 'ramen "spicy"', confidence: 0.8 }]),
      0.8,
      JSON.stringify([{ label: "noodle\n汤", confidence: 0.9 }]),
      "photo",
      null,
    );
    insertPhoto.run(
      "true-malformed-both",
      "file:///Photos/malformed.jpg",
      base + 200,
      null,
      null,
      "visit-confirmed-rich",
      1,
      "{not valid JSON",
      null,
      "[also not valid",
      "video",
      null,
    );
    insertPhoto.run(
      "false-valid-food-malformed-all",
      "file:///Photos/false.jpg",
      base + 1,
      0,
      0,
      "visit-confirmed-rich",
      0,
      JSON.stringify([{ label: "not food", confidence: 0.2 }]),
      0.2,
      "malformed-all",
      "photo",
      null,
    );
    insertPhoto.run(
      "unknown-null-media",
      "file:///Photos/unknown.heic",
      base,
      null,
      null,
      "visit-confirmed-rich",
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertPhoto.run(
      "unknown-empty-label-json",
      "file:///Photos/empty-labels.heic",
      base + 1,
      1.25,
      null,
      "visit-confirmed-rich",
      null,
      "",
      null,
      "",
      "image",
      null,
    );
    insertPhoto.run(
      "true-late-video",
      "file:///Photos/movie.mov",
      base + 300,
      null,
      139.6,
      "visit-confirmed-rich",
      1,
      null,
      null,
      JSON.stringify([{ label: "motion", confidence: 0.5 }]),
      "video",
      0,
    );
    insertPhoto.run(
      "pending-video",
      "file:///Photos/pending.mov",
      base + 10,
      null,
      null,
      EDGE_VISIT_ID,
      0,
      null,
      null,
      null,
      "video",
      42.25,
    );
    insertPhoto.run(
      "pending-photo",
      "file:///Photos/pending.jpg",
      base + 20,
      10,
      20,
      EDGE_VISIT_ID,
      null,
      null,
      null,
      null,
      "photo",
      null,
    );
    insertPhoto.run(
      "rejected-photo",
      "file:///Photos/rejected.jpg",
      base + 30,
      -10,
      -20,
      "visit-rejected-missing-restaurant",
      0,
      null,
      0,
      null,
      "photo",
      null,
    );
    insertPhoto.run(
      "pending-no-restaurant-photo",
      "file:///Photos/no-restaurant.jpg",
      base + 40,
      35.6,
      139.6,
      "visit-pending-no-restaurant",
      1,
      JSON.stringify([{ label: "抹茶", confidence: 1 }]),
      1,
      JSON.stringify([{ label: "green", confidence: 1 }]),
      "photo",
      null,
    );
    insertPhoto.run(
      "unassigned-photo",
      "file:///Photos/unassigned.jpg",
      base + 50,
      1,
      1,
      null,
      1,
      null,
      null,
      null,
      "photo",
      null,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getVisitsLegacy(database: DatabaseSync, filter: StatusFilter): VisitRecord[] {
  const statement =
    filter === "all"
      ? database.prepare("SELECT * FROM visits ORDER BY startTime DESC")
      : database.prepare("SELECT * FROM visits WHERE status = ? ORDER BY startTime DESC");
  const rows = filter === "all" ? statement.all() : statement.all(filter);
  return rows.map((row) => ({ ...row })) as unknown as VisitRecord[];
}

function getAllRestaurantsLegacy(database: DatabaseSync): RestaurantRecord[] {
  return database
    .prepare("SELECT * FROM restaurants")
    .all()
    .map((row) => ({ ...row })) as unknown as RestaurantRecord[];
}

function parseLegacyPhoto(raw: RawPhotoRow): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    try {
      foodLabels = JSON.parse(raw.foodLabels) as FoodLabel[];
    } catch {
      // The former database helper silently discarded malformed label JSON.
    }
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    try {
      allLabels = JSON.parse(raw.allLabels) as FoodLabel[];
    } catch {
      // The former database helper silently discarded malformed label JSON.
    }
  }

  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels,
    allLabels,
    mediaType: raw.mediaType === "video" ? "video" : "photo",
  };
}

function getPhotosForVisitLegacy(database: DatabaseSync, visitId: string): PhotoRecord[] {
  const rows = database.prepare(LEGACY_PHOTOS_SQL).all(visitId) as unknown as RawPhotoRow[];
  return rows.map(parseLegacyPhoto);
}

function formatDateLegacy(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTimeLegacy(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDurationLegacy(start: number, end: number): string {
  const diffMins = Math.round((end - start) / (1_000 * 60));
  if (diffMins < 60) {
    return `${diffMins} minutes`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
}

function normalizeExpectedSqliteBoolean(value: unknown): boolean {
  assert.ok(value === 0 || value === 1 || value === false || value === true);
  return value === 1 || value === true;
}

function normalizeExpectedNullableSqliteBoolean(value: unknown): boolean | null {
  return value === null ? null : normalizeExpectedSqliteBoolean(value);
}

/** Independent database access and assembly oracle, with an explicit boolean-schema mode. */
function buildIndependentExport(
  database: DatabaseSync,
  filter: StatusFilter,
  includePhotos: boolean,
  booleanMode: VisitBooleanMode = "json-schema",
): IndependentExportResult {
  const visitsEntries = getVisitsLegacy(database, filter);
  const allRestaurants = getAllRestaurantsLegacy(database);
  const restaurantVisitCounts = new Map<string, number>();
  let restaurantLookupCount = 0;
  let photoLookupCount = 0;

  const visits = visitsEntries.map((visit) => {
    let restaurant: RestaurantRecord | null = null;
    if (visit.restaurantId) {
      restaurantLookupCount += 1;
      const row = database.prepare("SELECT * FROM restaurants WHERE id = ?").get(visit.restaurantId);
      restaurant = row ? ({ ...row } as unknown as RestaurantRecord) : null;
      if (restaurant) {
        restaurantVisitCounts.set(restaurant.id, (restaurantVisitCounts.get(restaurant.id) ?? 0) + 1);
      }
    }

    let photos: PhotoRecord[] = [];
    if (includePhotos) {
      photoLookupCount += 1;
      photos = getPhotosForVisitLegacy(database, visit.id);
    }
    const exactPhotoCount = includePhotos
      ? photos.length
      : (
          database.prepare("SELECT COUNT(*) AS photoCount FROM photos WHERE visitId = ?").get(visit.id) as unknown as {
            readonly photoCount: number;
          }
        ).photoCount;

    return {
      visitId: visit.id,
      status: visit.status,
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.name,
            latitude: restaurant.latitude,
            longitude: restaurant.longitude,
            address: restaurant.address,
            phone: restaurant.phone,
            website: restaurant.website,
            googlePlaceId: restaurant.googlePlaceId,
            cuisine: restaurant.cuisine,
            priceLevel: restaurant.priceLevel,
            rating: restaurant.rating,
            notes: restaurant.notes,
          }
        : null,
      suggestedRestaurantId: visit.suggestedRestaurantId,
      visitDate: formatDateLegacy(visit.startTime),
      startTime: formatTimeLegacy(visit.startTime),
      endTime: formatTimeLegacy(visit.endTime),
      duration: formatDurationLegacy(visit.startTime, visit.endTime),
      startTimestamp: visit.startTime,
      endTimestamp: visit.endTime,
      location: {
        latitude: visit.centerLat,
        longitude: visit.centerLon,
      },
      photoCount: booleanMode === "json-schema" ? exactPhotoCount : visit.photoCount,
      // The raw branch deliberately reproduces the historical type lie: Expo
      // SQLite returned 0/1 even though VisitRecord declared a boolean.
      foodProbable:
        booleanMode === "json-schema" ? normalizeExpectedSqliteBoolean(visit.foodProbable) : visit.foodProbable,
      awardAtVisit: visit.awardAtVisit,
      notes: visit.notes,
      calendarEvent: {
        id: visit.calendarEventId,
        title: visit.calendarEventTitle,
        location: visit.calendarEventLocation,
        isAllDay:
          booleanMode === "json-schema"
            ? normalizeExpectedNullableSqliteBoolean(visit.calendarEventIsAllDay)
            : visit.calendarEventIsAllDay,
      },
      exportedToCalendarId: visit.exportedToCalendarId,
      updatedAt: visit.updatedAt ? new Date(visit.updatedAt).toISOString() : null,
      photos: photos.map((photo) => ({
        id: photo.id,
        uri: photo.uri,
        createdAt: new Date(photo.creationTime).toISOString(),
        latitude: photo.latitude,
        longitude: photo.longitude,
        mediaType: photo.mediaType,
        duration: photo.duration,
        foodDetected: photo.foodDetected,
        foodConfidence: photo.foodConfidence,
        foodLabels: photo.foodLabels,
        allLabels: photo.allLabels,
      })),
    };
  });

  const visitedRestaurantIds = new Set(visits.map((visit) => visit.restaurant?.id).filter(Boolean));
  const restaurants = allRestaurants
    .filter((restaurant) => visitedRestaurantIds.has(restaurant.id))
    .map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      visitCount: restaurantVisitCounts.get(restaurant.id) ?? 0,
      address: restaurant.address,
      phone: restaurant.phone,
      website: restaurant.website,
      googlePlaceId: restaurant.googlePlaceId,
      cuisine: restaurant.cuisine,
      priceLevel: restaurant.priceLevel,
      rating: restaurant.rating,
      notes: restaurant.notes,
    }))
    .sort((left, right) => right.visitCount - left.visitCount);

  return {
    data: {
      exportedAt: EXPORTED_AT,
      stats: {
        totalVisits: visits.length,
        confirmedVisits: visits.filter((visit) => visit.status === "confirmed").length,
        totalPhotos: visits.reduce((sum, visit) => sum + visit.photoCount, 0),
        uniqueRestaurants: restaurants.length,
      },
      visits,
      restaurants,
    },
    restaurantLookupCount,
    photoLookupCount,
  };
}

function parseCandidateLabels(value: string | null): FoodLabel[] | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as FoodLabel[];
  } catch {
    return null;
  }
}

function parseCandidatePhoto(raw: RawPhotoRow): PhotoRecord {
  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels: parseCandidateLabels(raw.foodLabels),
    allLabels: parseCandidateLabels(raw.allLabels),
    mediaType: raw.mediaType === "video" ? "video" : "photo",
  };
}

function getRawFoodRank(foodDetected: number | null): 0 | 1 | 2 {
  return foodDetected === 1 ? 0 : foodDetected === 0 ? 1 : 2;
}

function getExportFoodRank(foodDetected: boolean | null): 0 | 1 | 2 {
  return foodDetected === true ? 0 : foodDetected === false ? 1 : 2;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** SQLite's default BINARY collation compares the UTF-8 bytes of TEXT values. */
function compareSqliteBinaryText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function cursorForRawPhoto(
  raw: Pick<RawPhotoRow, "id" | "visitId" | "foodDetected" | "creationTime">,
): ExportPhotoCursor {
  if (raw.visitId === null) {
    throw new Error(`Paged export unexpectedly returned unassigned photo ${raw.id}.`);
  }
  return {
    visitId: raw.visitId,
    foodRank: getRawFoodRank(raw.foodDetected),
    creationTime: raw.creationTime,
    id: raw.id,
  };
}

function comparePhotoKeys(left: ExportPhotoCursor, right: ExportPhotoCursor): number {
  return (
    compareSqliteBinaryText(left.visitId, right.visitId) ||
    compareNumbers(left.foodRank, right.foodRank) ||
    compareNumbers(left.creationTime, right.creationTime) ||
    compareSqliteBinaryText(left.id, right.id)
  );
}

function getIndependentOrderedRawPhotos(database: DatabaseSync, visitIds: readonly string[]): RawPhotoRow[] {
  const requestedVisitIds = new Set(visitIds);
  return (database.prepare("SELECT * FROM photos").all() as unknown as RawPhotoRow[])
    .filter((photo) => photo.visitId !== null && requestedVisitIds.has(photo.visitId))
    .sort((left, right) => comparePhotoKeys(cursorForRawPhoto(left), cursorForRawPhoto(right)));
}

function getPhotosByVisitIdsCandidate(
  database: DatabaseSync,
  visitIds: readonly string[],
  pageSize = TEST_PAGE_SIZE,
): { photosByVisitId: Map<string, PhotoRecord[]>; lookupCount: number; paginationAudit: PaginationAudit } {
  const photosByVisitId = new Map<string, PhotoRecord[]>();
  const rawRowCounts: number[] = [];
  const emittedRowCounts: number[] = [];
  const continuationCursors: ExportPhotoCursor[] = [];
  const orderedPhotoIds: string[] = [];
  const emittedPhotoIds = new Set<string>();
  let lookaheadContinuityChecks = 0;
  let expectedFirstRow: ExportPhotoCursor | null = null;
  let cursor: ExportPhotoCursor | null = null;

  if (visitIds.length === 0) {
    return {
      photosByVisitId,
      lookupCount: 0,
      paginationAudit: {
        rawRowCounts,
        emittedRowCounts,
        continuationCursors,
        orderedPhotoIds,
        lookaheadContinuityChecks,
      },
    };
  }

  do {
    const query = buildExportPhotosQuery(visitIds, cursor, pageSize);
    assert.ok(query);
    assert.equal(query.pageSize, pageSize);
    const rawRows = database.prepare(query.sql).all(...query.parameters) as unknown as RawPhotoRow[];
    rawRowCounts.push(rawRows.length);
    assert.ok(
      rawRows.length <= pageSize + 1,
      `SQL page exposed ${rawRows.length} rows for a ${pageSize}-row page plus one lookahead`,
    );

    for (let index = 1; index < rawRows.length; index++) {
      assert.ok(
        comparePhotoKeys(cursorForRawPhoto(rawRows[index - 1]!), cursorForRawPhoto(rawRows[index]!)) < 0,
        "each SQL page must be strictly ordered by its complete key",
      );
    }

    if (expectedFirstRow) {
      assert.ok(rawRows[0], "a continuation page must contain its prior lookahead row");
      assert.deepEqual(
        cursorForRawPhoto(rawRows[0]),
        expectedFirstRow,
        "keyset cursor skipped or duplicated a boundary",
      );
      lookaheadContinuityChecks += 1;
    }

    const hasNextPage = rawRows.length > pageSize;
    if (hasNextPage) {
      assert.equal(rawRows.length, pageSize + 1, "continuation requires exactly one internal lookahead row");
    }
    const pageRows = hasNextPage ? rawRows.slice(0, pageSize) : rawRows;
    emittedRowCounts.push(pageRows.length);
    assert.ok(pageRows.length <= pageSize, "the candidate must never emit its internal lookahead row");

    for (const raw of pageRows) {
      if (raw.visitId === null) {
        throw new Error(`Paged export unexpectedly emitted unassigned photo ${raw.id}.`);
      }
      assert.equal(emittedPhotoIds.has(raw.id), false, `photo ${raw.id} crossed a page boundary twice`);
      emittedPhotoIds.add(raw.id);
      orderedPhotoIds.push(raw.id);
      const photo = parseCandidatePhoto(raw);
      const existing = photosByVisitId.get(raw.visitId);
      if (existing) {
        existing.push(photo);
      } else {
        photosByVisitId.set(raw.visitId, [photo]);
      }
    }

    if (hasNextPage) {
      const lastEmittedRow = pageRows.at(-1);
      const lookaheadRow = rawRows[pageSize];
      assert.ok(lastEmittedRow && lookaheadRow);
      cursor = cursorForRawPhoto(lastEmittedRow);
      expectedFirstRow = cursorForRawPhoto(lookaheadRow);
      assert.ok(comparePhotoKeys(cursor, expectedFirstRow) < 0, "lookahead must follow the emitted cursor key");
      continuationCursors.push(cursor);
    } else {
      cursor = null;
      expectedFirstRow = null;
    }
  } while (cursor !== null);

  return {
    photosByVisitId,
    lookupCount: rawRowCounts.length,
    paginationAudit: {
      rawRowCounts,
      emittedRowCounts,
      continuationCursors,
      orderedPhotoIds,
      lookaheadContinuityChecks,
    },
  };
}

function seedWalRaceDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        visitId TEXT,
        foodDetected INTEGER,
        creationTime INTEGER NOT NULL
      );
      CREATE INDEX idx_photos_visit_preview ON photos(
        visitId,
        (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
        creationTime,
        id
      );
    `);
    const insert = database.prepare("INSERT INTO photos (id, visitId, foodDetected, creationTime) VALUES (?, ?, ?, ?)");
    database.exec("BEGIN");
    try {
      insert.run("a-emitted-move", "visit-a", 1, 100);
      insert.run("z-cursor-anchor", "visit-a", 1, 100);
      insert.run("a-skip-me", "visit-a", null, 100);
      insert.run("z-tail", "visit-z", 1, 100);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function applyConcurrentRaceWrites(writer: DatabaseSync): void {
  writer.exec("BEGIN IMMEDIATE");
  try {
    // Move one already-emitted row forward by visit ID, and one lookahead row
    // backward by food rank. Separate page snapshots can now duplicate/skip.
    writer.prepare("UPDATE photos SET visitId = ? WHERE id = ?").run("visit-z", "a-emitted-move");
    writer.prepare("UPDATE photos SET foodDetected = 1 WHERE id = ?").run("a-skip-me");
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
}

function readRacePhotoPages(reader: DatabaseSync, afterFirstPage?: () => void): string[] {
  const visitIds = ["visit-a", "visit-z"];
  const emittedIds: string[] = [];
  let cursor: ExportPhotoCursor | null = null;
  let pageIndex = 0;

  do {
    const query = buildExportPhotosQuery(visitIds, cursor, 2);
    assert.ok(query);
    const rawRows = reader.prepare(query.sql).all(...query.parameters) as unknown as RacePhotoRow[];
    assert.ok(rawRows.length <= 3);
    const hasNextPage = rawRows.length > query.pageSize;
    const pageRows = hasNextPage ? rawRows.slice(0, query.pageSize) : rawRows;
    emittedIds.push(...pageRows.map(({ id }) => id));

    if (hasNextPage) {
      const lastRow = pageRows.at(-1);
      assert.ok(lastRow);
      cursor = cursorForRawPhoto(lastRow);
    } else {
      cursor = null;
    }

    if (pageIndex === 0) {
      afterFirstPage?.();
    }
    pageIndex += 1;
  } while (cursor !== null);

  return emittedIds;
}

function runWalRaceScenario(databasePath: string, freezeReadSnapshot: boolean): RaceResult {
  seedWalRaceDatabase(databasePath);
  const reader = new DatabaseSync(databasePath);
  const writer = new DatabaseSync(databasePath);
  let readTransactionOpen = false;

  try {
    reader.exec("PRAGMA busy_timeout = 5000");
    writer.exec("PRAGMA busy_timeout = 5000");
    if (freezeReadSnapshot) {
      reader.exec("BEGIN");
      readTransactionOpen = true;
    }

    const duringConcurrentWrite = readRacePhotoPages(reader, () => applyConcurrentRaceWrites(writer));
    if (readTransactionOpen) {
      reader.exec("COMMIT");
      readTransactionOpen = false;
    }
    const afterConcurrentWrite = readRacePhotoPages(reader);
    return { duringConcurrentWrite, afterConcurrentWrite };
  } finally {
    if (readTransactionOpen) {
      reader.exec("ROLLBACK");
    }
    writer.close();
    reader.close();
  }
}

function assertWalSnapshotPreventsCursorRaces(): void {
  const directory = mkdtempSync(join(tmpdir(), "palate-export-snapshot-"));
  try {
    const unfrozen = runWalRaceScenario(join(directory, "unfrozen.sqlite"), false);
    assert.deepEqual(unfrozen.duringConcurrentWrite, ["a-emitted-move", "z-cursor-anchor", "a-emitted-move", "z-tail"]);
    assert.equal(unfrozen.duringConcurrentWrite.filter((id) => id === "a-emitted-move").length, 2);
    assert.equal(unfrozen.duringConcurrentWrite.includes("a-skip-me"), false);

    const frozen = runWalRaceScenario(join(directory, "frozen.sqlite"), true);
    const initialSnapshotIds = ["a-emitted-move", "z-cursor-anchor", "a-skip-me", "z-tail"];
    const committedWriterIds = ["a-skip-me", "z-cursor-anchor", "a-emitted-move", "z-tail"];
    assert.deepEqual(frozen.duringConcurrentWrite, initialSnapshotIds);
    assert.equal(new Set(frozen.duringConcurrentWrite).size, initialSnapshotIds.length);
    assert.deepEqual(frozen.afterConcurrentWrite, committedWriterIds);
    assert.deepEqual(unfrozen.afterConcurrentWrite, committedWriterIds);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function buildCandidateExport(database: DatabaseSync, filter: StatusFilter, includePhotos: boolean): CandidateResult {
  const visits = getVisitsLegacy(database, filter);
  const restaurants = getAllRestaurantsLegacy(database);
  const visitIds = visits.map((visit) => visit.id);
  const loaded = includePhotos
    ? getPhotosByVisitIdsCandidate(database, visitIds)
    : { photosByVisitId: new Map<string, PhotoRecord[]>(), lookupCount: 0, paginationAudit: null };
  const visitsWithStoredCounts = buildExportVisits({
    visits,
    restaurants,
    photosByVisitId: loaded.photosByVisitId,
  });
  let photoCountLookupCount = 0;
  const exactPhotoCounts = new Map<string, number>();
  if (includePhotos) {
    for (const visit of visitsWithStoredCounts) {
      exactPhotoCounts.set(visit.visitId, visit.photos.length);
    }
  } else {
    const countQuery = buildExportPhotoCountsQuery(visitIds);
    if (countQuery) {
      const countRows = database.prepare(countQuery.sql).all(...countQuery.parameters) as unknown as {
        readonly visitId: string;
        readonly photoCount: number;
      }[];
      photoCountLookupCount = 1;
      for (const row of countRows) {
        exactPhotoCounts.set(row.visitId, row.photoCount);
      }
    }
  }
  const exportVisits = withExactExportPhotoCounts(visitsWithStoredCounts, exactPhotoCounts);

  return {
    data: buildExportDataFromVisits({
      visits: exportVisits,
      restaurants,
      exportedAt: EXPORTED_AT,
    }),
    photoLookupCount: loaded.lookupCount,
    photoCountLookupCount,
    paginationAudit: loaded.paginationAudit,
  };
}

function assertNoLegacyUndefinedPhotoTies(data: ExportData, context: string): void {
  for (const visit of data.visits) {
    const rankAndTimeKeys = new Set<string>();
    for (const photo of visit.photos) {
      const key = `${getExportFoodRank(photo.foodDetected)}\u0000${photo.createdAt}`;
      assert.equal(
        rankAndTimeKeys.has(key),
        false,
        `${context}: byte-parity fixture contains a legacy-undefined photo tie in visit ${visit.visitId}`,
      );
      rankAndTimeKeys.add(key);
    }
  }
}

function independentJSONString(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

function independentCSVString(data: ExportData): string {
  const headers = [
    "Visit Date",
    "Start Time",
    "End Time",
    "Duration",
    "Restaurant Name",
    "Restaurant ID",
    "Status",
    "Photo Count",
    "Latitude",
    "Longitude",
    "Visit ID",
  ];
  const rows = data.visits.map((visit) => [
    visit.visitDate,
    visit.startTime,
    visit.endTime,
    visit.duration,
    visit.restaurant?.name || "Unknown",
    visit.restaurant?.id || "",
    visit.status,
    visit.photoCount.toString(),
    visit.location.latitude.toFixed(6),
    visit.location.longitude.toFixed(6),
    visit.visitId,
  ]);
  return [headers.join(","), ...rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))].join(
    "\n",
  );
}

function assertByteParity(actual: string, expected: string, context: string): void {
  assert.deepEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"), context);
}

function assertExportQueryPlan(database: DatabaseSync, query: ExportPhotosQuery, context: string): void {
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...query.parameters) as unknown as QueryPlanRow[];
  const planDetails = plan.map(({ detail }) => detail).join("\n");
  assert.match(planDetails, /SEARCH p USING INDEX idx_photos_visit_preview/, `${context}: expression index`);
  assert.match(planDetails, /SCAN json_each VIRTUAL TABLE/, `${context}: JSON ID source`);
  assert.doesNotMatch(planDetails, /USE TEMP B-TREE FOR ORDER BY/, `${context}: ordered index walk`);
  assert.doesNotMatch(planDetails, /SCAN p(?:\s|$)/, `${context}: no full photo scan`);
}

const database = createDatabase();
try {
  seedFixture(database);

  assert.equal(buildExportPhotosQuery([]), null);
  assert.throws(() => buildExportPhotosQuery(["valid", 42 as unknown as string]), /string visit IDs/);
  assert.throws(() => buildExportPhotosQuery([null as unknown as string]), /string visit IDs/);
  assert.throws(() => buildExportPhotosQuery([undefined as unknown as string]), /string visit IDs/);
  assert.throws(() => buildExportPhotosQuery(["valid"], null, 0), /page size/);
  assert.throws(() => buildExportPhotosQuery(["valid"], null, 1.5), /page size/);
  assert.throws(() => buildExportPhotosQuery(["valid"], null, EXPORT_PHOTO_PAGE_SIZE + 1), /page size/);
  assert.throws(
    () =>
      buildExportPhotosQuery(["valid"], {
        visitId: "valid",
        foodRank: 3,
        creationTime: 1,
        id: "photo",
      } as unknown as ExportPhotoCursor),
    /valid ordered photo key/,
  );
  assert.throws(
    () =>
      buildExportPhotosQuery(["valid"], {
        visitId: "valid",
        foodRank: 0,
        creationTime: Number.POSITIVE_INFINITY,
        id: "photo",
      }),
    /valid ordered photo key/,
  );
  assert.doesNotMatch(
    LEGACY_PHOTOS_SQL,
    /\bid\s+ASC\b/i,
    "the legacy oracle must transcribe the old undefined tie order",
  );
  assertWalSnapshotPreventsCursorRaces();

  const exactIds = [EDGE_VISIT_ID, "missing-id", EDGE_VISIT_ID, "", 'quote-"-and-\\slash\nline'];
  const exactQuery = buildExportPhotosQuery(exactIds, null, TEST_PAGE_SIZE);
  assert.ok(exactQuery);
  assert.deepEqual(exactQuery.parameters, [JSON.stringify(exactIds), TEST_PAGE_SIZE + 1]);
  assert.equal(exactQuery.parameters.length, 2);
  assert.equal(exactQuery.pageSize, TEST_PAGE_SIZE);
  assertExportQueryPlan(database, exactQuery, "first page");

  // One JSON ID bind must remain valid beyond SQLite's traditional variable
  // limit. A tiny page forces more than two independent keyset boundaries.
  const largeIds = Array.from({ length: 5_200 }, (_, index) => `missing-${index}-雪`);
  largeIds.splice(
    17,
    0,
    "visit-confirmed-rich",
    EDGE_VISIT_ID,
    TIE_ONLY_VISIT_ID,
    "visit-confirmed-rich",
    "visit-rejected-missing-restaurant",
    "visit-pending-no-restaurant",
    "",
  );
  largeIds.push(EDGE_VISIT_ID, TIE_ONLY_VISIT_ID, "missing-final", "visit-confirmed-rich");
  const expectedLargeRows = getIndependentOrderedRawPhotos(database, largeIds);
  const largeCandidate = getPhotosByVisitIdsCandidate(database, largeIds, TEST_PAGE_SIZE);
  const largeAudit = largeCandidate.paginationAudit;
  assert.ok(largeAudit.rawRowCounts.length > 2, "large-ID coverage must cross more than two SQL pages");
  assert.deepEqual(
    largeAudit.orderedPhotoIds,
    expectedLargeRows.map(({ id }) => id),
    "keyset pages must have no gaps and preserve the independent complete-key ordering",
  );
  assert.equal(new Set(largeAudit.orderedPhotoIds).size, largeAudit.orderedPhotoIds.length);
  assert.equal(
    largeAudit.emittedRowCounts.reduce((sum, count) => sum + count, 0),
    expectedLargeRows.length,
  );
  assert.ok(largeAudit.rawRowCounts.every((count) => count <= TEST_PAGE_SIZE + 1));
  assert.ok(largeAudit.emittedRowCounts.every((count) => count <= TEST_PAGE_SIZE));
  assert.equal(largeAudit.continuationCursors.length, largeAudit.rawRowCounts.length - 1);
  assert.equal(largeAudit.lookaheadContinuityChecks, largeAudit.rawRowCounts.length - 1);

  const firstContinuationCursor = largeAudit.continuationCursors[0];
  assert.ok(firstContinuationCursor);
  const continuationQuery = buildExportPhotosQuery(largeIds, firstContinuationCursor, TEST_PAGE_SIZE);
  assert.ok(continuationQuery);
  assert.deepEqual(continuationQuery.parameters, [
    JSON.stringify(largeIds),
    firstContinuationCursor.visitId,
    firstContinuationCursor.foodRank,
    firstContinuationCursor.creationTime,
    firstContinuationCursor.id,
    TEST_PAGE_SIZE + 1,
  ]);
  assert.match(continuationQuery.sql, /\(p\.visitId, CASE[\s\S]+p\.id\) > \(\?, \?, \?, \?\)/);
  assertExportQueryPlan(database, continuationQuery, "continuation page");

  // Equal-rank/equal-time ordering was undefined in the legacy SQL, so these
  // rows are excluded from byte parity and assert only the intentional new ID
  // tie-break plus set preservation.
  assert.equal(
    getVisitsLegacy(database, "all").some(({ id }) => id === TIE_ONLY_VISIT_ID),
    false,
  );
  const tieLegacyIds = getPhotosForVisitLegacy(database, TIE_ONLY_VISIT_ID).map(({ id }) => id);
  const tieCandidate = getPhotosByVisitIdsCandidate(database, [TIE_ONLY_VISIT_ID], 1);
  const tieCandidateIds = tieCandidate.paginationAudit.orderedPhotoIds;
  assert.deepEqual(tieCandidateIds, ["tie-a", "tie-m", "tie-z"]);
  assert.deepEqual([...tieLegacyIds].sort(), tieCandidateIds);
  assert.equal(tieCandidate.lookupCount, 3);
  assert.equal(tieCandidate.paginationAudit.lookaheadContinuityChecks, 2);

  // Prove the historical runtime bug separately from the corrected schema
  // oracle. The raw legacy object was typed as boolean but JSON contained 0/1.
  const rawLegacy = buildIndependentExport(database, "all", true, "raw-legacy");
  const correctedExpectedAll = buildIndependentExport(database, "all", true, "json-schema");
  const rawLegacyRichVisit = rawLegacy.data.visits.find(({ visitId }) => visitId === "visit-confirmed-rich");
  const rawLegacyPendingVisit = rawLegacy.data.visits.find(({ visitId }) => visitId === EDGE_VISIT_ID);
  const correctedRichVisit = correctedExpectedAll.data.visits.find(({ visitId }) => visitId === "visit-confirmed-rich");
  const correctedPendingVisit = correctedExpectedAll.data.visits.find(({ visitId }) => visitId === EDGE_VISIT_ID);
  assert.ok(rawLegacyRichVisit && rawLegacyPendingVisit && correctedRichVisit && correctedPendingVisit);
  assert.equal(typeof rawLegacyRichVisit.foodProbable, "number");
  assert.equal(rawLegacyRichVisit.foodProbable as unknown, 1);
  assert.equal(typeof rawLegacyRichVisit.calendarEvent.isAllDay, "number");
  assert.equal(rawLegacyRichVisit.calendarEvent.isAllDay as unknown, 0);
  assert.equal(rawLegacyPendingVisit.foodProbable as unknown, 0);
  assert.equal(correctedRichVisit.foodProbable, true);
  assert.equal(correctedRichVisit.calendarEvent.isAllDay, false);
  assert.equal(correctedPendingVisit.foodProbable, false);
  assert.equal(correctedPendingVisit.calendarEvent.isAllDay, null);

  const rawLegacyJson = independentJSONString(rawLegacy.data);
  const correctedExpectedJson = independentJSONString(correctedExpectedAll.data);
  const parsedRawLegacyJson = JSON.parse(rawLegacyJson) as {
    visits: Array<{ visitId: string; foodProbable: unknown; calendarEvent: { isAllDay: unknown } }>;
  };
  const parsedRawRichVisit = parsedRawLegacyJson.visits.find(({ visitId }) => visitId === "visit-confirmed-rich");
  assert.ok(parsedRawRichVisit);
  assert.equal(parsedRawRichVisit.foodProbable, 1);
  assert.equal(parsedRawRichVisit.calendarEvent.isAllDay, 0);
  assert.notEqual(rawLegacyJson, correctedExpectedJson, "the corrected JSON schema must not claim buggy legacy parity");

  for (const filter of FILTERS) {
    for (const includePhotos of [false, true]) {
      const expected = buildIndependentExport(database, filter, includePhotos, "json-schema");
      const candidate = buildCandidateExport(database, filter, includePhotos);
      const context = `${filter}, includePhotos=${includePhotos}`;

      assertNoLegacyUndefinedPhotoTies(expected.data, context);
      assert.deepEqual(candidate.data, expected.data, `full corrected-schema, no-tie data parity: ${context}`);
      assertByteParity(
        exportDataToJSONString(candidate.data),
        independentJSONString(expected.data),
        `JSON corrected-schema, no-tie oracle parity: ${context}`,
      );
      assertByteParity(
        exportDataToCSVString(candidate.data),
        independentCSVString(expected.data),
        `CSV independent-oracle parity: ${context}`,
      );

      assert.equal(expected.photoLookupCount, includePhotos ? expected.data.visits.length : 0);
      const loadedPhotoCount = expected.data.visits.reduce((sum, visit) => sum + visit.photos.length, 0);
      const expectedCandidateLookups =
        includePhotos && candidate.data.visits.length > 0
          ? Math.max(1, Math.ceil(loadedPhotoCount / TEST_PAGE_SIZE))
          : 0;
      assert.equal(candidate.photoLookupCount, expectedCandidateLookups);
      assert.equal(candidate.photoCountLookupCount, !includePhotos && candidate.data.visits.length > 0 ? 1 : 0);
      assert.equal(
        expected.restaurantLookupCount,
        getVisitsLegacy(database, filter).filter(({ restaurantId }) => Boolean(restaurantId)).length,
      );
      if (includePhotos) {
        assert.ok(candidate.paginationAudit);
        assert.equal(
          candidate.paginationAudit.emittedRowCounts.reduce((sum, count) => sum + count, 0),
          loadedPhotoCount,
        );
        assert.equal(candidate.paginationAudit.lookaheadContinuityChecks, Math.max(0, candidate.photoLookupCount - 1));
      } else {
        assert.equal(candidate.paginationAudit, null);
        assert.ok(candidate.data.visits.every((visit) => visit.photos.length === 0));
      }
    }
  }

  const candidateAll = buildCandidateExport(database, "all", true).data;
  const richVisit = candidateAll.visits.find(({ visitId }) => visitId === "visit-confirmed-rich");
  assert.ok(richVisit);
  assert.equal(richVisit.foodProbable, true);
  assert.equal(richVisit.calendarEvent.isAllDay, false);
  const parsedCandidateJson = JSON.parse(exportDataToJSONString(candidateAll)) as {
    visits: Array<{ visitId: string; foodProbable: unknown; calendarEvent: { isAllDay: unknown } }>;
  };
  const parsedCandidateRichVisit = parsedCandidateJson.visits.find(({ visitId }) => visitId === "visit-confirmed-rich");
  assert.ok(parsedCandidateRichVisit);
  assert.equal(parsedCandidateRichVisit.foodProbable, true);
  assert.equal(typeof parsedCandidateRichVisit.foodProbable, "boolean");
  assert.equal(parsedCandidateRichVisit.calendarEvent.isAllDay, false);
  assert.equal(typeof parsedCandidateRichVisit.calendarEvent.isAllDay, "boolean");
  assert.deepEqual(
    richVisit.photos.map(({ id }) => id),
    [
      "true-malformed-both",
      "true-late-video",
      "false-valid-food-malformed-all",
      "unknown-null-media",
      "unknown-empty-label-json",
    ],
  );
  const malformed = richVisit.photos.find(({ id }) => id === "true-malformed-both");
  assert.ok(malformed);
  assert.equal(malformed.foodLabels, null);
  assert.equal(malformed.allLabels, null);
  assert.equal(malformed.mediaType, "video");
  assert.equal(malformed.duration, null);
  const partiallyMalformed = richVisit.photos.find(({ id }) => id === "false-valid-food-malformed-all");
  assert.ok(partiallyMalformed);
  assert.deepEqual(partiallyMalformed.foodLabels, [{ label: "not food", confidence: 0.2 }]);
  assert.equal(partiallyMalformed.allLabels, null);
  const nullMedia = richVisit.photos.find(({ id }) => id === "unknown-null-media");
  assert.ok(nullMedia);
  assert.equal(nullMedia.mediaType, "photo");
  assert.equal(nullMedia.foodDetected, null);
  assert.equal(nullMedia.latitude, null);
  assert.equal(nullMedia.longitude, null);
  assert.equal(
    candidateAll.restaurants.some(({ id }) => id === "restaurant-unused"),
    false,
  );
  assert.equal(
    candidateAll.visits.find(({ visitId }) => visitId === "visit-rejected-missing-restaurant")?.restaurant,
    null,
  );

  const storedCounts = database
    .prepare("SELECT id, photoCount FROM visits WHERE status = ? ORDER BY id")
    .all("confirmed") as unknown as { readonly id: string; readonly photoCount: number }[];
  database.prepare("UPDATE visits SET photoCount = photoCount + 1000 WHERE status = ?").run("confirmed");
  try {
    const correctedCsvCandidate = buildCandidateExport(database, "confirmed", false);
    const exactRows = database
      .prepare(
        `SELECT v.id AS visitId, COUNT(p.visitId) AS photoCount
         FROM visits v
         LEFT JOIN photos p ON p.visitId = v.id
         WHERE v.status = ?
         GROUP BY v.id
         ORDER BY v.id`,
      )
      .all("confirmed") as unknown as { readonly visitId: string; readonly photoCount: number }[];
    assert.equal(correctedCsvCandidate.photoLookupCount, 0);
    assert.equal(correctedCsvCandidate.photoCountLookupCount, 1);
    assert.deepEqual(
      correctedCsvCandidate.data.visits
        .map((visit) => [visit.visitId, visit.photoCount] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
      exactRows.map((row) => [row.visitId, row.photoCount] as const),
      "CSV candidate must replace stale visit counts with the exact grouped query",
    );
    assert.equal(
      correctedCsvCandidate.data.stats.totalPhotos,
      exactRows.reduce((sum, row) => sum + row.photoCount, 0),
    );
  } finally {
    const restoreCount = database.prepare("UPDATE visits SET photoCount = ? WHERE id = ?");
    for (const row of storedCounts) {
      restoreCount.run(row.photoCount, row.id);
    }
  }

  console.log("Export batching tests passed.");
} finally {
  database.close();
}
