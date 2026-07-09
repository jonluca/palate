import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export interface CalendarEvent {
  id: string;
  title: string;
  notes: string | null;
  location: string | null;
  startDate: number;
  endDate: number;
  isAllDay: boolean;
  calendarTitle: string | null;
}

export interface CalendarSuggestedRestaurant {
  id: string;
  name: string;
}

export interface CalendarVisit {
  id: string;
  startTime: number;
  endTime: number;
  suggestedRestaurants: CalendarSuggestedRestaurant[];
}

export interface CalendarVisitMatch extends CalendarEvent {
  visitId: string;
  suggestedRestaurantId: string | null;
}

interface NativeCalendarMatchingModule {
  getEvents(startMs: number, endMs: number, selectedCalendarIds: string[] | null): Promise<CalendarEvent[]>;
  matchVisits(
    visits: CalendarVisit[],
    selectedCalendarIds: string[] | null,
    bufferMinutes: number,
  ): Promise<CalendarVisitMatch[]>;
}

const CalendarMatchingModule =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeCalendarMatchingModule>("CalendarMatching") : null;

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

function requireCalendarMatchingModule(): NativeCalendarMatchingModule {
  if (!CalendarMatchingModule) {
    throw new Error("CalendarMatching native module is unavailable on this platform or binary.");
  }
  return CalendarMatchingModule;
}

function assertValidTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_DATE_TIMESTAMP_MS) {
    throw new TypeError(`${name} must be a valid ECMAScript Date timestamp in milliseconds.`);
  }
}

function copySelectedCalendarIds(selectedCalendarIds: readonly string[] | null): string[] | null {
  return selectedCalendarIds === null ? null : [...selectedCalendarIds];
}

/** Whether this binary contains the Apple-native calendar matching module. */
export function isCalendarMatchingAvailable(): boolean {
  return CalendarMatchingModule !== null;
}

/**
 * Fetches minimal, eligible calendar events for a time range.
 * `null` searches all non-birthday calendars; an empty array searches none.
 */
export async function getEvents(
  startMs: number,
  endMs: number,
  selectedCalendarIds: readonly string[] | null = null,
): Promise<CalendarEvent[]> {
  assertValidTimestamp(startMs, "startMs");
  assertValidTimestamp(endMs, "endMs");
  if (endMs < startMs) {
    throw new RangeError("endMs must be greater than or equal to startMs.");
  }

  return requireCalendarMatchingModule().getEvents(startMs, endMs, copySelectedCalendarIds(selectedCalendarIds));
}

/**
 * Fetches EventKit events through one native call and matches them to all supplied visits natively.
 * Visits with no eligible overlap are omitted from the returned flat array.
 */
export async function matchVisits(
  visits: readonly CalendarVisit[],
  selectedCalendarIds: readonly string[] | null = null,
  bufferMinutes: number = 30,
): Promise<CalendarVisitMatch[]> {
  if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0) {
    throw new RangeError("bufferMinutes must be a finite non-negative number.");
  }

  const nativeVisits = visits.map((visit) => {
    assertValidTimestamp(visit.startTime, "visit.startTime");
    assertValidTimestamp(visit.endTime, "visit.endTime");
    if (visit.endTime < visit.startTime) {
      throw new RangeError(`Visit ${visit.id} has an endTime before its startTime.`);
    }
    return {
      ...visit,
      suggestedRestaurants: visit.suggestedRestaurants.map((restaurant) => ({ ...restaurant })),
    };
  });

  if (nativeVisits.length === 0) {
    return [];
  }

  return requireCalendarMatchingModule().matchVisits(
    nativeVisits,
    copySelectedCalendarIds(selectedCalendarIds),
    bufferMinutes,
  );
}
