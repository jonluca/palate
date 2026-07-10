#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  buildExportPhotoCountsQuery,
  buildExportPhotosQuery,
  EXPORT_PHOTO_PAGE_SIZE,
  type ExportPhotoCursor,
} from "../utils/db/export-photos-core.ts";
import type { FoodLabel, PhotoRecord, RestaurantRecord, VisitRecord } from "../utils/db/types.ts";
import {
  buildExportDataFromVisits,
  buildExportPhoto,
  buildExportVisits,
  exportDataToCSVString,
  exportDataToJSONString,
  type ExportData,
  withExactExportPhotoCounts,
} from "../utils/export-core.ts";

interface Configuration {
  visits: number;
  photos: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
  skipMemoryProfile: boolean;
}

interface RawVisitRow {
  readonly id: string;
  readonly restaurantId: string;
  readonly suggestedRestaurantId: string | null;
  readonly status: "confirmed";
  readonly startTime: number;
  readonly endTime: number;
  readonly centerLat: number;
  readonly centerLon: number;
  readonly photoCount: number;
  readonly foodProbable: number;
  readonly calendarEventId: string | null;
  readonly calendarEventTitle: string | null;
  readonly calendarEventLocation: string | null;
  readonly calendarEventIsAllDay: number | null;
  readonly exportedToCalendarId: string | null;
  readonly notes: string | null;
  readonly updatedAt: number | null;
  readonly awardAtVisit: string | null;
}

interface RawPhotoRecord extends Omit<
  PhotoRecord,
  "foodLabels" | "foodDetected" | "foodConfidence" | "allLabels" | "mediaType"
> {
  readonly foodLabels: string | null;
  readonly foodDetected: number | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly mediaType: string | null;
}

interface Dataset {
  readonly visits: readonly RawVisitRow[];
  readonly restaurants: readonly RestaurantRecord[];
  readonly photos: readonly RawPhotoRecord[];
  readonly visitedRestaurantCount: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface Execution {
  readonly output: string;
  readonly sqliteCalls: number;
  readonly photoQueryCalls: number;
  readonly maximumPhotoQueryRows: number;
  readonly maximumPhotoPageRows: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly sqliteCalls: number;
  readonly photoQueryCalls: number;
  readonly maximumPhotoQueryRows: number;
  readonly maximumPhotoPageRows: number;
}

interface ParserParity {
  readonly rowsCompared: number;
  readonly parsedRowsSha256: string;
}

interface BooleanSchemaAudit {
  readonly visitsChecked: number;
  readonly rawSQLiteFoodProbableIntegerRows: number;
  readonly rawSQLiteCalendarEventIntegerRows: number;
  readonly foodProbable: { readonly true: number; readonly false: number };
  readonly calendarEventIsAllDay: { readonly true: number; readonly false: number; readonly null: number };
}

interface RunAudit extends Measurement {
  readonly phase: "oracle" | "validation" | "warmup" | "sample";
  readonly iteration: number;
}

interface MemoryChildResult {
  readonly strategy: Strategy;
  readonly sha256: string;
  readonly bytes: number;
  readonly sqliteCalls: number;
  readonly photoQueryCalls: number;
  readonly maximumPhotoQueryRows: number;
  readonly maximumPhotoPageRows: number;
  readonly elapsedMilliseconds: number;
  readonly resourceUsageMaxRSSKiB: number;
  readonly rssBytesAtCompletion: number;
  readonly heapUsedBytesAtCompletion: number;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly node: string;
}

type Format = "jsonIncludePhotos" | "csvWithoutPhotos";
type Strategy = "legacyNPlusOne" | "batchedCandidate";

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 4_000,
  photos: 68_030,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/export-batching-profile.json",
  skipMemoryProfile: false,
};
const EXPORTED_AT = "2026-07-08T12:34:56.789Z";
const BASE_TIME = 1_765_000_000_000;
const VISITS_SQL = "SELECT * FROM visits WHERE status = ? ORDER BY startTime DESC";
const RESTAURANTS_SQL = "SELECT * FROM restaurants";
const RESTAURANT_BY_ID_SQL = "SELECT * FROM restaurants WHERE id = ?";
const LEGACY_PHOTOS_SQL = `SELECT * FROM photos WHERE visitId = ? ORDER BY
  CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
  creationTime ASC`;
const MEMORY_PROFILE_VISITS = 4_000;
const MEMORY_PROFILE_PHOTOS = 68_030;

process.env.TZ = "UTC";

