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

function parsePhotoAssetId(row: PhotoAssetIdQueryRow, rowIndex: number): string {
  const id = requiredSQLiteText(row.id, "id", rowIndex);
  if (id.length === 0) {
    throw new Error(`Photo asset ID query returned an empty ID at row ${rowIndex}.`);
  }
  return id;
}

function assertUnvisitedPhotoQueryRows(rows: UnvisitedPhotoQueryRow[]): asserts rows is UnvisitedPhotoRecord[] {
  let rowIndex = 0;
  for (const row of rows) {
    requiredSQLiteText(row.id, "id", rowIndex);
    requiredSQLiteNumber(row.creationTime, "creationTime", rowIndex);
    requiredSQLiteNumber(row.latitude, "latitude", rowIndex);
    requiredSQLiteNumber(row.longitude, "longitude", rowIndex);
    rowIndex += 1;
  }
}

// Validate the SQLite boundary and construct the final domain object in one pass.
function parsePhotoQueryRow(row: PhotoQueryRow, rowIndex: number): PhotoRecord {
  const id = requiredSQLiteText(row.id, "id", rowIndex);
  const uri = requiredSQLiteText(row.uri, "uri", rowIndex);
  const creationTime = requiredSQLiteNumber(row.creationTime, "creationTime", rowIndex);
  const latitude = nullableSQLiteNumber(row.latitude, "latitude", rowIndex);
  const longitude = nullableSQLiteNumber(row.longitude, "longitude", rowIndex);
  const visitId = nullableSQLiteText(row.visitId, "visitId", rowIndex);
  const foodDetected = nullableSQLiteBoolean(row.foodDetected, "foodDetected", rowIndex);
  const foodLabelsJson = nullableSQLiteText(row.foodLabels, "foodLabels", rowIndex);
  const foodConfidence = nullableSQLiteNumber(row.foodConfidence, "foodConfidence", rowIndex);
  const allLabelsJson = nullableSQLiteText(row.allLabels, "allLabels", rowIndex);
  const mediaType = nullableSQLiteMediaType(row.mediaType, "mediaType", rowIndex);
  const duration = nullableSQLiteNumber(row.duration, "duration", rowIndex);

  let foodLabels: FoodLabel[] | null = null;
  if (foodLabelsJson) {
    foodLabels = parseFoodLabelArrayJson(foodLabelsJson);
  }

  let allLabels: FoodLabel[] | null = null;
  if (allLabelsJson) {
    allLabels = parseFoodLabelArrayJson(allLabelsJson);
  }

  return {
    id,
    uri,
    creationTime,
    latitude,
    longitude,
    visitId,
    foodDetected: foodDetected === null ? null : foodDetected === 1,
    foodLabels,
    foodConfidence,
    allLabels,
    mediaType: mediaType === "video" ? "video" : "photo",
    duration,
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
  assertUnvisitedPhotoQueryRows(rows);
  return rows;
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
  return queryRows.map(parsePhotoQueryRow);
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
  let rowIndex = 0;
  for (const row of rows) {
    const visitId = requiredSQLiteText(row.visitId, "visitId", rowIndex);
    const photoCount = requiredSQLiteNumber(row.photoCount, "photoCount", rowIndex);
    if (!Number.isSafeInteger(photoCount) || photoCount < 0) {
      throw new Error(`Photo query row ${rowIndex} returned an invalid photoCount.`);
    }
    counts.set(visitId, photoCount);
    rowIndex += 1;
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
  const hasNextPage = queryRows.length > query.pageSize;
  if (hasNextPage) {
    queryRows.length = query.pageSize;
  }
  const photos = queryRows.map(parsePhotoQueryRow);
  let nextCursor: ExportPhotoCursor | null = null;

  if (hasNextPage) {
    const lastPhoto = photos[photos.length - 1];
    if (!lastPhoto || lastPhoto.visitId === null) {
      throw new Error("Export photo paging returned an invalid continuation row.");
    }
    nextCursor = {
      visitId: lastPhoto.visitId,
      foodRank: lastPhoto.foodDetected === true ? 0 : lastPhoto.foodDetected === false ? 1 : 2,
      creationTime: lastPhoto.creationTime,
      id: lastPhoto.id,
    };
  }

  return {
    photos,
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
  return queryRows.map(parsePhotoQueryRow);
}
