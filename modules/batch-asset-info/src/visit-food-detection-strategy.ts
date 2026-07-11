export const FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY = "full-plan-v1";
export const RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY = "rank3-bulk-tail-v1";
export const DEFAULT_VISIT_FOOD_DETECTION_STRATEGY = RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY;

export type VisitFoodDetectionStrategy =
  | typeof FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY
  | typeof RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY;

/** Resolves an exact native strategy value, retaining the full path for older binaries. */
export function resolveVisitFoodDetectionStrategy(value: unknown): VisitFoodDetectionStrategy {
  if (value === FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY || value === RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY) {
    return value;
  }
  return FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY;
}

/**
 * Automatic full-library follow-ups must not erase adaptive skipped work or
 * start before a guarded validation trigger. Explicit user Deep Scans are a
 * separate path and retain their full-library contract outside validation.
 */
export function allowsAutomaticDeepScanFollowup(
  strategy: VisitFoodDetectionStrategy,
  validationModeEnabled: boolean = false,
): boolean {
  return !validationModeEnabled && strategy === FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY;
}
