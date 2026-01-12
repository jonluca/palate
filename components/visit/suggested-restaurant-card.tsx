import React from "react";
import { View, Pressable } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { getMichelinBadge } from "@/components/restaurant-search-modal";

interface SuggestedRestaurantCardProps {
  name: string;
  award?: string | null;
  cuisine?: string | null;
  address?: string | null;
  onSearchPress: () => void;
}

export function SuggestedRestaurantCard({ name, award, cuisine, onSearchPress }: SuggestedRestaurantCardProps) {
  const badge = award ? getMichelinBadge(award) : null;

  return (
    <Card delay={200}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-6 h-6 rounded-full bg-green-500/20 items-center justify-center"}>
            <IconSymbol name={"star.fill"} size={14} color={"#22c55e"} />
          </View>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Michelin Match Found
          </ThemedText>
        </View>
        <ThemedText variant={"heading"} className={"font-semibold"} numberOfLines={1}>
          {name}
        </ThemedText>
        {badge && (
          <View className={"flex-row items-center gap-1"}>
            <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
            <ThemedText variant={"caption2"} color={"secondary"}>
              {badge.label}
            </ThemedText>
          </View>
        )}
        {cuisine && (
          <ThemedText numberOfLines={1} variant={"footnote"} color={"tertiary"}>
            {cuisine}
          </ThemedText>
        )}
        <Pressable onPress={onSearchPress} className={"self-end"} hitSlop={8}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
            Not this restaurant?
          </ThemedText>
        </Pressable>
      </View>
    </Card>
  );
}
