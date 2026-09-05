import { getDatabase } from "./core";
import { runTransactionWithBusyRetry } from "./transaction-retry-core";
import {
  buildPhotoVisitAssociationStatement,
  flattenPhotoVisitAssociations,
  PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
} from "./photo-association-core";
import type { MovePhotosResult, RemovePhotosResult } from "./types";
import { REFRESH_VISIT_PHOTO_SUMMARIES_SQL } from "./visit-photo-summary-core";

export async function batchUpdatePhotoVisits(updates: { photoIds: string[]; visitId: string }[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const associations = flattenPhotoVisitAssociations(updates);
  if (associations.length === 0) {
    return;
  }

  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (let i = 0; i < associations.length; i += PHOTO_VISIT_ASSOCIATION_BATCH_SIZE) {
      const statement = buildPhotoVisitAssociationStatement(
        associations.slice(i, i + PHOTO_VISIT_ASSOCIATION_BATCH_SIZE),
      );
      await transaction.runAsync(statement.sql, statement.parameters);
    }
  });
}

/**
 * Move photos to a different visit.
 * Updates the visitId for each photo and recalculates photo counts for affected visits.
 * Returns the count of photos moved and the visit IDs they were moved from.
 */
export async function movePhotosToVisit(photoIds: string[], targetVisitId: string): Promise<MovePhotosResult> {
  if (photoIds.length === 0) {
    return { movedCount: 0, fromVisitIds: [] };
  }

  const database = await getDatabase();
  const photoIdsJson = JSON.stringify([...new Set(photoIds)]);
  return runTransactionWithBusyRetry(async () => {
    let result: MovePhotosResult = { movedCount: 0, fromVisitIds: [] };
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const existingPhotos = await transaction.getAllAsync<{ id: string; visitId: string | null }>(
        `SELECT id, visitId FROM photos WHERE id IN (SELECT value FROM json_each(?))`,
        [photoIdsJson],
      );
      if (existingPhotos.length === 0) {
        return;
      }

      // Exclusive transaction connections do not inherit foreign_keys=ON.
      // Check the destination before changing any photo ownership.
      const target = await transaction.getFirstAsync<{ id: string }>(`SELECT id FROM visits WHERE id = ?`, [
        targetVisitId,
      ]);
      if (!target) {
        throw new Error("Target visit not found");
      }

      const sourceVisitIds = new Set<string>();
      for (const photo of existingPhotos) {
        if (photo.visitId !== null && photo.visitId !== targetVisitId) {
          sourceVisitIds.add(photo.visitId);
        }
      }

      await transaction.runAsync(`UPDATE photos SET visitId = ? WHERE id IN (SELECT value FROM json_each(?))`, [
        targetVisitId,
        photoIdsJson,
      ]);
      await transaction.runAsync(REFRESH_VISIT_PHOTO_SUMMARIES_SQL, [
        JSON.stringify([...sourceVisitIds, targetVisitId]),
        targetVisitId,
      ]);
      result = { movedCount: existingPhotos.length, fromVisitIds: [...sourceVisitIds] };
    });
    return result;
  });
}

/**
 * Remove photos from a visit by setting their visitId to null.
 * This disassociates the photos from the visit without deleting them.
 * Updates the visit's photo count and time range after removal.
 */
export async function removePhotosFromVisit(photoIds: string[], visitId: string): Promise<RemovePhotosResult> {
  if (photoIds.length === 0) {
    return { removedCount: 0 };
  }

  const database = await getDatabase();
  const photoIdsJson = JSON.stringify([...new Set(photoIds)]);
  return runTransactionWithBusyRetry(async () => {
    let removedCount = 0;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      // The ownership predicate both protects photos from other visits and makes
      // the affected-row count authoritative without a separate snapshot read.
      const removal = await transaction.runAsync(
        `UPDATE photos SET visitId = NULL WHERE visitId = ? AND id IN (SELECT value FROM json_each(?))`,
        [visitId, photoIdsJson],
      );
      if (removal.changes === 0) {
        return;
      }
      await transaction.runAsync(REFRESH_VISIT_PHOTO_SUMMARIES_SQL, [JSON.stringify([visitId]), visitId]);
      removedCount = removal.changes;
    });
    return { removedCount };
  });
}
