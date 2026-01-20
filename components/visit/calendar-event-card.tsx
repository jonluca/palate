import React from "react";
import { View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { cleanCalendarEventTitle } from "@/services/calendar";

interface CalendarEventCardProps {
  title: string;
  location?: string | null;
}

export function CalendarEventCard({ title, location }: CalendarEventCardProps) {
  return (
    <Card animated={false}>
      <View className={"p-4 gap-2"}>
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-7 h-7 rounded-full bg-blue-500/20 items-center justify-center"}>
            <IconSymbol name={"calendar"} size={16} color={"#3b82f6"} />
          </View>
          <ThemedText variant={"title3"} className={"font-semibold text-blue-600"}>
            {cleanCalendarEventTitle(title)}
          </ThemedText>
        </View>

        {location && !location.includes("http") && (
          <View className={"flex-row items-center gap-2 pr-2"}>
            <IconSymbol name={"mappin"} size={14} color={"#6b7280"} />
            <ThemedText variant={"footnote"} color={"tertiary"} className={"pr-2"}>
              {location}
            </ThemedText>
          </View>
        )}
      </View>
    </Card>
  );
}
