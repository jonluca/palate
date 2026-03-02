import {
  RestaurantRowCard,
  RestaurantRowChevron,
  getRestaurantAwardBadge,
} from "@/components/restaurants/restaurant-row-card";
import type { MichelinRestaurantRecord } from "@/utils/db";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React from "react";
import Animated, { FadeInDown } from "react-native-reanimated";

interface MichelinRestaurantCardProps {
  restaurant: MichelinRestaurantRecord;
  index?: number;
  visited?: boolean;
}

export function MichelinRestaurantCard({ restaurant, index, visited = false }: MichelinRestaurantCardProps) {
  const handlePress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${restaurant.id}`);
  };

  const content = (
    <RestaurantRowCard
      title={restaurant.name}
      subtitle={restaurant.cuisine}
      supportingText={restaurant.location}
      variant={"main"}
      source={"michelin"}
      badge={getRestaurantAwardBadge(restaurant.award)}
      rightAccessory={<RestaurantRowChevron />}
      onPress={handlePress}
      className={visited ? "border-primary/20" : undefined}
    />
  );

  if (typeof index !== "number") {
    return content;
  }

  return <Animated.View entering={FadeInDown.delay(index * 50).duration(150)}>{content}</Animated.View>;
}
