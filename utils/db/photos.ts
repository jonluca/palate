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

// Raw photo record as stored in database (foodLabels and allLabels are JSON strings)
interface RawPhotoRecord extends Omit<PhotoRecord, "foodLabels" | "foodDetected" | "allLabels" | "mediaType"> {
  foodLabels: string | null;
  foodDetected: number | null;
  allLabels: string | null;
  mediaType: string | null;
}

interface ExportPhotoCountRow {
  readonly visitId: string;
  readonly photoCount: number;
}

function isValidExportPhotoCountRow(row: ExportPhotoCountRow): row is ExportPhotoCountRow {
  return typeof row.visitId === "string" && Number.isSafeInteger(row.photoCount) && row.photoCount >= 0;
}

function hasValidPhotoAssetId(row: { readonly id: string }): row is { readonly id: string } {
  return typeof row.id === "string" && row.id.length > 0;
}

function hasUsablePhotoDatabasePath(
  database: Awaited<ReturnType<typeof getDatabase>>,
): database is Awaited<ReturnType<typeof getDatabase>> & { readonly databasePath: string } {
  return typeof database.databasePath === "string" && database.databasePath.trim().length > 0;
}

// Helper to parse raw database photo record into proper PhotoRecord
function parsePhotoRecord(raw: RawPhotoRecord): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    foodLabels = parseFoodLabelArrayJson(raw.foodLabels);
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    allLabels = parseFoodLabelArrayJson(raw.allLabels);
  }

  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels,
    allLabels,
    mediaType: raw.mediaType === "video" ? "video" : "photo",
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
      const insertedRows = await transaction.getAllAsync<{ id: string }>(
        `${statement.sql} RETURNING id`,
        statement.parameters,
      );
      if (insertedRows.length > 0) {
        await transaction.runAsync(
          ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL,
          JSON.stringify(insertedRows.map((row) => row.id)),
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
  return database.getAllAsync<UnvisitedPhotoRecord>(
    `SELECT id, creationTime, latitude, longitude
     FROM photos
     WHERE visitId IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY creationTime ASC, id ASC`,
  );
}

export async function getPhotosByVisitId(visitId: string): Promise<PhotoRecord[]> {
  const database = await getDatabase();
  // Preserve the existing per-visit ordering contract for non-export consumers.
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE visitId = ? ORDER BY 
      CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
      creationTime ASC`,
    [visitId],
  );
  return rawPhotos.map(parsePhotoRecord);
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
  const rows = await database.getAllAsync<ExportPhotoCountRow>(query.sql, query.parameters);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isValidExportPhotoCountRow(row)) {
      throw new Error("Export photo count query returned an invalid row.");
    }
    counts.set(row.visitId, row.photoCount);
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
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(query.sql, query.parameters);
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
  const rows = await database.getAllAsync<{ id: string }>(INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL);
  const ids = rows.map((row, index) => {
    if (!hasValidPhotoAssetId(row)) {
      throw new Error(`Photo asset ID query returned an invalid ID at row ${index}`);
    }
    return row.id;
  });
  return ids;
}

/** Return the exact SQLite path for native database-backed PhotoKit exclusion. */
export async function getPhotoDatabasePathForIncrementalScan(): Promise<string> {
  const database = await getDatabase();
  if (!hasUsablePhotoDatabasePath(database)) {
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
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE id IN (${placeholders})`,
    assetIds,
  );
  return rawPhotos.map(parsePhotoRecord);
}
