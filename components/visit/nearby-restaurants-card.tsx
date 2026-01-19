import React from "react";
import { View, Pressable } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card, NearbyRestaurantsList } from "@/components/ui";
import type { NearbyRestaurant } from "@/hooks/queries";

interface NearbyRestaurantsCardProps {
  restaurants: NearbyRestaurant[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onSearchPress: () => void;
}

export function NearbyRestaurantsCard({
  restaurants,
  selectedIndex,
  onSelectIndex,
  onSearchPress,
}: NearbyRestaurantsCardProps) {
  if (restaurants.length <= 1) {
    return null;
  }

  return (
    <Card delay={200}>
      <View className={"p-4 gap-3"}>
        <NearbyRestaurantsList
          restaurants={restaurants}
          selectedIndex={selectedIndex}
          onSelectIndex={onSelectIndex}
          variant={"default"}
        />

        <Pressable onPress={onSearchPress} className={"self-end"} hitSlop={8}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
            Not in the list?
          </ThemedText>
        </Pressable>
      </View>
    </Card>
  );
}