function usage(): string {
  return `Usage: benchmark-export-batching.ts [options]

  --visits=N       Confirmed visits (default: ${DEFAULT_CONFIGURATION.visits})
  --photos=N       Photos spread across visits (default: ${DEFAULT_CONFIGURATION.photos})
  --samples=N      Measured strategy pairs per format (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy pairs per format (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --skip-memory    Skip isolated 4,000-visit/68,030-photo peak-memory children
  --help, -h       Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === "--skip-memory") {
      configuration.skipMemoryProfile = true;
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--visits":
        configuration.visits = parseInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parseInteger(value, option, true);
        break;
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function visitId(index: number): string {
  switch (index) {
    case 0:
      return "visit-O'Brien";
    case 1:
      return "訪問-東京-🍣";
    case 2:
      return 'visit-"quoted"-\\path';
    case 3:
      return "visit-line\nbreak";
    default:
      return `visit-${index.toString().padStart(6, "0")}`;
  }
}

function restaurantId(index: number): string {
  switch (index) {
    case 0:
      return "restaurant-O'Brien";
    case 1:
      return "restaurant-東京-🍜";
    case 2:
      return 'restaurant-"quoted"-\\path';
    default:
      return `restaurant-${index.toString().padStart(4, "0")}`;
  }
}

function photoId(index: number): string {
  switch (index) {
    case 0:
      return "photo-O'Brien";
    case 1:
      return "photo-雪-📷";
    case 2:
      return 'photo-"quoted"-\\path';
    default:
      return `photo-${index.toString().padStart(7, "0")}`;
  }
}

function serializedLabels(index: number, allLabels: boolean, labelCount = 1, includeEdgeCases = true): string | null {
  const selector = (index + (allLabels ? 3 : 0)) % 17;
  if (includeEdgeCases) {
    if (selector === 0) {
      return null;
    }
    if (selector === 1) {
      return "";
    }
    if (selector === 2) {
      return '{"malformed":';
    }
  }
  const labels: FoodLabel[] = Array.from({ length: labelCount }, (_, labelIndex) => ({
    label: allLabels ? `scene-${index % 13}-${labelIndex}` : `food-${index % 11}-${labelIndex}`,
    confidence: Number((0.51 + ((index + labelIndex) % 47) / 100).toFixed(2)),
  }));
  if (includeEdgeCases && selector === 3) {
    labels.push({ label: '寿司, "chef"\n雪', confidence: 0.999 });
  }
  return JSON.stringify(labels);
}

function createDataset(
  visitCount: number,
  photoCount: number,
  labelOptions: { readonly labelCount?: number; readonly includeEdgeCases?: boolean } = {},
): Dataset {
  const { labelCount = 1, includeEdgeCases = true } = labelOptions;
  const visitedRestaurantCount = Math.max(1, Math.min(visitCount, 503));
  const totalRestaurantCount = visitedRestaurantCount + 7;
  const restaurants: RestaurantRecord[] = Array.from({ length: totalRestaurantCount }, (_, index) => ({
    id: restaurantId(index),
    name: index === 0 ? 'Chez "Comma", O\'Brien\n雪' : `Restaurant ${index.toString().padStart(4, "0")}`,
    latitude: 34 + (index % 700) / 1_000,
    longitude: -118 - (index % 900) / 1_000,
    address: index % 7 === 0 ? null : `${index} Main St, Suite "${index % 19}"`,
    phone: index % 11 === 0 ? null : `+1-555-${(1_000 + index).toString()}`,
    website: index % 13 === 0 ? null : `https://example.test/restaurants/${encodeURIComponent(restaurantId(index))}`,
    googlePlaceId: index % 5 === 0 ? null : `google-${index}`,
    cuisine: index % 9 === 0 ? "日本料理" : `Cuisine ${index % 23}`,
    priceLevel: index % 6 === 0 ? null : (index % 4) + 1,
    rating: index % 10 === 0 ? null : Number((3.5 + (index % 15) / 10).toFixed(1)),
    notes: index % 8 === 0 ? null : `Restaurant note ${index}, "quoted"`,
  }));

  const basePhotosPerVisit = Math.floor(photoCount / visitCount);
  const visitsWithExtraPhoto = photoCount % visitCount;
  const visits: RawVisitRow[] = Array.from({ length: visitCount }, (_, index) => {
    const startTime = BASE_TIME - index * 86_400_000;
    return {
      id: visitId(index),
      restaurantId: restaurantId(index % visitedRestaurantCount),
      suggestedRestaurantId: index % 4 === 0 ? `michelin-${index % 97}` : null,
      status: "confirmed",
      startTime,
      endTime: startTime + (30 + (index % 151)) * 60_000,
      centerLat: 33.9 + (index % 1_000) / 10_000,
      centerLon: -118.5 + (index % 1_300) / 10_000,
      photoCount: basePhotosPerVisit + (index < visitsWithExtraPhoto ? 1 : 0),
      foodProbable: index % 3 === 0 ? 1 : 0,
      calendarEventId: index % 6 === 0 ? `calendar-${index}` : null,
      calendarEventTitle: index % 6 === 0 ? `Dinner, "table ${index}"` : null,
      calendarEventLocation: index % 12 === 0 ? "東京, CA\nUpstairs" : null,
      calendarEventIsAllDay: index % 6 === 0 ? (Math.floor(index / 6) % 2 === 0 ? 1 : 0) : null,
      exportedToCalendarId: index % 10 === 0 ? `exported-calendar-${index}` : null,
      notes: index % 7 === 0 ? 'Chef\'s counter, "omakase"\n雪' : null,
      updatedAt: index % 29 === 0 ? null : startTime + 12_345,
      awardAtVisit: index % 5 === 0 ? `${(index % 3) + 1} Star` : null,
    };
  });

  const photos: RawPhotoRecord[] = Array.from({ length: photoCount }, (_, index) => {
    const visitIndex = index % visitCount;
    const ordinalWithinVisit = Math.floor(index / visitCount);
    const rawMediaType = index % 19 === 0 ? null : index % 7 === 0 ? "video" : index % 23 === 0 ? "live" : "photo";
    return {
      id: photoId(index),
      uri: index === 0 ? 'ph://asset/雪?quote="yes"&comma=1' : `ph://asset/${index.toString().padStart(7, "0")}`,
      // Keep the scaled parity fixture free of equal-rank/equal-time ambiguity.
      // The production candidate still adds ID as an intentional stable tie-break.
      creationTime: visits[visitIndex]!.startTime + ordinalWithinVisit * 60_000,
      latitude: index % 31 === 0 ? null : 33.9 + (index % 1_500) / 10_000,
      longitude: index % 37 === 0 ? null : -118.5 + (index % 1_700) / 10_000,
      visitId: visits[visitIndex]!.id,
      foodDetected: index % 5 === 0 ? null : index % 3 === 0 ? 1 : 0,
      foodLabels: serializedLabels(index, false, labelCount, includeEdgeCases),
      foodConfidence: index % 5 === 0 ? null : Number((0.4 + (index % 59) / 100).toFixed(2)),
      allLabels: serializedLabels(index, true, labelCount, includeEdgeCases),
      mediaType: rawMediaType,
      duration: rawMediaType === "video" ? Number((1 + (index % 240) / 10).toFixed(1)) : null,
    };
  });

  assert.equal(photos.length, photoCount);
  assert.equal(
    visits.reduce((sum, visit) => sum + visit.photoCount, 0),
    photoCount,
  );
  assert.ok(visits.every((visit) => restaurants.some((restaurant) => restaurant.id === visit.restaurantId)));

  return { visits, restaurants, photos, visitedRestaurantCount };
}

