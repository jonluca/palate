#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  DEFAULT_WRAPPED_STATS_RENDER_STRATEGY,
  EAGER_WRAPPED_STATS_RENDER_STRATEGY,
  VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY,
  buildWrappedStatsSectionPlan,
  resolveWrappedStatsRenderStrategy,
  retainWrappedStatsMapVisibility,
  wrappedStatsVisibilityScopeKey,
  type WrappedStatsSectionKind,
  type WrappedStatsSectionPlanInput,
} from "../utils/wrapped-stats-render-core.ts";

const EMPTY_INPUT: WrappedStatsSectionPlanInput = {
  selectedYear: null,
  totalStarredVisits: 0,
  greenStarVisits: 0,
  cuisineCount: 0,
  monthlyVisitCount: 0,
  locationCount: 0,
  mapPointCount: 0,
  totalPhotos: 0,
  mealTimeVisitCount: 0,
  yearlyStatCount: 0,
};

const FULL_INPUT: WrappedStatsSectionPlanInput = {
  selectedYear: null,
  totalStarredVisits: 12,
  greenStarVisits: 2,
  cuisineCount: 5,
  monthlyVisitCount: 36,
  locationCount: 10,
  mapPointCount: 18,
  totalPhotos: 144,
  mealTimeVisitCount: 36,
  yearlyStatCount: 8,
};

const FULL_ALL_TIME_ORDER: readonly WrappedStatsSectionKind[] = [
  "michelin",
  "green-star",
  "editorial-overview",
  "monthly-visits",
  "dining-map",
  "location-breakdown",
  "cuisine-cloud",
  "dining-time",
  "weekend-weekday",
  "photo-stats",
  "seasonality",
  "yearly-highlights",
  "dining-style",
  "fun-facts",
];

function keys(input: WrappedStatsSectionPlanInput): WrappedStatsSectionKind[] {
  return buildWrappedStatsSectionPlan(input).map((section) => section.key);
}

assert.deepEqual(keys(EMPTY_INPUT), ["editorial-overview", "weekend-weekday", "dining-style", "fun-facts"]);
assert.deepEqual(keys(FULL_INPUT), FULL_ALL_TIME_ORDER);

const selectedYearPlan = buildWrappedStatsSectionPlan({ ...FULL_INPUT, selectedYear: 2025 });
assert.deepEqual(
  selectedYearPlan.map((section) => section.key),
  FULL_ALL_TIME_ORDER.filter((key) => key !== "yearly-highlights"),
  "a selected year must omit only the all-time yearly highlights section",
);

const allTimePlan = buildWrappedStatsSectionPlan(FULL_INPUT);
const selectedByKey = new Map(selectedYearPlan.map((section) => [section.key, section]));
for (const section of allTimePlan) {
  if (section.key !== "yearly-highlights") {
    assert.strictEqual(
      selectedByKey.get(section.key),
      section,
      `section ${section.key} should retain its stable descriptor across year changes`,
    );
  }
  assert.equal(section.key, section.kind);
}

const optionCases: ReadonlyArray<{
  readonly patch: Partial<WrappedStatsSectionPlanInput>;
  readonly expectedOptionalKeys: readonly WrappedStatsSectionKind[];
}> = [
  { patch: { totalStarredVisits: 1 }, expectedOptionalKeys: ["michelin"] },
  { patch: { greenStarVisits: 1 }, expectedOptionalKeys: ["green-star"] },
  { patch: { monthlyVisitCount: 1 }, expectedOptionalKeys: ["monthly-visits", "seasonality"] },
  { patch: { mapPointCount: 1 }, expectedOptionalKeys: ["dining-map"] },
  { patch: { locationCount: 1 }, expectedOptionalKeys: ["location-breakdown"] },
  { patch: { cuisineCount: 1 }, expectedOptionalKeys: ["cuisine-cloud"] },
  { patch: { mealTimeVisitCount: 1 }, expectedOptionalKeys: ["dining-time"] },
  { patch: { totalPhotos: 1 }, expectedOptionalKeys: ["photo-stats"] },
  { patch: { yearlyStatCount: 1 }, expectedOptionalKeys: ["yearly-highlights"] },
];

const requiredKeys = new Set<WrappedStatsSectionKind>([
  "editorial-overview",
  "weekend-weekday",
  "dining-style",
  "fun-facts",
]);
for (const optionCase of optionCases) {
  assert.deepEqual(
    keys({ ...EMPTY_INPUT, ...optionCase.patch }).filter((key) => !requiredKeys.has(key)),
    optionCase.expectedOptionalKeys,
  );
}
assert.ok(!keys({ ...EMPTY_INPUT, selectedYear: 2025, yearlyStatCount: 1 }).includes("yearly-highlights"));

assert.equal(DEFAULT_WRAPPED_STATS_RENDER_STRATEGY, EAGER_WRAPPED_STATS_RENDER_STRATEGY);
assert.equal(resolveWrappedStatsRenderStrategy(undefined), EAGER_WRAPPED_STATS_RENDER_STRATEGY);
assert.equal(resolveWrappedStatsRenderStrategy("invalid"), EAGER_WRAPPED_STATS_RENDER_STRATEGY);
assert.equal(
  resolveWrappedStatsRenderStrategy(VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY),
  VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY,
);

let retainedMapVisibility = false;
retainedMapVisibility = retainWrappedStatsMapVisibility(retainedMapVisibility, false);
assert.equal(retainedMapVisibility, false);
retainedMapVisibility = retainWrappedStatsMapVisibility(retainedMapVisibility, true);
assert.equal(retainedMapVisibility, true);
for (const laterObservation of [false, false, true, false]) {
  retainedMapVisibility = retainWrappedStatsMapVisibility(retainedMapVisibility, laterObservation);
  assert.equal(retainedMapVisibility, true, "map visibility must be monotonic within one list scope");
}

assert.equal(wrappedStatsVisibilityScopeKey(null), "all-time");
assert.equal(wrappedStatsVisibilityScopeKey(2025), "year-2025");
assert.notEqual(wrappedStatsVisibilityScopeKey(null), wrappedStatsVisibilityScopeKey(2025));

console.log("wrapped stats render core tests passed");
