import { getDatabase } from "./core";
import {
  buildLabeledPhotoFoodDetectionStatement,
  buildSimplePhotoFoodDetectionStatement,
  coalescePhotoFoodDetectionUpdates,
  LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE,
  type PhotoFoodDetectionUpdate,
} from "./photo-food-detection-core";
import { buildExportPhotoCountsQuery, buildExportPhotosQuery, type ExportPhotoCursor } from "./export-photos-core";
import { buildPhotoIngestionStatement, PHOTO_INGESTION_FLUSH_SIZE } from "./photo-ingestion-core";
import { INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL } from "../incremental-photo-scan-core";
import {
  ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL,
  MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
} from "./automatic-photo-deep-scan-queue-core";
import type { FoodLabel, PhotoRecord, UnvisitedPhotoRecord } from "./types";
import { parseFoodLabelArrayJson } from "./food-label-json.ts";

type SQLiteColumnValue = string | number | boolean | null | ArrayBuffer | Uint8Array;

interface PhotoQueryRow {
  readonly id: SQLiteColumnValue;
  readonly uri: SQLiteColumnValue;
  readonly creationTime: SQLiteColumnValue;
  readonly latitude: SQLiteColumnValue;
  readonly longitude: SQLiteColumnValue;
  readonly visitId: SQLiteColumnValue;
  readonly foodDetected: SQLiteColumnValue;
  readonly foodLabels: SQLiteColumnValue;
  readonly foodConfidence: SQLiteColumnValue;
  readonly allLabels: SQLiteColumnValue;
  readonly mediaType: SQLiteColumnValue;
  readonly duration: SQLiteColumnValue;
}

interface StoredPhotoRecord {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly visitId: string | null;
  readonly foodDetected: 0 | 1 | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly mediaType: "photo" | "video" | null;
  readonly duration: number | null;
}

interface ExportPhotoCountQueryRow {
  readonly visitId: SQLiteColumnValue;
  readonly photoCount: SQLiteColumnValue;
}

interface PhotoAssetIdQueryRow {
  readonly id: SQLiteColumnValue;
}

interface UnvisitedPhotoQueryRow {
  readonly id: SQLiteColumnValue;
  readonly creationTime: SQLiteColumnValue;
  readonly latitude: SQLiteColumnValue;
  readonly longitude: SQLiteColumnValue;
}

function isSQLiteText(value: SQLiteColumnValue): value is string {
  return typeof value === "string";
}

