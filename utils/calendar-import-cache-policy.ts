export interface CalendarImportCacheItem {
  readonly calendarEventId: string;
}

export function getUniqueCalendarImportEventIds(events: readonly CalendarImportCacheItem[]): string[] {
  return [...new Set(events.map((event) => event.calendarEventId))];
}

/**
 * Keep current non-requested cache changes, remove only rows actually inserted,
 * and restore optimistic rows for zero or partial outcomes in their old order.
 */
export function reconcileCalendarImportCache<T extends CalendarImportCacheItem>(
  current: readonly T[] | undefined,
  previous: readonly T[] | undefined,
  requestedCalendarEventIds: readonly string[],
  insertedCalendarEventIds: readonly string[],
): T[] | undefined {
  if (!previous) {
    const insertedIds = new Set(insertedCalendarEventIds);
    return current?.filter((event) => !insertedIds.has(event.calendarEventId));
  }

  const requestedIds = new Set(requestedCalendarEventIds);
  const insertedIds = new Set(insertedCalendarEventIds);
  const currentById = new Map((current ?? []).map((event) => [event.calendarEventId, event]));
  const reconciled: T[] = [];
  const retainedIds = new Set<string>();

  for (const previousEvent of previous) {
    const eventId = previousEvent.calendarEventId;
    if (insertedIds.has(eventId)) {
      continue;
    }
    const event = requestedIds.has(eventId) ? previousEvent : currentById.get(eventId);
    if (event && !retainedIds.has(eventId)) {
      reconciled.push(event);
      retainedIds.add(eventId);
    }
  }

  for (const currentEvent of current ?? []) {
    if (!insertedIds.has(currentEvent.calendarEventId) && !retainedIds.has(currentEvent.calendarEventId)) {
      reconciled.push(currentEvent);
      retainedIds.add(currentEvent.calendarEventId);
    }
  }

  return reconciled;
}
