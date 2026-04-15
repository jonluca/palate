import { normalizeForComparison } from "@/services/calendar";

type RestaurantSource = "michelin" | "mapkit" | "google";

interface RestaurantCandidate {
  id?: string;
  name: string;
  source?: RestaurantSource | null;
}

export function normalizeRestaurantNameForPriority(name: string): string {
  return normalizeForComparison(name);
}

export function isMichelinRestaurantCandidate(candidate: RestaurantCandidate): boolean {
  return candidate.source === "michelin" && (candidate.id === undefined || candidate.id.startsWith("michelin-"));
}

export function compareSameNameMichelinFirst<T extends RestaurantCandidate>(a: T, b: T): number {
  const aName = normalizeRestaurantNameForPriority(a.name);
  const bName = normalizeRestaurantNameForPriority(b.name);

  if (!aName || aName !== bName) {
    return 0;
  }

  const aIsMichelin = isMichelinRestaurantCandidate(a);
  const bIsMichelin = isMichelinRestaurantCandidate(b);

  if (aIsMichelin && !bIsMichelin) {
    return -1;
  }
  if (!aIsMichelin && bIsMichelin) {
    return 1;
  }
  return 0;
}