function isSQLiteFiniteNumber(value: SQLiteColumnValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredSQLiteText(value: SQLiteColumnValue, column: string, rowIndex: number): string {
  if (!isSQLiteText(value)) {
    throw new Error(`Photo query row ${rowIndex} returned a non-text ${column}.`);
  }
  return value;
}

function nullableSQLiteText(value: SQLiteColumnValue, column: string, rowIndex: number): string | null {
  return value === null ? null : requiredSQLiteText(value, column, rowIndex);
}

function requiredSQLiteNumber(value: SQLiteColumnValue, column: string, rowIndex: number): number {
  if (!isSQLiteFiniteNumber(value)) {
    throw new Error(`Photo query row ${rowIndex} returned a non-finite numeric ${column}.`);
  }
  return value;
}

function nullableSQLiteNumber(value: SQLiteColumnValue, column: string, rowIndex: number): number | null {
  return value === null ? null : requiredSQLiteNumber(value, column, rowIndex);
}

function nullableSQLiteBoolean(value: SQLiteColumnValue, column: string, rowIndex: number): 0 | 1 | null {
  if (value === null || value === 0 || value === 1) {
    return value;
  }
  throw new Error(`Photo query row ${rowIndex} returned an invalid SQLite boolean ${column}.`);
}

function nullableSQLiteMediaType(value: SQLiteColumnValue, column: string, rowIndex: number): "photo" | "video" | null {
  if (value === null || value === "photo" || value === "video") {
    return value;
  }
  throw new Error(`Photo query row ${rowIndex} returned an invalid ${column}.`);
}

function parsePhotoQueryRow(row: PhotoQueryRow, rowIndex: number): StoredPhotoRecord {
  return {
    id: requiredSQLiteText(row.id, "id", rowIndex),
    uri: requiredSQLiteText(row.uri, "uri", rowIndex),
    creationTime: requiredSQLiteNumber(row.creationTime, "creationTime", rowIndex),
    latitude: nullableSQLiteNumber(row.latitude, "latitude", rowIndex),
    longitude: nullableSQLiteNumber(row.longitude, "longitude", rowIndex),
    visitId: nullableSQLiteText(row.visitId, "visitId", rowIndex),
    foodDetected: nullableSQLiteBoolean(row.foodDetected, "foodDetected", rowIndex),
    foodLabels: nullableSQLiteText(row.foodLabels, "foodLabels", rowIndex),
    foodConfidence: nullableSQLiteNumber(row.foodConfidence, "foodConfidence", rowIndex),
    allLabels: nullableSQLiteText(row.allLabels, "allLabels", rowIndex),
    mediaType: nullableSQLiteMediaType(row.mediaType, "mediaType", rowIndex),
    duration: nullableSQLiteNumber(row.duration, "duration", rowIndex),
  };
}

function parseExportPhotoCountRow(row: ExportPhotoCountQueryRow, rowIndex: number): readonly [string, number] {
  const visitId = requiredSQLiteText(row.visitId, "visitId", rowIndex);
  const photoCount = requiredSQLiteNumber(row.photoCount, "photoCount", rowIndex);
  if (!Number.isSafeInteger(photoCount) || photoCount < 0) {
    throw new Error(`Photo query row ${rowIndex} returned an invalid photoCount.`);
  }
  return [visitId, photoCount];
}

function parsePhotoAssetId(row: PhotoAssetIdQueryRow, rowIndex: number): string {
  const id = requiredSQLiteText(row.id, "id", rowIndex);
  if (id.length === 0) {
    throw new Error(`Photo asset ID query returned an empty ID at row ${rowIndex}.`);
  }
  return id;
}

function parseUnvisitedPhotoQueryRow(row: UnvisitedPhotoQueryRow, rowIndex: number): UnvisitedPhotoRecord {
  return {
    id: requiredSQLiteText(row.id, "id", rowIndex),
    creationTime: requiredSQLiteNumber(row.creationTime, "creationTime", rowIndex),
    latitude: requiredSQLiteNumber(row.latitude, "latitude", rowIndex),
    longitude: requiredSQLiteNumber(row.longitude, "longitude", rowIndex),
  };
}

// Helper to parse stored JSON and SQLite booleans into a proper PhotoRecord.
function parsePhotoRecord(raw: StoredPhotoRecord): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    foodLabels = parseFoodLabelArrayJson(raw.foodLabels);
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    allLabels = parseFoodLabelArrayJson(raw.allLabels);
  }

  return {
    id: raw.id,
    uri: raw.uri,
    creationTime: raw.creationTime,
    latitude: raw.latitude,
    longitude: raw.longitude,
    visitId: raw.visitId,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels,
    foodConfidence: raw.foodConfidence,
    allLabels,
    mediaType: raw.mediaType === "video" ? "video" : "photo",
    duration: raw.duration,
  };
}

// Photo operations
export async function insertPhotos(
  photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence" | "allLabels">[],
): Promise<number> {
  if (photos.length === 0) {
    return 0;
  }

  const database = await getDatabase();
  let insertedCount = 0;
  for (let offset = 0; offset < photos.length; offset += PHOTO_INGESTION_FLUSH_SIZE) {
    const statement = buildPhotoIngestionStatement(photos.slice(offset, offset + PHOTO_INGESTION_FLUSH_SIZE));
    if (!statement) {
      continue;
    }
    const result = await database.runAsync(statement.sql, statement.parameters);
    insertedCount += result.changes;
  }
  return insertedCount;
}

