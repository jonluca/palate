export interface FoodDetectionVisitSampleRow {
  readonly visitId: string;
  readonly photoId: string;
  readonly totalVisits: number;
}

export interface FoodDetectionVisitSample {
  readonly visitId: string;
  readonly photoId: string;
}

export interface FoodDetectionVisitSamplePlan {
  readonly totalVisits: number;
  readonly samples: FoodDetectionVisitSample[];
}

export interface VisitPhotoSampleStatement {
  readonly sql: string;
  readonly parameters: Array<string | number>;
}

export const VISIT_PHOTO_SAMPLE_BATCH_SIZE = 400;

export function buildVisitPhotoSampleStatement(
  visitIds: readonly string[],
  samplePercentage: number,
): VisitPhotoSampleStatement {
  if (visitIds.length === 0) {
    throw new RangeError("At least one visit ID is required for photo sampling.");
  }
  if (visitIds.length > VISIT_PHOTO_SAMPLE_BATCH_SIZE) {
    throw new RangeError(
      `Visit photo sample batches cannot exceed ${VISIT_PHOTO_SAMPLE_BATCH_SIZE} visits; received ${visitIds.length}.`,
    );
  }
  if (!Number.isFinite(samplePercentage)) {
    throw new RangeError(`Sample percentage must be finite; received ${samplePercentage}.`);
  }

  const requestedValues = visitIds.map((_, requestOrder) => `(${requestOrder}, ?)`).join(", ");
  return {
    sql: `WITH requested(requestOrder, visitId) AS (VALUES ${requestedValues}),
      requested_ids(visitId) AS (
        SELECT DISTINCT visitId FROM requested
      ),
      photo_counts AS MATERIALIZED (
        SELECT photo.visitId, COUNT(*) AS totalPhotoCount
        FROM photos AS photo
        INNER JOIN requested_ids AS requestedId ON requestedId.visitId = photo.visitId
        GROUP BY photo.visitId
      ),
      ranked AS MATERIALIZED (
        SELECT
          requested.requestOrder,
          requested.visitId,
          photo.id AS photoId,
          ROW_NUMBER() OVER (
            PARTITION BY requested.requestOrder
            ORDER BY photo.creationTime ASC, photo.id ASC
          ) AS sampleRank,
          counts.totalPhotoCount
        FROM requested
        INNER JOIN photo_counts AS counts ON counts.visitId = requested.visitId
        INNER JOIN photos AS photo
          ON photo.visitId = requested.visitId AND photo.foodDetected IS NULL
      )
      SELECT visitId, photoId
      FROM ranked
      WHERE sampleRank <= MAX(1, CAST(totalPhotoCount * ? AS INTEGER))
      ORDER BY requestOrder ASC, sampleRank ASC`,
    parameters: [...visitIds, samplePercentage],
  };
}

/**
 * Select all visits needing food detection and their deterministic samples in
 * one result-producing database call. `totalPhotos` deliberately includes
 * already analyzed photos, preserving the previous per-visit LIMIT semantics.
 */
export const FOOD_DETECTION_VISIT_SAMPLES_SQL = `WITH photo_counts AS MATERIALIZED (
    SELECT
      visitId,
      COUNT(*) AS totalPhotos,
      SUM(foodDetected IS NULL) AS unanalyzedPhotos
    FROM photos
    WHERE visitId IS NOT NULL
    GROUP BY visitId
  ),
  eligible_visits AS MATERIALIZED (
    SELECT
      v.id AS visitId,
      v.startTime,
      counts.totalPhotos
    FROM visits AS v
    INNER JOIN photo_counts AS counts ON counts.visitId = v.id
    WHERE counts.unanalyzedPhotos > 0
  ),
  ranked_unanalyzed AS MATERIALIZED (
    SELECT
      photo.visitId,
      photo.id AS photoId,
      ROW_NUMBER() OVER (
        PARTITION BY photo.visitId
        ORDER BY photo.creationTime ASC, photo.id ASC
      ) AS sampleRank
    FROM photos AS photo
    INNER JOIN eligible_visits AS eligible ON eligible.visitId = photo.visitId
    WHERE photo.foodDetected IS NULL
  )
  SELECT
    eligible.visitId,
    ranked.photoId,
    (SELECT COUNT(*) FROM eligible_visits) AS totalVisits
  FROM eligible_visits AS eligible
  INNER JOIN ranked_unanalyzed AS ranked ON ranked.visitId = eligible.visitId
  WHERE ranked.sampleRank <= MAX(1, CAST(eligible.totalPhotos * ? AS INTEGER))
  ORDER BY eligible.startTime DESC, eligible.visitId ASC, ranked.sampleRank ASC`;

export function parseFoodDetectionVisitSampleRows(
  rows: readonly FoodDetectionVisitSampleRow[],
): FoodDetectionVisitSamplePlan {
  return {
    totalVisits: rows[0]?.totalVisits ?? 0,
    samples: rows.map(({ visitId, photoId }) => ({ visitId, photoId })),
  };
}
