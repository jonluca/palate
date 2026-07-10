import type { MergeableVisitGroup } from "./types";

export interface VisitMergePlanEntry {
  readonly targetVisitId: string;
  readonly sourceVisitId: string;
  readonly sourceOrder: number;
}

export interface VisitMergePlan {
  readonly entries: readonly VisitMergePlanEntry[];
  readonly targetVisitIds: readonly string[];
  readonly sourceVisitIds: readonly string[];
  readonly mergeCount: number;
  readonly referencedVisitCount: number;
  readonly payload: string;
}

export interface VisitMergePreflightRow {
  readonly plannedVisitCount: number;
  readonly existingVisitCount: number;
}

/**
 * Convert UI/database merge groups into one deterministic, disjoint mutation plan.
 *
 * Every actionable visit ID may occur exactly once. This rules out duplicate
 * sources, target/source overlap, and cycles before any database write begins.
 * Empty and Unicode IDs remain valid SQLite text identifiers.
 */
export function buildVisitMergePlan(groups: readonly MergeableVisitGroup[]): VisitMergePlan {
  const entries: VisitMergePlanEntry[] = [];
  const targetVisitIds: string[] = [];
  const sourceVisitIds: string[] = [];
  const claimedVisitIds = new Set<string>();

  for (const [groupIndex, group] of groups.entries()) {
    if (!Array.isArray(group.visits)) {
      throw new Error(`Invalid visit merge group at index ${groupIndex}`);
    }
    // Preserve the previous batch API: empty/singleton groups are no-ops and
    // therefore do not participate in actionable-plan overlap validation.
    if (group.visits.length < 2) {
      continue;
    }

    for (const [visitIndex, visit] of group.visits.entries()) {
      if (typeof visit.id !== "string") {
        throw new Error(`Invalid visit ID at group ${groupIndex}, visit ${visitIndex}`);
      }
      if (claimedVisitIds.has(visit.id)) {
        throw new Error(`Visit merge groups overlap at ID ${JSON.stringify(visit.id)}`);
      }
      claimedVisitIds.add(visit.id);
    }

    const targetVisitId = group.visits[0].id;
    targetVisitIds.push(targetVisitId);

    for (let visitIndex = 1; visitIndex < group.visits.length; visitIndex++) {
      const sourceVisitId = group.visits[visitIndex].id;
      entries.push({
        targetVisitId,
        sourceVisitId,
        sourceOrder: entries.length,
      });
      sourceVisitIds.push(sourceVisitId);
    }
  }

  return {
    entries,
    targetVisitIds,
    sourceVisitIds,
    mergeCount: entries.length,
    referencedVisitCount: targetVisitIds.length + sourceVisitIds.length,
    payload: JSON.stringify(entries),
  };
}

/** Each statement binds the serialized {@link VisitMergePlan.payload} as its first parameter. */
const VISIT_MERGE_PLAN_CTE = `WITH visit_merge_plan AS (
  SELECT
    CAST(json_extract(value, '$.targetVisitId') AS TEXT) AS targetVisitId,
    CAST(json_extract(value, '$.sourceVisitId') AS TEXT) AS sourceVisitId,
    CAST(json_extract(value, '$.sourceOrder') AS INTEGER) AS sourceOrder
  FROM json_each(?)
)`;

export const VISIT_MERGE_PREFLIGHT_SQL = `${VISIT_MERGE_PLAN_CTE},
referenced_visits AS (
  SELECT targetVisitId AS visitId FROM visit_merge_plan
  UNION
  SELECT sourceVisitId AS visitId FROM visit_merge_plan
)
SELECT
  COUNT(*) AS plannedVisitCount,
  COUNT(visits.id) AS existingVisitCount
FROM referenced_visits
LEFT JOIN visits ON visits.id = referenced_visits.visitId`;

export const VISIT_MERGE_MOVE_PHOTOS_SQL = `${VISIT_MERGE_PLAN_CTE}
UPDATE photos AS photo
SET visitId = mapping.targetVisitId
FROM visit_merge_plan AS mapping
WHERE photo.visitId = mapping.sourceVisitId`;

