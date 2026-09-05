import { DEBUG_TIMING, getDatabase } from "./core";
import {
  buildVisitMergePlan,
  parseVisitMergePreflightQueryRow,
  VISIT_MERGE_COPY_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_VISITS_SQL,
  VISIT_MERGE_MOVE_PHOTOS_SQL,
  VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL,
  VISIT_MERGE_PREFLIGHT_SQL,
  VISIT_MERGE_UPDATE_TARGETS_SQL,
  type VisitMergePlan,
  type VisitMergePreflightQueryRow,
} from "./visit-merge-core";
import { runTransactionWithBusyRetry } from "./transaction-retry-core";
import type { MergeableVisitGroup, VisitWithDetails } from "./types";
import { parseVisitQueryRow, type VisitQueryRow } from "./visit-record-core";

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
    VisitQueryRow & {
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
    ...parseVisitQueryRow(visit),
    previewPhotos: photosByVisit.get(visit.id) ?? [],
  }));
}

/**
 * Merge two visits together.
 * Photos from sourceVisitId are moved to targetVisitId, and the source visit is deleted.
 * The target visit's time range and center coordinates are updated.
 */
export async function mergeVisits(targetVisitId: string, sourceVisitId: string): Promise<void> {
  const plan = buildVisitMergePlan([{ visits: [{ id: targetVisitId }, { id: sourceVisitId }] }]);
  await executeVisitMergePlan(plan);
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
    ORDER BY v.restaurantId, v.startTime ASC, v.id ASC`,
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
  const plan = buildVisitMergePlan(groups);
  if (plan.mergeCount === 0) {
    return 0;
  }

  await executeVisitMergePlan(plan);

  if (DEBUG_TIMING) {
    console.log(
      `[DB] batchMergeSameRestaurantVisits: ${(performance.now() - start).toFixed(2)}ms (${plan.mergeCount} merges)`,
    );
  }

  return plan.mergeCount;
}

/** One atomic mutation path for manual and same-restaurant batch merges. */
async function executeVisitMergePlan(plan: VisitMergePlan): Promise<void> {
  const database = await getDatabase();
  await runTransactionWithBusyRetry(async (updatedAt) => {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const preflightQueryRow = await transaction.getFirstAsync<VisitMergePreflightQueryRow>(
        VISIT_MERGE_PREFLIGHT_SQL,
        plan.payload,
      );
      const preflight = preflightQueryRow ? parseVisitMergePreflightQueryRow(preflightQueryRow) : null;
      if (
        !preflight ||
        preflight.plannedVisitCount !== plan.referencedVisitCount ||
        preflight.existingVisitCount !== plan.referencedVisitCount
      ) {
        throw new Error("One or more visits in the merge plan were not found");
      }

      await transaction.runAsync(VISIT_MERGE_MOVE_PHOTOS_SQL, plan.payload);
      const targetUpdate = await transaction.runAsync(VISIT_MERGE_UPDATE_TARGETS_SQL, [plan.payload, updatedAt]);
      if (targetUpdate.changes !== plan.targetVisitIds.length) {
        throw new Error(`Visit merge updated ${targetUpdate.changes} targets; expected ${plan.targetVisitIds.length}`);
      }

      await transaction.runAsync(VISIT_MERGE_COPY_SUGGESTIONS_SQL, plan.payload);
      await transaction.runAsync(VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL, plan.payload);
      await transaction.runAsync(VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL, plan.payload);
      const sourceDelete = await transaction.runAsync(VISIT_MERGE_DELETE_SOURCE_VISITS_SQL, plan.payload);
      if (sourceDelete.changes !== plan.mergeCount) {
        throw new Error(`Visit merge deleted ${sourceDelete.changes} sources; expected ${plan.mergeCount}`);
      }
    });
  });
}
