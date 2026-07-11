#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL,
  PENDING_VISITS_FOR_REVIEW_SQL,
  type PendingVisitReviewQueryRow,
} from "../utils/db/visit-review-core.ts";
import {
  DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
  PENDING_VISIT_REVIEW_MANIFEST_SQL,
  PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL,
  PENDING_VISIT_REVIEW_PAGE_SQL,
  createPendingVisitReviewGeneration,
  parsePendingVisitReviewManifest,
  parsePendingVisitReviewOrderedKeys,
  partitionPendingVisitReviewKeys,
  serializePendingVisitReviewPageKeys,
  validatePendingVisitReviewPageSize,
  type PendingVisitReviewFilters,
  type PendingVisitReviewGeneration,
  type PendingVisitReviewManifestItem,
  type PendingVisitReviewManifestRow,
  type PendingVisitReviewOrderedKeysRow,
  type PendingVisitReviewPageKey,
} from "../utils/db/visit-review-paging-core.ts";
import {
  BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS,
  assertCalendarTitleMatchingSourceContract,
} from "./calendar-title-matching-benchmark-core.ts";

interface Configuration {
  databasePath: string | null;
  pendingVisits: number;
  photos: number;
  pageSizes: number[];
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface DatasetSummary {
  readonly pendingVisits: number;
  readonly excludedVisits: number;
  readonly photos: number;
  readonly pendingVisitPhotos: number;
  readonly pendingFoodVisits: number;
  readonly pendingFoodLabelPhotos: number;
  readonly pendingSuggestionRows: number;
  readonly pendingSuggestionVisits: number;
}

interface MeasurementShape {
  readonly queryCalls: number;
  readonly manifestQueryCalls: number;
  readonly hydrationQueryCalls: number;
  readonly manifestRows: number;
  readonly manifestItems: number;
  readonly selectedRows: number;
  readonly exactMatchRows: number;
  readonly filteredManualRows: number;
  readonly firstPageRows: number;
  readonly resultRows: number;
  readonly transferredRows: number;
  readonly maxRowsPerCall: number;
  readonly manifestPayloadBytes: number;
  readonly firstPagePayloadBytes: number;
  readonly transferredBytes: number;
  readonly maxBytesPerCall: number;
}

interface Measurement extends MeasurementShape {
  readonly elapsedMilliseconds: number;
  readonly timeToFirstPageMilliseconds: number;
  readonly manifestSqlMilliseconds: number;
  readonly strictManifestParseMilliseconds: number;
  readonly globalFilterPlanningMilliseconds: number;
  readonly firstPageHydrationMilliseconds: number;
  readonly checksum: string;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface FileComponentSnapshot {
  readonly component: "main" | "wal" | "shm" | "journal";
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly mainBasename: string;
  readonly components: FileComponentSnapshot[];
}

type Strategy = "monolith" | `page-${number}`;

interface PromotedBootstrapOracle {
  readonly manifestRow: PendingVisitReviewManifestRow;
  readonly items: readonly PendingVisitReviewManifestItem[];
  readonly generation: PendingVisitReviewGeneration;
  readonly expectedRows: readonly PendingVisitReviewQueryRow[];
  readonly selectedRowSha256: string;
}

const PRODUCTION_BOOTSTRAP_FILTERS: PendingVisitReviewFilters = {
  food: "on",
  restaurantMatches: "on",
};

const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  pendingVisits: 6_511,
  photos: 68_028,
  pageSizes: [DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE],
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/pending-visit-review-paging-profile.json",
};

const SQLITE_SIDECARS = [
  { suffix: "-wal", component: "wal" },
  { suffix: "-shm", component: "shm" },
  { suffix: "-journal", component: "journal" },
] as const;

function usage(): string {
  return `Usage: benchmark-pending-visit-review-paging.ts [options]

  --database=PATH     Profile an existing Palate database through mode=ro,
                      immutable=1 after rejecting a non-empty WAL/journal.
                      Otherwise build a synthetic current-Mac-scale fixture.
  --pending-visits=N  Synthetic pending visits (default: ${DEFAULT_CONFIGURATION.pendingVisits})
  --photos=N          Synthetic total photos (default: ${DEFAULT_CONFIGURATION.photos})
  --page-sizes=LIST   Comma-separated page sizes (default: ${DEFAULT_CONFIGURATION.pageSizes.join(",")})
  --samples=N         Counterbalanced measured rounds (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N          Counterbalanced warmup rounds (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH       Aggregate-only JSON report (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h          Show this help

The page-128 strategy is the promoted production bootstrap: compact manifest
SQL, strict parse, global production title matching/filter planning, then the
first 128-row hydration. Extra page sizes are sensitivity variants. Fully
awaiting all pages remains a compatibility oracle, not a production usage
recommendation.`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration: Configuration = { ...DEFAULT_CONFIGURATION, pageSizes: [...DEFAULT_CONFIGURATION.pageSizes] };
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
      case "--database":
        if (!value) {
          throw new RangeError("--database cannot be empty");
        }
        configuration.databasePath = resolve(value);
        break;
      case "--pending-visits":
        configuration.pendingVisits = parseInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parseInteger(value, option, true);
        break;
      case "--page-sizes": {
        if (!value) {
          throw new RangeError("--page-sizes cannot be empty");
        }
        const pageSizes = value
          .split(",")
          .map((entry) => validatePendingVisitReviewPageSize(parseInteger(entry, option)));
        if (new Set(pageSizes).size !== pageSizes.length) {
          throw new RangeError("--page-sizes cannot contain duplicates");
        }
        configuration.pageSizes = pageSizes;
        break;
      }
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--output":
        if (!value) {
          throw new RangeError("--output cannot be empty");
        }
        configuration.outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!configuration.pageSizes.includes(DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE)) {
    throw new RangeError(
      `--page-sizes must include ${DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE} so the production bootstrap is measured`,
    );
  }
  return configuration;
}

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function checksumRows(rows: readonly PendingVisitReviewQueryRow[]): string {
  return sha256Bytes(JSON.stringify(rows));
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

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(resolve(databasePath));
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function sourcePathVariants(databasePath: string): string[] {
  return [...new Set([resolve(databasePath), realpathSync(databasePath)])];
}

function canonicalizePotentialPath(path: string): string {
  const suffix: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function protectedSourcePaths(databasePath: string): string[] {
  return sourcePathVariants(databasePath).flatMap((base) => [
    base,
    ...SQLITE_SIDECARS.map(({ suffix }) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const outputCanonical = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    if (outputIdentity && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not be a hard link to the source database or a SQLite sidecar");
      }
    }
  }
}

function assertSourceCanBeOpenedImmutable(databasePath: string): void {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${databasePath}`);
  }
  for (const base of sourcePathVariants(databasePath)) {
    for (const suffix of ["-wal", "-journal"] as const) {
      const sidecar = `${base}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw new Error(`Immutable profiling requires an empty or absent ${suffix.slice(1)} sidecar`);
      }
    }
  }
}

