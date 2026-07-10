#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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
  exportDataToJSONString,
  type ExportVisit,
  type ExportVisitPhoto,
} from "../utils/export-core.ts";
import { BoundedUtf8BufferingSink, ExportJsonStreamWriter } from "../utils/export-stream-core.ts";
import { planExportPhotoBatches } from "../utils/export-stream-plan.ts";

type Scenario = "distributed" | "singleVisitOwnsAllPhotos";
type Strategy = "legacyFullString" | "streamedCandidate";

interface Configuration {
  visits: number;
  photos: number;
  samples: number;
  outputPath: string;
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

interface PhotoCountRow {
  readonly visitId: string;
  readonly photoCount: number;
}

interface StrategyExecution {
  readonly sha256: string;
  readonly bytes: number;
  readonly outputFileBytes: number;
  readonly sqliteCalls: number;
  readonly countQueryCalls: number;
  readonly photoPageQueries: number;
  readonly photoPages: number;
  readonly maximumFetchedPhotoRows: number;
  readonly maximumHeldPhotoRows: number;
  readonly maximumEmittedByteChunk: number;
  readonly maximumBufferedCodeUnitsObserved: number | null;
  readonly boundedBatches: number | null;
  readonly streamingBatches: number | null;
  readonly zeroPhotoBatches: number | null;
  readonly elapsedMilliseconds: number;
  readonly peakObservedHeapUsedBytes: number;
}

interface ChildResult extends StrategyExecution {
  readonly scenario: Scenario;
  readonly strategy: Strategy;
  readonly visits: number;
  readonly photos: number;
  readonly labelsPerPhotoField: number;
  readonly resourceUsageMaxRSSKiB: number;
  readonly rssBytesAtCompletion: number;
  readonly heapUsedBytesAtCompletion: number;
  readonly heapTotalBytesAtCompletion: number;
  readonly externalBytesAtCompletion: number;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly node: string;
}

interface ScenarioResult {
  readonly fixture: {
    readonly visits: number;
    readonly photos: number;
    readonly distribution: Scenario;
    readonly foodLabelsPerPhoto: number;
    readonly allLabelsPerPhoto: number;
    readonly databaseBytes: number;
    readonly legacyOrderingTieGroups: 0;
  };
  readonly executionOrderBySample: readonly (readonly Strategy[])[];
  readonly samples: Record<Strategy, readonly ChildResult[]>;
  readonly exactParity: {
    readonly sha256: string;
    readonly bytes: number;
    readonly everySampleMatched: true;
  };
  readonly medians: Record<Strategy, StrategyMedian>;
  readonly candidateToLegacyRatios: {
    readonly elapsed: number;
    readonly maxRSS: number;
    readonly peakObservedHeap: number;
    readonly sqliteCalls: number;
    readonly maximumHeldPhotoRows: number;
    readonly maximumEmittedByteChunk: number;
  };
}

interface StrategyMedian {
  readonly elapsedMilliseconds: number;
  readonly resourceUsageMaxRSSKiB: number;
  readonly peakObservedHeapUsedBytes: number;
  readonly heapUsedBytesAtCompletion: number;
  readonly sqliteCalls: number;
  readonly photoPages: number;
  readonly maximumFetchedPhotoRows: number;
  readonly maximumHeldPhotoRows: number;
  readonly maximumEmittedByteChunk: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 4_000,
  photos: 68_030,
  samples: 1,
  outputPath: ".build/export-streaming-profile.json",
};
const LABELS_PER_PHOTO_FIELD = 13;
const EXPORTED_AT = "2026-07-08T12:34:56.789Z";
const BASE_TIME = 1_765_000_000_000;
const VISITS_SQL = "SELECT * FROM visits WHERE status = ? ORDER BY startTime DESC";
const RESTAURANTS_SQL = "SELECT * FROM restaurants";
const FOOD_RANK_SQL = "CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END";

process.env.TZ = "UTC";

function usage(): string {
  return `Usage: benchmark-export-streaming.ts [options]

  --visits=N       Confirmed visits in each scenario (default: ${DEFAULT_CONFIGURATION.visits})
  --photos=N       Photos in each scenario (default: ${DEFAULT_CONFIGURATION.photos})
  --samples=N      Fresh child pairs per scenario (default: ${DEFAULT_CONFIGURATION.samples})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help

Every run measures both a distributed-photo fixture and a fixture where one
visit owns every photo. Each strategy gets a fresh child process and both
strategies read the same pre-seeded file database for their scenario.`;
}

function parsePositiveInteger(value: string, option: string, allowZero = false): number {
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
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--visits":
        configuration.visits = parsePositiveInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parsePositiveInteger(value, option, true);
        break;
      case "--samples":
        configuration.samples = parsePositiveInteger(value, option);
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

function internalArgument(name: string): string | null {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
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

function photoCountForVisit(scenario: Scenario, visitIndex: number, visitCount: number, photoCount: number): number {
  if (scenario === "singleVisitOwnsAllPhotos") {
    return visitIndex === 0 ? photoCount : 0;
  }
  return Math.floor(photoCount / visitCount) + (visitIndex < photoCount % visitCount ? 1 : 0);
}

function photoVisitIndex(scenario: Scenario, photoIndex: number, visitCount: number): number {
  return scenario === "singleVisitOwnsAllPhotos" ? 0 : photoIndex % visitCount;
}

function photoOrdinalWithinVisit(scenario: Scenario, photoIndex: number, visitCount: number): number {
  return scenario === "singleVisitOwnsAllPhotos" ? photoIndex : Math.floor(photoIndex / visitCount);
}

function serializedLabels(photoIndex: number, allLabels: boolean): string {
  const labels: FoodLabel[] = Array.from({ length: LABELS_PER_PHOTO_FIELD }, (_, labelIndex) => ({
    label: `${allLabels ? "scene" : "food"}-${photoIndex % 97}-${labelIndex}-bench`,
    confidence: Number((0.5 + ((photoIndex + labelIndex) % 49) / 100).toFixed(2)),
  }));
  return JSON.stringify(labels);
}

function seedScenarioDatabase(path: string, scenario: Scenario, visitCount: number, photoCount: number): number {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;

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
      CREATE INDEX idx_photos_visit_preview ON photos(
        visitId,
        (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
        creationTime,
        id
      );
    `);

    const visitedRestaurantCount = Math.max(1, Math.min(visitCount, 503));
    const insertRestaurant = database.prepare("INSERT INTO restaurants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertVisit = database.prepare(
      "INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertPhoto = database.prepare("INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

    database.exec("BEGIN");
    try {
      for (let index = 0; index < visitedRestaurantCount + 7; index++) {
        insertRestaurant.run(
          restaurantId(index),
          index === 0 ? 'Chez "Comma", O\'Brien\n雪' : `Restaurant ${index.toString().padStart(4, "0")}`,
          34 + (index % 700) / 1_000,
          -118 - (index % 900) / 1_000,
          index % 7 === 0 ? null : `${index} Main St, Suite "${index % 19}"`,
          index % 11 === 0 ? null : `+1-555-${1_000 + index}`,
          index % 13 === 0 ? null : `https://example.test/restaurants/${index}`,
          index % 5 === 0 ? null : `google-${index}`,
          index % 9 === 0 ? "日本料理" : `Cuisine ${index % 23}`,
          index % 6 === 0 ? null : (index % 4) + 1,
          index % 10 === 0 ? null : Number((3.5 + (index % 15) / 10).toFixed(1)),
          index % 8 === 0 ? null : `Restaurant note ${index}, "quoted"`,
        );
      }

      for (let index = 0; index < visitCount; index++) {
        const startTime = BASE_TIME - index * 86_400_000;
        insertVisit.run(
          visitId(index),
          restaurantId(index % visitedRestaurantCount),
          index % 4 === 0 ? `michelin-${index % 97}` : null,
          "confirmed",
          startTime,
          startTime + (30 + (index % 151)) * 60_000,
          33.9 + (index % 1_000) / 10_000,
          -118.5 + (index % 1_300) / 10_000,
          photoCountForVisit(scenario, index, visitCount, photoCount),
          index % 3 === 0 ? 1 : 0,
          index % 6 === 0 ? `calendar-${index}` : null,
          index % 6 === 0 ? `Dinner, "table ${index}"` : null,
          index % 12 === 0 ? "東京, CA\nUpstairs" : null,
          index % 6 === 0 ? (Math.floor(index / 6) % 2 === 0 ? 1 : 0) : null,
          index % 7 === 0 ? 'Chef\'s counter, "omakase"\n雪' : null,
          index % 29 === 0 ? null : startTime + 12_345,
          index % 10 === 0 ? `exported-calendar-${index}` : null,
          index % 5 === 0 ? `${(index % 3) + 1} Star` : null,
        );
      }

      for (let index = 0; index < photoCount; index++) {
        const ownerIndex = photoVisitIndex(scenario, index, visitCount);
        const ordinal = photoOrdinalWithinVisit(scenario, index, visitCount);
        const creationTime = BASE_TIME - ownerIndex * 86_400_000 + ordinal * 60_000;
        const rawMediaType = index % 19 === 0 ? null : index % 7 === 0 ? "video" : index % 23 === 0 ? "live" : "photo";
        insertPhoto.run(
          photoId(index),
          index === 0 ? 'ph://asset/雪?quote="yes"&comma=1' : `ph://asset/${index.toString().padStart(7, "0")}`,
          creationTime,
          index % 31 === 0 ? null : 33.9 + (index % 1_500) / 10_000,
          index % 37 === 0 ? null : -118.5 + (index % 1_700) / 10_000,
          visitId(ownerIndex),
          index % 5 === 0 ? null : index % 3 === 0 ? 1 : 0,
          serializedLabels(index, false),
          index % 5 === 0 ? null : Number((0.4 + (index % 59) / 100).toFixed(2)),
          serializedLabels(index, true),
          rawMediaType,
          rawMediaType === "video" ? Number((1 + (index % 240) / 10).toFixed(1)) : null,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const totals = database.prepare("SELECT COUNT(*) AS count FROM photos").get() as unknown as {
      readonly count: number;
    };
    assert.equal(totals.count, photoCount);
    const tieGroups = database
      .prepare(
        `SELECT COUNT(*) AS count FROM (
          SELECT visitId, ${FOOD_RANK_SQL} AS foodRank, creationTime
          FROM photos
          GROUP BY visitId, foodRank, creationTime
          HAVING COUNT(*) > 1
        )`,
      )
      .get() as unknown as { readonly count: number };
    assert.equal(tieGroups.count, 0, "profile fixtures must not depend on unspecified legacy tie ordering");
  } finally {
    database.close();
  }
  return statSync(path).size;
}

function asVisitRecords(rows: readonly Record<string, unknown>[]): VisitRecord[] {
  return rows.map((row) => ({ ...row })) as unknown as VisitRecord[];
}

function asRestaurantRecords(rows: readonly Record<string, unknown>[]): RestaurantRecord[] {
  return rows.map((row) => ({ ...row })) as unknown as RestaurantRecord[];
}

function asRawPhotoRecords(rows: readonly Record<string, unknown>[]): RawPhotoRecord[] {
  return rows.map((row) => ({ ...row })) as unknown as RawPhotoRecord[];
}

function parsePhotoRecord(raw: RawPhotoRecord): PhotoRecord {
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
  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels: parseLabels(raw.foodLabels),
    allLabels: parseLabels(raw.allLabels),
    mediaType: raw.mediaType === "video" ? "video" : "photo",
  };
}

function cursorForRawPhoto(raw: RawPhotoRecord): ExportPhotoCursor {
  if (raw.visitId === null) {
    throw new Error(`Export profile unexpectedly read unassigned photo ${raw.id}.`);
  }
  return {
    visitId: raw.visitId,
    foodRank: raw.foodDetected === 1 ? 0 : raw.foodDetected === 0 ? 1 : 2,
    creationTime: raw.creationTime,
    id: raw.id,
  };
}

function getBaseExportRows(database: DatabaseSync): {
  readonly visits: VisitRecord[];
  readonly restaurants: RestaurantRecord[];
} {
  const visits = asVisitRecords(database.prepare(VISITS_SQL).all("confirmed") as Record<string, unknown>[]);
  const restaurants = asRestaurantRecords(database.prepare(RESTAURANTS_SQL).all() as Record<string, unknown>[]);
  return { visits, restaurants };
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) {
      throw new Error("Profile output file stopped accepting bytes.");
    }
    offset += written;
  }
}

