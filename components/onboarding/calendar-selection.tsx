import React, { useEffect, useState, useCallback, useMemo } from "react";
import { View, Pressable, ActivityIndicator, Dimensions, ScrollView } from "react-native";
import Animated, { useAnimatedStyle, interpolate, Extrapolation, type SharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { getAllSyncableCalendars, hasCalendarPermission, type SyncableCalendar } from "@/services/calendar";
import { useSelectedCalendarIds, useSetSelectedCalendarIds } from "@/store";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

interface CalendarSelectionContentProps {
  scrollX: SharedValue<number>;
  index: number;
  setParentScrollEnabled?: (enabled: boolean) => void;
}

export function CalendarSelectionContent({ scrollX, index, setParentScrollEnabled }: CalendarSelectionContentProps) {
  const [calendars, setCalendars] = useState<SyncableCalendar[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasPermission, setHasPermission] = useState(false);

  const selectedCalendarIds = useSelectedCalendarIds();
  const setSelectedCalendarIds = useSetSelectedCalendarIds();

  const isDefaultDeselectedCalendar = useCallback((calendar: SyncableCalendar) => {
    const haystack = `${calendar.title} ${calendar.source} ${calendar.accountName ?? ""}`.toLowerCase();
    return /holiday|holidays/.test(haystack) || /flight|flights/.test(haystack);
  }, []);

  // Initialize selected calendars - if null (first time), select all
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(selectedCalendarIds ?? []));

  const inputRange = [(index - 1) * SCREEN_WIDTH, index * SCREEN_WIDTH, (index + 1) * SCREEN_WIDTH];

  const animatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollX.value, inputRange, [0, 1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(scrollX.value, inputRange, [30, 0, 30], Extrapolation.CLAMP);

    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  useEffect(() => {
    async function loadCalendars() {
      const permission = await hasCalendarPermission();
      setHasPermission(permission);

      if (permission) {
        const cals = await getAllSyncableCalendars();
        setCalendars(cals);

        // If no selection yet, select all calendars by default (except holidays/flights)
        if (selectedCalendarIds === null && cals.length > 0) {
          const defaultIds = new Set(cals.filter((c) => !isDefaultDeselectedCalendar(c)).map((c) => c.id));
          setSelectedIds(defaultIds);
          setSelectedCalendarIds(Array.from(defaultIds));
        } else if (selectedCalendarIds !== null) {
          setSelectedIds(new Set(selectedCalendarIds));
        }
      }

      setIsLoading(false);
    }

    loadCalendars();
  }, [selectedCalendarIds, setSelectedCalendarIds, isDefaultDeselectedCalendar]);

  const toggleCalendar = useCallback(
    (calendarId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(calendarId)) {
          next.delete(calendarId);
        } else {
          next.add(calendarId);
        }

        // Save to store
        setSelectedCalendarIds(Array.from(next));
        return next;
      });
    },
    [setSelectedCalendarIds],
  );

  const selectAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const allIds = new Set(calendars.map((c) => c.id));
    setSelectedIds(allIds);
    setSelectedCalendarIds(Array.from(allIds));
  }, [calendars, setSelectedCalendarIds]);

  const deselectAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIds(new Set());
    setSelectedCalendarIds([]);
  }, [setSelectedCalendarIds]);
  const sortedCalendars = useMemo(() => {
    if (calendars.length === 0) {
      return calendars;
    }
    const defaultDeselected: SyncableCalendar[] = [];
    const rest: SyncableCalendar[] = [];
    for (const calendar of calendars) {
      if (isDefaultDeselectedCalendar(calendar)) {
        defaultDeselected.push(calendar);
      } else {
        rest.push(calendar);
      }
    }
    return rest.concat(defaultDeselected);
  }, [calendars, isDefaultDeselectedCalendar]);
  if (!hasPermission) {
    return (
      <Animated.View style={animatedStyle} className={"mt-6 w-full px-4"}>
        <View className={"bg-white/10 rounded-2xl p-4 items-center"}>
          <IconSymbol name={"calendar.badge.exclamationmark"} size={32} color={"#f97316"} />
          <ThemedText variant={"footnote"} className={"text-white/60 text-center mt-2"}>
            Grant calendar access on the previous step to select calendars
          </ThemedText>
        </View>
      </Animated.View>
    );
  }

  if (isLoading) {
    return (
      <Animated.View style={animatedStyle} className={"mt-6 w-full px-4"}>
        <View className={"bg-white/10 rounded-2xl p-6 items-center"}>
          <ActivityIndicator color={"#fff"} />
          <ThemedText variant={"footnote"} className={"text-white/60 mt-2"}>
            Loading calendars...
          </ThemedText>
        </View>
      </Animated.View>
    );
  }

  if (calendars.length === 0) {
    return (
      <Animated.View style={animatedStyle} className={"mt-6 w-full px-4"}>
        <View className={"bg-white/10 rounded-2xl p-4 items-center"}>
          <IconSymbol name={"calendar.badge.exclamationmark"} size={32} color={"#6b7280"} />
          <ThemedText variant={"footnote"} className={"text-white/60 text-center mt-2"}>
            No calendars found
          </ThemedText>
        </View>
      </Animated.View>
    );
  }

  const allSelected = selectedIds.size === calendars.length;
  const noneSelected = selectedIds.size === 0;

  return (
    <Animated.View style={animatedStyle} className={"mt-6 w-full px-4"}>
      {/* Quick Actions */}
      <View className={"flex-row justify-center gap-4 mb-3"}>
        <Pressable
          onPress={selectAll}
          disabled={allSelected}
          className={`px-4 py-2 rounded-full ${allSelected ? "bg-white/5" : "bg-white/10"}`}
        >
          <ThemedText variant={"caption1"} className={allSelected ? "text-white/30" : "text-white/70"}>
            Select All
          </ThemedText>
        </Pressable>
        <Pressable
          onPress={deselectAll}
          disabled={noneSelected}
          className={`px-4 py-2 rounded-full ${noneSelected ? "bg-white/5" : "bg-white/10"}`}
        >
          <ThemedText variant={"caption1"} className={noneSelected ? "text-white/30" : "text-white/70"}>
            Deselect All
          </ThemedText>
        </Pressable>
      </View>

      {/* Calendar List */}
      <View className={"bg-white/10 rounded-2xl overflow-hidden max-h-56"}>
        <ScrollView
          nestedScrollEnabled
          showsVerticalScrollIndicator
          keyboardShouldPersistTaps={"handled"}
          onTouchStart={() => setParentScrollEnabled?.(false)}
          onTouchEnd={() => setParentScrollEnabled?.(true)}
          onScrollBeginDrag={() => setParentScrollEnabled?.(false)}
          onScrollEndDrag={() => setParentScrollEnabled?.(true)}
          onMomentumScrollBegin={() => setParentScrollEnabled?.(false)}
          onMomentumScrollEnd={() => setParentScrollEnabled?.(true)}
        >
          {sortedCalendars.map((calendar, idx) => {
            const isSelected = selectedIds.has(calendar.id);
            const isLast = idx === sortedCalendars.length - 1;

            return (
              <Pressable
                key={calendar.id}
                onPress={() => toggleCalendar(calendar.id)}
                className={`flex-row items-center px-4 py-3 ${!isLast ? "border-b border-white/10" : ""}`}
              >
                {/* Calendar Color Dot */}
                <View className={"w-4 h-4 rounded-full mr-3"} style={{ backgroundColor: calendar.color }} />

                {/* Calendar Info */}
                <View className={"flex-1"}>
                  <ThemedText
                    variant={"subhead"}
                    className={`font-medium ${isSelected ? "text-white" : "text-white/50"}`}
                    numberOfLines={1}
                  >
                    {calendar.title}
                  </ThemedText>
                  <ThemedText variant={"caption2"} className={"text-white/40"} numberOfLines={1}>
                    {calendar.source}
                  </ThemedText>
                </View>

                {/* Checkbox */}
                <View
                  className={`w-6 h-6 rounded-md items-center justify-center ${
                    isSelected ? "bg-blue-500" : "bg-white/10 border border-white/20"
                  }`}
                >
                  {isSelected && <IconSymbol name={"checkmark"} size={14} color={"#fff"} />}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Selection Info */}
      <ThemedText variant={"caption1"} className={"text-white/40 text-center mt-3"}>
        {selectedIds.size} of {calendars.length} calendar{calendars.length === 1 ? "" : "s"} selected
      </ThemedText>
    </Animated.View>
  );
}
