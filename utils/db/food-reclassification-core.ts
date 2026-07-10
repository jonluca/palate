import type { FoodLabel } from "./types";

export interface FoodReclassificationSource {
  readonly photoId: string;
  readonly allLabelsJson: string;
}

export interface FoodReclassificationUpdate {
  readonly photoId: string;
  readonly foodDetected: boolean;
  readonly foodLabelsJson: string | null;
  readonly foodConfidence: number | null;
}

export interface FoodReclassificationStatement {
  readonly sql: string;
  readonly parameters: Array<string | number | null>;
}

export interface FoodReclassificationBatch {
  readonly updates: readonly FoodReclassificationUpdate[];
  readonly processed: number;
}

// Four bind parameters are used per row. Staying below 999 keeps this portable
// across SQLite builds with the historical default variable limit.
export const FOOD_RECLASSIFICATION_BATCH_SIZE = 200;

/**
 * Re-evaluate one stored classifier result against the enabled keyword set.
 * Malformed JSON is deliberately skipped so its existing classification stays
 * unchanged, matching the previous production behavior.
 */
export function buildFoodReclassificationUpdate(
  source: FoodReclassificationSource,
  enabledKeywords: ReadonlySet<string>,
): FoodReclassificationUpdate | null {
  let allLabels: FoodLabel[];
  try {
    allLabels = JSON.parse(source.allLabelsJson) as FoodLabel[];
  } catch {
    return null;
  }
  if (!Array.isArray(allLabels)) {
    return null;
  }

  const matchedLabels = allLabels.filter((label) => enabledKeywords.has(label.label.trim().toLowerCase()));
  return {
    photoId: source.photoId,
    foodDetected: matchedLabels.length > 0,
    foodLabelsJson: matchedLabels.length > 0 ? JSON.stringify(matchedLabels) : null,
    foodConfidence: matchedLabels.length > 0 ? Math.max(...matchedLabels.map(({ confidence }) => confidence)) : null,
  };
}

export function* buildFoodReclassificationBatches(
  sources: readonly FoodReclassificationSource[],
  enabledKeywords: ReadonlySet<string>,
  batchSize = FOOD_RECLASSIFICATION_BATCH_SIZE,
): Generator<FoodReclassificationBatch> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`Food reclassification batch size must be a positive integer; received ${batchSize}.`);
  }

  let updates: FoodReclassificationUpdate[] = [];
  for (let index = 0; index < sources.length; index++) {
    const update = buildFoodReclassificationUpdate(sources[index], enabledKeywords);
    if (update) {
      updates.push(update);
    }
    if (updates.length >= batchSize) {
      const completedBatch = updates;
      updates = [];
      yield { updates: completedBatch, processed: index + 1 };
    }
  }

  if (updates.length > 0) {
    yield { updates, processed: sources.length };
  }
}

export function buildFoodReclassificationStatement(
  updates: readonly FoodReclassificationUpdate[],
): FoodReclassificationStatement {
  if (updates.length === 0) {
    throw new RangeError("At least one food reclassification update is required.");
  }
  if (updates.length > FOOD_RECLASSIFICATION_BATCH_SIZE) {
    throw new RangeError(
      `Food reclassification batches cannot exceed ${FOOD_RECLASSIFICATION_BATCH_SIZE} rows; received ${updates.length}.`,
    );
  }
  const uniquePhotoIds = new Set(updates.map(({ photoId }) => photoId));
  if (uniquePhotoIds.size !== updates.length) {
    throw new RangeError("Food reclassification batches cannot contain duplicate photo IDs.");
  }

  const valuePlaceholders = updates.map(() => "(?, ?, ?, ?)").join(", ");
  return {
    sql: `WITH reclassified(id, foodDetected, foodLabels, foodConfidence) AS (VALUES ${valuePlaceholders})
      UPDATE photos AS target
      SET foodDetected = reclassified.foodDetected,
          foodLabels = reclassified.foodLabels,
          foodConfidence = reclassified.foodConfidence
      FROM reclassified
      WHERE target.id = reclassified.id`,
    parameters: updates.flatMap(({ photoId, foodDetected, foodLabelsJson, foodConfidence }) => [
      photoId,
      foodDetected ? 1 : 0,
      foodLabelsJson,
      foodConfidence,
    ]),
  };
}
