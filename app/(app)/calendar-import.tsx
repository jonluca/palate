import React, { useCallback, useMemo, useState } from "react";
import { View, Alert, ScrollView, RefreshControl } from "react-native";
import { useToast } from "@/components/ui/toast";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card, AllCaughtUpEmpty, SkeletonVisitCard } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import { CalendarImportCard } from "@/components/review";
import Animated, { FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import { useImportableCalendarEvents, useImportCalendarEvents, type ImportableCalendarEvent } from "@/hooks/queries";

function LoadingState() {
  return (
    <View className={"gap-4"}>
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonVisitCard key={i} />
      ))}
    </View>
  );
}

export default function CalendarImportScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [refreshing, setRefreshing] = useState(false);
  const [importingEventIds, setImportingEventIds] = useState<Set<string>>(new Set());

  // Data queries
  const { data: importableCalendarEvents = [], isLoading } = useImportableCalendarEvents();

  // Mutations
  const importCalendarMutation = useImportCalendarEvents();

  // UI state
  const isImportingAll = importingEventIds.size === importableCalendarEvents.length && importingEventIds.size > 0;
  const isEmpty = importableCalendarEvents.length === 0;

  // Handlers
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.refetchQueries();
    setRefreshing(false);
  }, [queryClient]);

  const handleImportCalendarEvent = useCallback(
    async (calendarEventId: string) => {
      setImportingEventIds((prev) => new Set(prev).add(calendarEventId));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await importCalendarMutation.mutateAsync([calendarEventId]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: "success", message: "Calendar event imported as visit." });
      } catch (error) {
        console.error("Error importing calendar event:", error);
        showToast({ type: "error", message: "Failed to import. Please try again." });
      } finally {
        setImportingEventIds((prev) => {
          const next = new Set(prev);
          next.delete(calendarEventId);
          return next;
        });
      }
    },
    [importCalendarMutation, showToast],
  );

  const handleImportAllCalendarEvents = useCallback(() => {
    if (importableCalendarEvents.length === 0) {
      return;
    }

    Alert.alert(
      "Import All Calendar Events",
      `This will create ${importableCalendarEvents.length.toLocaleString()} visit${importableCalendarEvents.length === 1 ? "" : "s"} from calendar events that match Michelin restaurants.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Import All",
          style: "default",
          onPress: async () => {
            const allIds = importableCalendarEvents.map((e) => e.calendarEventId);
            setImportingEventIds(new Set(allIds));
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const count = await importCalendarMutation.mutateAsync(allIds);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Imported ${count.toLocaleString()} visit${count === 1 ? "" : "s"} from calendar.`,
              });
            } catch (error) {
              console.error("Error importing calendar events:", error);
              showToast({ type: "error", message: "Failed to import. Please try again." });
            } finally {
              setImportingEventIds(new Set());
            }
          },
        },
      ],
    );
  }, [importableCalendarEvents, importCalendarMutation, showToast]);

  // Group events by date for better organization
  const groupedEvents = useMemo(() => {
    const groups: Map<string, ImportableCalendarEvent[]> = new Map();

    for (const event of importableCalendarEvents) {
      const date = new Date(event.startDate);
      const key = date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
      const existing = groups.get(key) ?? [];
      existing.push(event);
      groups.set(key, existing);
    }

    return Array.from(groups.entries()).sort(([a], [b]) => {
      // Sort by date descending (most recent first)
      return new Date(b).getTime() - new Date(a).getTime();
    });
  }, [importableCalendarEvents]);

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentContainerStyle={{
        paddingTop: insets.top + 60,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#999"} colors={["#999"]} />
      }
    >
      {/* Header */}
      <View className={"gap-2 mb-6"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Calendar Imports
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          Import restaurant reservations from your calendar
        </ThemedText>
      </View>

      {/* Stats Card */}
      {!isEmpty && (
        <Animated.View entering={FadeInDown.delay(100).duration(300)} className={"mb-6"}>
          <Card animated={false}>
            <View className={"p-4 gap-4"}>
              <View className={"flex-row items-center gap-4"}>
                <View className={"w-12 h-12 rounded-full bg-blue-500/15 items-center justify-center"}>
                  <IconSymbol name={"calendar.badge.checkmark"} size={24} color={"#3b82f6"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"title3"} className={"font-bold"}>
                    {importableCalendarEvents.length.toLocaleString()}
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Calendar event{importableCalendarEvents.length === 1 ? "" : "s"} matching Michelin restaurants
                  </ThemedText>
                </View>
              </View>
              <Button
                variant={"default"}
                onPress={handleImportAllCalendarEvents}
                loading={isImportingAll}
                disabled={isImportingAll}
                className={"w-full"}
              >
                <IconSymbol name={"plus.circle.fill"} size={18} color={"#fff"} />
                <ButtonText className={"ml-2"}>
                  Import All ({importableCalendarEvents.length.toLocaleString()})
                </ButtonText>
              </Button>
            </View>
          </Card>
        </Animated.View>
      )}

      {/* Loading State */}
      {isLoading && <LoadingState />}

      {/* Empty State */}
      {!isLoading && isEmpty && (
        <Animated.View entering={FadeInDown.delay(100).duration(300)}>
          <AllCaughtUpEmpty />
          <View className={"mt-6 bg-blue-500/10 rounded-xl p-4 flex-row gap-3"}>
            <IconSymbol name={"lightbulb.fill"} size={18} color={"#3b82f6"} />
            <View className={"flex-1"}>
              <ThemedText variant={"footnote"} className={"text-blue-400"}>
                Tip: Calendar events with restaurant reservation names that match Michelin restaurants will appear here
                for easy importing.
              </ThemedText>
            </View>
          </View>
        </Animated.View>
      )}

      {/* Grouped Events List */}
      {!isLoading && !isEmpty && (
        <View className={"gap-6"}>
          {groupedEvents.map(([monthYear, events], groupIndex) => (
            <Animated.View key={monthYear} entering={FadeInDown.delay(150 + groupIndex * 50).duration(300)}>
              <ThemedText
                variant={"footnote"}
                color={"tertiary"}
                className={"uppercase font-semibold tracking-wide px-1 mb-3"}
              >
                {monthYear}
              </ThemedText>
              <View className={"gap-0"}>
                {events.map((event) => (
                  <CalendarImportCard
                    key={event.calendarEventId}
                    event={event}
                    onImport={() => handleImportCalendarEvent(event.calendarEventId)}
                    isImporting={importingEventIds.has(event.calendarEventId)}
                  />
                ))}
              </View>
            </Animated.View>
          ))}
        </View>
      )}

      {/* Info Tip */}
      {!isLoading && !isEmpty && (
        <Animated.View entering={FadeInDown.delay(300).duration(300)} className={"mt-6"}>
          <View className={"bg-blue-500/10 rounded-xl p-4 flex-row gap-3"}>
            <IconSymbol name={"lightbulb.fill"} size={18} color={"#3b82f6"} />
            <View className={"flex-1"}>
              <ThemedText variant={"footnote"} className={"text-blue-400"}>
                Tip: These calendar events match Michelin restaurant names. Importing creates visits without photos that
                you can add to later.
              </ThemedText>
            </View>
          </View>
        </Animated.View>
      )}
    </ScrollView>
  );
}