function createDatabase(dataset: Dataset, path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -131072;

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
      notes TEXT,
      updatedAt INTEGER,
      exportedToCalendarId TEXT,
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

    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_photos_visit ON photos(visitId);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
  `);

  const insertRestaurant = database.prepare("INSERT INTO restaurants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPhoto = database.prepare("INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

  database.exec("BEGIN");
  try {
    for (const restaurant of dataset.restaurants) {
      insertRestaurant.run(
        restaurant.id,
        restaurant.name,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.address,
        restaurant.phone,
        restaurant.website,
        restaurant.googlePlaceId,
        restaurant.cuisine,
        restaurant.priceLevel,
        restaurant.rating,
        restaurant.notes,
      );
    }
    for (const visit of dataset.visits) {
      insertVisit.run(
        visit.id,
        visit.restaurantId,
        visit.suggestedRestaurantId,
        visit.status,
        visit.startTime,
        visit.endTime,
        visit.centerLat,
        visit.centerLon,
        visit.photoCount,
        visit.foodProbable,
        visit.calendarEventId,
        visit.calendarEventTitle,
        visit.calendarEventLocation,
        visit.calendarEventIsAllDay,
        visit.notes,
        visit.updatedAt,
        visit.exportedToCalendarId,
        visit.awardAtVisit,
      );
    }
    for (const photo of dataset.photos) {
      insertPhoto.run(
        photo.id,
        photo.uri,
        photo.creationTime,
        photo.latitude,
        photo.longitude,
        photo.visitId,
        photo.foodDetected,
        photo.foodLabels,
        photo.foodConfidence,
        photo.allLabels,
        photo.mediaType,
        photo.duration,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return database;
}

function parseLegacyPhotoRecord(raw: RawPhotoRecord): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    try {
      foodLabels = JSON.parse(raw.foodLabels) as FoodLabel[];
    } catch {
      // Preserve the legacy behavior: malformed label payloads are ignored.
    }
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    try {
      allLabels = JSON.parse(raw.allLabels) as FoodLabel[];
    } catch {
      // Preserve the legacy behavior: malformed label payloads are ignored.
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

function parseBatchedPhotoRecord(raw: RawPhotoRecord): PhotoRecord {
  const parseLabels = (serialized: string | null): FoodLabel[] | null => {
    if (!serialized) {
      return null;
    }
    try {
      return JSON.parse(serialized) as FoodLabel[];
    } catch {
      return null;
    }
  };

  return Object.assign({}, raw, {
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels: parseLabels(raw.foodLabels),
    allLabels: parseLabels(raw.allLabels),
    mediaType: raw.mediaType === "video" ? ("video" as const) : ("photo" as const),
  });
}

function asVisitRecords(rows: readonly Record<string, unknown>[]): VisitRecord[] {
  // Preserve Expo SQLite's raw INTEGER-backed 0/1 values here so the
  // independent reference and production assembly each normalize them at
  // their public-schema boundary.
  return rows.map((row) => ({ ...row })) as unknown as VisitRecord[];
}

function asRestaurantRecords(rows: readonly Record<string, unknown>[]): RestaurantRecord[] {
  return rows.map((row) => ({ ...row })) as unknown as RestaurantRecord[];
}

function asRawPhotoRecords(rows: readonly Record<string, unknown>[]): RawPhotoRecord[] {
  return rows.map((row) => ({ ...row })) as unknown as RawPhotoRecord[];
}

function legacyFormatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0]!;
}

function legacyFormatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function legacyFormatDuration(start: number, end: number): string {
  const differenceMinutes = Math.round((end - start) / (1_000 * 60));
  if (differenceMinutes < 60) {
    return `${differenceMinutes} minutes`;
  }
  const hours = Math.floor(differenceMinutes / 60);
  const minutes = differenceMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours} hours`;
}