/**
 * Aggregate after moving photos so the final centroid/count exactly reflect all
 * target photos. Visit times and stored food flags include the original target
 * and every source; all other target columns remain untouched.
 */
export const VISIT_MERGE_UPDATE_TARGETS_SQL = `${VISIT_MERGE_PLAN_CTE},
target_visits AS (
  SELECT DISTINCT targetVisitId FROM visit_merge_plan
),
visit_members AS (
  SELECT targetVisitId, targetVisitId AS memberVisitId FROM target_visits
  UNION ALL
  SELECT targetVisitId, sourceVisitId AS memberVisitId FROM visit_merge_plan
),
visit_aggregates AS (
  SELECT
    visit_members.targetVisitId,
    MIN(visits.startTime) AS startTime,
    MAX(visits.endTime) AS endTime,
    MAX(CASE WHEN visits.foodProbable != 0 THEN 1 ELSE 0 END) AS storedFoodProbable
  FROM visit_members
  JOIN visits ON visits.id = visit_members.memberVisitId
  GROUP BY visit_members.targetVisitId
),
photo_aggregates AS (
  SELECT
    target_visits.targetVisitId,
    COUNT(photos.id) AS photoCount,
    AVG(
      CASE
        WHEN photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL THEN photos.latitude
      END
    ) AS centerLat,
    AVG(
      CASE
        WHEN photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL THEN photos.longitude
      END
    ) AS centerLon,
    MAX(CASE WHEN photos.foodDetected = 1 THEN 1 ELSE 0 END) AS detectedFood
  FROM target_visits
  LEFT JOIN photos ON photos.visitId = target_visits.targetVisitId
  GROUP BY target_visits.targetVisitId
)
UPDATE visits AS target
SET
  startTime = visit_aggregates.startTime,
  endTime = visit_aggregates.endTime,
  centerLat = COALESCE(photo_aggregates.centerLat, target.centerLat),
  centerLon = COALESCE(photo_aggregates.centerLon, target.centerLon),
  photoCount = photo_aggregates.photoCount,
  foodProbable = CASE
    WHEN visit_aggregates.storedFoodProbable = 1 OR photo_aggregates.detectedFood = 1 THEN 1
    ELSE 0
  END,
  updatedAt = ?
FROM visit_aggregates
JOIN photo_aggregates ON photo_aggregates.targetVisitId = visit_aggregates.targetVisitId
WHERE target.id = visit_aggregates.targetVisitId`;

/** Existing target suggestions win; among sources the earliest source wins. */
export const VISIT_MERGE_COPY_SUGGESTIONS_SQL = `${VISIT_MERGE_PLAN_CTE},
ranked_source_suggestions AS (
  SELECT
    visit_merge_plan.targetVisitId,
    source_suggestions.restaurantId,
    source_suggestions.distance,
    ROW_NUMBER() OVER (
      PARTITION BY visit_merge_plan.targetVisitId, source_suggestions.restaurantId
      ORDER BY visit_merge_plan.sourceOrder
    ) AS sourceRank
  FROM visit_merge_plan
  JOIN visit_suggested_restaurants AS source_suggestions
    ON source_suggestions.visitId = visit_merge_plan.sourceVisitId
)
INSERT OR IGNORE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
SELECT targetVisitId, restaurantId, distance
FROM ranked_source_suggestions
WHERE sourceRank = 1`;

export const VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL = `${VISIT_MERGE_PLAN_CTE}
UPDATE reservation_import_sources AS reservation_source
SET visitId = mapping.targetVisitId
FROM visit_merge_plan AS mapping
WHERE reservation_source.visitId = mapping.sourceVisitId`;

// Keep this explicit: Expo's exclusive transaction connection does not inherit foreign_keys=ON.
export const VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL = `${VISIT_MERGE_PLAN_CTE}
DELETE FROM visit_suggested_restaurants
WHERE visitId IN (SELECT sourceVisitId FROM visit_merge_plan)`;

export const VISIT_MERGE_DELETE_SOURCE_VISITS_SQL = `${VISIT_MERGE_PLAN_CTE}
DELETE FROM visits
WHERE id IN (SELECT sourceVisitId FROM visit_merge_plan)`;
