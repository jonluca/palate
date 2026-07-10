import type { FoodLabel } from "./types";

export interface PhotoFoodDetectionUpdate {
  readonly photoId: string;
  readonly foodDetected: boolean;
  readonly foodLabels?: readonly FoodLabel[];
  readonly foodConfidence?: number;
  readonly allLabels?: readonly FoodLabel[];
}

export interface LabeledPhotoFoodDetectionUpdate {
  readonly photoId: string;
  readonly foodDetected: boolean;
  readonly foodLabelsJson: string | null;
  readonly foodConfidence: number | null;
  readonly allLabelsJson: string | null;
}

export interface SimplePhotoFoodDetectionUpdate {
  readonly photoId: string;
  readonly foodDetected: boolean;
}

export interface CoalescedPhotoFoodDetectionUpdates {
  readonly labeledUpdates: readonly LabeledPhotoFoodDetectionUpdate[];
  readonly simpleUpdates: readonly SimplePhotoFoodDetectionUpdate[];
}

export interface PhotoFoodDetectionStatement {
  readonly sql: string;
  readonly parameters: Array<string | number | null>;
}

// Both statement shapes stay below SQLite's historical 999-variable default.
// The spare bindings leave room for future statement-level parameters without
// silently crossing that portability boundary.
export const LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE = 180;
export const SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE = 450;

/**
 * Preserve the legacy two-phase writer while eliminating duplicate work.
 *
 * Labeled updates were applied sequentially, so the final labeled update for
 * each photo wins. Simple updates ran afterward in a true pass followed by a
 * false pass, so any false simple update wins regardless of input order.
 */
export function coalescePhotoFoodDetectionUpdates(
  updates: readonly PhotoFoodDetectionUpdate[],
): CoalescedPhotoFoodDetectionUpdates {
  const labeledByPhotoId = new Map<string, LabeledPhotoFoodDetectionUpdate>();
  const simpleByPhotoId = new Map<string, SimplePhotoFoodDetectionUpdate>();

  for (const update of updates) {
    const hasLabeledPayload =
      update.foodLabels !== undefined || update.foodConfidence !== undefined || update.allLabels !== undefined;

    if (hasLabeledPayload) {
      labeledByPhotoId.set(update.photoId, {
        photoId: update.photoId,
        foodDetected: update.foodDetected,
        // Arrays, including [], are truthy and were serialized by the previous
        // writer. Omitted (and invalid runtime null) values were stored as NULL.
        foodLabelsJson: update.foodLabels ? JSON.stringify(update.foodLabels) : null,
        foodConfidence: update.foodConfidence ?? null,
        allLabelsJson: update.allLabels ? JSON.stringify(update.allLabels) : null,
      });
      continue;
    }

    const previous = simpleByPhotoId.get(update.photoId);
    simpleByPhotoId.set(update.photoId, {
      photoId: update.photoId,
      foodDetected: (previous?.foodDetected ?? true) && update.foodDetected,
    });
  }

  return {
    labeledUpdates: [...labeledByPhotoId.values()],
    simpleUpdates: [...simpleByPhotoId.values()],
  };
}

export function buildLabeledPhotoFoodDetectionStatement(
  updates: readonly LabeledPhotoFoodDetectionUpdate[],
): PhotoFoodDetectionStatement {
  validateBatch(
    updates.map(({ photoId }) => photoId),
    LABELED_PHOTO_FOOD_DETECTION_BATCH_SIZE,
    "Labeled photo food-detection",
  );

  const values = updates.map(() => "(?, ?, ?, ?, ?)").join(", ");
  return {
    sql: `WITH food_updates(id, foodDetected, foodLabels, foodConfidence, allLabels) AS (VALUES ${values})
      UPDATE photos AS target
      SET foodDetected = food_updates.foodDetected,
          foodLabels = food_updates.foodLabels,
          foodConfidence = food_updates.foodConfidence,
          allLabels = food_updates.allLabels
      FROM food_updates
      WHERE target.id = food_updates.id`,
    parameters: updates.flatMap((update) => [
      update.photoId,
      update.foodDetected ? 1 : 0,
      update.foodLabelsJson,
      update.foodConfidence,
      update.allLabelsJson,
    ]),
  };
}

export function buildSimplePhotoFoodDetectionStatement(
  updates: readonly SimplePhotoFoodDetectionUpdate[],
): PhotoFoodDetectionStatement {
  validateBatch(
    updates.map(({ photoId }) => photoId),
    SIMPLE_PHOTO_FOOD_DETECTION_BATCH_SIZE,
    "Simple photo food-detection",
  );

  const values = updates.map(() => "(?, ?)").join(", ");
  return {
    sql: `WITH food_updates(id, foodDetected) AS (VALUES ${values})
      UPDATE photos AS target
      SET foodDetected = food_updates.foodDetected
      FROM food_updates
      WHERE target.id = food_updates.id`,
    parameters: updates.flatMap((update) => [update.photoId, update.foodDetected ? 1 : 0]),
  };
}

function validateBatch(photoIds: readonly string[], maximumSize: number, description: string): void {
  if (photoIds.length === 0) {
    throw new RangeError(`At least one ${description.toLowerCase()} update is required.`);
  }
  if (photoIds.length > maximumSize) {
    throw new RangeError(`${description} batches cannot exceed ${maximumSize} rows; received ${photoIds.length}.`);
  }
  if (new Set(photoIds).size !== photoIds.length) {
    throw new RangeError(`${description} batches cannot contain duplicate photo IDs.`);
  }
}