function snapshotSource(databasePath: string): SourceSnapshot {
  const main = realpathSync(databasePath);
  const component = (componentName: FileComponentSnapshot["component"], path: string): FileComponentSnapshot => {
    if (!existsSync(path)) {
      return { component: componentName, present: false, bytes: 0, sha256: null };
    }
    return {
      component: componentName,
      present: true,
      bytes: statSync(path).size,
      sha256: sha256File(path),
    };
  };
  return {
    mainBasename: basename(main),
    components: [
      component("main", main),
      ...SQLITE_SIDECARS.map(({ suffix, component: componentName }) => component(componentName, `${main}${suffix}`)),
    ],
  };
}

function createSchema(database: DatabaseSync): void {
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
      awardAtVisit TEXT
    );
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId)
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL
    );
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

function distribute(total: number, buckets: number, index: number): number {
  if (buckets <= 0) {
    return 0;
  }
  return Math.floor(total / buckets) + (index < total % buckets ? 1 : 0);
}

function priorityCounts(total: number): readonly [number, number, number, number] {
  if (total < 4) {
    const counts = [0, 0, 0, 0];
    for (let index = 0; index < total; index++) {
      counts[index] = 1;
    }
    return counts as unknown as readonly [number, number, number, number];
  }
  const p1 = Math.max(1, Math.round((total * 574) / 6_511));
  const p2 = Math.max(1, Math.round((total * 1_418) / 6_511));
  const p3 = Math.max(1, Math.round((total * 446) / 6_511));
  const used = Math.min(total - 1, p1 + p2 + p3);
  const adjustedP3 = Math.max(1, p3 - Math.max(0, p1 + p2 + p3 - used));
  return [p1, p2, adjustedP3, total - p1 - p2 - adjustedP3];
}

