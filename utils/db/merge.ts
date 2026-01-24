import { DEBUG_TIMING, getDatabase } from "./core";
import type { MergeableVisitGroup, VisitRecord, VisitWithDetails } from "./types";

/**
 * Get visits that can be merged with the given visit.
 * Returns visits that are different from the current one, ordered by time proximity.
 */
export async function getMergeableVisits(
  currentVisitId: string,
  currentStartTime: number,
): Promise<VisitWithDetails[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Get visits excluding the current one, ordered by time proximity
  // Use awardAtVisit (historical) if available, otherwise fall back to current award
  const visits = await database.getAllAsync<
    VisitRecord & {
      restaurantName: string | null;
      suggestedRestaurantName: string | null;
      suggestedRestaurantAward: string | null;
    }
  >(
    `SELECT c.*, 
            r.name as restaurantName,
            m.name as suggestedRestaurantName,
            COALESCE(c.awardAtVisit, m.award) as suggestedRestaurantAward,
            ABS(c.startTime - ?) as timeDiff
     FROM visits c
     LEFT JOIN restaurants r ON c.restaurantId = r.id
     LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
     WHERE c.id != ?
     ORDER BY timeDiff ASC
     LIMIT 50`,
    [currentStartTime, currentVisitId],
  );

  if (visits.length === 0) {
    if (DEBUG_TIMING) {
      console.log(`[DB] getMergeableVisits: ${(performance.now() - start).toFixed(2)}ms (0 results)`);
    }
    return [];
  }

  // Get preview photos
  const visitIds = visits.map((c) => c.id);
  const placeholders = visitIds.map(() => "?").join(", ");

  const previewPhotos = await database.getAllAsync<{ visitId: string; uri: string }>(
    `SELECT visitId, uri FROM (
      SELECT visitId, uri, ROW_NUMBER() OVER (
        PARTITION BY visitId 
        ORDER BY CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC, creationTime ASC
      ) as rn
      FROM photos
      WHERE visitId IN (${placeholders})
    ) WHERE rn <= 3
    ORDER BY rn ASC`,
    visitIds,
  );

  const photosByVisit = new Map<string, string[]>();
  for (const photo of previewPhotos) {
    const existing = photosByVisit.get(photo.visitId) ?? [];
    existing.push(photo.uri);
    photosByVisit.set(photo.visitId, existing);
  }

  if (DEBUG_TIMING) {
    console.log(`[DB] getMergeableVisits: ${(performance.now() - start).toFixed(2)}ms (${visits.length} results)`);
  }

  return visits.map((visit) => ({
    ...visit,
    previewPhotos: photosByVisit.get(visit.id) ?? [],
  }));
}

/**
 * Merge two visits together.
 * Photos from sourceVisitId are moved to targetVisitId, and the source visit is deleted.
 * The target visit's time range and center coordinates are updated.
 */
export async function mergeVisits(targetVisitId: string, sourceVisitId: string): Promise<void> {
  const database = await getDatabase();

  // Get both visits
  const [targetVisit, sourceVisit] = await Promise.all([
    database.getFirstAsync<VisitRecord>(`SELECT * FROM visits WHERE id = ?`, [targetVisitId]),
    database.getFirstAsync<VisitRecord>(`SELECT * FROM visits WHERE id = ?`, [sourceVisitId]),
  ]);

  if (!targetVisit || !sourceVisit) {
    throw new Error("One or both visits not found");
  }

  // Move all photos from source to target
  await database.runAsync(`UPDATE photos SET visitId = ? WHERE visitId = ?`, [targetVisitId, sourceVisitId]);

  // Calculate new time range
  const newStartTime = Math.min(targetVisit.startTime, sourceVisit.startTime);
  const newEndTime = Math.max(targetVisit.endTime, sourceVisit.endTime);

  // Calculate new centroid from all photos
  const photos = await database.getAllAsync<{ latitude: number; longitude: number }>(
    `SELECT latitude, longitude FROM photos WHERE visitId = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    [targetVisitId],
  );

  let newCenterLat = targetVisit.centerLat;
  let newCenterLon = targetVisit.centerLon;

  if (photos.length > 0) {
    const sumLat = photos.reduce((sum, p) => sum + p.latitude, 0);
    const sumLon = photos.reduce((sum, p) => sum + p.longitude, 0);
    newCenterLat = sumLat / photos.length;
    newCenterLon = sumLon / photos.length;
  }

  // Get new photo count
  const photoCountResult = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE visitId = ?`,
    [targetVisitId],
  );
  const newPhotoCount = photoCountResult?.count ?? 0;

  // Check if any photos have food detected
  const foodResult = await database.getFirstAsync<{ hasFood: number }>(
    `SELECT MAX(CASE WHEN foodDetected = 1 THEN 1 ELSE 0 END) as hasFood FROM photos WHERE visitId = ?`,
    [targetVisitId],
  );
  const foodProbable = (foodResult?.hasFood ?? 0) === 1 || targetVisit.foodProbable || sourceVisit.foodProbable;

  // Update target visit
  const now = Date.now();
  await database.runAsync(
    `UPDATE visits SET startTime = ?, endTime = ?, centerLat = ?, centerLon = ?, photoCount = ?, foodProbable = ?, updatedAt = ? WHERE id = ?`,
    [newStartTime, newEndTime, newCenterLat, newCenterLon, newPhotoCount, foodProbable ? 1 : 0, now, targetVisitId],
  );

  // Move suggested restaurants from source to target (if not already present)
  await database.runAsync(
    `INSERT OR IGNORE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
     SELECT ?, restaurantId, distance FROM visit_suggested_restaurants WHERE visitId = ?`,
    [targetVisitId, sourceVisitId],
  );

  // Delete source visit's suggested restaurants
  await database.runAsync(`DELETE FROM visit_suggested_restaurants WHERE visitId = ?`, [sourceVisitId]);

  // Delete source visit
  await database.runAsync(`DELETE FROM visits WHERE id = ?`, [sourceVisitId]);
}

