import * as Calendar from "expo-calendar/legacy";
import { getSelectedCalendarIds } from "@/store";
import {
  batchCreateExportEvents as batchCreateExportEventsNatively,
  batchDeleteEvents as batchDeleteEventsNatively,
  executeCalendarCreateMutations,
  executeCalendarDeleteMutations,
  getEvents as getNativeCalendarEvents,
  getCalendarRevision,
  isCalendarBatchCreateAvailable,
  isCalendarBatchDeleteAvailable,
  isCalendarMatchingAvailable,
  matchVisits as matchNativeCalendarVisits,
  type CalendarVisit as NativeCalendarVisit,
  type CalendarVisitMatch as NativeCalendarVisitMatch,
} from "@/modules/calendar-matching";
import type { VisitForCalendarExport } from "@/utils/db/types";

export type { VisitForCalendarExport } from "@/utils/db/types";

/** Syncable calendar info for selection UI */
export interface SyncableCalendar {
  id: string;
  title: string;
  color: string;
  source: string;
  accountName: string | null;
}

export interface CalendarEventInfo {
  id: string;
  title: string;
  notes: string | null;
  location: string | null;
  startDate: number;
  endDate: number;
  isAllDay: boolean;
  calendarTitle: string | null;
}

/** Request calendar permissions */
export async function requestCalendarPermission(): Promise<boolean> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  return status === "granted";
}

/** Check if calendar permission is granted */
export async function hasCalendarPermission(): Promise<boolean> {
  const { status } = await Calendar.getCalendarPermissionsAsync();
  const granted = status === "granted";
  if (lastObservedCalendarPermission !== undefined && lastObservedCalendarPermission !== granted) {
    calendarPermissionRevision++;
  }
  lastObservedCalendarPermission = granted;
  return granted;
}

let lastObservedCalendarPermission: boolean | undefined;
let calendarPermissionRevision = 0;

/** Retain one selection across awaited SQLite, native, and fallback matching work. */
export function getCalendarMatchingSelection(): readonly string[] | null {
  const selectedIds = getSelectedCalendarIds();
  return selectedIds === null ? null : [...new Set(selectedIds)].sort();
}

/** Selected calendars and the observed EventKit revision define a matching snapshot. */
export async function getCalendarEnrichmentContext(
  selectedIds: readonly string[] | null = getCalendarMatchingSelection(),
): Promise<string | null> {
  try {
    const revision = await getCalendarRevision();
    if (revision === null || !(await hasCalendarPermission())) {
      return null;
    }
    return JSON.stringify([
      revision,
      calendarPermissionRevision,
      selectedIds === null ? null : [...new Set(selectedIds)].sort(),
    ]);
  } catch (error) {
    console.warn("Calendar revision unavailable; matching without cached attempts:", error);
    return null;
  }
}

/** Get all syncable calendars for the selection UI (excluding system calendars) */
export async function getAllSyncableCalendars(): Promise<SyncableCalendar[]> {
  if (!(await hasCalendarPermission())) {
    return [];
  }

  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const systemTypes = new Set(["birthdays", "holidays"]);

    return calendars
      .filter((cal) => !systemTypes.has(cal.source?.type ?? ""))
      .map((cal) => ({
        id: cal.id,
        title: cal.title,
        color: cal.color ?? "#3b82f6",
        source: cal.source?.name ?? "Unknown",
        accountName: cal.source?.type ?? null,
      }));
  } catch (error) {
    console.warn("Failed to get syncable calendars:", error);
    return [];
  }
}

/** Get all accessible calendars (excluding system calendars), filtered by user selection */
async function getCalendars(
  throwOnError = false,
  selectedIds: readonly string[] | null = getCalendarMatchingSelection(),
): Promise<Calendar.Calendar[]> {
  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const systemTypes = new Set(["birthdays", "holidays"]);
    const nonSystemCalendars = calendars.filter((cal) => !systemTypes.has(cal.source?.type ?? ""));

    // Filter by selected calendars if the user has made a selection
    if (selectedIds !== null) {
      const selectedSet = new Set(selectedIds);
      return nonSystemCalendars.filter((cal) => selectedSet.has(cal.id));
    }

    return nonSystemCalendars;
  } catch (error) {
    console.warn("Failed to get calendars:", error);
    if (throwOnError) {
      throw error;
    }
    return [];
  }
}

