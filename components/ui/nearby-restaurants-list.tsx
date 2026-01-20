import React from "react";
import { View, Pressable, ScrollView } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { cn } from "@/utils/cn";
import * as Haptics from "expo-haptics";
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
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  /**
   * Variant affects styling:
   * - "default": Shows distance on the side, address only when no cuisine
   * - "compact": Shorter max height, inline distance, more visual source differentiation
   * - "calendar": Shows address, hides distance (for calendar import where distance isn't relevant)
   */
  variant?: "default" | "compact" | "calendar";
  /** Whether to show the header with icon and count */
  showHeader?: boolean;
  /** Custom header text - if not provided, will generate based on restaurant counts */
  headerText?: string;
  /**
   * Callback fired when user taps on an already-selected restaurant.
   * Use this to deep link to the restaurant detail page if it exists in the database.
   */
  onDeepLink?: (restaurant: NearbyRestaurant) => void;
}

export function NearbyRestaurantsList({
  restaurants,
  selectedIndex,
  onSelectIndex,
  variant = "default",
  showHeader = true,
  headerText,
  onDeepLink,
}: NearbyRestaurantsListProps) {
  if (restaurants.length === 0) {
    return null;
  }

  const handleSelect = (index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // If tapping on an already-selected restaurant and we have a deep link handler,
    // trigger the deep link instead of just selecting
    if (index === selectedIndex && onDeepLink) {
      const restaurant = restaurants[index];
      // Only deep link for Michelin restaurants (they exist in our database)
      if (restaurant.source === "michelin") {
        onDeepLink(restaurant);
        return;
      }
    }

    onSelectIndex(index);
  };

  const michelinCount = restaurants.filter((r) => r.source === "michelin").length;
  const mapKitCount = restaurants.filter((r) => r.source === "mapkit").length;

  // Generate header text based on sources if not provided
  const displayHeaderText =
    headerText ??
    (variant === "compact"
      ? `${restaurants.length.toLocaleString()} Nearby${
          michelinCount > 0 && mapKitCount > 0
            ? ` (${michelinCount} Michelin, ${mapKitCount} Apple Maps)`
            : michelinCount > 0
              ? " Michelin"
              : " Maps"
        }`
      : variant === "calendar"
        ? `${restaurants.length} Matching Restaurants`
        : michelinCount > 0 && mapKitCount > 0
          ? `${restaurants.length} Nearby Restaurants`
          : michelinCount > 0
            ? `${michelinCount} Nearby Michelin Restaurants`
            : `${mapKitCount} Nearby Restaurants`);

  const isCompact = variant === "compact";
  const isCalendar = variant === "calendar";
  const showDistance = !isCalendar; // Hide distance for calendar variant
  const maxHeight = isCompact ? 200 : 240;

  return (
    <View className={"gap-2"}>
      {showHeader && (
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-6 h-6 rounded-full bg-amber-500/20 items-center justify-center"}>
            <IconSymbol name={"list.bullet"} size={14} color={"#f59e0b"} />
          </View>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {displayHeaderText}
          </ThemedText>
        </View>
      )}

      <ScrollView
        style={{ maxHeight }}
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={true}
        contentContainerStyle={{ gap: 8 }}
      >
        {restaurants.map((restaurant, idx) => {
          const isSelected = idx === selectedIndex;
          const badge = restaurant.award ? getMichelinBadge(restaurant.award) : null;
          const isMapKit = restaurant.source === "mapkit";

          return (
            <Pressable
              key={`${restaurant.id}-${idx}`}
              onPress={() => handleSelect(idx)}
              className={cn(
                "rounded-xl p-3 border-2",
                isSelected
                  ? "bg-green-500/15 border-green-500/30"
                  : isCompact && isMapKit
                    ? "bg-blue-500/5 border-blue-500/10"
                    : "bg-card border-transparent",
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
                      <View className={"flex-row items-center gap-1 bg-blue-500/15 px-1.5 py-0.5 rounded-full"}>
                        <IconSymbol name={"map.fill"} size={8} color={"#3b82f6"} />
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
                      {!isCompact && <IconSymbol name={"map"} size={10} color={"#6b7280"} />}
                      <ThemedText
                        variant={"caption2"}
                        color={isCompact ? undefined : "tertiary"}
                        className={isCompact ? "text-blue-500" : undefined}
                      >
                        {isCompact ? "Apple" : "Apple Maps"}
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