// ============================================================================
// BATCH MERGE SAME RESTAURANT VISITS
// ============================================================================

/**
 * Find groups of confirmed visits to the same restaurant closely clustered in time.
 * Returns groups that have 2+ visits (i.e., visits that can be merged).
 */
export async function getMergeableSameRestaurantVisitGroups(): Promise<MergeableVisitGroup[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Get all confirmed visits with restaurant info, ordered by restaurant and time
  const visits = await database.getAllAsync<{
    id: string;
    restaurantId: string;
    restaurantName: string;
    startTime: number;
    endTime: number;
    photoCount: number;
  }>(
    `SELECT 
      v.id,
      v.restaurantId,
      r.name as restaurantName,
      v.startTime,
      v.endTime,
      v.photoCount
    FROM visits v
    JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.status = 'confirmed' AND v.restaurantId IS NOT NULL
    ORDER BY v.restaurantId, v.startTime ASC`,
  );

  if (visits.length === 0) {
    if (DEBUG_TIMING) {
      console.log(`[DB] getMergeableSameRestaurantVisitGroups: ${(performance.now() - start).toFixed(2)}ms (0 visits)`);
    }
    return [];
  }

  // Group visits by restaurant, then find visits within 12 hours of each other
  const TWELVE_FOUR_HOURS_MS = 12 * 60 * 60 * 1000;
  const mergeableGroups: MergeableVisitGroup[] = [];

  let currentGroup: typeof visits = [];
  let currentRestaurantId: string | null = null;

  const finalizeGroup = () => {
    if (currentGroup.length >= 2) {
      const subGroups = findTimeProximityGroups(currentGroup, TWELVE_FOUR_HOURS_MS);
      for (const subGroup of subGroups) {
        if (subGroup.length >= 2) {
          mergeableGroups.push({
            restaurantId: subGroup[0].restaurantId,
            restaurantName: subGroup[0].restaurantName,
            visits: subGroup.map((v) => ({
              id: v.id,
              startTime: v.startTime,
              endTime: v.endTime,
              photoCount: v.photoCount,
            })),
            totalPhotos: subGroup.reduce((sum, v) => sum + v.photoCount, 0),
          });
        }
      }
    }
  };

  for (const visit of visits) {
    if (visit.restaurantId !== currentRestaurantId) {
      // New restaurant - finalize previous group
      finalizeGroup();
      currentGroup = [visit];
      currentRestaurantId = visit.restaurantId;
    } else {
      currentGroup.push(visit);
    }
  }

  // Finalize last group
  finalizeGroup();

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getMergeableSameRestaurantVisitGroups: ${(performance.now() - start).toFixed(2)}ms (${mergeableGroups.length} groups)`,
    );
  }

  return mergeableGroups;
}

/**
 * Helper to find sub-groups of visits where consecutive visits are within the time threshold.
 * Uses a greedy approach: visits are grouped if they are within threshold of any visit in the current group.
 */
function findTimeProximityGroups<T extends { startTime: number; endTime: number }>(
  visits: T[],
  thresholdMs: number,
): T[][] {
  if (visits.length === 0) {
    return [];
  }

  const groups: T[][] = [];
  let currentGroup: T[] = [visits[0]];

  for (let i = 1; i < visits.length; i++) {
    const visit = visits[i];
    // Check if this visit is within threshold of the previous visit's end time
    const prevVisit = currentGroup[currentGroup.length - 1];
    const timeDiff = visit.startTime - prevVisit.endTime;

    if (timeDiff <= thresholdMs) {
      currentGroup.push(visit);
    } else {
      groups.push(currentGroup);
      currentGroup = [visit];
    }
  }

  groups.push(currentGroup);
  return groups;
}

/**
 * Batch merge all visits within the given groups.
 * For each group, merges all visits into the earliest one (by startTime).
 * Returns the number of merges performed (number of source visits merged).
 */
export async function batchMergeSameRestaurantVisits(groups: MergeableVisitGroup[]): Promise<number> {
  const start = DEBUG_TIMING ? performance.now() : 0;

  let totalMerges = 0;

  for (const group of groups) {
    if (group.visits.length < 2) {
      continue;
    }

    // First visit is the target (earliest by time)
    const targetVisitId = group.visits[0].id;

    // Merge all other visits into the target
    for (let i = 1; i < group.visits.length; i++) {
      const sourceVisitId = group.visits[i].id;
      await mergeVisits(targetVisitId, sourceVisitId);
      totalMerges++;
    }
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] batchMergeSameRestaurantVisits: ${(performance.now() - start).toFixed(2)}ms (${totalMerges} merges)`,
    );
  }

  return totalMerges;
}