/** Fetch calendar events within a time range */
async function getEventsInRange(
  startDate: number,
  endDate: number,
  throwOnError = false,
  selectedCalendarIds: readonly string[] | null = getCalendarMatchingSelection(),
): Promise<CalendarEventInfo[]> {
  if (!(await hasCalendarPermission())) {
    if (throwOnError) {
      throw new Error("Calendar access changed during matching");
    }
    return [];
  }

  if (isCalendarMatchingAvailable()) {
    try {
      return await getNativeCalendarEvents(startDate, endDate, selectedCalendarIds);
    } catch (error) {
      console.warn("Native calendar event fetch failed; falling back to expo-calendar:", error);
    }
  }

  const calendars = await getCalendars(throwOnError, selectedCalendarIds);
  if (calendars.length === 0) {
    return [];
  }

  const calendarMap = new Map(calendars.map((c) => [c.id, c.title]));

  try {
    const events = await Calendar.getEventsAsync(
      calendars.map((c) => c.id),
      new Date(startDate),
      new Date(endDate),
    );

    return events
      .filter(
        (event) =>
          !event.allDay &&
          !event.recurrenceRule &&
          hasValidEventTitle(event.title) &&
          !isLikelyNonReservationTitle(event.title),
      )
      .map((event) => ({
        id: event.id,
        title: event.title!.trim(),
        notes: event.notes ?? null,
        location: event.location ?? null,
        startDate: new Date(event.startDate).getTime(),
        endDate: new Date(event.endDate).getTime(),
        isAllDay: event.allDay ?? false,
        calendarTitle: calendarMap.get(event.calendarId) ?? null,
      }));
  } catch (error) {
    console.warn("Failed to fetch calendar events:", error);
    if (throwOnError) {
      throw error;
    }
    return [];
  }
}

/**
 * Match visits to EventKit events in one native batch.
 * Returns `null` when this binary has no native implementation or it fails, so callers can use the JS fallback.
 */
export async function matchCalendarEventsForVisitsNatively(
  visits: NativeCalendarVisit[],
  bufferMinutes: number = 30,
  selectedCalendarIds: readonly string[] | null = getCalendarMatchingSelection(),
): Promise<NativeCalendarVisitMatch[] | null> {
  if (!isCalendarMatchingAvailable()) {
    return null;
  }

  try {
    return await matchNativeCalendarVisits(visits, selectedCalendarIds, bufferMinutes);
  } catch (error) {
    console.warn("Native calendar matching failed; falling back to JavaScript:", error);
    return null;
  }
}

/** Whether the current platform and binary can run the all-native matching path. */
export function isNativeCalendarMatchingAvailable(): boolean {
  return isCalendarMatchingAvailable();
}

const NON_RESTAURANT_TITLE_PATTERNS: RegExp[] = [
  // Travel/transport emojis
  /[✈️✈︎🛫🛬🛩️🚆🚄🚅🚇🚈🚉🚌🚍🚎🚗🚕🚖🚘🚙🛻🚲🚴🚤⛴️🚢🚋🚝🚞🚊🛳️]/u,
  // Lodging/travel keywords
  /\b(airbnb|check[-\s]?in|check[-\s]?out)\b/i,
];

function isLikelyNonReservationTitle(title: string): boolean {
  return NON_RESTAURANT_TITLE_PATTERNS.some((p) => p.test(title));
}

function hasValidEventTitle(title: string | null | undefined): title is string {
  if (!title) {
    return false;
  }
  const trimmed = title.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  return normalized !== "untitled event" && normalized !== "custom";
}

/** Check if two time ranges overlap (with optional buffer) */
function isTimeOverlapping(
  visitStart: number,
  visitEnd: number,
  eventStart: number,
  eventEnd: number,
  bufferMs: number,
): boolean {
  return visitStart < eventEnd + bufferMs && visitEnd > eventStart - bufferMs;
}

