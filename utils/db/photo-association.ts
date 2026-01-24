import { getDatabase } from "./core";
import { syncAllVisitsFoodProbable } from "./visits";
import type { MovePhotosResult, RemovePhotosResult } from "./types";

export async function batchUpdatePhotoVisits(updates: { photoIds: string[]; visitId: string }[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Flatten all updates into a single query using CASE WHEN
  const allPhotoIds: string[] = [];
  const caseStatements: string[] = [];

  for (const { photoIds, visitId } of updates) {
    for (const photoId of photoIds) {
      allPhotoIds.push(photoId);
      caseStatements.push(`WHEN id = '${photoId.replace(/'/g, "''")}' THEN '${visitId.replace(/'/g, "''")}'`);
    }
  }

  if (allPhotoIds.length === 0) {
    return;
  }

  // Process in batches to avoid SQLite limits
  const batchSize = 1000;
  for (let i = 0; i < allPhotoIds.length; i += batchSize) {
    const batchPhotoIds = allPhotoIds.slice(i, i + batchSize);
    const batchCases = caseStatements.slice(i, i + batchSize);
    const placeholders = batchPhotoIds.map(() => "?").join(", ");

    await database.runAsync(
      `UPDATE photos SET visitId = CASE ${batchCases.join(" ")} END WHERE id IN (${placeholders})`,
      batchPhotoIds,
    );
  }
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

  // Get the current visit IDs for these photos (to update their counts later)
  const placeholders = photoIds.map(() => "?").join(", ");
  const existingPhotos = await database.getAllAsync<{ id: string; visitId: string | null }>(
    `SELECT id, visitId FROM photos WHERE id IN (${placeholders})`,
    photoIds,
  );

  // Collect unique source visit IDs (excluding null and the target)
  const sourceVisitIds = new Set<string>();
  for (const photo of existingPhotos) {
    if (photo.visitId && photo.visitId !== targetVisitId) {
      sourceVisitIds.add(photo.visitId);
    }
  }

  // Update the photos to point to the target visit
  await database.runAsync(`UPDATE photos SET visitId = ? WHERE id IN (${placeholders})`, [targetVisitId, ...photoIds]);

  // Update photo counts for all affected visits (target + sources)
  const allAffectedVisitIds = [...sourceVisitIds, targetVisitId];
  const visitPlaceholders = allAffectedVisitIds.map(() => "?").join(", ");

  await database.runAsync(
    `UPDATE visits SET photoCount = (
      SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id
    ) WHERE id IN (${visitPlaceholders})`,
    allAffectedVisitIds,
  );

  // Update the target visit's time range if needed (expand to include new photos)
  await database.runAsync(
    `UPDATE visits SET 
      startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
      endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?)
    WHERE id = ?`,
    [targetVisitId, targetVisitId, targetVisitId],
  );

  // Sync food probable status for affected visits
  await syncAllVisitsFoodProbable();

  return {
    movedCount: existingPhotos.length,
    fromVisitIds: Array.from(sourceVisitIds),
  };
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

  // Verify these photos belong to the specified visit
  const placeholders = photoIds.map(() => "?").join(", ");
  const matchingPhotos = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM photos WHERE id IN (${placeholders}) AND visitId = ?`,
    [...photoIds, visitId],
  );

  if (matchingPhotos.length === 0) {
    return { removedCount: 0 };
  }

  const matchingPhotoIds = matchingPhotos.map((p) => p.id);
  const matchingPlaceholders = matchingPhotoIds.map(() => "?").join(", ");

  // Set visitId to null for the photos
  await database.runAsync(`UPDATE photos SET visitId = NULL WHERE id IN (${matchingPlaceholders})`, matchingPhotoIds);

  // Update the visit's photo count
  await database.runAsync(
    `UPDATE visits SET photoCount = (
      SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id
    ) WHERE id = ?`,
    [visitId],
  );

  // Update the visit's time range based on remaining photos
  const remainingPhotos = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE visitId = ?`,
    [visitId],
  );

  if (remainingPhotos && remainingPhotos.count > 0) {
    // Update time range to match remaining photos
    await database.runAsync(
      `UPDATE visits SET 
        startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
        endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?)
      WHERE id = ?`,
      [visitId, visitId, visitId],
    );
  }

  // Sync food probable status for the visit
  await syncAllVisitsFoodProbable();

  return {
    removedCount: matchingPhotos.length,
  };
}
