import { useMemo } from "react";
import { Platform } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  isMapKitSearchAvailable,
  searchByText,
  searchNearbyRestaurants as mapKitSearchNearby,
  type MapKitSearchResult,
} from "@/modules/mapkit-search";
import { isFuzzyRestaurantMatch } from "@/services/calendar";
import { calculateDistance } from "@/components/visit-card/utils";
import type {
  SuggestedRestaurant,
  AppleMapsVerification,
  MergedRestaurantSuggestion,
  AppleMapsSearchResult,
} from "@/components/visit-card/types";

// Query key for Apple Maps search
const appleMapsSearchQueryKey = (lat: number, lon: number, michelinIds: string[]) =>
  ["appleMapsSearch", lat.toFixed(4), lon.toFixed(4), michelinIds.join(",")] as const;

// Fetcher function for Apple Maps search
async function fetchAppleMapsSearch(
  michelinRestaurants: SuggestedRestaurant[],
  centerLat: number,
  centerLon: number,
): Promise<Omit<AppleMapsSearchResult, "isLoading">> {
  // 1. Search Apple Maps for nearby restaurants
  const appleMapsResults = await mapKitSearchNearby(centerLat, centerLon, 300);

  // 2. Verify top 3 Michelin restaurants against Apple Maps
  const topMichelin = michelinRestaurants.slice(0, 3);
  const verifications = new Map<string, AppleMapsVerification>();

  for (const restaurant of topMichelin) {
    try {
      const searchResults = await searchByText(restaurant.name, centerLat, centerLon, 500);
      let isVerified = false;
      let matchedResult: MapKitSearchResult | undefined;

      for (const mapResult of searchResults) {
        if (!mapResult.name) {
          continue;
        }

        const nameMatches = isFuzzyRestaurantMatch(restaurant.name, mapResult.name);
        const distance = calculateDistance(
          restaurant.latitude,
          restaurant.longitude,
          mapResult.latitude,
          mapResult.longitude,
        );

        if ((nameMatches && distance < 100) || distance < 30) {
          isVerified = true;
          matchedResult = mapResult;
          break;
        }
      }

      verifications.set(restaurant.id, {
        restaurantId: restaurant.id,
        isVerified,
        mapKitResult: matchedResult,
        isLoading: false,
      });
    } catch {
      verifications.set(restaurant.id, {
        restaurantId: restaurant.id,
        isVerified: false,
        isLoading: false,
      });
    }
  }

  // 3. Convert Michelin restaurants to merged format with verification status
  const mergedMichelin: MergedRestaurantSuggestion[] = michelinRestaurants.map((r) => ({
    ...r,
    source: "michelin" as const,
    isVerified: verifications.get(r.id)?.isVerified ?? false,
  }));

  // 4. Convert Apple Maps results to merged format, filtering out duplicates
  const michelinNames = new Set(michelinRestaurants.map((r) => r.name.toLowerCase().trim()));

  const appleMapsRestaurants: MergedRestaurantSuggestion[] = appleMapsResults
    .filter((r: MapKitSearchResult) => {
      if (!r.name) {
        return false;
      }
      const normalizedName = r.name.toLowerCase().trim();
      // Skip if name matches any Michelin restaurant (fuzzy match)
      for (const michelinName of michelinNames) {
        if (isFuzzyRestaurantMatch(normalizedName, michelinName)) {
          return false;
        }
      }
      return true;
    })
    .map((r: MapKitSearchResult) => ({
      id: `apple-maps-${r.latitude.toFixed(9)}-${r.longitude.toFixed(9)}-${r.name?.slice(0, 10)}`,
      name: r.name!,
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address ?? "",
      location: r.address ?? "",
      cuisine: "",
      award: "", // No Michelin award
      distance: r.distance,
      source: "apple-maps" as const,
      isVerified: true, // Apple Maps results are inherently "verified" by Apple Maps
    }));

  // 5. Merge: Michelin first (sorted by distance), then Apple Maps (sorted by distance)
  const merged = [...mergedMichelin, ...appleMapsRestaurants].sort((a, b) => a.distance - b.distance);

  const verifiedCount = Array.from(verifications.values()).filter((v) => v.isVerified).length;

  return {
    mergedRestaurants: merged,
    verifications,
    appleMapsCount: appleMapsRestaurants.length,
    verifiedCount,
  };
}

// Hook to search Apple Maps and merge with Michelin suggestions
export function useAppleMapsSearch(
  michelinRestaurants: SuggestedRestaurant[],
  centerLat: number,
  centerLon: number,
  enabled: boolean = true,
): AppleMapsSearchResult {
  const isAvailable = enabled && isMapKitSearchAvailable() && Platform.OS === "ios";
  const michelinIds = useMemo(() => michelinRestaurants.map((r) => r.id), [michelinRestaurants]);

  const { data, isLoading } = useQuery({
    queryKey: appleMapsSearchQueryKey(centerLat, centerLon, michelinIds),
    queryFn: () => fetchAppleMapsSearch(michelinRestaurants, centerLat, centerLon),
    enabled: isAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Return default result when disabled or no data yet
  if (!isAvailable || !data) {
    return {
      mergedRestaurants: michelinRestaurants.map((r) => ({ ...r, source: "michelin" as const, isVerified: false })),
      verifications: new Map(),
      isLoading: isAvailable && isLoading,
      appleMapsCount: 0,
      verifiedCount: 0,
    };
  }

  return {
    ...data,
    isLoading,
  };
}