/** Binary search: first index where event.startDate >= target */
function lowerBoundByStartDate(events: CalendarEventInfo[], target: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.startDate < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Binary search: first index where event.startDate > target */
function upperBoundByStartDate(events: CalendarEventInfo[], target: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.startDate <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Get start of day (midnight) for a timestamp */
function getStartOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Get end of day (23:59:59.999) for a timestamp */
function getEndOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

interface VisitTimeRange {
  id: string;
  startTime: number;
  endTime: number;
}

/**
 * Batch find overlapping calendar event candidates for multiple visits efficiently.
 * Returns candidates sorted by relevance (best first) for each visit.
 */
export async function batchFindCandidateEventsForVisits(
  visits: VisitTimeRange[],
  bufferMinutes: number = 30,
  throwOnError = false,
  selectedCalendarIds: readonly string[] | null = getCalendarMatchingSelection(),
): Promise<Map<string, CalendarEventInfo[]>> {
  if (visits.length === 0) {
    return new Map();
  }
  if (!(await hasCalendarPermission())) {
    if (throwOnError) {
      throw new Error("Calendar access changed during matching");
    }
    return new Map(visits.map((v) => [v.id, []]));
  }

  // Find overall date range (single calendar query for the batch)
  const times = visits.flatMap((v) => [v.startTime, v.endTime]);
  const bufferMs = bufferMinutes * 60 * 1000;
  const searchStart = getStartOfDay(Math.min(...times)) - bufferMs;
  const searchEnd = getEndOfDay(Math.max(...times)) + bufferMs;

  const allEvents = await getEventsInRange(searchStart, searchEnd, throwOnError, selectedCalendarIds);
  const timedEvents = allEvents
    .filter((e) => !e.isAllDay)
    .sort((a, b) => (a.startDate - b.startDate !== 0 ? a.startDate - b.startDate : a.endDate - b.endDate));

  // Compute max duration so we can bound "overlap" searches safely.
  // Any event starting before (windowStart - maxDurationMs) cannot overlap the visit window.
  let maxDurationMs = 0;
  for (const e of timedEvents) {
    const d = Math.max(0, e.endDate - e.startDate);
    if (d > maxDurationMs) {
      maxDurationMs = d;
    }
  }

  const results = new Map<string, CalendarEventInfo[]>();

  for (const visit of visits) {
    const windowStart = visit.startTime - bufferMs;
    const windowEnd = visit.endTime + bufferMs;

    // Binary-search the only slice of events that could possibly overlap.
    const startIdx = lowerBoundByStartDate(timedEvents, windowStart - maxDurationMs);
    const endExclusiveIdx = upperBoundByStartDate(timedEvents, windowEnd);

    const candidates: Array<{ event: CalendarEventInfo; score: number }> = [];

    for (let i = startIdx; i < endExclusiveIdx; i++) {
      const event = timedEvents[i]!;
      if (!isTimeOverlapping(visit.startTime, visit.endTime, event.startDate, event.endDate, bufferMs)) {
        continue;
      }

      candidates.push({
        event,
        score: scoreEvent(event, visit.startTime, visit.endTime),
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.event.startDate !== b.event.startDate) {
        return a.event.startDate - b.event.startDate;
      }
      return a.event.endDate - b.event.endDate;
    });

    results.set(
      visit.id,
      candidates.map((c) => c.event),
    );
  }

  return results;
}

/**
 * Get all calendar events that overlap a visit time range.
 */
export async function getEventsOverlappingRange(
  startTime: number,
  endTime: number,
  bufferMinutes: number = 30,
): Promise<CalendarEventInfo[]> {
  const bufferMs = bufferMinutes * 60 * 1000;
  const events = await getEventsInRange(startTime - bufferMs, endTime + bufferMs);
  return events.filter((event) => isTimeOverlapping(startTime, endTime, event.startDate, event.endDate, bufferMs));
}

/** Check if a string looks like a URL */
function looksLikeUrl(str: string): boolean {
  if (!str) {
    return false;
  }
  const s = str.toLowerCase().trim();
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("www.") ||
    /^[a-z0-9-]+\.(com|org|net|io|co|app|ly|me|us|uk|ca|de|fr|it|es|au|jp|cn)\b/.test(s)
  );
}

/** Patterns that indicate a reservation or restaurant-related event */
const RESERVATION_PATTERNS = [
  /reserv(ation|e|ed)/i,
  /resy/i,
  /opentable/i,
  /yelp/i,
  /tock/i,
  /seated/i,
  /bookatable/i,
  /quandoo/i,
  /the\s*fork/i,
  /dinner/i,
  /lunch/i,
  /brunch/i,
  /breakfast/i,
  /restaurant/i,
  /bistro/i,
  /cafe/i,
  /table\s+(at|for)/i,
  /party\s+of\s+\d+/i,
  /\d+\s*(people|guests|pax)/i,
];

/** Check if an event title or location suggests a restaurant reservation */
function looksLikeReservation(event: CalendarEventInfo): boolean {
  const text = `${event.title} ${event.location ?? ""} ${event.notes ?? ""}`;
  return RESERVATION_PATTERNS.some((p) => p.test(text));
}

/** Score an event for relevance to a visit (higher = better) */
function scoreEvent(event: CalendarEventInfo, visitStart: number, visitEnd: number): number {
  let score = 0;

  // Timed events strongly preferred
  if (!event.isAllDay) {
    score += 100;
  }

  // Reservation keywords highest priority
  if (looksLikeReservation(event)) {
    score += 200;
  }

  // Location scoring: prefer real addresses, penalize URLs
  if (event.location) {
    score += looksLikeUrl(event.location) ? -100 : 50;
  }

  if (event.notes) {
    score += 10;
  }

  // Time proximity for timed events (up to +20 for close events)
  if (!event.isAllDay) {
    const timeDiff = Math.abs((visitStart + visitEnd) / 2 - (event.startDate + event.endDate) / 2);
    const twoHours = 2 * 60 * 60 * 1000;
    if (timeDiff < twoHours) {
      score += Math.round(20 * (1 - timeDiff / twoHours));
    }
  }

  // Prefer shorter events (more specific)
  const duration = event.endDate - event.startDate;
  if (duration < 4 * 60 * 60 * 1000) {
    score += 15;
  } else if (duration < 8 * 60 * 60 * 1000) {
    score += 5;
  }

  return score;
}

/** Get eligible timed calendar events for later restaurant-name matching. */
export async function getReservationEvents(startDate: number, endDate: number): Promise<CalendarEventInfo[]> {
  const events = await getEventsInRange(startDate, endDate);

  // Exact restaurant names often contain no reservation keyword, so title matching happens downstream.
  return events.filter((event) => hasValidEventTitle(event.title) && !isLikelyNonReservationTitle(event.title));
}

// ============================================================================
// CALENDAR EVENT CREATION
// ============================================================================

export interface WritableCalendar {
  id: string;
  title: string;
  color: string;
  source: string;
  isPrimary: boolean;
}

/** Get all writable calendars the user can add events to */
export async function getWritableCalendars(): Promise<WritableCalendar[]> {
  if (!(await hasCalendarPermission())) {
    return [];
  }

  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);

    // Filter to only writable calendars and exclude system calendars
    const systemTypes = new Set(["birthdays", "holidays"]);
    const writableCalendars = calendars.filter(
      (cal) =>
        cal.allowsModifications !== false &&
        !systemTypes.has(cal.source?.type ?? "") &&
        cal.accessLevel !== "none" &&
        cal.accessLevel !== "read",
    );

    return writableCalendars.map((cal) => ({
      id: cal.id,
      title: cal.title,
      color: cal.color ?? "#3b82f6",
      source: cal.source?.name ?? "Unknown",
      isPrimary: cal.isPrimary ?? false,
    }));
  } catch (error) {
    console.warn("Failed to get writable calendars:", error);
    return [];
  }
}