function createHeapSampler(): { sample: () => void; peak: () => number } {
  let peakHeapUsedBytes = process.memoryUsage().heapUsed;
  return {
    sample: () => {
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, process.memoryUsage().heapUsed);
    },
    peak: () => peakHeapUsedBytes,
  };
}

function runLegacyFullString(database: DatabaseSync, outputPath: string): StrategyExecution {
  const heap = createHeapSampler();
  const startedAt = performance.now();
  let sqliteCalls = 0;
  let photoPageQueries = 0;
  let maximumFetchedPhotoRows = 0;
  let heldPhotoRows = 0;

  database.exec("BEGIN");
  try {
    const { visits, restaurants } = getBaseExportRows(database);
    sqliteCalls += 2;
    const exportVisits = buildExportVisits({ visits, restaurants, photosByVisitId: new Map() });
    const exportVisitsById = new Map(exportVisits.map((visit) => [visit.visitId, visit]));
    const visitIds = visits.map((visit) => visit.id);
    let cursor: ExportPhotoCursor | null = null;

    if (visitIds.length > 0) {
      do {
        const query = buildExportPhotosQuery(visitIds, cursor);
        assert.ok(query);
        const rawRows = asRawPhotoRecords(
          database.prepare(query.sql).all(...query.parameters) as Record<string, unknown>[],
        );
        sqliteCalls += 1;
        photoPageQueries += 1;
        maximumFetchedPhotoRows = Math.max(maximumFetchedPhotoRows, rawRows.length);
        const hasNextPage = rawRows.length > query.pageSize;
        const pageRows = hasNextPage ? rawRows.slice(0, query.pageSize) : rawRows;
        for (const raw of pageRows) {
          const exportVisit = raw.visitId === null ? null : exportVisitsById.get(raw.visitId);
          if (!exportVisit) {
            throw new Error(`Legacy export photo ${raw.id} did not match a requested visit.`);
          }
          exportVisit.photos.push(buildExportPhoto(parsePhotoRecord(raw)));
          heldPhotoRows += 1;
        }
        cursor = hasNextPage ? cursorForRawPhoto(pageRows.at(-1)!) : null;
        heap.sample();
      } while (cursor !== null);
    }

    const data = buildExportDataFromVisits({ visits: exportVisits, restaurants, exportedAt: EXPORTED_AT });
    const output = exportDataToJSONString(data);
    heap.sample();
    const sha256 = createHash("sha256").update(output).digest("hex");
    const bytes = Buffer.byteLength(output, "utf8");
    writeFileSync(outputPath, output, "utf8");
    heap.sample();
    database.exec("COMMIT");

    return {
      sha256,
      bytes,
      outputFileBytes: statSync(outputPath).size,
      sqliteCalls,
      countQueryCalls: 0,
      photoPageQueries,
      photoPages: photoPageQueries,
      maximumFetchedPhotoRows,
      maximumHeldPhotoRows: heldPhotoRows,
      maximumEmittedByteChunk: bytes,
      maximumBufferedCodeUnitsObserved: null,
      boundedBatches: null,
      streamingBatches: null,
      zeroPhotoBatches: null,
      elapsedMilliseconds: performance.now() - startedAt,
      peakObservedHeapUsedBytes: heap.peak(),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readExactPhotoCounts(database: DatabaseSync, visitIds: readonly string[]): Map<string, number> {
  const query = buildExportPhotoCountsQuery(visitIds);
  if (!query) {
    return new Map();
  }
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as PhotoCountRow[];
  const counts = new Map(rows.map((row) => [row.visitId, Number(row.photoCount)]));
  assert.equal(counts.size, visitIds.length);
  return counts;
}

function groupBoundedPhotos(
  rawRows: readonly RawPhotoRecord[],
  expectedVisitIds: readonly string[],
): Map<string, ExportVisitPhoto[]> {
  const photosByVisitId = new Map(expectedVisitIds.map((visitId) => [visitId, [] as ExportVisitPhoto[]]));
  for (const raw of rawRows) {
    const photos = raw.visitId === null ? undefined : photosByVisitId.get(raw.visitId);
    if (!photos) {
      throw new Error(`Bounded export photo ${raw.id} did not match its planned visit batch.`);
    }
    photos.push(buildExportPhoto(parsePhotoRecord(raw)));
  }
  return photosByVisitId;
}

function writeVisit(writer: ExportJsonStreamWriter, visit: ExportVisit, photos: readonly ExportVisitPhoto[]): void {
  writer.beginVisit(visit);
  for (const photo of photos) {
    writer.writePhoto(photo);
  }
  writer.endVisit();
}

function runStreamedCandidate(database: DatabaseSync, outputPath: string): StrategyExecution {
  const heap = createHeapSampler();
  const startedAt = performance.now();
  const outputFd = openSync(outputPath, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  let maximumEmittedByteChunk = 0;
  let sqliteCalls = 0;
  let photoPageQueries = 0;
  let maximumFetchedPhotoRows = 0;
  let maximumHeldPhotoRows = 0;
  let boundedBatches = 0;
  let streamingBatches = 0;
  let zeroPhotoBatches = 0;
  let buffer: BoundedUtf8BufferingSink | null = null;

  try {
    buffer = new BoundedUtf8BufferingSink((chunk) => {
      hash.update(chunk);
      writeAll(outputFd, chunk);
      bytes += chunk.byteLength;
      maximumEmittedByteChunk = Math.max(maximumEmittedByteChunk, chunk.byteLength);
    });

    database.exec("BEGIN");
    try {
      const { visits, restaurants } = getBaseExportRows(database);
      sqliteCalls += 2;
      const exportVisits = buildExportVisits({ visits, restaurants, photosByVisitId: new Map() });
      const exportVisitsById = new Map(exportVisits.map((visit) => [visit.visitId, visit]));
      const data = buildExportDataFromVisits({ visits: exportVisits, restaurants, exportedAt: EXPORTED_AT });
      const writer = new ExportJsonStreamWriter(buffer.write, {
        exportedAt: data.exportedAt,
        stats: data.stats,
        restaurants: data.restaurants,
      });
      const visitIds = visits.map((visit) => visit.id);
      const counts = readExactPhotoCounts(database, visitIds);
      if (visitIds.length > 0) {
        sqliteCalls += 1;
      }
      const batches = planExportPhotoBatches(visitIds, counts);

      for (const batch of batches) {
        if (batch.mode === "bounded") {
          boundedBatches += 1;
          if (batch.photoCount === 0) {
            zeroPhotoBatches += 1;
            for (const visitId_ of batch.visitIds) {
              const visit = exportVisitsById.get(visitId_);
              assert.ok(visit);
              writeVisit(writer, visit, []);
            }
            continue;
          }

          const query = buildExportPhotosQuery(batch.visitIds);
          assert.ok(query);
          const rawRows = asRawPhotoRecords(
            database.prepare(query.sql).all(...query.parameters) as Record<string, unknown>[],
          );
          sqliteCalls += 1;
          photoPageQueries += 1;
          maximumFetchedPhotoRows = Math.max(maximumFetchedPhotoRows, rawRows.length);
          assert.equal(
            rawRows.length,
            batch.photoCount,
            "an exact bounded batch must fit in one query without lookahead",
          );
          const grouped = groupBoundedPhotos(rawRows, batch.visitIds);
          maximumHeldPhotoRows = Math.max(maximumHeldPhotoRows, batch.photoCount);
          for (const visitId_ of batch.visitIds) {
            const visit = exportVisitsById.get(visitId_);
            assert.ok(visit);
            writeVisit(writer, visit, grouped.get(visitId_)!);
          }
          heap.sample();
          continue;
        }

        streamingBatches += 1;
        const visitId_ = batch.visitIds[0];
        const visit = exportVisitsById.get(visitId_);
        assert.ok(visit);
        writer.beginVisit(visit);
        let emitted = 0;
        let cursor: ExportPhotoCursor | null = null;
        do {
          const query = buildExportPhotosQuery(batch.visitIds, cursor);
          assert.ok(query);
          const rawRows = asRawPhotoRecords(
            database.prepare(query.sql).all(...query.parameters) as Record<string, unknown>[],
          );
          sqliteCalls += 1;
          photoPageQueries += 1;
          maximumFetchedPhotoRows = Math.max(maximumFetchedPhotoRows, rawRows.length);
          const hasNextPage = rawRows.length > query.pageSize;
          const pageRows = hasNextPage ? rawRows.slice(0, query.pageSize) : rawRows;
          maximumHeldPhotoRows = Math.max(maximumHeldPhotoRows, pageRows.length);
          for (const raw of pageRows) {
            assert.equal(raw.visitId, visitId_);
            writer.writePhoto(buildExportPhoto(parsePhotoRecord(raw)));
            emitted += 1;
          }
          cursor = hasNextPage ? cursorForRawPhoto(pageRows.at(-1)!) : null;
          heap.sample();
        } while (cursor !== null);
        assert.equal(emitted, batch.photoCount);
        writer.endVisit();
      }

      writer.finish();
      buffer.close();
      heap.sample();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    closeSync(outputFd);
  }

  const sha256 = hash.digest("hex");
  return {
    sha256,
    bytes,
    outputFileBytes: statSync(outputPath).size,
    sqliteCalls,
    countQueryCalls: sqliteCalls >= 3 ? 1 : 0,
    photoPageQueries,
    photoPages: photoPageQueries,
    maximumFetchedPhotoRows,
    maximumHeldPhotoRows,
    maximumEmittedByteChunk,
    maximumBufferedCodeUnitsObserved: buffer?.maximumBufferedCodeUnitsObserved ?? null,
    boundedBatches,
    streamingBatches,
    zeroPhotoBatches,
    elapsedMilliseconds: performance.now() - startedAt,
    peakObservedHeapUsedBytes: heap.peak(),
  };
}

function requireInternalScenario(value: string | null): Scenario {
  if (value === "distributed" || value === "singleVisitOwnsAllPhotos") {
    return value;
  }
  throw new Error(`Invalid child scenario: ${String(value)}`);
}

function requireInternalStrategy(value: string | null): Strategy {
  if (value === "legacyFullString" || value === "streamedCandidate") {
    return value;
  }
  throw new Error(`Invalid child strategy: ${String(value)}`);
}

function runChildIfRequested(): void {
  const strategyValue = internalArgument("child-strategy");
  if (strategyValue === null) {
    return;
  }
  const strategy = requireInternalStrategy(strategyValue);
  const scenario = requireInternalScenario(internalArgument("child-scenario"));
  const databasePath = internalArgument("child-database");
  const outputPath = internalArgument("child-output");
  const visitsValue = internalArgument("child-visits");
  const photosValue = internalArgument("child-photos");
  if (!databasePath || !outputPath || !visitsValue || photosValue === null) {
    throw new Error("Child mode requires database, output, visits, and photos arguments.");
  }
  const visits = parsePositiveInteger(visitsValue, "--child-visits");
  const photos = parsePositiveInteger(photosValue, "--child-photos", true);
  globalThis.gc?.();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let execution: StrategyExecution;
  try {
    execution =
      strategy === "legacyFullString"
        ? runLegacyFullString(database, outputPath)
        : runStreamedCandidate(database, outputPath);
  } finally {
    database.close();
  }
  assert.equal(execution.bytes, execution.outputFileBytes);
  const memory = process.memoryUsage();
  const resourceUsage = process.resourceUsage();
  const result: ChildResult = {
    ...execution,
    scenario,
    strategy,
    visits,
    photos,
    labelsPerPhotoField: LABELS_PER_PHOTO_FIELD,
    resourceUsageMaxRSSKiB: resourceUsage.maxRSS,
    rssBytesAtCompletion: memory.rss,
    heapUsedBytesAtCompletion: memory.heapUsed,
    heapTotalBytesAtCompletion: memory.heapTotal,
    externalBytesAtCompletion: memory.external,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}

function parseChildResult(stdout: string, scenario: Scenario, strategy: Strategy): ChildResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Could not parse ${scenario}/${strategy} child output: ${String(error)}`, { cause: error });
  }
  assert.ok(parsed && typeof parsed === "object");
  const result = parsed as ChildResult;
  assert.equal(result.scenario, scenario);
  assert.equal(result.strategy, strategy);
  assert.equal(typeof result.sha256, "string");
  assert.equal(typeof result.resourceUsageMaxRSSKiB, "number");
  return result;
}

function runChild(
  databasePath: string,
  outputPath: string,
  scenario: Scenario,
  strategy: Strategy,
  configuration: Configuration,
): ChildResult {
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      fileURLToPath(import.meta.url),
      `--child-strategy=${strategy}`,
      `--child-scenario=${scenario}`,
      `--child-database=${databasePath}`,
      `--child-output=${outputPath}`,
      `--child-visits=${configuration.visits}`,
      `--child-photos=${configuration.photos}`,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(
      `${scenario}/${strategy} child failed (status ${String(child.status)}, signal ${String(child.signal)}): ${child.stderr}`,
    );
  }
  return parseChildResult(child.stdout, scenario, strategy);
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function medianResult(results: readonly ChildResult[]): StrategyMedian {
  return {
    elapsedMilliseconds: median(results.map((result) => result.elapsedMilliseconds)),
    resourceUsageMaxRSSKiB: median(results.map((result) => result.resourceUsageMaxRSSKiB)),
    peakObservedHeapUsedBytes: median(results.map((result) => result.peakObservedHeapUsedBytes)),
    heapUsedBytesAtCompletion: median(results.map((result) => result.heapUsedBytesAtCompletion)),
    sqliteCalls: median(results.map((result) => result.sqliteCalls)),
    photoPages: median(results.map((result) => result.photoPages)),
    maximumFetchedPhotoRows: median(results.map((result) => result.maximumFetchedPhotoRows)),
    maximumHeldPhotoRows: median(results.map((result) => result.maximumHeldPhotoRows)),
    maximumEmittedByteChunk: median(results.map((result) => result.maximumEmittedByteChunk)),
  };
}

function ratio(candidate: number, legacy: number): number {
  return candidate / Math.max(legacy, Number.EPSILON);
}

function profileScenario(directory: string, scenario: Scenario, configuration: Configuration): ScenarioResult {
  const databasePath = join(directory, `${scenario}.sqlite`);
  const databaseBytes = seedScenarioDatabase(databasePath, scenario, configuration.visits, configuration.photos);
  const samples: Record<Strategy, ChildResult[]> = {
    legacyFullString: [],
    streamedCandidate: [],
  };
  const executionOrderBySample: Strategy[][] = [];
  const strategies: readonly Strategy[] = ["legacyFullString", "streamedCandidate"];

  for (let sample = 0; sample < configuration.samples; sample++) {
    const baseOrder = scenario === "distributed" ? strategies : ([...strategies].reverse() as Strategy[]);
    const order = sample % 2 === 0 ? baseOrder : ([...baseOrder].reverse() as Strategy[]);
    executionOrderBySample.push([...order]);
    for (const strategy of order) {
      const outputPath = join(directory, `${scenario}-${strategy}-${sample}.json`);
      const result = runChild(databasePath, outputPath, scenario, strategy, configuration);
      samples[strategy].push(result);
      rmSync(outputPath, { force: true });
    }
  }

  const expectedHash = samples.legacyFullString[0]!.sha256;
  const expectedBytes = samples.legacyFullString[0]!.bytes;
  for (const result of [...samples.legacyFullString, ...samples.streamedCandidate]) {
    assert.equal(result.sha256, expectedHash, `${scenario}/${result.strategy} SHA-256 parity`);
    assert.equal(result.bytes, expectedBytes, `${scenario}/${result.strategy} byte parity`);
    assert.equal(result.photos, configuration.photos);
    assert.equal(result.visits, configuration.visits);
  }
  for (const candidate of samples.streamedCandidate) {
    assert.ok(candidate.maximumFetchedPhotoRows <= EXPORT_PHOTO_PAGE_SIZE + 1);
    assert.ok(candidate.maximumHeldPhotoRows <= EXPORT_PHOTO_PAGE_SIZE);
    assert.ok(candidate.maximumBufferedCodeUnitsObserved !== null);
    assert.ok(candidate.maximumBufferedCodeUnitsObserved > 0);
    assert.ok(candidate.bytes === 0 || candidate.maximumEmittedByteChunk < candidate.bytes);
  }
  if (configuration.photos > EXPORT_PHOTO_PAGE_SIZE && scenario === "singleVisitOwnsAllPhotos") {
    assert.ok(samples.streamedCandidate.every((result) => (result.streamingBatches ?? 0) === 1));
  }

  const medians = {
    legacyFullString: medianResult(samples.legacyFullString),
    streamedCandidate: medianResult(samples.streamedCandidate),
  };
  return {
    fixture: {
      visits: configuration.visits,
      photos: configuration.photos,
      distribution: scenario,
      foodLabelsPerPhoto: LABELS_PER_PHOTO_FIELD,
      allLabelsPerPhoto: LABELS_PER_PHOTO_FIELD,
      databaseBytes,
      legacyOrderingTieGroups: 0,
    },
    executionOrderBySample,
    samples,
    exactParity: {
      sha256: expectedHash,
      bytes: expectedBytes,
      everySampleMatched: true,
    },
    medians,
    candidateToLegacyRatios: {
      elapsed: ratio(medians.streamedCandidate.elapsedMilliseconds, medians.legacyFullString.elapsedMilliseconds),
      maxRSS: ratio(medians.streamedCandidate.resourceUsageMaxRSSKiB, medians.legacyFullString.resourceUsageMaxRSSKiB),
      peakObservedHeap: ratio(
        medians.streamedCandidate.peakObservedHeapUsedBytes,
        medians.legacyFullString.peakObservedHeapUsedBytes,
      ),
      sqliteCalls: ratio(medians.streamedCandidate.sqliteCalls, medians.legacyFullString.sqliteCalls),
      maximumHeldPhotoRows: ratio(
        medians.streamedCandidate.maximumHeldPhotoRows,
        medians.legacyFullString.maximumHeldPhotoRows,
      ),
      maximumEmittedByteChunk: ratio(
        medians.streamedCandidate.maximumEmittedByteChunk,
        medians.legacyFullString.maximumEmittedByteChunk,
      ),
    },
  };
}

runChildIfRequested();

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "palate-export-streaming-profile-"));
try {
  const distributed = profileScenario(directory, "distributed", configuration);
  const singleVisitOwnsAllPhotos = profileScenario(directory, "singleVisitOwnsAllPhotos", configuration);

  const report = {
    schemaVersion: 1,
    status: "ok",
    mode: "synthetic-node-v8-file-sqlite-fresh-child",
    generatedAt: new Date().toISOString(),
    configuration: {
      ...configuration,
      fixedExportedAt: EXPORTED_AT,
      photoPageSize: EXPORT_PHOTO_PAGE_SIZE,
      boundedUtf8CodeUnitLimit: 64 * 1024,
      foodLabelsPerPhoto: LABELS_PER_PHOTO_FIELD,
      allLabelsPerPhoto: LABELS_PER_PHOTO_FIELD,
    },
    scenarios: {
      distributed,
      singleVisitOwnsAllPhotos,
    },
    correctness: {
      exactPrettyJsonSha256AndByteParityForEveryChild: true,
      candidateUsesProductionCountQueryBuilder: true,
      candidateUsesProductionPageQueryBuilder: true,
      candidateUsesProductionBatchPlanner: true,
      candidateUsesProductionJsonStreamWriter: true,
      candidateUsesProductionBoundedUtf8Sink: true,
      candidateNeverConcatenatesTheFullDocument: true,
      deterministicTieFreePhotoOrdering: true,
      parityCheckedIndependentlyForEachPhotoDistribution: true,
    },
    metricDefinitions: {
      sqliteCalls:
        "Read statements only: visits, restaurants, exact counts when used, and photo-page queries. BEGIN/COMMIT are excluded.",
      maximumFetchedPhotoRows: "Most raw photo rows returned by one page statement, including an internal lookahead.",
      maximumHeldPhotoRows:
        "Most parsed/export photo rows deliberately retained by the strategy: the whole graph for legacy, one planned batch/page for streaming.",
      maximumEmittedByteChunk:
        "Largest UTF-8 write passed to the output file. Legacy writes its complete string once; candidate reports bounded sink chunks. The sink preserves complete fragments, so one photo or the restaurant footer may exceed its nominal code-unit buffer limit.",
      peakObservedHeapUsedBytes:
        "Largest process.memoryUsage().heapUsed sample at strategy milestones/pages; resourceUsageMaxRSSKiB remains the OS-reported process peak.",
    },
    scope:
      "Each strategy runs in a fresh Node/V8 child against the same pre-seeded read-only SQLite file for its scenario. Child order is recorded and alternates by scenario/sample to expose OS file-cache ordering effects. Timings include visits/restaurants/count/photo reads, object conversion, canonical pretty-JSON serialization, SHA-256, UTF-8 encoding, file writes, and close/commit work; fixture creation, process startup, module loading, report assembly, and file deletion are excluded. Node SQLite and synchronous file writes approximate production dataflow but do not include Expo native bridge, FileHandle, React Native/Hermes, share-sheet, device storage, or concurrent-app workload costs. maxRSS is Node's platform-reported KiB and is comparable only between children on the same host/runtime.",
  };

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Export streaming profile written to ${configuration.outputPath}`);
  for (const [name, scenario] of Object.entries(report.scenarios)) {
    console.log(
      `${name}: ${(scenario.exactParity.bytes / (1024 * 1024)).toFixed(2)} MiB, ` +
        `RSS ${(scenario.candidateToLegacyRatios.maxRSS * 100).toFixed(1)}%, ` +
        `heap ${(scenario.candidateToLegacyRatios.peakObservedHeap * 100).toFixed(1)}%, ` +
        `elapsed ${scenario.candidateToLegacyRatios.elapsed.toFixed(3)}x`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
