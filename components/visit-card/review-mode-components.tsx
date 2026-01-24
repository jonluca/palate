import React from "react";
import { Pressable, View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { CalendarBadge, ExactMatchBadge } from "./badges";
import { formatDate, formatTime, getMichelinBadge } from "./utils";

interface VisitMetaHeaderProps {
  startTime: number;
  photoCount: number;
  foodProbable: boolean;
}

export function VisitMetaHeader({ startTime, photoCount, foodProbable }: VisitMetaHeaderProps) {
  return (
    <View className={"flex-row items-center justify-between"}>
      <View>
        <ThemedText variant={"subhead"} className={"font-medium"}>
          {formatDate(startTime)}
        </ThemedText>
        <ThemedText variant={"footnote"} color={"tertiary"}>
          {formatTime(startTime)} • {photoCount.toLocaleString()} photos
        </ThemedText>
      </View>
      <View className={"flex-row items-center gap-2"}>
        {Boolean(foodProbable) && (
          <View className={"flex-row items-center gap-1 bg-amber-500/10 px-2 py-1 rounded-full"}>
            <ThemedText variant={"caption1"}>🍽️</ThemedText>
            <ThemedText variant={"caption2"} className={"text-amber-600"}>
              Food Detected
            </ThemedText>
          </View>
        )}
        <IconSymbol name={"chevron.right"} size={16} color={"gray"} />
      </View>
    </View>
  );
}

interface BadgesRowProps {
  calendarEventTitle: string | null | undefined;
  hasMatch: boolean;
}

export function BadgesRow({ calendarEventTitle, hasMatch }: BadgesRowProps) {
  if (!calendarEventTitle && !hasMatch) {
    return null;
  }
  return (
    <View className={"flex-row items-center gap-2 flex-1 overflow-x-auto"}>
      {calendarEventTitle && <CalendarBadge title={calendarEventTitle} />}
      {hasMatch && <ExactMatchBadge />}
    </View>
  );
}

interface ExactMatchCardProps {
  displayName: string | undefined;
  displayAward: string | null | undefined;
  displayCuisine: string | null | undefined;
}

export function ExactMatchCard({ displayName, displayAward, displayCuisine }: ExactMatchCardProps) {
  const badge = displayAward ? getMichelinBadge(displayAward) : null;

  return (
    <View className={"rounded-xl p-3 gap-2 bg-green-500/10"}>
      <View className={"flex-row items-center gap-2"}>
        <View className={"w-6 h-6 rounded-full bg-green-500/20 items-center justify-center"}>
          <IconSymbol name={"checkmark.seal.fill"} size={14} color={"#22c55e"} />
        </View>
        <ThemedText variant={"footnote"} color={"secondary"}>
          Calendar Match Found
        </ThemedText>
      </View>
      <ThemedText numberOfLines={1} variant={"heading"} className={"font-semibold"}>
        {displayName}
      </ThemedText>
      {badge && (
        <View className={"flex-row items-center gap-1"}>
          <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
          <ThemedText variant={"caption2"} color={"secondary"}>
            {badge.label}
          </ThemedText>
        </View>
      )}
      {displayCuisine && (
        <ThemedText numberOfLines={1} variant={"footnote"} color={"tertiary"}>
          {displayCuisine}
        </ThemedText>
      )}
    </View>
  );
}

interface NotThisRestaurantLinkProps {
  onPress: () => void;
}

export function NotThisRestaurantLink({ onPress }: NotThisRestaurantLinkProps) {
  return (
    <Pressable onPress={onPress} className={"self-end"} hitSlop={8}>
      <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
        Not this restaurant?
      </ThemedText>
    </Pressable>
  );
}
