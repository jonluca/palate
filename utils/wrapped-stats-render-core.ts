export const EAGER_WRAPPED_STATS_RENDER_STRATEGY = "eager-v1";
export const VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY = "virtualized-v1";
export const DEFAULT_WRAPPED_STATS_RENDER_STRATEGY = EAGER_WRAPPED_STATS_RENDER_STRATEGY;

export type WrappedStatsRenderStrategy =
  | typeof EAGER_WRAPPED_STATS_RENDER_STRATEGY
  | typeof VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY;

export type WrappedStatsSectionKind =
  | "michelin"
  | "green-star"
  | "editorial-overview"
  | "monthly-visits"
  | "dining-map"
  | "location-breakdown"
  | "cuisine-cloud"
  | "dining-time"
  | "weekend-weekday"
  | "photo-stats"
  | "seasonality"
  | "yearly-highlights"
  | "dining-style"
  | "fun-facts";

export interface WrappedStatsSectionDescriptor {
  readonly key: WrappedStatsSectionKind;
  readonly kind: WrappedStatsSectionKind;
}

export interface WrappedStatsSectionPlanInput {
  readonly selectedYear: number | null;
  readonly totalStarredVisits: number;
  readonly greenStarVisits: number;
  readonly cuisineCount: number;
  readonly monthlyVisitCount: number;
  readonly locationCount: number;
  readonly mapPointCount: number;
  readonly totalPhotos: number;
  readonly mealTimeVisitCount: number;
  readonly yearlyStatCount: number;
}

const SECTION_DESCRIPTORS: Readonly<Record<WrappedStatsSectionKind, WrappedStatsSectionDescriptor>> = Object.freeze({
  michelin: Object.freeze({ key: "michelin", kind: "michelin" }),
  "green-star": Object.freeze({ key: "green-star", kind: "green-star" }),
  "editorial-overview": Object.freeze({ key: "editorial-overview", kind: "editorial-overview" }),
  "monthly-visits": Object.freeze({ key: "monthly-visits", kind: "monthly-visits" }),
  "dining-map": Object.freeze({ key: "dining-map", kind: "dining-map" }),
  "location-breakdown": Object.freeze({ key: "location-breakdown", kind: "location-breakdown" }),
  "cuisine-cloud": Object.freeze({ key: "cuisine-cloud", kind: "cuisine-cloud" }),
  "dining-time": Object.freeze({ key: "dining-time", kind: "dining-time" }),
  "weekend-weekday": Object.freeze({ key: "weekend-weekday", kind: "weekend-weekday" }),
  "photo-stats": Object.freeze({ key: "photo-stats", kind: "photo-stats" }),
  seasonality: Object.freeze({ key: "seasonality", kind: "seasonality" }),
  "yearly-highlights": Object.freeze({ key: "yearly-highlights", kind: "yearly-highlights" }),
  "dining-style": Object.freeze({ key: "dining-style", kind: "dining-style" }),
  "fun-facts": Object.freeze({ key: "fun-facts", kind: "fun-facts" }),
});

export function resolveWrappedStatsRenderStrategy(value: unknown): WrappedStatsRenderStrategy {
  return value === VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY
    ? VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY
    : DEFAULT_WRAPPED_STATS_RENDER_STRATEGY;
}

/**
 * Preserve the Stats screen's editorial order while keeping stable identities
 * for every section that survives a filter or year change.
 */
export function buildWrappedStatsSectionPlan(
  input: WrappedStatsSectionPlanInput,
): readonly WrappedStatsSectionDescriptor[] {
  const plan: WrappedStatsSectionDescriptor[] = [];
  const hasMonthlyData = input.monthlyVisitCount > 0;

  if (input.totalStarredVisits > 0) {
    plan.push(SECTION_DESCRIPTORS.michelin);
  }
  if (input.greenStarVisits > 0) {
    plan.push(SECTION_DESCRIPTORS["green-star"]);
  }

  plan.push(SECTION_DESCRIPTORS["editorial-overview"]);

  if (hasMonthlyData) {
    plan.push(SECTION_DESCRIPTORS["monthly-visits"]);
  }
  if (input.mapPointCount > 0) {
    plan.push(SECTION_DESCRIPTORS["dining-map"]);
  }
  if (input.locationCount > 0) {
    plan.push(SECTION_DESCRIPTORS["location-breakdown"]);
  }
  if (input.cuisineCount > 0) {
    plan.push(SECTION_DESCRIPTORS["cuisine-cloud"]);
  }
  if (input.mealTimeVisitCount > 0) {
    plan.push(SECTION_DESCRIPTORS["dining-time"]);
  }

  plan.push(SECTION_DESCRIPTORS["weekend-weekday"]);

  if (input.totalPhotos > 0) {
    plan.push(SECTION_DESCRIPTORS["photo-stats"]);
  }
  if (hasMonthlyData) {
    plan.push(SECTION_DESCRIPTORS.seasonality);
  }
  if (input.selectedYear === null && input.yearlyStatCount > 0) {
    plan.push(SECTION_DESCRIPTORS["yearly-highlights"]);
  }

  plan.push(SECTION_DESCRIPTORS["dining-style"], SECTION_DESCRIPTORS["fun-facts"]);
  return plan;
}

/** A false observation can never evict a native map that was already exposed. */
export function retainWrappedStatsMapVisibility(wasVisible: boolean, isVisible: boolean): boolean {
  return wasVisible || isVisible;
}

export function wrappedStatsVisibilityScopeKey(selectedYear: number | null): string {
  return selectedYear === null ? "all-time" : `year-${selectedYear}`;
}
