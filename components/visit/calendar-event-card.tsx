import React, { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { cleanCalendarEventTitle } from "@/services/calendar";

interface CalendarEventEntry {
  id: string;
  title: string;
  location?: string | null;
}

interface CalendarEventCardProps {
  visit: {
    id: number | string;
    status: "pending" | "confirmed" | "rejected";
    calendarEventTitle?: string | null;
    calendarEventId?: string | null;
    calendarEventLocation?: string | null;
    calendarEvents: CalendarEventEntry[];
  };
}

function dedupeCalendarEventsByTitle(events: CalendarEventEntry[]): CalendarEventEntry[] {
  const seenTitles = new Set<string>();

  return events.filter((event) => {
    const rawTitle = event.title ?? "";
    const cleanedTitle = cleanCalendarEventTitle(rawTitle).trim().toLowerCase();
    const dedupeKey = cleanedTitle.length > 0 ? cleanedTitle : rawTitle.trim().toLowerCase();

    if (seenTitles.has(dedupeKey)) {
      return false;
    }

    seenTitles.add(dedupeKey);
    return true;
  });
}

function CalendarEventItem({ title, location }: Pick<CalendarEventEntry, "title" | "location">) {
  return (
    <View className={"gap-2 bg-card/80 border border-border/20 rounded-lg p-2 mb-1"}>
      <View className={"flex-row items-center gap-2"}>
        <ThemedText variant={"title4"} className={"font-semibold text-blue-600"}>
          {cleanCalendarEventTitle(title)}
        </ThemedText>
      </View>

      {location && !location.includes("http") && (
        <View className={"flex-row items-center gap-2 pr-2"}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"pr-2"}>
            {location}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

export function CalendarEventCard({ visit }: CalendarEventCardProps) {
  const dedupedCalendarEvents = useMemo(() => {
    const { id: visitId, status, calendarEvents, calendarEventTitle, calendarEventId, calendarEventLocation } = visit;
    const fallbackEvent =
      calendarEventTitle && calendarEventTitle.trim().length > 0
        ? {
            id: calendarEventId ?? `visit-${visitId}-calendar`,
            title: calendarEventTitle,
            location: calendarEventLocation ?? null,
          }
        : null;

    const shouldShowAllCalendarEvents = status !== "confirmed";
    const calendarEventsToDisplay = shouldShowAllCalendarEvents
      ? calendarEvents.length > 0
        ? calendarEvents
        : fallbackEvent
          ? [fallbackEvent]
          : []
      : fallbackEvent
        ? [fallbackEvent]
        : [];

    return dedupeCalendarEventsByTitle(calendarEventsToDisplay);
  }, [visit]);

  if (dedupedCalendarEvents.length === 0) {
    return null;
  }

  return (
    <Card>
      <View className={"px-4 pt-4 flex-row items-center gap-1"}>
        <View className={"w-7 h-7 rounded-full bg-blue-500/20 items-center justify-center"}>
          <IconSymbol name={"calendar"} size={14} color={"#3b82f6"} />
        </View>
        <ThemedText variant={"footnote"} color={"secondary"} className={"uppercase tracking-wide"}>
          {"Calendar Events at This Time"}
        </ThemedText>
      </View>
      <ScrollView
        className={"flex gap-2 pt-4 max-h-[120px] overflow-y-auto px-4 pb-4"}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        {dedupedCalendarEvents.map((event) => (
          <CalendarEventItem key={event.id} title={event.title} location={event.location} />
        ))}
      </ScrollView>
    </Card>
  );
}
