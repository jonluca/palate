import { calculateDistanceMeters } from "../data/restaurants.ts";
import { MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS } from "./db/michelin-provider-spatial-core.ts";
import type { MichelinRestaurantRecord } from "./db/types";

export const PROVIDER_EXACT_MICHELIN_RADIUS_METERS = MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS;
export const PROVIDER_FUZZY_MICHELIN_RADIUS_METERS = 250;

export interface ProviderMichelinNameTools {
  readonly normalizeForComparison: (value: string) => string;
  readonly stripComparisonAffixes: (value: string) => string;
  readonly compareRestaurantAndCalendarTitle: (title: string, restaurantName: string) => boolean;
  readonly isFuzzyRestaurantMatch: (left: string, right: string) => boolean;
}

export interface ProviderMichelinLocatedReservation {
  readonly restaurantName: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface ProviderMichelinPossiblyLocatedReservation {
  readonly restaurantName: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface ProviderMichelinMatchableRestaurant {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface ProviderMichelinMatch<
  Restaurant extends ProviderMichelinMatchableRestaurant = MichelinRestaurantRecord,
> {
  readonly restaurant: Restaurant;
  readonly distance: number;
  readonly kind: "exact" | "fuzzy";
}

export type ProviderMichelinRestaurantsByNormalizedName<
  Restaurant extends ProviderMichelinMatchableRestaurant = MichelinRestaurantRecord,
> = Map<string, Restaurant[]>;

export function normalizeProviderMichelinRestaurantName(name: string, tools: ProviderMichelinNameTools): string {
  return tools.normalizeForComparison(tools.stripComparisonAffixes(name));
}

export function buildProviderMichelinRestaurantsByNormalizedName<
  Restaurant extends ProviderMichelinMatchableRestaurant,
>(
  restaurants: readonly Restaurant[],
  tools: ProviderMichelinNameTools,
): ProviderMichelinRestaurantsByNormalizedName<Restaurant> {
  const grouped: ProviderMichelinRestaurantsByNormalizedName<Restaurant> = new Map();
  for (const restaurant of restaurants) {
    const normalizedName = normalizeProviderMichelinRestaurantName(restaurant.name, tools);
    if (!normalizedName) {
      continue;
    }
    const existing = grouped.get(normalizedName);
    if (existing) {
      existing.push(restaurant);
    } else {
      grouped.set(normalizedName, [restaurant]);
    }
  }
  return grouped;
}

export function isValidProviderMichelinCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Legacy exact-first/fuzzy-second matching over one rowid-ordered spatial candidate group. */
export function findProviderMichelinMatch<Restaurant extends ProviderMichelinMatchableRestaurant>(
  reservation: ProviderMichelinLocatedReservation,
  restaurants: readonly Restaurant[],
  tools: ProviderMichelinNameTools,
): ProviderMichelinMatch<Restaurant> | null {
  if (!isValidProviderMichelinCoordinate(reservation.latitude, reservation.longitude)) {
    return null;
  }

  const restaurantsByName = buildProviderMichelinRestaurantsByNormalizedName(restaurants, tools);
  const normalizedName = normalizeProviderMichelinRestaurantName(reservation.restaurantName, tools);
  const exactCandidates = (restaurantsByName.get(normalizedName) ?? [])
    .map((restaurant) => ({
      restaurant,
      distance: calculateDistanceMeters(
        reservation.latitude,
        reservation.longitude,
        restaurant.latitude,
        restaurant.longitude,
      ),
    }))
    .filter(({ distance }) => distance <= PROVIDER_EXACT_MICHELIN_RADIUS_METERS)
    .sort((left, right) => left.distance - right.distance);
  if (exactCandidates.length > 0) {
    return { ...exactCandidates[0]!, kind: "exact" };
  }

  let bestFuzzyMatch: ProviderMichelinMatch<Restaurant> | null = null;
  for (const restaurant of restaurants) {
    const distance = calculateDistanceMeters(
      reservation.latitude,
      reservation.longitude,
      restaurant.latitude,
      restaurant.longitude,
    );
    if (distance > PROVIDER_FUZZY_MICHELIN_RADIUS_METERS) {
      continue;
    }
    if (
      !tools.compareRestaurantAndCalendarTitle(reservation.restaurantName, restaurant.name) &&
      !tools.isFuzzyRestaurantMatch(reservation.restaurantName, restaurant.name)
    ) {
      continue;
    }
    if (!bestFuzzyMatch || distance < bestFuzzyMatch.distance) {
      bestFuzzyMatch = { restaurant, distance, kind: "fuzzy" };
    }
  }
  return bestFuzzyMatch;
}

/** Only null-coordinate reservations need the selective Calendar name projection. */
export function collectProviderMichelinFallbackNormalizedNames(
  reservations: readonly ProviderMichelinPossiblyLocatedReservation[],
  tools: ProviderMichelinNameTools,
): Set<string> {
  const names = new Set<string>();
  for (const reservation of reservations) {
    if (reservation.latitude !== null && reservation.longitude !== null) {
      continue;
    }
    const normalizedName = normalizeProviderMichelinRestaurantName(reservation.restaurantName, tools);
    if (normalizedName) {
      names.add(normalizedName);
    }
  }
  return names;
}

export function getUniqueProviderMichelinNameFallback(
  restaurantName: string,
  restaurantsByName: ProviderMichelinRestaurantsByNormalizedName,
  tools: ProviderMichelinNameTools,
): MichelinRestaurantRecord | null {
  const matches = restaurantsByName.get(normalizeProviderMichelinRestaurantName(restaurantName, tools)) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}
