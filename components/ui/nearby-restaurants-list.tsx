import React, { useCallback } from "react";
import { View, ScrollView } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import {
  RestaurantRowCard,
  getRestaurantAwardBadge,
  getRestaurantSourceBadge,
  formatRestaurantDistance,
} from "@/components/restaurants/restaurant-row-card";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { NearbyRestaurant } from "@/hooks/queries";

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
        contentContainerStyle={{ gap: 8 }}
      >
        {restaurants.map((restaurant) => {
          const isSelected = selectedRestaurant?.id === restaurant.id;
          const badge = getRestaurantAwardBadge(restaurant.award) ?? getRestaurantSourceBadge(restaurant.source);
          const subtitle = restaurant.cuisine ?? restaurant.address ?? null;
          const supportingText = restaurant.cuisine && restaurant.address ? restaurant.address : null;
          const rightAccessory = isSelected ? (
            <IconSymbol name={"checkmark.circle.fill"} size={20} color={"#22c55e"} />
          ) : showDistance ? (
            <ThemedText variant={"caption1"} color={"tertiary"}>
              {formatRestaurantDistance(restaurant.distance)}
            </ThemedText>
          ) : undefined;

          return (
            <RestaurantRowCard
              key={restaurant.id}
              onPress={() => handleSelect(restaurant)}
              title={restaurant.name}
              subtitle={subtitle}
              supportingText={isCalendar ? restaurant.address : supportingText}
              variant={isCompact ? "compact" : "selection"}
              badge={badge}
              rightAccessory={rightAccessory}
              selected={isSelected}
              source={restaurant.source}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}
