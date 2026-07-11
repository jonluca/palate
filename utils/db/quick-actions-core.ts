import type { AggregatedFoodLabel, FoodLabel } from "./types.ts";
import {
  PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL,
  PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL,
} from "./visit-review-core.ts";
import type { PendingVisitReviewExactConfirmation, PendingVisitReviewMatchTools } from "./visit-review-paging-core.ts";

/** Minimal restaurant identity needed to find and confirm an exact Calendar match. */
export interface PendingQuickActionSuggestion {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Complete per-visit state consumed by Quick Actions.
 *
 * Card-only fields such as preview URIs, notes, addresses, awards, and full
 * restaurant records deliberately do not cross the SQLite boundary.
 */
export interface PendingQuickActionVisit {
  readonly id: string;
  readonly photoCount: number;
  readonly foodProbable: boolean;
  readonly suggestedRestaurantId: string | null;
  readonly calendarEventTitle: string | null;
  readonly startTime: number;
  readonly suggestedRestaurants: readonly PendingQuickActionSuggestion[];
  readonly foodLabels: readonly AggregatedFoodLabel[];
}

export interface PendingQuickActionExactMatch extends PendingVisitReviewExactConfirmation {
  readonly visit: PendingQuickActionVisit;
}

export interface PendingQuickActionsData {
  readonly visits: PendingQuickActionVisit[];
  readonly exactMatches: PendingQuickActionExactMatch[];
}

/** Raw slim row returned by {@link PENDING_QUICK_ACTIONS_SQL}. */
export interface PendingQuickActionQueryRow {
  readonly id: string;
  readonly photoCount: number;
  readonly foodProbable: number;
  readonly suggestedRestaurantId: string | null;
  readonly calendarEventTitle: string | null;
  readonly startTime: number;
  readonly suggestedRestaurantsJson: string;
  readonly foodLabelsJson: string | null;
}

/**
 * Fetch exactly the state used by Quick Actions.
 *
 * Suggestions retain the same distance/ID order as Review. Food-label source
 * arrays deliberately use the legacy aggregate without adding a new order:
 * top-five confidence ties must preserve the existing query semantics.
 * `startTime` remains a direct SQLite scalar because packing it into JSON can
 * round fractional IEEE Float64 values at millisecond-scale epochs.
 */
export const PENDING_QUICK_ACTIONS_SQL = `WITH
  pending_visits AS MATERIALIZED (
    SELECT
      v.id,
      v.photoCount,
      v.foodProbable,
      v.suggestedRestaurantId,
      v.calendarEventTitle,
      v.startTime
    FROM visits v
    WHERE v.status = 'pending'
  ),
  suggested_restaurants AS (
    SELECT
      vsr.visitId,
      json_group_array(
        json_array(m.id, m.name, m.latitude, m.longitude)
        ORDER BY ${PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL}
      ) AS restaurants
    FROM visit_suggested_restaurants vsr
    JOIN michelin_restaurants m ON m.id = vsr.restaurantId
    WHERE vsr.visitId IN (SELECT id FROM pending_visits)
    GROUP BY vsr.visitId
  ),
  ${PENDING_VISIT_REVIEW_FOOD_LABELS_CTE_SQL}
SELECT
  pv.id,
  pv.photoCount,
  pv.foodProbable,
  pv.suggestedRestaurantId,
  pv.calendarEventTitle,
  pv.startTime,
  COALESCE(sr.restaurants, '[]') AS suggestedRestaurantsJson,
  fl.labelsJson AS foodLabelsJson
FROM pending_visits pv
LEFT JOIN suggested_restaurants sr ON sr.visitId = pv.id
LEFT JOIN food_labels fl ON fl.visitId = pv.id
ORDER BY
  CASE
    WHEN pv.foodProbable = 1
      AND (pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL) THEN 1
    WHEN pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL THEN 2
    WHEN pv.foodProbable = 1 THEN 3
    ELSE 4
  END ASC,
  pv.startTime DESC,
  pv.id COLLATE BINARY ASC`;

/** Shared reducer preserving Review's max-confidence, occurrence-count, and stable top-five rules. */
export function aggregatePendingVisitFoodLabelArrays(
  rawLabelsArrays: readonly (readonly FoodLabel[])[],
): AggregatedFoodLabel[] {
  const labelMap = new Map<string, AggregatedFoodLabel>();
  for (const labels of rawLabelsArrays) {
    if (!Array.isArray(labels)) {
      continue;
    }
    for (const label of labels) {
      const existing = labelMap.get(label.label);
      if (existing) {
        existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
        existing.photoCount++;
      } else {
        labelMap.set(label.label, {
          label: label.label,
          maxConfidence: label.confidence,
          photoCount: 1,
        });
      }
    }
  }
  return Array.from(labelMap.values())
    .sort((left, right) => right.maxConfidence - left.maxConfidence)
    .slice(0, 5);
}

/** Preserve the legacy card parser's tolerance for optional or malformed label JSON. */
export function parseLegacyPendingVisitFoodLabels(
  foodLabelsJson: string | null,
  foodProbable: boolean,
): AggregatedFoodLabel[] {
  if (!foodLabelsJson || !foodProbable) {
    return [];
  }
  try {
    const rawLabelsArrays = JSON.parse(foodLabelsJson) as FoodLabel[][];
    return Array.isArray(rawLabelsArrays) ? aggregatePendingVisitFoodLabelArrays(rawLabelsArrays) : [];
  } catch {
    return [];
  }
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function requireNullableString(value: unknown, context: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${context} must be a string or null`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  return value;
}

function requireSuggestion(value: unknown, context: string): PendingQuickActionSuggestion {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${context} must be a four-value array`);
  }
  const [id, name, latitudeValue, longitudeValue] = value;
  const latitude = requireFiniteNumber(latitudeValue, `${context}.latitude`);
  const longitude = requireFiniteNumber(longitudeValue, `${context}.longitude`);
  if (latitude < -90 || latitude > 90) {
    throw new RangeError(`${context}.latitude must be between -90 and 90`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new RangeError(`${context}.longitude must be between -180 and 180`);
  }
  if (typeof name !== "string") {
    throw new TypeError(`${context}.name must be a string`);
  }
  return {
    id: requireNonEmptyString(id, `${context}.id`),
    name,
    latitude,
    longitude,
  };
}

function parseSuggestions(value: unknown, context: string): PendingQuickActionSuggestion[] {
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a JSON string`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new SyntaxError(`${context} is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(decoded)) {
    throw new TypeError(`${context} must decode to an array`);
  }
  const suggestions = decoded.map((suggestion, index) => requireSuggestion(suggestion, `${context}[${index}]`));
  const suggestionIds = new Set<string>();
  for (const suggestion of suggestions) {
    if (suggestionIds.has(suggestion.id)) {
      throw new RangeError(`${context} contains duplicate restaurant id ${JSON.stringify(suggestion.id)}`);
    }
    suggestionIds.add(suggestion.id);
  }
  return suggestions;
}