/** Atomically persist newly inserted photos and enqueue their exact IDs for automatic deep scanning. */
export async function insertPhotosForAutomaticDeepScan(
  photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence" | "allLabels">[],
): Promise<number> {
  if (photos.length === 0) {
    return 0;
  }

  const database = await getDatabase();
  let insertedCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (let offset = 0; offset < photos.length; offset += PHOTO_INGESTION_FLUSH_SIZE) {
      const statement = buildPhotoIngestionStatement(photos.slice(offset, offset + PHOTO_INGESTION_FLUSH_SIZE));
      if (!statement) {
        continue;
      }
      const insertedRows = await transaction.getAllAsync<PhotoAssetIdQueryRow>(
        `${statement.sql} RETURNING id`,
        statement.parameters,
      );
      if (insertedRows.length > 0) {
        await transaction.runAsync(
          ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL,
          JSON.stringify(insertedRows.map(parsePhotoAssetId)),
        );
        await transaction.runAsync(MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL);
        insertedCount += insertedRows.length;
      }
    }
  });
  return insertedCount;
}

export async function getUnvisitedPhotos(): Promise<UnvisitedPhotoRecord[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<UnvisitedPhotoQueryRow>(
    `SELECT id, creationTime, latitude, longitude
     FROM photos
     WHERE visitId IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY creationTime ASC, id ASC`,
  );
  return rows.map(parseUnvisitedPhotoQueryRow);
}

export async function getPhotosByVisitId(visitId: string): Promise<PhotoRecord[]> {
  const database = await getDatabase();
  // Preserve the existing per-visit ordering contract for non-export consumers.
  const queryRows = await database.getAllAsync<PhotoQueryRow>(
    `SELECT * FROM photos WHERE visitId = ? ORDER BY 
      CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
      creationTime ASC`,
    [visitId],
  );
  return queryRows.map((row, rowIndex) => parsePhotoRecord(parsePhotoQueryRow(row, rowIndex)));
}

export interface ExportPhotosPage {
  readonly photos: PhotoRecord[];
  readonly nextCursor: ExportPhotoCursor | null;
}

/** Read exact per-visit counts on the caller's snapshot connection. */
export async function getExportPhotoCountsByVisitIds(
  visitIds: readonly string[],
  databaseOverride?: Awaited<ReturnType<typeof getDatabase>>,
): Promise<Map<string, number>> {
  const query = buildExportPhotoCountsQuery(visitIds);
  if (!query) {
    return new Map();
  }

  const database = databaseOverride ?? (await getDatabase());
  const rows = await database.getAllAsync<ExportPhotoCountQueryRow>(query.sql, query.parameters);
  const counts = new Map<string, number>();
  for (const [rowIndex, row] of rows.entries()) {
    const [visitId, photoCount] = parseExportPhotoCountRow(row, rowIndex);
    counts.set(visitId, photoCount);
  }
  return counts;
}

/** Load one bounded, deterministically ordered page of export photos. */
export async function getPhotosByVisitIdsPage(
  visitIds: readonly string[],
  cursor: ExportPhotoCursor | null = null,
  databaseOverride?: Awaited<ReturnType<typeof getDatabase>>,
  pageSize?: number,
): Promise<ExportPhotosPage> {
  const query = buildExportPhotosQuery(visitIds, cursor, pageSize);
  if (!query) {
    return { photos: [], nextCursor: null };
  }

  const database = databaseOverride ?? (await getDatabase());
  const queryRows = await database.getAllAsync<PhotoQueryRow>(query.sql, query.parameters);
  const rawPhotos = queryRows.map(parsePhotoQueryRow);
  const hasNextPage = rawPhotos.length > query.pageSize;
  const pageRows = hasNextPage ? rawPhotos.slice(0, query.pageSize) : rawPhotos;
  let nextCursor: ExportPhotoCursor | null = null;

  if (hasNextPage) {
    const lastPhoto = pageRows[pageRows.length - 1];
    if (!lastPhoto || lastPhoto.visitId === null) {
      throw new Error("Export photo paging returned an invalid continuation row.");
    }
    nextCursor = {
      visitId: lastPhoto.visitId,
      foodRank: lastPhoto.foodDetected === 1 ? 0 : lastPhoto.foodDetected === 0 ? 1 : 2,
      creationTime: lastPhoto.creationTime,
      id: lastPhoto.id,
    };
  }

  return {
    photos: pageRows.map(parsePhotoRecord),
    nextCursor,
  };
}

/**
 * Get photo IDs that haven't been analyzed for food yet (foodDetected IS NULL)
 * Ordered deterministically by creationTime and id
 */
