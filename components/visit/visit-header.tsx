import React from "react";
import { View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Badge } from "@/components/ui";
import { getMichelinBadge } from "@/components/restaurant-search-modal";
import { formatDate, formatTime, statusVariant } from "./utils";
import type { VisitStatus } from "@/hooks/queries";

interface VisitHeaderProps {
  displayName: string;
  status: VisitStatus;
  startTime: number;
  endTime: number;
  foodProbable: boolean;
  award?: string | null;
  timeZone?: string | null;
}

export function VisitHeader({
  displayName,
  status,
  startTime,
  endTime,
  foodProbable,
  award,
  timeZone,
}: VisitHeaderProps) {
  const badge = award ? getMichelinBadge(award) : null;

  return (
    <View className={"gap-3"}>
      <View className={"flex-row items-center gap-2"}>
        <Badge variant={statusVariant[status]} label={status} />
        {Boolean(foodProbable) && (
          <View className={"flex-row items-center gap-1 bg-amber-500/10 px-2 py-1 rounded-full"}>
            <ThemedText variant={"caption1"}>🍽️</ThemedText>
            <ThemedText variant={"caption2"} className={"text-amber-600"}>
              Food
            </ThemedText>
          </View>
        )}
      </View>

      <ThemedText variant={"largeTitle"} className={"font-bold line-clamp-2"}>
        {displayName}
      </ThemedText>

      {badge && (
        <View className={"flex-row items-center gap-2"}>
          <ThemedText variant={"body"}>{badge.emoji}</ThemedText>
          <ThemedText variant={"subhead"} color={"secondary"}>
            {badge.label}
          </ThemedText>
        </View>
      )}

      <ThemedText variant={"body"} color={"secondary"}>
        {formatDate(startTime, timeZone)} · {formatTime(startTime, timeZone)} – {formatTime(endTime, timeZone)}
      </ThemedText>
    </View>
  );
}