function seedSyntheticDatabase(database: DatabaseSync, configuration: Configuration): DatasetSummary {
  const insertMichelin = database.prepare(`
    INSERT INTO michelin_restaurants (
      id, name, latitude, longitude, address, location, cuisine,
      latestAwardYear, award, datasetVersion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      notes, updatedAt, exportedToCalendarId, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSuggestion = database.prepare(`
    INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
    VALUES (?, ?, ?)
  `);
  const insertPhoto = database.prepare(`
    INSERT INTO photos (id, uri, creationTime, visitId, foodDetected, foodLabels, foodConfidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const pendingPhotoTarget = Math.min(configuration.photos, Math.round((configuration.photos * 56_075) / 68_028));
  const foodLabelTarget = Math.min(pendingPhotoTarget, Math.round((configuration.photos * 2_526) / 68_028));
  const photoBearingVisits = configuration.pendingVisits > 1 ? configuration.pendingVisits - 1 : 1;
  const [priority1, priority2, priority3] = priorityCounts(configuration.pendingVisits);
  const suggestionVisitCount = priority1 + priority2;
  const suggestionRowTarget = Math.min(suggestionVisitCount * 3, Math.round((suggestionVisitCount * 5_147) / 1_992));
  const extraThirdSuggestionCount = Math.max(0, suggestionRowTarget - suggestionVisitCount * 2);
  const epoch = 1_700_000_000_000;
  let insertedPendingPhotos = 0;
  let insertedFoodLabels = 0;
  let insertedSuggestionRows = 0;

  database.exec("BEGIN");
  try {
    for (let index = 0; index < 8; index++) {
      insertRestaurant.run(`restaurant-${index}`, index === 0 ? 'Local "Bistro" 東京' : `Local Restaurant ${index}`);
      insertMichelin.run(
        `michelin-${index}`,
        index === 0 ? 'Café "Snow" 雪' : `Guide Restaurant ${index}`,
        34 + index / 100,
        -118 - index / 100,
        `${index + 1} Benchmark Street`,
        index === 0 ? "東京, 日本" : `Benchmark City ${index}`,
        index === 0 ? "Crème brûlée" : `Cuisine ${index}`,
        2026,
        index % 3 === 0 ? "1 Star" : index % 3 === 1 ? "Bib Gourmand" : "Selected",
        "paging-benchmark-v1",
      );
    }

    for (let index = 0; index < configuration.pendingVisits; index++) {
      const id = `visit-${index.toString().padStart(6, "0")}`;
      const priority =
        index < priority1 ? 1 : index < priority1 + priority2 ? 2 : index < priority1 + priority2 + priority3 ? 3 : 4;
      const foodProbable = priority === 1 || priority === 3 ? 1 : 0;
      const hasSuggestion = priority === 1 || priority === 2;
      const directSuggestion = hasSuggestion && index % 3 === 0 ? `michelin-${index % 8}` : null;
      const photoCount = index < photoBearingVisits ? distribute(pendingPhotoTarget, photoBearingVisits, index) : 0;
      const startTime = epoch + index * 100_000;
      insertVisit.run(
        id,
        index % 17 === 0 ? `restaurant-${index % 8}` : null,
        directSuggestion,
        "pending",
        startTime,
        startTime + 7_200_000,
        34 + (index % 100) / 1_000,
        -118 - (index % 100) / 1_000,
        photoCount,
        foodProbable,
        index % 29 === 0 ? `event-${index}` : null,
        index % 29 === 0 ? 'Dinner at "Café" 雪' : null,
        index % 29 === 0 ? "Los Angeles, CA" : null,
        index % 29 === 0 ? 0 : null,
        index % 31 === 0 ? "notes with quotes, Unicode 雪, and newline\nvalue" : null,
        startTime + 1,
        null,
        null,
      );

      if (hasSuggestion) {
        const suggestionCount = 2 + (index < extraThirdSuggestionCount ? 1 : 0);
        for (let suggestion = 0; suggestion < suggestionCount; suggestion++) {
          insertSuggestion.run(id, `michelin-${(index + suggestion) % 8}`, 1 + ((index + suggestion) % 500) / 10);
          insertedSuggestionRows++;
        }
      }

      for (let photo = 0; photo < photoCount; photo++) {
        const isLabeledFood = foodProbable === 1 && insertedFoodLabels < foodLabelTarget;
        const detectionBucket = (index + photo) % 10;
        const foodDetected = isLabeledFood ? 1 : detectionBucket < 4 ? 1 : detectionBucket < 8 ? 0 : null;
        const foodLabels = isLabeledFood
          ? JSON.stringify([
              { label: index % 2 === 0 ? 'Crème "brûlée" 🍮' : "東京寿司", confidence: 0.93 },
              { label: "restaurant food", confidence: 0.81 },
            ])
          : null;
        insertPhoto.run(
          `${id}-photo-${photo.toString().padStart(4, "0")}`,
          `ph://${id}/雪/${photo}`,
          startTime + photo * 10,
          id,
          foodDetected,
          foodLabels,
          foodDetected === 1 ? 0.5 + ((index + photo) % 50) / 100 : null,
        );
        insertedPendingPhotos++;
        if (foodLabels) {
          insertedFoodLabels++;
        }
      }
    }

    for (let index = insertedPendingPhotos; index < configuration.photos; index++) {
      insertPhoto.run(`unvisited-${index}`, `ph://unvisited/${index}`, epoch + index, null, null, null, null);
    }
    for (const [status, suffix] of [
      ["confirmed", "confirmed-excluded"],
      ["rejected", "rejected-excluded"],
    ] as const) {
      insertVisit.run(
        suffix,
        null,
        "michelin-0",
        status,
        epoch - (status === "confirmed" ? 1 : 2),
        epoch,
        0,
        0,
        0,
        1,
        null,
        null,
        null,
        null,
        null,
        epoch,
        null,
        null,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.equal(insertedPendingPhotos, pendingPhotoTarget);
  assert.ok(insertedFoodLabels <= foodLabelTarget);
  assert.equal(insertedSuggestionRows, suggestionRowTarget);
  return datasetSummary(database);
}

function numericCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number") {
    throw new TypeError(`Count query did not return a number: ${sql}`);
  }
  return row.count;
}

function datasetSummary(database: DatabaseSync): DatasetSummary {
  return {
    pendingVisits: numericCount(database, "SELECT COUNT(*) AS count FROM visits WHERE status = 'pending'"),
    excludedVisits: numericCount(database, "SELECT COUNT(*) AS count FROM visits WHERE status != 'pending'"),
    photos: numericCount(database, "SELECT COUNT(*) AS count FROM photos"),
    pendingVisitPhotos: numericCount(
      database,
      "SELECT COUNT(*) AS count FROM photos WHERE visitId IN (SELECT id FROM visits WHERE status = 'pending')",
    ),
    pendingFoodVisits: numericCount(
      database,
      "SELECT COUNT(*) AS count FROM visits WHERE status = 'pending' AND foodProbable = 1",
    ),
    pendingFoodLabelPhotos: numericCount(
      database,
      `SELECT COUNT(*) AS count FROM photos
       WHERE foodDetected = 1 AND foodLabels IS NOT NULL
         AND visitId IN (SELECT id FROM visits WHERE status = 'pending' AND foodProbable = 1)`,
    ),
    pendingSuggestionRows: numericCount(
      database,
      `SELECT COUNT(*) AS count FROM visit_suggested_restaurants
       WHERE visitId IN (SELECT id FROM visits WHERE status = 'pending')`,
    ),
    pendingSuggestionVisits: numericCount(
      database,
      `SELECT COUNT(DISTINCT visitId) AS count FROM visit_suggested_restaurants
       WHERE visitId IN (SELECT id FROM visits WHERE status = 'pending')`,
    ),
  };
}

function totalChanges(database: DatabaseSync): number {
  return numericCount(database, "SELECT total_changes() AS count");
}

function orderedKeys(database: DatabaseSync): {
  readonly row: PendingVisitReviewOrderedKeysRow;
  readonly keys: PendingVisitReviewPageKey[];
} {
  const row = database.prepare(PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL).get() as
    | PendingVisitReviewOrderedKeysRow
    | undefined;
  assert.ok(row, "ordered-key aggregate must return one row");
  return { row, keys: parsePendingVisitReviewOrderedKeys(row) };
}

function assertRowsMatchKeys(
  rows: readonly PendingVisitReviewQueryRow[],
  keys: readonly PendingVisitReviewPageKey[],
): void {
  assert.equal(rows.length, keys.length, "page must return one row per key");
  for (const [index, row] of rows.entries()) {
    assert.equal(row.id, keys[index].id, `page row ${index} must preserve its key ID`);
    assert.equal(row.priority, keys[index].priority, `page row ${index} must preserve its key priority`);
  }
}

function parseHydratedSuggestionIds(row: PendingVisitReviewQueryRow): string[] {
  if (row.suggestedRestaurantsJson === null) {
    return [];
  }
  const decoded: unknown = JSON.parse(row.suggestedRestaurantsJson);
  assert.ok(Array.isArray(decoded), `suggested restaurants for ${JSON.stringify(row.id)} must be an array`);
  return decoded.map((value, index) => {
    assert.ok(
      typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string",
      `suggested restaurant ${index} for ${JSON.stringify(row.id)} must have a string id`,
    );
    return (value as { id: string }).id;
  });
}

function executeMonolith(database: DatabaseSync): Measurement {
  const statement = database.prepare(PENDING_VISITS_FOR_REVIEW_SQL);
  const startedAt = performance.now();
  const rows = statement.all() as unknown as PendingVisitReviewQueryRow[];
  const elapsedMilliseconds = performance.now() - startedAt;
  const canonicalRows = canonicalReviewOrder(rows);
  const bytes = serializedBytes(rows);
  return {
    elapsedMilliseconds,
    timeToFirstPageMilliseconds: elapsedMilliseconds,
    manifestSqlMilliseconds: 0,
    strictManifestParseMilliseconds: 0,
    globalFilterPlanningMilliseconds: 0,
    firstPageHydrationMilliseconds: elapsedMilliseconds,
    checksum: checksumRows(canonicalRows),
    queryCalls: 1,
    manifestQueryCalls: 0,
    hydrationQueryCalls: 1,
    manifestRows: 0,
    manifestItems: 0,
    selectedRows: rows.length,
    exactMatchRows: 0,
    filteredManualRows: rows.length,
    firstPageRows: rows.length,
    resultRows: rows.length,
    transferredRows: rows.length,
    maxRowsPerCall: rows.length,
    manifestPayloadBytes: 0,
    firstPagePayloadBytes: bytes,
    transferredBytes: bytes,
    maxBytesPerCall: bytes,
  };
}

function executePromotedBootstrap(database: DatabaseSync, pageSize: number): Measurement {
  const manifestStatement = database.prepare(PENDING_VISIT_REVIEW_MANIFEST_SQL);
  const pageStatement = database.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
  const startedAt = performance.now();
  const manifestRow = manifestStatement.get() as PendingVisitReviewManifestRow | undefined;
  const manifestSqlCompletedAt = performance.now();
  assert.ok(manifestRow, "manifest aggregate must return one row");
  const items = parsePendingVisitReviewManifest(manifestRow);
  const manifestParseCompletedAt = performance.now();
  const generation = createPendingVisitReviewGeneration(
    items,
    PRODUCTION_BOOTSTRAP_FILTERS,
    BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS,
    manifestRow.manifestJson,
  );
  const filterPlanningCompletedAt = performance.now();
  const rows: PendingVisitReviewQueryRow[] = [];
  const pages: Array<{
    readonly keys: PendingVisitReviewPageKey[];
    readonly rows: PendingVisitReviewQueryRow[];
  }> = [];
  let timeToFirstPageMilliseconds: number | null = null;
  let firstPageHydrationMilliseconds = 0;

  for (const pageKeys of partitionPendingVisitReviewKeys(generation.selectedKeys, pageSize)) {
    const pageStartedAt = performance.now();
    const pageRows = pageStatement.all(
      serializePendingVisitReviewPageKeys(pageKeys),
    ) as unknown as PendingVisitReviewQueryRow[];
    const pageCompletedAt = performance.now();
    pages.push({ keys: pageKeys, rows: pageRows });
    rows.push(...pageRows);
    if (timeToFirstPageMilliseconds === null) {
      timeToFirstPageMilliseconds = pageCompletedAt - startedAt;
      firstPageHydrationMilliseconds = pageCompletedAt - pageStartedAt;
    }
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  const manifestBytes = serializedBytes([manifestRow]);
  const firstPageBytes = pages[0] ? serializedBytes(pages[0].rows) : 0;
  let transferredRows = 1;
  let maxRowsPerCall = 1;
  let transferredBytes = manifestBytes;
  let maxBytesPerCall = manifestBytes;
  for (const page of pages) {
    assertRowsMatchKeys(page.rows, page.keys);
    const pageBytes = serializedBytes(page.rows);
    transferredRows += page.rows.length;
    maxRowsPerCall = Math.max(maxRowsPerCall, page.rows.length);
    transferredBytes += pageBytes;
    maxBytesPerCall = Math.max(maxBytesPerCall, pageBytes);
  }
  return {
    elapsedMilliseconds,
    timeToFirstPageMilliseconds: timeToFirstPageMilliseconds ?? filterPlanningCompletedAt - startedAt,
    manifestSqlMilliseconds: manifestSqlCompletedAt - startedAt,
    strictManifestParseMilliseconds: manifestParseCompletedAt - manifestSqlCompletedAt,
    globalFilterPlanningMilliseconds: filterPlanningCompletedAt - manifestParseCompletedAt,
    firstPageHydrationMilliseconds,
    checksum: checksumRows(rows),
    queryCalls: 1 + pages.length,
    manifestQueryCalls: 1,
    hydrationQueryCalls: pages.length,
    manifestRows: 1,
    manifestItems: items.length,
    selectedRows: generation.selectedKeys.length,
    exactMatchRows: generation.summary.exactMatchCount,
    filteredManualRows: generation.summary.filteredManualCount,
    firstPageRows: pages[0]?.rows.length ?? 0,
    resultRows: rows.length,
    transferredRows,
    maxRowsPerCall,
    manifestPayloadBytes: manifestBytes,
    firstPagePayloadBytes: firstPageBytes,
    transferredBytes,
    maxBytesPerCall,
  };
}

function executeStrategy(database: DatabaseSync, strategy: Strategy): Measurement {
  if (strategy === "monolith") {
    return executeMonolith(database);
  }
  return executePromotedBootstrap(database, Number(strategy.slice("page-".length)));
}

function measurementShape(measurement: Measurement): MeasurementShape {
  return {
    queryCalls: measurement.queryCalls,
    manifestQueryCalls: measurement.manifestQueryCalls,
    hydrationQueryCalls: measurement.hydrationQueryCalls,
    manifestRows: measurement.manifestRows,
    manifestItems: measurement.manifestItems,
    selectedRows: measurement.selectedRows,
    exactMatchRows: measurement.exactMatchRows,
    filteredManualRows: measurement.filteredManualRows,
    firstPageRows: measurement.firstPageRows,
    resultRows: measurement.resultRows,
    transferredRows: measurement.transferredRows,
    maxRowsPerCall: measurement.maxRowsPerCall,
    manifestPayloadBytes: measurement.manifestPayloadBytes,
    firstPagePayloadBytes: measurement.firstPagePayloadBytes,
    transferredBytes: measurement.transferredBytes,
    maxBytesPerCall: measurement.maxBytesPerCall,
  };
}

function summarize(samples: readonly number[]): MeasurementSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0],
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function counterbalancedOrder(strategies: readonly Strategy[], round: number): Strategy[] {
  const base = round % 2 === 0 ? [...strategies] : [...strategies].reverse();
  const offset = round % strategies.length;
  return [...base.slice(offset), ...base.slice(0, offset)];
}

function verifyCandidateParity(database: DatabaseSync, pageSizes: readonly number[]) {
  const productionRows = database
    .prepare(PENDING_VISITS_FOR_REVIEW_SQL)
    .all() as unknown as PendingVisitReviewQueryRow[];
  const expected = canonicalReviewOrder(productionRows);
  const productionTieGroups = new Map<string, number>();
  for (const row of productionRows) {
    const key = `${row.priority}:${row.startTime}`;
    productionTieGroups.set(key, (productionTieGroups.get(key) ?? 0) + 1);
  }
  const tiedPriorityStartTimeGroups = [...productionTieGroups.values()].filter((count) => count > 1).length;
  const literalMonolithOrderMatchedDeterministicOrder = productionRows.every(
    (row, index) => row.id === expected[index].id,
  );
  const expectedChecksum = checksumRows(expected);
  const keyResult = orderedKeys(database);
  assert.deepEqual(
    keyResult.keys,
    expected.map(({ id, priority }) => ({ id, priority })),
    "ordered-key query must match production raw rows after the explicit ID tie refinement",
  );
  for (const pageSize of pageSizes) {
    const pageStatement = database.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
    const rows: PendingVisitReviewQueryRow[] = [];
    for (const pageKeys of partitionPendingVisitReviewKeys(keyResult.keys, pageSize)) {
      const pageRows = pageStatement.all(
        serializePendingVisitReviewPageKeys(pageKeys),
      ) as unknown as PendingVisitReviewQueryRow[];
      assertRowsMatchKeys(pageRows, pageKeys);
      rows.push(...pageRows);
    }
    assert.deepEqual(
      rows,
      expected,
      `page size ${pageSize} must match every production raw field under the deterministic tie refinement`,
    );
    assert.equal(checksumRows(rows), expectedChecksum);
  }
  return {
    comparedRows: expected.length,
    fullRawRowSha256: expectedChecksum,
    orderedKeyRowCount: 1,
    orderedKeys: keyResult.keys.length,
    orderedKeysPayloadBytes: serializedBytes([keyResult.row]),
    exactRawFieldParityUnderDeterministicOrder: true,
    deterministicFinalOrderKey: "id ASC",
    productionOrderContract: "priority ASC, startTime DESC; equal groups are unspecified",
    tiedPriorityStartTimeGroups,
    literalMonolithOrderMatchedDeterministicOrder,
  };
}

function buildPromotedBootstrapOracle(database: DatabaseSync): PromotedBootstrapOracle {
  const manifestRow = database.prepare(PENDING_VISIT_REVIEW_MANIFEST_SQL).get() as
    | PendingVisitReviewManifestRow
    | undefined;
  assert.ok(manifestRow, "manifest aggregate must return one row");
  const items = parsePendingVisitReviewManifest(manifestRow);
  const generation = createPendingVisitReviewGeneration(
    items,
    PRODUCTION_BOOTSTRAP_FILTERS,
    BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS,
    manifestRow.manifestJson,
  );
  const rawRows = canonicalReviewOrder(
    database.prepare(PENDING_VISITS_FOR_REVIEW_SQL).all() as unknown as PendingVisitReviewQueryRow[],
  );
  assert.deepEqual(
    items.map(({ id, priority }) => ({ id, priority })),
    rawRows.map(({ id, priority }) => ({ id, priority })),
    "strict manifest order and priority must match the deterministic monolith candidate order",
  );
  const manifestItemById = new Map(items.map((item) => [item.id, item]));
  for (const row of rawRows) {
    const manifestItem = manifestItemById.get(row.id);
    assert.ok(manifestItem, `manifest must contain monolith visit ${JSON.stringify(row.id)}`);
    assert.deepEqual(
      manifestItem.suggestedRestaurants.map((restaurant) => restaurant.id),
      parseHydratedSuggestionIds(row),
      `manifest and hydrated suggestion order must match for ${JSON.stringify(row.id)}`,
    );
  }
  const rowById = new Map(rawRows.map((row) => [row.id, row]));
  const expectedRows = generation.selectedKeys.map((key) => {
    const row = rowById.get(key.id);
    assert.ok(row, `promoted generation selected unknown visit ${JSON.stringify(key.id)}`);
    assert.equal(row.priority, key.priority, `promoted generation priority diverged for ${JSON.stringify(key.id)}`);
    return row;
  });
  assert.equal(expectedRows.length, generation.selectedKeys.length);
  return {
    manifestRow,
    items,
    generation,
    expectedRows,
    selectedRowSha256: checksumRows(expectedRows),
  };
}

function verifyPromotedBootstrapFullHydration(database: DatabaseSync, pageSizes: readonly number[]) {
  const oracle = buildPromotedBootstrapOracle(database);
  const pageStatement = database.prepare(PENDING_VISIT_REVIEW_PAGE_SQL);
  for (const pageSize of pageSizes) {
    const rows: PendingVisitReviewQueryRow[] = [];
    for (const pageKeys of partitionPendingVisitReviewKeys(oracle.generation.selectedKeys, pageSize)) {
      const pageRows = pageStatement.all(
        serializePendingVisitReviewPageKeys(pageKeys),
      ) as unknown as PendingVisitReviewQueryRow[];
      assertRowsMatchKeys(pageRows, pageKeys);
      rows.push(...pageRows);
    }
    assert.deepEqual(
      rows,
      oracle.expectedRows,
      `promoted page size ${pageSize} must hydrate every globally planned selected row exactly`,
    );
    assert.equal(checksumRows(rows), oracle.selectedRowSha256);
  }
  return {
    ...oracle,
    manifestSqlRows: 1,
    manifestItems: oracle.items.length,
    manifestJsonUtf8Bytes: Buffer.byteLength(oracle.manifestRow.manifestJson),
    manifestSqlPayloadBytes: serializedBytes([oracle.manifestRow]),
    exactSelectedRows: oracle.generation.summary.exactMatchCount,
    filteredManualRows: oracle.generation.summary.filteredManualCount,
    selectedRows: oracle.expectedRows.length,
    exactSelectedRowParity: true,
    deterministicSuggestionOrderParity: true,
  };
}

async function run(configuration: Configuration): Promise<void> {
  const calendarTitleMatchingSourceAttestation = assertCalendarTitleMatchingSourceContract();
  let sourceBefore: SourceSnapshot | null = null;
  let database: DatabaseSync;
  let mode: "synthetic" | "immutable-real";
  let syntheticBuildMilliseconds: number | null = null;

  if (configuration.databasePath) {
    assertSourceCanBeOpenedImmutable(configuration.databasePath);
    assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
    sourceBefore = snapshotSource(configuration.databasePath);
    database = new DatabaseSync(immutableDatabaseUri(configuration.databasePath), { readOnly: true });
    mode = "immutable-real";
  } else {
    database = new DatabaseSync(":memory:");
    mode = "synthetic";
    createSchema(database);
    const buildStartedAt = performance.now();
    seedSyntheticDatabase(database, configuration);
    syntheticBuildMilliseconds = performance.now() - buildStartedAt;
  }

  let report: Record<string, unknown>;
  try {
    database.exec("PRAGMA query_only = ON; BEGIN");
    const changesBefore = totalChanges(database);
    const integrityRow = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    assert.equal(integrityRow?.integrity_check, "ok", "database integrity_check must pass");
    const foreignKeyViolationCount = database.prepare("PRAGMA foreign_key_check").all().length;
    assert.equal(foreignKeyViolationCount, 0, "database must not contain foreign-key violations");
    const dataset = datasetSummary(database);
    const parityBefore = verifyCandidateParity(database, configuration.pageSizes);
    const promotedParityBefore = verifyPromotedBootstrapFullHydration(database, configuration.pageSizes);

    const strategies: Strategy[] = ["monolith", ...configuration.pageSizes.map((size) => `page-${size}` as const)];
    for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
      for (const strategy of counterbalancedOrder(strategies, warmup)) {
        const measurement = executeStrategy(database, strategy);
        const expectedChecksum =
          strategy === "monolith" ? parityBefore.fullRawRowSha256 : promotedParityBefore.selectedRowSha256;
        assert.equal(measurement.checksum, expectedChecksum, `warmup ${strategy} checksum diverged`);
      }
    }

    const measurements = Object.fromEntries(strategies.map((strategy) => [strategy, [] as Measurement[]])) as Record<
      Strategy,
      Measurement[]
    >;
    const measurementOrder: Strategy[][] = [];
    const measuredChecksums = new Map<Strategy, Set<string>>(
      strategies.map((strategy) => [strategy, new Set<string>()]),
    );
    for (let sample = 0; sample < configuration.samples; sample++) {
      const order = counterbalancedOrder(strategies, sample + configuration.warmupIterations);
      measurementOrder.push(order);
      for (const strategy of order) {
        const measurement = executeStrategy(database, strategy);
        const expectedChecksum =
          strategy === "monolith" ? parityBefore.fullRawRowSha256 : promotedParityBefore.selectedRowSha256;
        assert.equal(measurement.checksum, expectedChecksum, `sample ${sample + 1} ${strategy} diverged`);
        measurements[strategy].push(measurement);
        measuredChecksums.get(strategy)!.add(measurement.checksum);
      }
    }

    const parityAfter = verifyCandidateParity(database, configuration.pageSizes);
    const promotedParityAfter = verifyPromotedBootstrapFullHydration(database, configuration.pageSizes);
    assert.equal(parityAfter.fullRawRowSha256, parityBefore.fullRawRowSha256, "database rows changed during timing");
    assert.equal(
      promotedParityAfter.selectedRowSha256,
      promotedParityBefore.selectedRowSha256,
      "promoted selected rows changed during timing",
    );
    assert.equal(
      promotedParityAfter.manifestRow.manifestJson,
      promotedParityBefore.manifestRow.manifestJson,
      "manifest changed during timing",
    );
    for (const strategy of strategies) {
      const expectedChecksum =
        strategy === "monolith" ? parityBefore.fullRawRowSha256 : promotedParityBefore.selectedRowSha256;
      assert.deepEqual([...measuredChecksums.get(strategy)!], [expectedChecksum]);
    }
    const changesAfter = totalChanges(database);
    assert.equal(changesAfter, changesBefore, "read-only profiling must not change SQLite total_changes()");

    const monolithFullSummary = summarize(measurements.monolith.map((measurement) => measurement.elapsedMilliseconds));
    const monolithFirstSummary = summarize(
      measurements.monolith.map((measurement) => measurement.timeToFirstPageMilliseconds),
    );
    const timingByStrategy = Object.fromEntries(
      strategies.map((strategy) => {
        const fullHydration = summarize(measurements[strategy].map((measurement) => measurement.elapsedMilliseconds));
        const timeToFirstPage = summarize(
          measurements[strategy].map((measurement) => measurement.timeToFirstPageMilliseconds),
        );
        const expectedShape = measurementShape(measurements[strategy][0]);
        for (const measurement of measurements[strategy]) {
          assert.deepEqual(
            measurementShape(measurement),
            expectedShape,
            `${strategy} transfer shape changed between samples`,
          );
        }
        return [
          strategy,
          {
            fullHydration,
            timeToFirstPage,
            promotedBootstrapStages:
              strategy === "monolith"
                ? null
                : {
                    manifestSql: summarize(
                      measurements[strategy].map((measurement) => measurement.manifestSqlMilliseconds),
                    ),
                    strictManifestParse: summarize(
                      measurements[strategy].map((measurement) => measurement.strictManifestParseMilliseconds),
                    ),
                    globalProductionTitleMatchingAndFilterPlanning: summarize(
                      measurements[strategy].map((measurement) => measurement.globalFilterPlanningMilliseconds),
                    ),
                    firstPageHydration: summarize(
                      measurements[strategy].map((measurement) => measurement.firstPageHydrationMilliseconds),
                    ),
                    accountedFirstPageStages: summarize(
                      measurements[strategy].map(
                        (measurement) =>
                          measurement.manifestSqlMilliseconds +
                          measurement.strictManifestParseMilliseconds +
                          measurement.globalFilterPlanningMilliseconds +
                          measurement.firstPageHydrationMilliseconds,
                      ),
                    ),
                  },
            transferShape: expectedShape,
            relativeToMonolith: {
              firstPageSpeedup: monolithFirstSummary.medianMilliseconds / timeToFirstPage.medianMilliseconds,
              fullHydrationSpeedup: monolithFullSummary.medianMilliseconds / fullHydration.medianMilliseconds,
              fullHydrationMillisecondsDelta: fullHydration.medianMilliseconds - monolithFullSummary.medianMilliseconds,
            },
          },
        ];
      }),
    );

    const monolithTransferShape = measurementShape(measurements.monolith[0]);
    const productionStrategy = `page-${DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE}` as const;
    const productionTransferShape = measurementShape(measurements[productionStrategy][0]);
    assert.equal(
      productionTransferShape.firstPageRows,
      Math.min(DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE, productionTransferShape.selectedRows),
      "production strategy must hydrate the first 128 globally selected rows",
    );
    const bootstrapPayloadComparison = {
      monolith: {
        sqliteRows: monolithTransferShape.transferredRows,
        pendingVisits: monolithTransferShape.resultRows,
        payloadBytes: monolithTransferShape.transferredBytes,
      },
      compactManifest: {
        sqliteRows: productionTransferShape.manifestRows,
        manifestItems: productionTransferShape.manifestItems,
        payloadBytes: productionTransferShape.manifestPayloadBytes,
        payloadBytesSavedVersusMonolith:
          monolithTransferShape.transferredBytes - productionTransferShape.manifestPayloadBytes,
        payloadRatioVersusMonolith:
          productionTransferShape.manifestPayloadBytes / monolithTransferShape.transferredBytes,
      },
      firstHydratedPage: {
        requestedMaximumRows: DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
        hydratedRows: productionTransferShape.firstPageRows,
        payloadBytes: productionTransferShape.firstPagePayloadBytes,
      },
      promotedBootstrapThroughFirstPage: {
        sqliteRows: productionTransferShape.manifestRows + productionTransferShape.firstPageRows,
        payloadBytes: productionTransferShape.manifestPayloadBytes + productionTransferShape.firstPagePayloadBytes,
        payloadBytesSavedVersusMonolith:
          monolithTransferShape.transferredBytes -
          productionTransferShape.manifestPayloadBytes -
          productionTransferShape.firstPagePayloadBytes,
        payloadRatioVersusMonolith:
          (productionTransferShape.manifestPayloadBytes + productionTransferShape.firstPagePayloadBytes) /
          monolithTransferShape.transferredBytes,
      },
    };

    report = {
      schemaVersion: 2,
      status: "ok",
      benchmarkScope:
        mode === "immutable-real"
          ? "Node/V8 node:sqlite against one immutable read-only Palate database snapshot; promoted timing includes compact manifest SQL, strict JSON parsing, global production title matching/filter planning, and page hydration, but excludes Expo SQLite scheduling, the React Native bridge, Hermes, React rendering, Photos, and live Calendar access."
          : "Node/V8 node:sqlite against a synthetic in-memory current-Mac-scale fixture; promoted timing includes compact manifest SQL, strict JSON parsing, global production title matching/filter planning, and page hydration, but excludes Expo SQLite scheduling, the React Native bridge, Hermes, React rendering, Photos, and live Calendar access.",
      productionGuidance:
        "page-128 measures the promoted production bootstrap contract. Its full-hydration timing is retained only as a compatibility/correctness oracle; production consumes pages progressively.",
      strategyContracts: {
        monolith: "PENDING_VISITS_FOR_REVIEW_SQL returning every heavy pending row",
        [productionStrategy]:
          "PENDING_VISIT_REVIEW_MANIFEST_SQL + strict parse + createPendingVisitReviewGeneration with production title semantics and default on/on filters + first 128-row hydration",
      },
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        sqlite: (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
      },
      configuration: {
        mode,
        syntheticPendingVisits: mode === "synthetic" ? configuration.pendingVisits : null,
        syntheticPhotos: mode === "synthetic" ? configuration.photos : null,
        pageSizes: configuration.pageSizes,
        productionPageSize: DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
        productionBootstrapFilters: PRODUCTION_BOOTSTRAP_FILTERS,
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
      },
      dataset: {
        ...dataset,
        syntheticBuildMilliseconds,
      },
      correctness: {
        exactRawFieldParityUnderDeterministicOrderBeforeTiming: parityBefore.exactRawFieldParityUnderDeterministicOrder,
        exactRawFieldParityUnderDeterministicOrderAfterTiming: parityAfter.exactRawFieldParityUnderDeterministicOrder,
        fullRawRowSha256BeforeTiming: parityBefore.fullRawRowSha256,
        fullRawRowSha256AfterTiming: parityAfter.fullRawRowSha256,
        promotedSelectedRowSha256BeforeTiming: promotedParityBefore.selectedRowSha256,
        promotedSelectedRowSha256AfterTiming: promotedParityAfter.selectedRowSha256,
        promotedFullHydrationParityBeforeTiming: promotedParityBefore.exactSelectedRowParity,
        promotedFullHydrationParityAfterTiming: promotedParityAfter.exactSelectedRowParity,
        manifestMonolithPageSuggestionOrderParityBeforeTiming: promotedParityBefore.deterministicSuggestionOrderParity,
        manifestMonolithPageSuggestionOrderParityAfterTiming: promotedParityAfter.deterministicSuggestionOrderParity,
        deterministicSuggestionOrderSql: PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL,
        measuredSampleChecksumsByStrategy: Object.fromEntries(
          [...measuredChecksums].map(([strategy, checksums]) => [strategy, [...checksums]]),
        ),
        comparedRows: parityBefore.comparedRows,
        orderedKeyRowCount: parityBefore.orderedKeyRowCount,
        orderedKeys: parityBefore.orderedKeys,
        orderedKeysPayloadBytes: parityBefore.orderedKeysPayloadBytes,
        deterministicFinalOrderKey: parityBefore.deterministicFinalOrderKey,
        productionOrderContract: parityBefore.productionOrderContract,
        tiedPriorityStartTimeGroups: parityBefore.tiedPriorityStartTimeGroups,
        literalMonolithOrderMatchedDeterministicOrder: parityBefore.literalMonolithOrderMatchedDeterministicOrder,
        manifestSqlRows: promotedParityBefore.manifestSqlRows,
        manifestItems: promotedParityBefore.manifestItems,
        manifestJsonUtf8Bytes: promotedParityBefore.manifestJsonUtf8Bytes,
        manifestSqlPayloadBytes: promotedParityBefore.manifestSqlPayloadBytes,
        promotedSelectedRows: promotedParityBefore.selectedRows,
        promotedExactSelectedRows: promotedParityBefore.exactSelectedRows,
        promotedFilteredManualRows: promotedParityBefore.filteredManualRows,
        calendarTitleMatchingSourceAttestation,
        checksumOrder:
          "Raw production rows canonicalized only within otherwise unspecified equal-priority/equal-startTime groups using id ASC",
        integrityCheck: integrityRow?.integrity_check,
        foreignKeyViolationCount,
        totalChangesBefore: changesBefore,
        totalChangesAfter: changesAfter,
      },
      bootstrapPayloadComparison,
      timings: timingByStrategy,
      measurementOrder,
      privacy: {
        aggregateOnly: true,
        rawRowsRetainedInReport: false,
        visitIdentifiersRetainedInReport: false,
        restaurantIdentifiersOrNamesRetainedInReport: false,
        sourcePathRetainedInReport: false,
        photosLibraryAccessed: false,
        calendarLibraryAccessed: false,
      },
    };
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the primary failure if the transaction already ended.
    }
    throw error;
  } finally {
    database.close();
  }

  if (configuration.databasePath) {
    const sourceAfter = snapshotSource(configuration.databasePath);
    assert.deepEqual(sourceAfter, sourceBefore, "immutable profiling altered the source database or a sidecar");
    report.sourceAttestation = {
      before: sourceBefore,
      after: sourceAfter,
      mainAndSidecarsByteIdentical: true,
      openMode: "mode=ro, immutable=1, PRAGMA query_only=ON, one read transaction",
    };
  } else {
    report.sourceAttestation = null;
  }

  mkdirSync(dirname(configuration.outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configuration.outputPath, 0o600);
  if (configuration.databasePath) {
    assert.deepEqual(
      snapshotSource(configuration.databasePath),
      sourceBefore,
      "source database changed while publishing the aggregate report",
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
} else {
  await run(configuration);
}