export async function getUnanalyzedPhotoIds(): Promise<{ id: string }[]> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string }>(
    `SELECT id FROM photos WHERE foodDetected IS NULL ORDER BY creationTime ASC, id ASC`,
  );
}

/**
 * Get count of photos that haven't been analyzed for food yet (foodDetected IS NULL)
 */
export async function getUnanalyzedPhotoCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE foodDetected IS NULL`,
  );
  return result?.count ?? 0;
}

export async function getTotalPhotoCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM photos`);
  return result?.count ?? 0;
}

/**
 * Read stable local identifiers for native incremental PhotoKit exclusion.
 * The single query also identifies an empty database without a second SQLite
 * round trip; callers preserve the full-scan path when this returns `[]`.
 */
export async function getExistingPhotoAssetIdsForIncrementalScan(): Promise<string[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<PhotoAssetIdQueryRow>(INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL);
  return rows.map(parsePhotoAssetId);
}

/** Return the exact SQLite path for native database-backed PhotoKit exclusion. */
export async function getPhotoDatabasePathForIncrementalScan(): Promise<string> {
  const database = await getDatabase();
  if (database.databasePath.trim().length === 0) {
    throw new Error("Expo SQLite did not expose a usable photo database path");
  }
  return database.databasePath;
}

export async function getVisitablePhotoCounts(): Promise<{
  total: number;
  visited: number;
  unvisited: number;
}> {
  const database = await getDatabase();
  const counts = await database.getFirstAsync<{ total: number; visited: number }>(
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN visitId IS NOT NULL THEN 1 ELSE 0 END) as visited
     FROM photos 
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
  );
  return {
    total: counts?.total ?? 0,
    visited: counts?.visited ?? 0,
    unvisited: (counts?.total ?? 0) - (counts?.visited ?? 0),
  };
}

export async function batchUpdatePhotosFoodDetected(updates: readonly PhotoFoodDetectionUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();
  const { labeledUpdates, simpleUpdates } = coalescePhotoFoodDetectionUpdates(updates);

  await database.withExclusiveTransactionAsync(async (transaction) => {
    let reusableLabeledStatement: Awaited<ReturnType<typeof transaction.prepareAsync>> | null = null;
    let reusableSimpleStatement: Awaited<ReturnType<typeof transaction.prepareAsync>> | null = null;
    try {
      for (let offset = 0; offset < labeledUpdates.length; offset += LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
        const batch = labeledUpdates.slice(offset, offset + LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE);
        const statement = buildLabeledPhotoFoodDetectionStatement(batch);
        if (batch.length === LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
          await (reusableLabeledStatement ??= await transaction.prepareAsync(statement.sql)).executeAsync(
            statement.parameters,
          );
        } else {
          await transaction.runAsync(statement.sql, statement.parameters);
        }
      }

      // Keep this phase after all labeled writes. It intentionally changes only
      // foodDetected, preserving any payload written by the labeled phase.
      for (let offset = 0; offset < simpleUpdates.length; offset += SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
        const batch = simpleUpdates.slice(offset, offset + SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE);
        const statement = buildSimplePhotoFoodDetectionStatement(batch);
        if (batch.length === SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE) {
          await (reusableSimpleStatement ??= await transaction.prepareAsync(statement.sql)).executeAsync(
            statement.parameters,
          );
        } else {
          await transaction.runAsync(statement.sql, statement.parameters);
        }
      }
    } finally {
      try {
        await reusableLabeledStatement?.finalizeAsync();
      } finally {
        await reusableSimpleStatement?.finalizeAsync();
      }
    }
  });
}

/**
 * Get photos by their asset IDs (for checking if photos exist in the database)
 */
export async function getPhotosByAssetIds(assetIds: string[]): Promise<PhotoRecord[]> {
  if (assetIds.length === 0) {
    return [];
  }

  const database = await getDatabase();
  const placeholders = assetIds.map(() => "?").join(", ");
  const queryRows = await database.getAllAsync<PhotoQueryRow>(
    `SELECT * FROM photos WHERE id IN (${placeholders})`,
    assetIds,
  );
  return queryRows.map((row, rowIndex) => parsePhotoRecord(parsePhotoQueryRow(row, rowIndex)));
}
