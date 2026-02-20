import React, { useCallback } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { cn } from "@/utils/cn";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { NearbyRestaurant } from "@/hooks/queries";

// Inline getMichelinBadge to avoid circular dependencies
function getMichelinBadge(award: string): { emoji: string; label: string } | null {
  if (!award) {
    return null;
  }
  const lowerAward = award.toLowerCase();
  if (lowerAward.includes("3 star")) {
    return { emoji: "⭐⭐⭐", label: "3 Michelin Stars" };
  }
  if (lowerAward.includes("2 star")) {
    return { emoji: "⭐⭐", label: "2 Michelin Stars" };
  }
  if (lowerAward.includes("1 star")) {
    return { emoji: "⭐", label: "1 Michelin Star" };
  }
  if (lowerAward.includes("bib")) {
    return { emoji: "🍴", label: "Bib Gourmand" };
  }
  if (lowerAward.includes("selected") || lowerAward.includes("guide")) {
    return { emoji: "🔴", label: "Michelin Selected" };
  }
  return null;
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

export interface NearbyRestaurantsListProps {
  restaurants: NearbyRestaurant[];
  selectedRestaurant: NearbyRestaurant | null;
  onSelectRestaurant: (restaurant: NearbyRestaurant) => void;
  /**
   * Variant affects styling:
   * - "default": Shows distance on the side, address only when no cuisine
   * - "compact": Shorter max height, inline distance, more visual source differentiation
   * - "calendar": Shows address, hides distance (for calendar import where distance isn't relevant)
   */
  variant?: "default" | "compact" | "calendar";
  /**
   * Callback fired when user taps on an already-selected restaurant.
   * Use this to deep link to the restaurant detail page if it exists in the database.
   */
  onDeepLink?: (restaurant: NearbyRestaurant) => void;
}

export function NearbyRestaurantsList({
  restaurants,
  selectedRestaurant,
  onSelectRestaurant,
  variant = "default",
  onDeepLink,
}: NearbyRestaurantsListProps) {
  // Default deep link navigates to restaurant detail page
  const defaultDeepLink = useCallback((restaurant: NearbyRestaurant) => {
    router.push(`/restaurant/${restaurant.id}`);
  }, []);

  const deepLinkHandler = onDeepLink ?? defaultDeepLink;

  const handleSelect = (restaurant: NearbyRestaurant) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // If tapping on an already-selected restaurant, trigger the deep link instead of just selecting
    // Only deep link for Michelin restaurants (they exist in our database)
    if (selectedRestaurant?.id === restaurant.id && restaurant.source === "michelin") {
      deepLinkHandler(restaurant);
      return;
    }

    onSelectRestaurant(restaurant);
  };

  if (restaurants.length === 0) {
    return null;
  }

  const isCompact = variant === "compact";
  const isCalendar = variant === "calendar";
  const showDistance = !isCalendar; // Hide distance for calendar variant
  const maxHeight = isCompact ? 200 : 240;

  return (
    <View className={"gap-2"}>
      <ScrollView
        style={{ maxHeight }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled={true}
        contentContainerStyle={{ gap: 4 }}
      >
        {restaurants.map((restaurant, idx) => {
          const isSelected = selectedRestaurant?.id === restaurant.id;
          const badge = restaurant.award ? getMichelinBadge(restaurant.award) : null;
          const isMapKit = restaurant.source === "mapkit";

          return (
            <Pressable
              key={`${restaurant.id}-${idx}`}
              onPress={() => handleSelect(restaurant)}
              className={cn(
                "rounded-xl p-3",
                isSelected
                  ? "bg-green-500/10 border-green-500/40 border-1"
                  : isCompact && isMapKit
                    ? "bg-blue-500/5"
                    : "bg-card/80",
              )}
            >
              <View className={"flex-row items-start justify-between"}>
                <View className={"flex-1 gap-1"}>
                  <View className={"flex-row items-center gap-1"}>
                    {isSelected && <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#22c55e"} />}
                    <ThemedText
                      variant={"subhead"}
                      className={cn("font-medium", isCompact && "flex-1")}
                      numberOfLines={isCompact ? 1 : undefined}
                    >
                      {restaurant.name}
                    </ThemedText>
                    {isCompact && isMapKit && (
                      <View
                        className={
                          "flex-row items-center gap-1 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full"
                        }
                      >
                        <IconSymbol name={"map.fill"} size={8} color={"#2563eb"} />
                      </View>
                    )}
                    {isCompact && showDistance && (
                      <ThemedText variant={"caption2"} color={"tertiary"}>
                        {formatDistance(restaurant.distance)}
                      </ThemedText>
                    )}
                  </View>

                  {badge && (
                    <View className={"flex-row items-center gap-1"}>
                      <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
                      <ThemedText variant={"caption2"} color={"secondary"}>
                        {badge.label}
                      </ThemedText>
                    </View>
                  )}

                  {/* MapKit label - different styling for compact vs default */}
                  {isMapKit && !badge && (
                    <View className={"flex-row items-center gap-1"}>
                      {!isCompact && <IconSymbol name={"map.fill"} size={10} color={"#6b7280"} />}
                      <ThemedText
                        variant={"caption2"}
                        color={isCompact ? undefined : "tertiary"}
                        className={isCompact ? "text-blue-500" : undefined}
                      >
                        Apple Maps
                      </ThemedText>
                    </View>
                  )}

                  {restaurant.cuisine && (
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      {restaurant.cuisine}
                    </ThemedText>
                  )}

                  {/* Show address for calendar variant (always) or default variant (when no cuisine) */}
                  {restaurant.address && (isCalendar || (!isCompact && !restaurant.cuisine)) && (
                    <ThemedText variant={"caption2"} color={"tertiary"} numberOfLines={1}>
                      {restaurant.address}
                    </ThemedText>
                  )}
                </View>

                {/* Distance on the side for default variant (not calendar) */}
                {!isCompact && showDistance && (
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    {formatDistance(restaurant.distance)}
                  </ThemedText>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