/** Independently assemble the corrected public schema using the legacy N+1 reads. */
function buildCorrectedReferenceExportData(
  visits: readonly VisitRecord[],
  allRestaurants: readonly RestaurantRecord[],
  restaurantsByVisitId: ReadonlyMap<string, RestaurantRecord | null>,
  photosByVisitId: ReadonlyMap<string, readonly PhotoRecord[]>,
): ExportData {
  const restaurantVisitCounts = new Map<string, number>();
  const exportedVisits = visits.map((visit) => {
    const restaurant = restaurantsByVisitId.get(visit.id) ?? null;
    if (restaurant) {
      restaurantVisitCounts.set(restaurant.id, (restaurantVisitCounts.get(restaurant.id) || 0) + 1);
    }
    const photos = photosByVisitId.get(visit.id) ?? [];
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
      visitDate: legacyFormatDate(visit.startTime),
      startTime: legacyFormatTime(visit.startTime),
      endTime: legacyFormatTime(visit.endTime),
      duration: legacyFormatDuration(visit.startTime, visit.endTime),
      startTimestamp: visit.startTime,
      endTimestamp: visit.endTime,
      location: {
        latitude: visit.centerLat,
        longitude: visit.centerLon,
      },
      photoCount: visit.photoCount,
      foodProbable: Boolean(visit.foodProbable),
      awardAtVisit: visit.awardAtVisit,
      notes: visit.notes,
      calendarEvent: {
        id: visit.calendarEventId,
        title: visit.calendarEventTitle,
        location: visit.calendarEventLocation,
        isAllDay: visit.calendarEventIsAllDay === null ? null : Boolean(visit.calendarEventIsAllDay),
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

  const visitedRestaurantIds = new Set(exportedVisits.map((visit) => visit.restaurant?.id).filter(Boolean));
  const restaurants = allRestaurants
    .filter((restaurant) => visitedRestaurantIds.has(restaurant.id))
    .map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      visitCount: restaurantVisitCounts.get(restaurant.id) || 0,
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
    exportedAt: EXPORTED_AT,
    stats: {
      totalVisits: exportedVisits.length,
      confirmedVisits: exportedVisits.filter((visit) => visit.status === "confirmed").length,
      totalPhotos: exportedVisits.reduce((sum, visit) => sum + visit.photoCount, 0),
      uniqueRestaurants: restaurants.length,
    },
    visits: exportedVisits,
    restaurants,
  };
}

function referenceJSONString(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

function referenceCSVString(data: ExportData): string {
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
  return [headers.join(","), ...rows.map((row) => row.map((cell) => `"${cell}"`).join(","))].join("\n");
}

function runLegacy(database: DatabaseSync, format: Format): Execution {
  let sqliteCalls = 0;
  let photoQueryCalls = 0;
  let maximumPhotoQueryRows = 0;
  const visitRows = database.prepare(VISITS_SQL).all("confirmed") as Record<string, unknown>[];
  sqliteCalls += 1;
  const visits = asVisitRecords(visitRows);
  const restaurantRows = database.prepare(RESTAURANTS_SQL).all() as Record<string, unknown>[];
  sqliteCalls += 1;
  const allRestaurants = asRestaurantRecords(restaurantRows);
  const restaurantsByVisitId = new Map<string, RestaurantRecord | null>();
  const photosByVisitId = new Map<string, PhotoRecord[]>();

  for (const visit of visits) {
    const restaurantRow = database.prepare(RESTAURANT_BY_ID_SQL).get(visit.restaurantId!) as
      | Record<string, unknown>
      | undefined;
    sqliteCalls += 1;
    restaurantsByVisitId.set(visit.id, restaurantRow ? asRestaurantRecords([restaurantRow])[0]! : null);

    if (format === "jsonIncludePhotos") {
      const rawPhotos = asRawPhotoRecords(
        database.prepare(LEGACY_PHOTOS_SQL).all(visit.id) as Record<string, unknown>[],
      );
      sqliteCalls += 1;
      photoQueryCalls += 1;
      maximumPhotoQueryRows = Math.max(maximumPhotoQueryRows, rawPhotos.length);
      photosByVisitId.set(visit.id, rawPhotos.map(parseLegacyPhotoRecord));
    }
  }

  const data = buildCorrectedReferenceExportData(visits, allRestaurants, restaurantsByVisitId, photosByVisitId);
  return {
    output: format === "jsonIncludePhotos" ? referenceJSONString(data) : referenceCSVString(data),
    sqliteCalls,
    photoQueryCalls,
    maximumPhotoQueryRows,
    maximumPhotoPageRows: maximumPhotoQueryRows,
  };
}

function runCandidate(database: DatabaseSync, format: Format): Execution {
  let sqliteCalls = 0;
  let photoQueryCalls = 0;
  let maximumPhotoQueryRows = 0;
  let maximumPhotoPageRows = 0;
  const visitRows = database.prepare(VISITS_SQL).all("confirmed") as Record<string, unknown>[];
  sqliteCalls += 1;
  const visits = asVisitRecords(visitRows);
  const restaurantRows = database.prepare(RESTAURANTS_SQL).all() as Record<string, unknown>[];
  sqliteCalls += 1;
  const restaurants = asRestaurantRecords(restaurantRows);
  let exportVisits = buildExportVisits({ visits, restaurants, photosByVisitId: new Map() });
  const visitIds = visits.map((visit) => visit.id);

  if (format === "jsonIncludePhotos" && visits.length > 0) {
    const exportVisitsById = new Map(exportVisits.map((visit) => [visit.visitId, visit]));
    let cursor: ExportPhotoCursor | null = null;

    do {
      const photoQuery = buildExportPhotosQuery(visitIds, cursor);
      assert.ok(photoQuery);
      const rawPhotos = asRawPhotoRecords(
        database.prepare(photoQuery.sql).all(...photoQuery.parameters) as Record<string, unknown>[],
      );
      sqliteCalls += 1;
      photoQueryCalls += 1;
      maximumPhotoQueryRows = Math.max(maximumPhotoQueryRows, rawPhotos.length);

      const hasNextPage = rawPhotos.length > photoQuery.pageSize;
      const pageRows = hasNextPage ? rawPhotos.slice(0, photoQuery.pageSize) : rawPhotos;
      maximumPhotoPageRows = Math.max(maximumPhotoPageRows, pageRows.length);
      for (const rawPhoto of pageRows) {
        const exportVisit = rawPhoto.visitId === null ? null : exportVisitsById.get(rawPhoto.visitId);
        if (!exportVisit) {
          throw new Error(`Export photo ${rawPhoto.id} did not match a requested visit.`);
        }
        exportVisit.photos.push(buildExportPhoto(parseBatchedPhotoRecord(rawPhoto)));
      }

      if (hasNextPage) {
        const lastPhoto = pageRows.at(-1);
        assert.ok(lastPhoto?.visitId);
        cursor = {
          visitId: lastPhoto.visitId,
          foodRank: lastPhoto.foodDetected === 1 ? 0 : lastPhoto.foodDetected === 0 ? 1 : 2,
          creationTime: lastPhoto.creationTime,
          id: lastPhoto.id,
        };
      } else {
        cursor = null;
      }
    } while (cursor !== null);
  }

  const exactPhotoCounts = new Map<string, number>();
  if (format === "jsonIncludePhotos") {
    for (const visit of exportVisits) {
      exactPhotoCounts.set(visit.visitId, visit.photos.length);
    }
  } else {
    const countQuery = buildExportPhotoCountsQuery(visitIds);
    if (countQuery) {
      const countRows = database.prepare(countQuery.sql).all(...countQuery.parameters) as unknown as {
        readonly visitId: string;
        readonly photoCount: number;
      }[];
      sqliteCalls += 1;
      for (const row of countRows) {
        exactPhotoCounts.set(row.visitId, row.photoCount);
      }
    }
  }
  exportVisits = withExactExportPhotoCounts(exportVisits, exactPhotoCounts);

  const data = buildExportDataFromVisits({ visits: exportVisits, restaurants, exportedAt: EXPORTED_AT });
  return {
    output: format === "jsonIncludePhotos" ? exportDataToJSONString(data) : exportDataToCSVString(data),
    sqliteCalls,
    photoQueryCalls,
    maximumPhotoQueryRows,
    maximumPhotoPageRows,
  };
}

function expectedPhotoQueryCalls(format: Format, strategy: Strategy, visitCount: number, photoCount: number): number {
  if (format !== "jsonIncludePhotos" || visitCount === 0) {
    return 0;
  }
  if (strategy === "legacyNPlusOne") {
    return visitCount;
  }
  return Math.max(1, Math.ceil(photoCount / EXPORT_PHOTO_PAGE_SIZE));
}

function expectedCalls(format: Format, strategy: Strategy, visitCount: number, photoCount: number): number {
  if (strategy === "batchedCandidate") {
    const exactCountQueries = format === "csvWithoutPhotos" && visitCount > 0 ? 1 : 0;
    return 2 + exactCountQueries + expectedPhotoQueryCalls(format, strategy, visitCount, photoCount);
  }
  return 2 + visitCount + (format === "jsonIncludePhotos" ? visitCount : 0);
}

function countLegacyOrderingTieGroups(dataset: Dataset): number {
  const orderingKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const photo of dataset.photos) {
    const foodRank = photo.foodDetected === 1 ? 0 : photo.foodDetected === 0 ? 1 : 2;
    const key = `${photo.visitId ?? "<null>"}\u0000${foodRank}\u0000${photo.creationTime}`;
    if (orderingKeys.has(key)) {
      duplicateKeys.add(key);
    } else {
      orderingKeys.add(key);
    }
  }
  return duplicateKeys.size;
}

function execute(
  dataset: Dataset,
  format: Format,
  strategy: Strategy,
  expectedOutput: string | null,
): Measurement & { readonly output: string } {
  const database = createDatabase(dataset);
  try {
    const startedAt = performance.now();
    const execution = strategy === "legacyNPlusOne" ? runLegacy(database, format) : runCandidate(database, format);
    const elapsedMilliseconds = performance.now() - startedAt;
    const bytes = Buffer.byteLength(execution.output, "utf8");
    const sha256 = createHash("sha256").update(execution.output).digest("hex");

    assert.equal(execution.sqliteCalls, expectedCalls(format, strategy, dataset.visits.length, dataset.photos.length));
    assert.equal(
      execution.photoQueryCalls,
      expectedPhotoQueryCalls(format, strategy, dataset.visits.length, dataset.photos.length),
    );
    if (expectedOutput !== null) {
      assert.equal(execution.output, expectedOutput, `${format}/${strategy} output lost exact byte parity`);
    }
    return { ...execution, elapsedMilliseconds, bytes, sha256 };
  } finally {
    database.close();
  }
}

function validatePhotoParserParity(dataset: Dataset): ParserParity {
  const database = createDatabase(dataset);
  try {
    const rows = asRawPhotoRecords(
      database.prepare("SELECT * FROM photos ORDER BY id ASC").all() as Record<string, unknown>[],
    );
    const digest = createHash("sha256");
    for (const row of rows) {
      const legacy = parseLegacyPhotoRecord(row);
      const candidate = parseBatchedPhotoRecord(row);
      assert.deepEqual(candidate, legacy, `raw photo parser parity failed for ${row.id}`);
      digest.update(JSON.stringify(candidate));
      digest.update("\n");
    }
    return {
      rowsCompared: rows.length,
      parsedRowsSha256: digest.digest("hex"),
    };
  } finally {
    database.close();
  }
}

function validateCorrectedBooleanSchema(dataset: Dataset, jsonOutput: string): BooleanSchemaAudit {
  const parsed = JSON.parse(jsonOutput) as {
    readonly visits: readonly {
      readonly visitId: string;
      readonly foodProbable: unknown;
      readonly calendarEvent: { readonly isAllDay: unknown };
    }[];
  };
  assert.equal(parsed.visits.length, dataset.visits.length);
  const rawVisitsById = new Map(dataset.visits.map((visit) => [visit.id, visit]));
  let foodProbableTrue = 0;
  let foodProbableFalse = 0;
  let calendarEventTrue = 0;
  let calendarEventFalse = 0;
  let calendarEventNull = 0;

  for (const exportedVisit of parsed.visits) {
    const rawVisit = rawVisitsById.get(exportedVisit.visitId);
    assert.ok(rawVisit);
    assert.equal(typeof exportedVisit.foodProbable, "boolean");
    assert.equal(exportedVisit.foodProbable, Boolean(rawVisit.foodProbable));
    if (exportedVisit.foodProbable) {
      foodProbableTrue += 1;
    } else {
      foodProbableFalse += 1;
    }

    const isAllDay = exportedVisit.calendarEvent.isAllDay;
    const expectedIsAllDay = rawVisit.calendarEventIsAllDay === null ? null : Boolean(rawVisit.calendarEventIsAllDay);
    assert.equal(isAllDay, expectedIsAllDay);
    if (isAllDay === null) {
      calendarEventNull += 1;
    } else {
      assert.equal(typeof isAllDay, "boolean");
      if (isAllDay) {
        calendarEventTrue += 1;
      } else {
        calendarEventFalse += 1;
      }
    }
  }

  return {
    visitsChecked: parsed.visits.length,
    rawSQLiteFoodProbableIntegerRows: dataset.visits.filter(
      (visit) => visit.foodProbable === 0 || visit.foodProbable === 1,
    ).length,
    rawSQLiteCalendarEventIntegerRows: dataset.visits.filter(
      (visit) => visit.calendarEventIsAllDay === 0 || visit.calendarEventIsAllDay === 1,
    ).length,
    foodProbable: { true: foodProbableTrue, false: foodProbableFalse },
    calendarEventIsAllDay: {
      true: calendarEventTrue,
      false: calendarEventFalse,
      null: calendarEventNull,
    },
  };
}

function summarize(samples: readonly number[]): MeasurementSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: median,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function recordAudit(
  audits: Record<Format, Record<Strategy, RunAudit[]>>,
  format: Format,
  strategy: Strategy,
  measurement: Measurement,
  phase: RunAudit["phase"],
  iteration: number,
): void {
  audits[format][strategy].push({
    phase,
    iteration,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    sha256: measurement.sha256,
    bytes: measurement.bytes,
    sqliteCalls: measurement.sqliteCalls,
    photoQueryCalls: measurement.photoQueryCalls,
    maximumPhotoQueryRows: measurement.maximumPhotoQueryRows,
    maximumPhotoPageRows: measurement.maximumPhotoPageRows,
  });
}

function internalArgument(name: string): string | null {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function runMemoryChildIfRequested(): void {
  const strategyValue = internalArgument("memory-child");
  if (strategyValue === null) {
    return;
  }
  if (strategyValue !== "legacyNPlusOne" && strategyValue !== "batchedCandidate") {
    throw new Error(`Invalid memory child strategy: ${strategyValue}`);
  }
  const databasePath = internalArgument("memory-database");
  if (!databasePath) {
    throw new Error("Memory child requires --memory-database=PATH.");
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const startedAt = performance.now();
    const execution =
      strategyValue === "legacyNPlusOne"
        ? runLegacy(database, "jsonIncludePhotos")
        : runCandidate(database, "jsonIncludePhotos");
    const elapsedMilliseconds = performance.now() - startedAt;
    const memory = process.memoryUsage();
    const resourceUsage = process.resourceUsage();
    const result: MemoryChildResult = {
      strategy: strategyValue,
      sha256: createHash("sha256").update(execution.output).digest("hex"),
      bytes: Buffer.byteLength(execution.output, "utf8"),
      sqliteCalls: execution.sqliteCalls,
      photoQueryCalls: execution.photoQueryCalls,
      maximumPhotoQueryRows: execution.maximumPhotoQueryRows,
      maximumPhotoPageRows: execution.maximumPhotoPageRows,
      elapsedMilliseconds,
      resourceUsageMaxRSSKiB: resourceUsage.maxRSS,
      rssBytesAtCompletion: memory.rss,
      heapUsedBytesAtCompletion: memory.heapUsed,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    };
    console.log(JSON.stringify(result));
  } finally {
    database.close();
  }
  process.exit(0);
}

function parseMemoryChildResult(stdout: string, strategy: Strategy): MemoryChildResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Could not parse ${strategy} memory child output: ${String(error)}`, { cause: error });
  }
  assert.ok(parsed && typeof parsed === "object");
  const result = parsed as MemoryChildResult;
  assert.equal(result.strategy, strategy);
  assert.equal(typeof result.sha256, "string");
  assert.equal(typeof result.resourceUsageMaxRSSKiB, "number");
  return result;
}

function runMemoryChild(databasePath: string, strategy: Strategy): MemoryChildResult {
  const child = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      fileURLToPath(import.meta.url),
      `--memory-child=${strategy}`,
      `--memory-database=${databasePath}`,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(
      `${strategy} memory child failed (status ${String(child.status)}, signal ${String(child.signal)}): ${child.stderr}`,
    );
  }
  return parseMemoryChildResult(child.stdout, strategy);
}

function profilePeakMemory(): {
  readonly fixture: {
    readonly visits: number;
    readonly photos: number;
    readonly foodLabelsPerPayload: number;
    readonly allLabelsPerPayload: number;
  };
  readonly legacyNPlusOne: MemoryChildResult;
  readonly batchedCandidate: MemoryChildResult;
  readonly candidateToLegacyMaxRSSRatio: number;
  readonly exactOutputParity: true;
  readonly scope: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "palate-export-memory-"));
  const databasePath = join(directory, "memory-profile.sqlite");
  try {
    // Seed once outside both measured children. The temporary dataset becomes
    // unreachable after this block and no duplicate export/oracle string is retained.
    (() => {
      const memoryDataset = createDataset(MEMORY_PROFILE_VISITS, MEMORY_PROFILE_PHOTOS, {
        labelCount: 13,
        includeEdgeCases: false,
      });
      const seedDatabase = createDatabase(memoryDataset, databasePath);
      seedDatabase.close();
    })();

    const legacyNPlusOne = runMemoryChild(databasePath, "legacyNPlusOne");
    const batchedCandidate = runMemoryChild(databasePath, "batchedCandidate");
    assert.equal(batchedCandidate.sha256, legacyNPlusOne.sha256);
    assert.equal(batchedCandidate.bytes, legacyNPlusOne.bytes);
    assert.ok(batchedCandidate.maximumPhotoPageRows <= EXPORT_PHOTO_PAGE_SIZE);
    assert.ok(batchedCandidate.maximumPhotoQueryRows <= EXPORT_PHOTO_PAGE_SIZE + 1);

    return {
      fixture: {
        visits: MEMORY_PROFILE_VISITS,
        photos: MEMORY_PROFILE_PHOTOS,
        foodLabelsPerPayload: 13,
        allLabelsPerPayload: 13,
      },
      legacyNPlusOne,
      batchedCandidate,
      candidateToLegacyMaxRSSRatio:
        batchedCandidate.resourceUsageMaxRSSKiB / Math.max(legacyNPlusOne.resourceUsageMaxRSSKiB, 1),
      exactOutputParity: true,
      scope:
        "Each strategy runs in a fresh Node child against the same pre-seeded read-only SQLite file containing 13 foodLabels and 13 allLabels entries per photo. process.resourceUsage().maxRSS is reported in Node-documented KiB for this host platform; values include Node, V8, SQLite page cache, parsed export objects, and the final serialized JSON string, but exclude fixture seeding and Expo/native bridge memory. Compare children from the same platform/runtime only.",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

runMemoryChildIfRequested();

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const peakMemory = configuration.skipMemoryProfile ? null : profilePeakMemory();

const dataset = createDataset(configuration.visits, configuration.photos);
const legacyOrderingTieGroups = countLegacyOrderingTieGroups(dataset);
assert.equal(legacyOrderingTieGroups, 0, "scaled parity fixture must not rely on unspecified legacy tie ordering");
const parserParity = validatePhotoParserParity(dataset);
assert.equal(parserParity.rowsCompared, configuration.photos);

const formats: readonly Format[] = ["jsonIncludePhotos", "csvWithoutPhotos"];
const strategies: readonly Strategy[] = ["legacyNPlusOne", "batchedCandidate"];
const expectedOutputs = new Map<Format, string>();
const audits: Record<Format, Record<Strategy, RunAudit[]>> = {
  jsonIncludePhotos: { legacyNPlusOne: [], batchedCandidate: [] },
  csvWithoutPhotos: { legacyNPlusOne: [], batchedCandidate: [] },
};

for (const format of formats) {
  const oracle = execute(dataset, format, "legacyNPlusOne", null);
  expectedOutputs.set(format, oracle.output);
  recordAudit(audits, format, "legacyNPlusOne", oracle, "oracle", 0);
  const validation = execute(dataset, format, "batchedCandidate", oracle.output);
  assert.equal(validation.sha256, oracle.sha256);
  assert.equal(validation.bytes, oracle.bytes);
  recordAudit(audits, format, "batchedCandidate", validation, "validation", 0);
}

const booleanSchemaAudit = validateCorrectedBooleanSchema(dataset, expectedOutputs.get("jsonIncludePhotos")!);

for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
  for (const [formatIndex, format] of formats.entries()) {
    const order = (iteration + formatIndex) % 2 === 0 ? strategies : ([...strategies].reverse() as Strategy[]);
    for (const strategy of order) {
      const measurement = execute(dataset, format, strategy, expectedOutputs.get(format)!);
      recordAudit(audits, format, strategy, measurement, "warmup", iteration);
    }
  }
}

const samples: Record<Format, Record<Strategy, number[]>> = {
  jsonIncludePhotos: { legacyNPlusOne: [], batchedCandidate: [] },
  csvWithoutPhotos: { legacyNPlusOne: [], batchedCandidate: [] },
};
for (let iteration = 0; iteration < configuration.samples; iteration++) {
  for (const [formatIndex, format] of formats.entries()) {
    const order = (iteration + formatIndex) % 2 === 0 ? strategies : ([...strategies].reverse() as Strategy[]);
    for (const strategy of order) {
      const measurement = execute(dataset, format, strategy, expectedOutputs.get(format)!);
      samples[format][strategy].push(measurement.elapsedMilliseconds);
      recordAudit(audits, format, strategy, measurement, "sample", iteration);
    }
  }
}

const jsonLegacySummary = summarize(samples.jsonIncludePhotos.legacyNPlusOne);
const jsonCandidateSummary = summarize(samples.jsonIncludePhotos.batchedCandidate);
const csvLegacySummary = summarize(samples.csvWithoutPhotos.legacyNPlusOne);
const csvCandidateSummary = summarize(samples.csvWithoutPhotos.batchedCandidate);
const jsonOracle = audits.jsonIncludePhotos.legacyNPlusOne[0]!;
const csvOracle = audits.csvWithoutPhotos.legacyNPlusOne[0]!;
const maximumCandidatePhotoQueryRows = Math.max(
  0,
  ...audits.jsonIncludePhotos.batchedCandidate.map((audit) => audit.maximumPhotoQueryRows),
);
const maximumCandidatePhotoPageRows = Math.max(
  0,
  ...audits.jsonIncludePhotos.batchedCandidate.map((audit) => audit.maximumPhotoPageRows),
);
assert.ok(maximumCandidatePhotoQueryRows <= EXPORT_PHOTO_PAGE_SIZE + 1);
assert.ok(maximumCandidatePhotoPageRows <= EXPORT_PHOTO_PAGE_SIZE);
const report = {
  schemaVersion: 1,
  status: "ok",
  mode: "synthetic-node-v8-in-memory-sqlite",
  generatedAt: new Date().toISOString(),
  configuration: {
    visits: configuration.visits,
    photos: configuration.photos,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    fixedExportedAt: EXPORTED_AT,
    photoPageSize: EXPORT_PHOTO_PAGE_SIZE,
    isolatedMemoryProfileSkipped: configuration.skipMemoryProfile,
  },
  dataset: {
    confirmedVisits: dataset.visits.length,
    photos: dataset.photos.length,
    restaurants: dataset.restaurants.length,
    visitedRestaurants: dataset.visitedRestaurantCount,
    everyVisitReferencesExistingRestaurant: true,
    exactDefaultScale:
      configuration.visits === DEFAULT_CONFIGURATION.visits && configuration.photos === DEFAULT_CONFIGURATION.photos,
  },
  correctness: {
    independentLegacyNPlusOneDatabaseOracle: true,
    independentCorrectedReferenceAssemblyAndSerializers: true,
    candidateUsesProductionKeysetQueryDirectPageAppendAndExactGroupedCounts: true,
    exactOutputByteParityAfterEveryRunAgainstCorrectedReference: true,
    fullOutputSha256AfterEveryRunAgainstCorrectedReference: true,
    sqliteBooleanNormalization: {
      intentionalSchemaCorrection: true,
      affectedJsonFields: ["visits[].foodProbable", "visits[].calendarEvent.isAllDay"],
      oldBuggyRepresentation: "SQLite INTEGER values 0/1 were emitted directly into JSON.",
      correctedRepresentation:
        "JSON booleans true/false are emitted; calendarEvent.isAllDay remains null when the database value is null.",
      parityScope:
        "Exact byte and SHA-256 parity is against the independently assembled corrected reference, not the old buggy 0/1 JSON bytes.",
      audit: booleanSchemaAudit,
    },
    ordering: {
      legacySql: LEGACY_PHOTOS_SQL,
      scaledParityFixtureEqualRankAndCreationTimeTieGroups: legacyOrderingTieGroups,
      exactParityFixtureReliesOnUnspecifiedLegacyTieOrder: false,
      legacyTieBehavior: "Unspecified when food rank and creationTime are equal; the legacy SQL has no ID term.",
      candidateTieBehavior:
        "Deterministic ID ASC tie-break after visitId, food rank, and creationTime. This intentional behavior is reported separately from exact parity on the tie-free scaled fixture.",
    },
    jsonIncludePhotos: {
      bytes: jsonOracle.bytes,
      sha256: jsonOracle.sha256,
    },
    csvWithoutPhotos: {
      bytes: csvOracle.bytes,
      sha256: csvOracle.sha256,
    },
    rawPhotoParserParity: {
      exact: true,
      ...parserParity,
      cases: ["valid JSON", "malformed JSON", "empty JSON", "null JSON", "numeric booleans", "media fallback"],
    },
    runAudits: audits,
  },
  operationCounts: {
    jsonIncludePhotos: {
      legacyNPlusOne: {
        sqliteCalls: expectedCalls("jsonIncludePhotos", "legacyNPlusOne", configuration.visits, configuration.photos),
        visits: 1,
        allRestaurants: 1,
        restaurantById: configuration.visits,
        photosByVisitId: configuration.visits,
      },
      batchedCandidate: {
        sqliteCalls: expectedCalls("jsonIncludePhotos", "batchedCandidate", configuration.visits, configuration.photos),
        visits: 1,
        allRestaurants: 1,
        photoPages: expectedPhotoQueryCalls(
          "jsonIncludePhotos",
          "batchedCandidate",
          configuration.visits,
          configuration.photos,
        ),
        maximumRowsReturnedByPhotoQuery: maximumCandidatePhotoQueryRows,
        maximumRowsAppendedPerPage: maximumCandidatePhotoPageRows,
        queryLookaheadRows: 1,
      },
    },
    csvWithoutPhotos: {
      legacyNPlusOne: {
        sqliteCalls: expectedCalls("csvWithoutPhotos", "legacyNPlusOne", configuration.visits, configuration.photos),
        visits: 1,
        allRestaurants: 1,
        restaurantById: configuration.visits,
        photoQueries: 0,
      },
      batchedCandidate: {
        sqliteCalls: expectedCalls("csvWithoutPhotos", "batchedCandidate", configuration.visits, configuration.photos),
        visits: 1,
        allRestaurants: 1,
        exactGroupedPhotoCountQueries: configuration.visits > 0 ? 1 : 0,
        photoQueries: 0,
      },
    },
  },
  timings: {
    jsonIncludePhotos: {
      legacyNPlusOne: jsonLegacySummary,
      batchedCandidate: jsonCandidateSummary,
      medianRawSpeedup:
        jsonLegacySummary.medianMilliseconds / Math.max(jsonCandidateSummary.medianMilliseconds, Number.EPSILON),
    },
    csvWithoutPhotos: {
      legacyNPlusOne: csvLegacySummary,
      batchedCandidate: csvCandidateSummary,
      medianRawSpeedup:
        csvLegacySummary.medianMilliseconds / Math.max(csvCandidateSummary.medianMilliseconds, Number.EPSILON),
    },
  },
  peakMemory,
  measurementScope:
    "Timings include synchronous database fetches, raw-photo parsing, JavaScript assembly, and JSON/CSV serialization in Node/V8 against a fresh deterministic in-memory SQLite database. Database creation and fixture insertion, SHA-256 hashing, byte comparisons, and assertions are outside the timed region. Results exclude Expo asynchronous bridge overhead and real-device storage latency; SQLite call reductions are reported separately.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