export interface CreatedCalendarEventResult {
  inputIndex: number;
  visitId: string;
  eventId: string;
}

/** Batch create calendar events for multiple visits */
export async function batchCreateCalendarEvents(
  visits: readonly VisitForCalendarExport[],
  calendarId: string,
): Promise<{ created: number; failed: number; createdEvents: CreatedCalendarEventResult[] }> {
  const execution = await executeCalendarCreateMutations(visits, calendarId, {
    invokeNative: isCalendarBatchCreateAvailable()
      ? (nativeCalendarId, timeZone, requests) => batchCreateExportEventsNatively(nativeCalendarId, timeZone, requests)
      : undefined,
    hasCalendarPermission,
    getTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    createWithExpo: (expoCalendarId, timeZone, request) =>
      Calendar.createEventAsync(expoCalendarId, {
        title: request.title,
        startDate: new Date(request.startMs),
        endDate: new Date(request.endMs),
        location: request.location ?? undefined,
        notes: request.notes,
        timeZone,
      }),
    onExpoError: (error) => console.warn("Failed to create calendar event:", error),
  });

  return {
    created: execution.createdItems.length,
    failed: execution.failedInputIndices.length,
    createdEvents: execution.createdItems,
  };
}

/** Batch delete calendar events and return results */
export async function batchDeleteCalendarEvents(
  eventIds: readonly string[],
): Promise<{ deleted: number; failed: number; successfulInputIndices: number[] }> {
  const execution = await executeCalendarDeleteMutations(eventIds, {
    invokeNative: isCalendarBatchDeleteAvailable() ? (requests) => batchDeleteEventsNatively(requests) : undefined,
    hasCalendarPermission,
    deleteWithExpo: (request) => Calendar.deleteEventAsync(request.eventId),
    onExpoError: (error) => console.warn("Failed to delete calendar event:", error),
  });

  return {
    deleted: execution.successfulInputIndices.length,
    failed: execution.failedInputIndices.length,
    successfulInputIndices: execution.successfulInputIndices,
  };
}
