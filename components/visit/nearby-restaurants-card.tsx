import React from "react";
import { View, Pressable, ScrollView } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { getMichelinBadge, formatDistance } from "@/components/restaurant-search-modal";
import type { NearbyRestaurant } from "@/hooks/queries";
import * as Haptics from "expo-haptics";

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

  const handleSelect = (index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelectIndex(index);
  };

  const michelinCount = restaurants.filter((r) => r.source === "michelin").length;
  const mapKitCount = restaurants.filter((r) => r.source === "mapkit").length;

  // Generate header text based on sources
  const headerText =
    michelinCount > 0 && mapKitCount > 0
      ? `${restaurants.length} Nearby Restaurants`
      : michelinCount > 0
        ? `${michelinCount} Nearby Michelin Restaurants`
        : `${mapKitCount} Nearby Restaurants`;

  return (
    <Card delay={200}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-6 h-6 rounded-full bg-amber-500/20 items-center justify-center"}>
            <IconSymbol name={"list.bullet"} size={14} color={"#f59e0b"} />
          </View>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {headerText}
          </ThemedText>
        </View>

        <ScrollView
          style={{ maxHeight: 240 }}
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          contentContainerStyle={{ gap: 8 }}
        >
          {restaurants.map((restaurant, idx) => {
            const isSelected = idx === selectedIndex;
            const badge = restaurant.award ? getMichelinBadge(restaurant.award) : null;
            const isMichelin = restaurant.source === "michelin";

            return (
              <Pressable
                key={`${restaurant.id}-${idx}`}
                onPress={() => handleSelect(idx)}
                className={
                  isSelected
                    ? "bg-green-500/15 rounded-xl p-3 border-2 border-green-500/30"
                    : "bg-card rounded-xl p-3 border-2 border-transparent"
                }
              >
                <View className={"flex-row items-start justify-between"}>
                  <View className={"flex-1 gap-1"}>
                    <View className={"flex-row items-center gap-2"}>
                      {isSelected && <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#22c55e"} />}
                      <ThemedText variant={"subhead"} className={"font-medium"}>
                        {restaurant.name}
                      </ThemedText>
                    </View>
                    {badge && (
                      <View className={"flex-row items-center gap-1"}>
                        <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
                        <ThemedText variant={"caption2"} color={"secondary"}>
                          {badge.label}
                        </ThemedText>
                      </View>
                    )}
                    {!isMichelin && (
                      <View className={"flex-row items-center gap-1"}>
                        <IconSymbol name={"map"} size={10} color={"#6b7280"} />
                        <ThemedText variant={"caption2"} color={"tertiary"}>
                          Apple Maps
                        </ThemedText>
                      </View>
                    )}
                    {restaurant.cuisine && (
                      <ThemedText variant={"caption2"} color={"tertiary"}>
                        {restaurant.cuisine}
                      </ThemedText>
                    )}
                    {restaurant.address && !restaurant.cuisine && (
                      <ThemedText variant={"caption2"} color={"tertiary"} numberOfLines={1}>
                        {restaurant.address}
                      </ThemedText>
                    )}
                  </View>
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    {formatDistance(restaurant.distance)}
                  </ThemedText>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <Pressable onPress={onSearchPress} className={"self-end"} hitSlop={8}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
            Not in the list?
          </ThemedText>
        </Pressable>
      </View>
    </Card>
  );
}
