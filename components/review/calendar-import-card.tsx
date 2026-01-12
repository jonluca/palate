import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import type { ImportableCalendarEvent } from "@/hooks/queries";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

interface CalendarImportCardProps {
  event: ImportableCalendarEvent;
  onImport: () => void;
  onDismiss: () => void;
  isImporting: boolean;
  isDismissing: boolean;
}

/** Card for displaying an importable calendar event that matches a Michelin restaurant */
export function CalendarImportCard({ event, onImport, onDismiss, isImporting, isDismissing }: CalendarImportCardProps) {
  const eventDate = new Date(event.startDate);
  const formattedDate = eventDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: eventDate.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
  const formattedTime = eventDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <View className={"bg-card rounded-2xl p-4 gap-3 mb-4"}>
      {/* Calendar Event Info */}
      <View className={"flex-row items-start gap-3"}>
        <View className={"w-10 h-10 rounded-full bg-primary/10 items-center justify-center"}>
          <IconSymbol name={"calendar"} size={20} color={"#007AFF"} />
        </View>
        <View className={"flex-1"}>
          <ThemedText className={"font-semibold text-base"} numberOfLines={2}>
            {event.calendarEventTitle}
          </ThemedText>
          <ThemedText variant={"caption1"} color={"secondary"} className={"mt-0.5"}>
            {formattedDate} at {formattedTime}
          </ThemedText>
          {event.calendarEventLocation && (
            <ThemedText variant={"caption1"} color={"secondary"} numberOfLines={1} className={"mt-0.5"}>
              📍 {event.calendarEventLocation}
            </ThemedText>
          )}
        </View>
      </View>

      {/* Matched Restaurant */}
      <Pressable
        onPress={() => router.push(`/restaurant/${event.matchedRestaurant.id}`)}
        accessibilityRole={"button"}
        className={"bg-background/50 rounded-xl p-3"}
        hitSlop={6}
      >
        <View className={"flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-2"}>
            <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#34C759"} />
            <ThemedText variant={"caption1"} color={"secondary"}>
              Matches Michelin Restaurant
            </ThemedText>
          </View>
          <IconSymbol name={"chevron.right"} size={16} color={"#9ca3af"} />
        </View>

        <ThemedText className={"font-medium mt-1 text-blue-400"} numberOfLines={2}>
          {event.matchedRestaurant.name}
        </ThemedText>

        {/* Award badge */}
        {event.matchedRestaurant.award && (
          <View className={"flex-row items-center gap-1 mt-1"}>
            <IconSymbol name={"star.fill"} size={12} color={"#f59e0b"} />
            <ThemedText variant={"caption1"} color={"secondary"}>
              {event.matchedRestaurant.award}
            </ThemedText>
          </View>
        )}

        {/* Location details */}
        <View className={"mt-1.5 gap-0.5"}>
          {event.matchedRestaurant.location && (
            <View className={"flex-row items-center gap-1"}>
              <IconSymbol name={"mappin"} size={12} color={"#9ca3af"} />
              <ThemedText variant={"caption1"} color={"tertiary"} numberOfLines={1}>
                {event.matchedRestaurant.location}
              </ThemedText>
            </View>
          )}
          {event.matchedRestaurant.address && (
            <ThemedText variant={"caption2"} color={"tertiary"} numberOfLines={1} className={"ml-4"}>
              {event.matchedRestaurant.address}
            </ThemedText>
          )}
        </View>

        {/* Cuisine */}
        {event.matchedRestaurant.cuisine && (
          <View className={"flex-row items-center gap-1 mt-1"}>
            <IconSymbol name={"fork.knife"} size={12} color={"#9ca3af"} />
            <ThemedText variant={"caption1"} color={"tertiary"}>
              {event.matchedRestaurant.cuisine}
            </ThemedText>
          </View>
        )}
      </Pressable>

      {/* Action Buttons */}
      <View className={"flex-row gap-2"}>
        <Button
          size={"sm"}
          variant={"secondary"}
          onPress={onDismiss}
          loading={isDismissing}
          disabled={isImporting || isDismissing}
          className={"flex-1"}
        >
          <IconSymbol name={"xmark.circle.fill"} size={18} color={"#9ca3af"} />
          <ButtonText className={"ml-2 text-gray-400"}>Dismiss</ButtonText>
        </Button>
        <Button
          size={"sm"}
          variant={"default"}
          onPress={onImport}
          loading={isImporting}
          disabled={isImporting || isDismissing}
          className={"flex-1"}
        >
          <IconSymbol name={"plus.circle.fill"} size={18} color={"#fff"} />
          <ButtonText className={"ml-2"}>Import</ButtonText>
        </Button>
      </View>
    </View>
  );
}
