/** Raw row returned by the pending-visit review query before JSON parsing. */
export interface PendingVisitReviewQueryRow {
  readonly id: string;
  readonly restaurantId: string | null;
  readonly suggestedRestaurantId: string | null;
  readonly status: "pending" | "confirmed" | "rejected";
  readonly startTime: number;
  readonly endTime: number;
  readonly centerLat: number;
  readonly centerLon: number;
  readonly photoCount: number;
  readonly foodProbable: number;
  readonly calendarEventId: string | null;
  readonly calendarEventTitle: string | null;
  readonly calendarEventLocation: string | null;
  readonly calendarEventIsAllDay: number | null;
  readonly notes: string | null;
  readonly updatedAt: number | null;
  readonly exportedToCalendarId: string | null;
  readonly awardAtVisit: string | null;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly suggestedRestaurantAward: string | null;
  readonly suggestedRestaurantCuisine: string | null;
  readonly suggestedRestaurantAddress: string | null;
  readonly previewPhotosJson: string | null;
  readonly suggestedRestaurantsJson: string | null;
  readonly foodLabelsJson: string | null;
  readonly priority: number;
  readonly hasUnanalyzedPhotos: number;
}

/** One deterministic nearest-first order shared by every Review suggestion aggregate. */
export const PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL = "vsr.distance ASC, m.id COLLATE BINARY ASC";

/**
 * Preserve the legacy photo-label aggregate byte-for-byte across card and
 * Quick Actions projections. Its input order affects stable top-five tie
 * selection, so callers must not add an independent ORDER BY here.
 */
export const PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL = `food_labels AS (
    SELECT
      p.visitId,
      json_group_array(json(p.foodLabels)) AS labelsJson
    FROM photos p
    WHERE p.visitId IN (SELECT id FROM pending_visits WHERE foodProbable = 1)
      AND p.foodDetected = 1
      AND p.foodLabels IS NOT NULL
    GROUP BY p.visitId
  )`;

/**
 * Fetch every pending-review field in one database call.
 *
 * Preview photos use the `idx_photos_visit_preview` ordering and stop after
 * three rows per visit. This avoids assigning a window row number to every
 * photo belonging to every pending visit. The photo ID is the deterministic
 * final key when food priority and creation time are equal.
 */
export const PENDING_VISITS_FOR_REVIEW_SQL = `WITH
  pending_visits AS (
    SELECT
      v.*,
      r.name AS restaurantName,
      m.name AS suggestedRestaurantName,
      m.award AS suggestedRestaurantAward,
      m.cuisine AS suggestedRestaurantCuisine,
      m.address AS suggestedRestaurantAddress
    FROM visits v
    LEFT JOIN restaurants r ON v.restaurantId = r.id
    LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
    WHERE v.status = 'pending'
  ),
  suggested_restaurants AS (
    SELECT
      vsr.visitId,
      json_group_array(
        json_object(
          'id', m.id,
          'name', m.name,
          'latitude', m.latitude,
          'longitude', m.longitude,
          'address', m.address,
          'location', m.location,
          'cuisine', m.cuisine,
          'latestAwardYear', m.latestAwardYear,
          'award', m.award,
          'distance', vsr.distance
        ) ORDER BY ${PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL}
      ) AS restaurants
    FROM visit_suggested_restaurants vsr
    JOIN michelin_restaurants m ON vsr.restaurantId = m.id
    WHERE vsr.visitId IN (SELECT id FROM pending_visits)
    GROUP BY vsr.visitId
  ),
  ${PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL}
SELECT
  pv.*,
  NULLIF((
    SELECT json_group_array(preview.uri)
    FROM (
      SELECT p.uri
      FROM photos p
      WHERE p.visitId = pv.id
      ORDER BY
        CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
        p.creationTime ASC,
        p.id ASC
      LIMIT 3
    ) AS preview
  ), '[]') AS previewPhotosJson,
  sr.restaurants AS suggestedRestaurantsJson,
  fl.labelsJson AS foodLabelsJson,
  CASE
    WHEN pv.foodProbable = 1 AND (pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL) THEN 1
    WHEN pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL THEN 2
    WHEN pv.foodProbable = 1 THEN 3
    ELSE 4
  END AS priority,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM photos p_check
      WHERE p_check.visitId = pv.id
        AND p_check.foodDetected IS NULL
    ) THEN 1
    ELSE 0
  END AS hasUnanalyzedPhotos
FROM pending_visits pv
LEFT JOIN suggested_restaurants sr ON pv.id = sr.visitId
LEFT JOIN food_labels fl ON pv.id = fl.visitId
ORDER BY priority ASC, pv.startTime DESC, pv.id COLLATE BINARY ASC`;
