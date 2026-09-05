/**
 * Recompute the summaries owned by explicit photo move/remove actions from the
 * current photo rows. Bind affected visit IDs as JSON, then the one visit whose
 * photo time range should be refreshed. Empty visits retain their time range:
 * it can still describe a calendar reservation after the last photo is removed.
 * Merge operations deliberately retain their separate sticky food-flag policy.
 */
export const REFRESH_VISIT_PHOTO_SUMMARIES_SQL = `WITH
  affected_visits AS (
    SELECT id FROM visits WHERE id IN (SELECT value FROM json_each(?1))
  ),
  photo_summaries AS MATERIALIZED (
    SELECT
      affected_visits.id AS visitId,
      COUNT(photos.rowid) AS photoCount,
      COALESCE(MAX(photos.foodDetected), 0) AS foodProbable,
      MIN(photos.creationTime) AS startTime,
      MAX(photos.creationTime) AS endTime
    FROM affected_visits
    LEFT JOIN photos ON photos.visitId = affected_visits.id
    GROUP BY affected_visits.id
  )
UPDATE visits AS target
SET
  photoCount = photo_summaries.photoCount,
  foodProbable = photo_summaries.foodProbable,
  startTime = CASE WHEN target.id = ?2
    THEN COALESCE(photo_summaries.startTime, target.startTime) ELSE target.startTime END,
  endTime = CASE WHEN target.id = ?2
    THEN COALESCE(photo_summaries.endTime, target.endTime) ELSE target.endTime END
FROM photo_summaries
WHERE target.id = photo_summaries.visitId`;
