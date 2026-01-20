import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, NearbyRestaurantsList } from "@/components/ui";
import type { ImportableCalendarEvent, NearbyRestaurant } from "@/hooks/queries";
import { router } from "expo-router";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";

interface CalendarImportCardProps {
  event: ImportableCalendarEvent;
  onImport: (selectedRestaurantId?: string) => void;
  onDismiss: () => void;
  isImporting: boolean;
  isDismissing: boolean;
}

/** Card for displaying an importable calendar event that matches a Michelin restaurant */
export function CalendarImportCard({ event, onImport, onDismiss, isImporting, isDismissing }: CalendarImportCardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selected index when event changes (handles list recycling)
  useEffect(() => {
    setSelectedIndex(0);
  }, [event.calendarEventId]);

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

  const hasMultipleMatches = event.matchedRestaurants.length > 1;
  const selectedRestaurant = event.matchedRestaurants[selectedIndex] ?? event.matchedRestaurant;

  // Convert to NearbyRestaurant format for the list component
  const restaurantsForList: NearbyRestaurant[] = useMemo(
    () =>
      event.matchedRestaurants.map((r) => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        distance: 0, // Calendar matches don't have a distance from the event
        award: r.award ?? null,
        cuisine: r.cuisine,
        address: r.address,
        source: "michelin" as const,
      })),
    [event.matchedRestaurants],
  );

  const handleSelectIndex = useCallback((idx: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIndex(idx);
  }, []);

  const handleDeepLink = useCallback((restaurant: NearbyRestaurant) => {
    router.push(`/restaurant/${restaurant.id}`);
  }, []);

  const handleImport = useCallback(() => {
    // Pass the selected restaurant ID to the import handler
    onImport(selectedRestaurant.id);
  }, [onImport, selectedRestaurant.id]);

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

      {/* Multiple Matches - Show Restaurant List */}
      {hasMultipleMatches ? (
        <View className={"gap-2"}>
          <View className={"flex-row items-center gap-2"}>
            <IconSymbol name={"list.bullet"} size={14} color={"#f59e0b"} />
            <ThemedText variant={"caption1"} color={"secondary"}>
              {event.matchedRestaurants.length} matching Michelin restaurants found
            </ThemedText>
          </View>
          <NearbyRestaurantsList
            restaurants={restaurantsForList}
            selectedIndex={selectedIndex}
            onSelectIndex={handleSelectIndex}
            onDeepLink={handleDeepLink}
            variant={"calendar"}
            showHeader={false}
          />
        </View>
      ) : (
        /* Single Match - Show Detailed Card */
        <Pressable
          onPress={() => router.push(`/restaurant/${selectedRestaurant.id}`)}
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
            {selectedRestaurant.name}
          </ThemedText>

          {/* Award badge */}
          {selectedRestaurant.award && (
            <View className={"flex-row items-center gap-1 mt-1"}>
              <IconSymbol name={"star.fill"} size={12} color={"#f59e0b"} />
              <ThemedText variant={"caption1"} color={"secondary"}>
                {selectedRestaurant.award}
              </ThemedText>
            </View>
          )}

          {/* Location details */}
          <View className={"mt-1.5 gap-0.5"}>
            {selectedRestaurant.location && (
              <View className={"flex-row items-center gap-1"}>
                <IconSymbol name={"mappin"} size={12} color={"#9ca3af"} />
                <ThemedText variant={"caption1"} color={"tertiary"} numberOfLines={1}>
                  {selectedRestaurant.location}
                </ThemedText>
              </View>
            )}
            {selectedRestaurant.address && (
              <ThemedText variant={"caption2"} color={"tertiary"} numberOfLines={1} className={"ml-4"}>
                {selectedRestaurant.address}
              </ThemedText>
            )}
          </View>

          {/* Cuisine */}
          {selectedRestaurant.cuisine && (
            <View className={"flex-row items-center gap-1 mt-1"}>
              <IconSymbol name={"fork.knife"} size={12} color={"#9ca3af"} />
              <ThemedText variant={"caption1"} color={"tertiary"}>
                {selectedRestaurant.cuisine}
              </ThemedText>
            </View>
          )}
        </Pressable>
      )}

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
          onPress={handleImport}
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