function parseRow(row: PendingQuickActionQueryRow, index: number): PendingQuickActionVisit {
  const context = `quickActionRows[${index}]`;
  const photoCount = row?.photoCount;
  if (typeof photoCount !== "number" || !Number.isSafeInteger(photoCount) || photoCount < 0) {
    throw new RangeError(`${context}.photoCount must be a non-negative safe integer`);
  }
  if (row?.foodProbable !== 0 && row?.foodProbable !== 1) {
    throw new TypeError(`${context}.foodProbable must be 0 or 1`);
  }
  const suggestedRestaurantId = requireNullableString(row?.suggestedRestaurantId, `${context}.suggestedRestaurantId`);
  if (suggestedRestaurantId === "") {
    throw new TypeError(`${context}.suggestedRestaurantId must be non-empty when present`);
  }
  const foodProbable = row.foodProbable === 1;
  return {
    id: requireNonEmptyString(row?.id, `${context}.id`),
    photoCount,
    foodProbable,
    suggestedRestaurantId,
    calendarEventTitle: requireNullableString(row?.calendarEventTitle, `${context}.calendarEventTitle`),
    // Keep the direct driver value; JSON conversion at this magnitude is not bit-exact.
    startTime: requireFiniteNumber(row?.startTime, `${context}.startTime`),
    suggestedRestaurants: parseSuggestions(row?.suggestedRestaurantsJson, `${context}.suggestedRestaurantsJson`),
    // Food labels are optional historical metadata. Preserve the Review card
    // parser's tolerant behavior so one malformed payload cannot hide every
    // Quick Action, while required visit/suggestion fields remain strict.
    foodLabels: parseLegacyPendingVisitFoodLabels(row?.foodLabelsJson, foodProbable),
  };
}

/** Strictly decode slim rows without changing their SQLite-supplied order. */
export function parsePendingQuickActionRows(rows: readonly PendingQuickActionQueryRow[]): PendingQuickActionVisit[] {
  if (!Array.isArray(rows)) {
    throw new TypeError("Pending Quick Actions rows must be an array");
  }
  const visits = rows.map(parseRow);
  const visitIds = new Set<string>();
  for (const visit of visits) {
    if (visitIds.has(visit.id)) {
      throw new RangeError(`Pending Quick Actions rows contain duplicate visit id ${JSON.stringify(visit.id)}`);
    }
    visitIds.add(visit.id);
  }
  return visits;
}

/** Apply the existing fuzzy-first order and exact-confirmation semantics to slim visits. */
export function createPendingQuickActionsData(
  databaseOrderedVisits: readonly PendingQuickActionVisit[],
  tools: PendingVisitReviewMatchTools,
): PendingQuickActionsData {
  const fuzzyMatchIds = new Set<string>();
  for (const visit of databaseOrderedVisits) {
    if (!visit.calendarEventTitle || visit.suggestedRestaurants.length === 0) {
      continue;
    }
    const cleanedTitle = tools.cleanCalendarEventTitle(visit.calendarEventTitle);
    if (
      cleanedTitle &&
      visit.suggestedRestaurants.some((restaurant) => tools.isFuzzyRestaurantMatch(cleanedTitle, restaurant.name))
    ) {
      fuzzyMatchIds.add(visit.id);
    }
  }

  const fuzzyMatches: PendingQuickActionVisit[] = [];
  const remaining: PendingQuickActionVisit[] = [];
  for (const visit of databaseOrderedVisits) {
    (fuzzyMatchIds.has(visit.id) ? fuzzyMatches : remaining).push(visit);
  }
  const visits = [...fuzzyMatches, ...remaining];
  const exactMatches: PendingQuickActionExactMatch[] = [];
  for (const visit of visits) {
    if (!visit.calendarEventTitle) {
      continue;
    }
    const restaurant = visit.suggestedRestaurants.find((suggestion) =>
      tools.compareRestaurantAndCalendarTitle(visit.calendarEventTitle!, suggestion.name),
    );
    if (!restaurant) {
      continue;
    }
    exactMatches.push({
      visitId: visit.id,
      visit,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      calendarTitle: visit.calendarEventTitle,
      startTime: visit.startTime,
    });
  }
  return { visits, exactMatches };
}
