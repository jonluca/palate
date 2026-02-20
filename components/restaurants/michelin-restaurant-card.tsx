import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import type { MichelinRestaurantRecord } from "@/utils/db";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

function formatAward(award: string | null): string | null {
  if (!award) {
    return null;
  }
  const lower = award.toLowerCase();
  if (lower.includes("3 star")) {
    return "⭐⭐⭐";
  }
  if (lower.includes("2 star")) {
    return "⭐⭐";
  }
  if (lower.includes("1 star")) {
    return "⭐";
  }
  if (lower.includes("bib gourmand")) {
    return "🍽️ Bib";
  }
  if (lower.includes("green star")) {
    return "🌿";
  }
  return null;
}

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

  const awardDisplay = formatAward(restaurant.award);

  const content = (
    <Pressable onPress={handlePress} className={"rounded-2xl"}>
      <Card animated={false}>
        <View className={"p-4 gap-2"}>
          <View className={"flex-row items-start justify-between"}>
            <View className={"flex-1 gap-1"}>
              <View className={"flex-row items-center gap-2"}>
                <ThemedText variant={"heading"} className={"font-semibold flex-shrink"} numberOfLines={1}>
                  {restaurant.name}
                </ThemedText>
                {awardDisplay && (
                  <ThemedText variant={"subhead"} className={"text-amber-300"}>
                    {awardDisplay}
                  </ThemedText>
                )}
              </View>
              <View className={"flex-row items-center gap-2 flex-wrap"}>
                {restaurant.cuisine ? (
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    {restaurant.cuisine}
                  </ThemedText>
                ) : null}
              </View>
              {restaurant.location ? (
                <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={1}>
                  {restaurant.location}
                </ThemedText>
              ) : null}
            </View>
            <View className={"flex-row items-center gap-2 ml-3"}>
              <ThemedText variant={"caption1"} color={visited ? "primary" : "tertiary"}>
                {visited ? "Visited" : "Not visited"}
              </ThemedText>
              <View className={"w-7 h-7 rounded-full bg-secondary/70 items-center justify-center"}>
                <IconSymbol name={"chevron.right"} size={12} color={"#8E8E93"} weight={"semibold"} />
              </View>
            </View>
          </View>
        </View>
      </Card>
    </Pressable>
  );

  if (typeof index !== "number") {
    return content;
  }

  return <Animated.View entering={FadeInDown.delay(index * 50).duration(150)}>{content}</Animated.View>;
}
