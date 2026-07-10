import type { MichelinRestaurantRecord } from "./db/types";

export interface CalendarGuideNameTools {
  readonly cleanCalendarEventTitle: (title: string) => string;
  readonly normalizeForComparison: (value: string) => string;
  readonly stripComparisonAffixes: (value: string) => string;
}

export interface CalendarGuideEventLike {
  readonly title: string;
}

export type CalendarGuideRestaurantsByName = Map<string, MichelinRestaurantRecord[]>;

export interface CalendarGuideMatchingContext {
  readonly requestedNormalizedNames: ReadonlySet<string>;
  readonly restaurantsByName: CalendarGuideRestaurantsByName;
}

export type LoadCalendarGuideRestaurants = (
  requestedNormalizedNames: ReadonlySet<string>,
  normalizeRestaurantName: (name: string) => string,
) => Promise<MichelinRestaurantRecord[]>;

export function normalizeMichelinCalendarRestaurantName(name: string, tools: CalendarGuideNameTools): string {
  return tools.normalizeForComparison(tools.stripComparisonAffixes(name));
}

export function normalizeCalendarImportEventTitle(title: string, tools: CalendarGuideNameTools): string | null {
  const cleanedTitle = tools.stripComparisonAffixes(tools.cleanCalendarEventTitle(title));
  if (cleanedTitle.length < 3) {
    return null;
  }
  const normalizedName = tools.normalizeForComparison(cleanedTitle);
  return normalizedName || null;
}

export function collectCalendarImportRequestedNormalizedNames(
  events: readonly CalendarGuideEventLike[],
  tools: CalendarGuideNameTools,
): Set<string> {
  const requestedNormalizedNames = new Set<string>();
  for (const event of events) {
    const normalizedName = normalizeCalendarImportEventTitle(event.title, tools);
    if (normalizedName) {
      requestedNormalizedNames.add(normalizedName);
    }
  }
  return requestedNormalizedNames;
}

export function buildCalendarGuideRestaurantsByNormalizedName(
  restaurants: readonly MichelinRestaurantRecord[],
  tools: CalendarGuideNameTools,
): CalendarGuideRestaurantsByName {
  const restaurantsByName: CalendarGuideRestaurantsByName = new Map();
  for (const restaurant of restaurants) {
    const normalizedName = normalizeMichelinCalendarRestaurantName(restaurant.name, tools);
    if (!normalizedName) {
      continue;
    }
    const existing = restaurantsByName.get(normalizedName);
    if (existing) {
      existing.push(restaurant);
    } else {
      restaurantsByName.set(normalizedName, [restaurant]);
    }
  }
  return restaurantsByName;
}

/** Runs the production request/name-index sequence with an injected DB loader. */
export async function loadCalendarGuideMatchingContext(
  events: readonly CalendarGuideEventLike[],
  tools: CalendarGuideNameTools,
  loadRestaurants: LoadCalendarGuideRestaurants,
): Promise<CalendarGuideMatchingContext> {
  const requestedNormalizedNames = collectCalendarImportRequestedNormalizedNames(events, tools);
  if (requestedNormalizedNames.size === 0) {
    return { requestedNormalizedNames, restaurantsByName: new Map() };
  }
  const restaurants = await loadRestaurants(requestedNormalizedNames, (name) =>
    normalizeMichelinCalendarRestaurantName(name, tools),
  );
  return {
    requestedNormalizedNames,
    restaurantsByName: buildCalendarGuideRestaurantsByNormalizedName(restaurants, tools),
  };
}

function locationRelevanceScore(
  restaurant: MichelinRestaurantRecord,
  eventLocation: string | null,
  tools: CalendarGuideNameTools,
): number {
  if (!eventLocation) {
    return 0;
  }
  const event = tools.normalizeForComparison(eventLocation);
  const location = tools.normalizeForComparison(restaurant.location);
  const address = tools.normalizeForComparison(restaurant.address);
  let score = 0;
  if (event.includes(address) || address.includes(event)) {
    score += 2;
  }
  if (event.includes(location) || location.includes(event)) {
    score += 1;
  }
  return score;
}

/** Returns an event's exact-name group in legacy stable location-relevance order. */
export function getCalendarGuideMatchesForEvent(
  title: string,
  eventLocation: string | null,
  restaurantsByName: CalendarGuideRestaurantsByName,
  tools: CalendarGuideNameTools,
): MichelinRestaurantRecord[] {
  const normalizedName = normalizeCalendarImportEventTitle(title, tools);
  if (!normalizedName) {
    return [];
  }
  const matches = restaurantsByName.get(normalizedName);
  if (!matches || matches.length <= 1) {
    return matches ?? [];
  }
  return [...matches].sort(
    (left, right) =>
      locationRelevanceScore(right, eventLocation, tools) - locationRelevanceScore(left, eventLocation, tools),
  );
}
