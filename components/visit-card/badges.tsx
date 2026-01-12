import { View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { cleanCalendarEventTitle } from "@/services/calendar";

export function FoodBadge() {
  return (
    <View className={"flex-row items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded-full"}>
      <ThemedText variant={"caption2"} className={"text-amber-600"}>
        🍽️ Food
      </ThemedText>
    </View>
  );
}

export function CalendarBadge({ title, isAllDay }: { title: string; isAllDay?: boolean }) {
  const cleanedTitle = cleanCalendarEventTitle(title);
  return (
    <View className={"flex-row items-center gap-1 bg-blue-500/10 px-2 py-0.5 rounded-full"}>
      <IconSymbol name={"calendar"} size={12} color={"#3b82f6"} />
      <ThemedText variant={"caption2"} className={"text-blue-500 max-w-[200px]"} numberOfLines={1}>
        {isAllDay ? `📅 ${cleanedTitle}` : cleanedTitle}
      </ThemedText>
    </View>
  );
}

export function NearbyRestaurantsBadge({ count }: { count: number }) {
  return (
    <View className={"flex-row items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded-full"}>
      <IconSymbol name={"mappin.and.ellipse"} size={12} color={"#f59e0b"} />
      <ThemedText variant={"caption2"} className={"text-amber-600"}>
        {count} nearby
      </ThemedText>
    </View>
  );
}

export function ExactMatchBadge() {
  return (
    <View className={"flex-row items-center gap-1 bg-green-500/10 px-2 py-0.5 rounded-full"}>
      <IconSymbol name={"checkmark.seal.fill"} size={12} color={"#22c55e"} />
      <ThemedText variant={"caption2"} className={"text-green-600"}>
        Exact Match
      </ThemedText>
    </View>
  );
}

export function AppleMapsVerifiedBadge({ isLoading }: { isLoading?: boolean }) {
  if (isLoading) {
    return (
      <View className={"flex-row items-center gap-1 bg-blue-500/10 px-2 py-0.5 rounded-full"}>
        <ThemedText variant={"caption2"} className={"text-blue-500"}>
          Verifying...
        </ThemedText>
      </View>
    );
  }
  return (
    <View className={"flex-row items-center gap-1 bg-blue-500/10 px-2 py-0.5 rounded-full"}>
      <IconSymbol name={"map.fill"} size={12} color={"#3b82f6"} />
      <ThemedText variant={"caption2"} className={"text-blue-500"}>
        Apple Maps ✓
      </ThemedText>
    </View>
  );
}
