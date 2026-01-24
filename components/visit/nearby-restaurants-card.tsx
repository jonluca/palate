import React, { useMemo } from "react";
import { View, Pressable } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card, NearbyRestaurantsList } from "@/components/ui";
import type { NearbyRestaurant } from "@/hooks/queries";

interface NearbyRestaurantsCardProps {
  restaurants: NearbyRestaurant[];
  isShowingSuggestedRestaurant: boolean;
  /** The currently selected restaurant (null means first in list) */
  selectedRestaurant: NearbyRestaurant | null;
  /** Called when user selects a restaurant from the list */
  onSelectRestaurant: (restaurant: NearbyRestaurant) => void;
  onSearchPress: () => void;
}

export function NearbyRestaurantsCard({
  restaurants,
  selectedRestaurant,
  onSelectRestaurant,
  onSearchPress,
  isShowingSuggestedRestaurant,
}: NearbyRestaurantsCardProps) {
  // Default to first restaurant if none selected
  const currentSelectedRestaurant = useMemo(
    () => selectedRestaurant ?? restaurants[0] ?? null,
    [selectedRestaurant, restaurants],
  );

  return (
    <Card delay={200}>
      <View className={"p-4 gap-3"}>
        {!isShowingSuggestedRestaurant && (
          <NearbyRestaurantsList
            restaurants={restaurants}
            selectedRestaurant={currentSelectedRestaurant}
            onSelectRestaurant={onSelectRestaurant}
            variant={"default"}
          />
        )}

        <Pressable onPress={onSearchPress} className={"self-end"} hitSlop={8}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
            Not in the list?
          </ThemedText>
        </Pressable>
      </View>
    </Card>
  );
}
