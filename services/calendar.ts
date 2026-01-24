import * as Calendar from "expo-calendar";
import { deburr } from "lodash-es";
import { memoize } from "../utils/memoize";
import { getSelectedCalendarIds } from "@/store";

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
  return status === "granted";
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
async function getCalendars(): Promise<Calendar.Calendar[]> {
  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const systemTypes = new Set(["birthdays", "holidays"]);
    const nonSystemCalendars = calendars.filter((cal) => !systemTypes.has(cal.source?.type ?? ""));

    // Filter by selected calendars if the user has made a selection
    const selectedIds = getSelectedCalendarIds();
    if (selectedIds !== null && selectedIds.length > 0) {
      const selectedSet = new Set(selectedIds);
      return nonSystemCalendars.filter((cal) => selectedSet.has(cal.id));
    }

    return nonSystemCalendars;
  } catch (error) {
    console.warn("Failed to get calendars:", error);
    return [];
  }
}

/** Fetch calendar events within a time range */
async function getEventsInRange(startDate: number, endDate: number): Promise<CalendarEventInfo[]> {
  if (!(await hasCalendarPermission())) {
    return [];
  }

  const calendars = await getCalendars();
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
    return [];
  }
}

const NON_RESTAURANT_TITLE_PATTERNS: RegExp[] = [
  // Travel/transport emojis
  /[✈️✈︎🛫🛬🛩️🚆🚄🚅🚇🚈🚉🚌🚍🚎🚗🚕🚖🚘🚙🛻🚲🚴🚤⛴️🚢🚋🚝🚞🚊🛳️✈]/u,
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

/**
 * Batch find calendar events for multiple visits efficiently.
 * Groups visits by date to minimize calendar queries.
 */
export async function batchFindEventsForVisits(
  visits: Array<{ id: string; startTime: number; endTime: number }>,
  bufferMinutes: number = 30,
): Promise<Map<string, CalendarEventInfo | null>> {
  if (visits.length === 0) {
    return new Map();
  }
  if (!(await hasCalendarPermission())) {
    return new Map(visits.map((v) => [v.id, null]));
  }

  // Find overall date range (single calendar query for the batch)
  const times = visits.flatMap((v) => [v.startTime, v.endTime]);
  const bufferMs = bufferMinutes * 60 * 1000;
  const searchStart = getStartOfDay(Math.min(...times)) - bufferMs;
  const searchEnd = getEndOfDay(Math.max(...times)) + bufferMs;

  const allEvents = await getEventsInRange(searchStart, searchEnd);
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

  const results = new Map<string, CalendarEventInfo | null>();

  for (const visit of visits) {
    const windowStart = visit.startTime - bufferMs;
    const windowEnd = visit.endTime + bufferMs;

    // Binary-search the only slice of events that could possibly overlap.
    const startIdx = lowerBoundByStartDate(timedEvents, windowStart - maxDurationMs);
    const endExclusiveIdx = upperBoundByStartDate(timedEvents, windowEnd);

    let bestEvent: CalendarEventInfo | null = null;
    let bestScore = -Infinity;

    for (let i = startIdx; i < endExclusiveIdx; i++) {
      const event = timedEvents[i]!;
      if (!isTimeOverlapping(visit.startTime, visit.endTime, event.startDate, event.endDate, bufferMs)) {
        continue;
      }

      const s = scoreEvent(event, visit.startTime, visit.endTime);
      if (s > bestScore) {
        bestScore = s;
        bestEvent = event;
      }
    }

    results.set(visit.id, bestEvent);
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

/**
 * Common prefixes and patterns to strip from calendar event titles
 * to extract the restaurant name.
 */
const CALENDAR_TITLE_PREFIXES_TO_STRIP = [
  // Reservation services
  /^resevervation\s+(at|for|@)\s+/i,
  /^reservation\s+(at|for|@)\s+/i,
  /^booking\s+appointment\s+(at|for|@)\s+/i,
  /^resy\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^opentable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^yelp\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^seated\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^bookatable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^quandoo\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^the\s+fork\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^exploretock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^sevenrooms\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tripleseat\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tablein\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^eat\s*app\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*/i,
  // Common meal prefixes
  /^(dinner|lunch|brunch|breakfast|supper|tea|coffee|happy\s*hour|drinks|appetizers)\s+(at|@)\s+/i,
  /^(dinner|lunch|brunch|breakfast|supper)\s+reservation\s+(at|for|@)?\s*/i,
  // Special occasion prefixes
  /^(date\s*night|anniversary|birthday|celebration|celebrate|party)\s+(at|@)\s+/i,
  /^(date\s*night|anniversary|birthday|celebration)\s+dinner\s+(at|@)?\s*/i,
  // Time prefix patterns: "830pm at", "8:30 pm at", "8pm at <name>"
  /^\d{1,2}:?\d{0,2}\s*(am|pm)?\s+(at|@)\s+/i,
  // Simple "at" prefix
  /^(eating\s+)?at\s+/i,
  /^(going\s+to|meet\s+at|meeting\s+at|dining\s+at)\s+/i,
  /^meal\s+(at|@)\s+/i,
  /^table\s+(at|for|@)\s+/i,
  /^booking\s+(at|for|@)\s+/i,
  /^your\s+(reservation|table|booking)\s+(at|for|@)\s+/i,
  /^ticket:\s+/i,
  /^reservation\s*:\s+/i,
  /^confirmation\s*:\s+/i,
  /^confirmed\s*:\s+/i,
  /^booking\s*:\s+/i,
  /^reminder\s*:\s+/i,
  /^don'?t\s+forget\s*:\s+/i,
  /^event\s+(at|@)\s+/i,
  /^upcoming reservation (at|for|@)\s+/i,
  /^reservation\s+(at|for|@)\s+/i,
  /^dinner\s*\|/i,
  /^cena\s*\|/i,
  // Foreign language meal prefixes
  /^(pranzo|almuerzo|déjeuner|mittagessen|almoço)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(cena|comida|dîner|abendessen|jantar)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(colazione|desayuno|petit\s*déjeuner|frühstück|café\s*da\s*manhã)\s+(at|@|a|à|en|bei|em)?\s*/i,
  // Emoji prefixes (common in calendar apps)
  /^[🍴🍕🍔🍣🍜🥘🍝🍲🥗🍛🍱🥡🍷🍺🍸🥂🍾☕🍵🍽]\s*/u,
];

const CALENDAR_TITLE_SUFFIXES_TO_STRIP = [
  // Reservation details
  /\s*[-–—]\s*\d+\s*(people|guests|pax|persons?)$/i,
  /\s*[-–—]\s*table\s+for\s+\d+$/i,
  /\s*[-–—]\s*party\s+of\s+\d+$/i,
  /\s*\(\d+\s*(people|guests|pax|persons?)\)$/i,
  /\s*\(party\s+of\s+\d+\)$/i,
  /\s*\(table\s+for\s+\d+\)$/i,
  /\s*\(for\s+\d+\)$/i,
  /\s*for\s+\d+$/i,
  /\s*(dinner|lunch|brunch|cena|breakfast|supper)\s*$/i,
  // Status suffixes
  /\s*[-–—]\s*(confirmed|pending|waitlist|wait\s*list)$/i,
  /\s*\((confirmed|pending|waitlist|wait\s*list)\)$/i,
  // Time suffixes
  /\s*[-–—]\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /\s*@\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  // Full date with year and time: "on Wednesday, November 29, 2023, 8:45 PM"
  /\s*on\s+\w+\s*,\s*\w+\s+\d{1,2}(st|nd|rd|th)?\s*,\s*\d{4}\s*,?\s*\d{1,2}:\d{2}\s*(AM|PM)?$/i,
  // Date patterns: "12/25", "Dec 25", "December 25th"
  /\s*[-–—]\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?$/i,
  /\s*[-–—]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?$/i,
  /\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?\)$/i,
  // Confirmation numbers
  /\s*[-–—]\s*(conf|confirmation)\s*#?\s*[\w\d]+$/i,
  /\s*\(confirmation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(reservation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(booking\s*:?\s*[\w\d]+\)$/i,
  /\s*#\s*[\w\d]{4,}$/i, // Generic confirmation number
  // Guest/companion patterns
  /\s*[-–—]\s*w\/?\s+\w+.*$/i, // "- w/ John", "- with friends"
  /\s*[-–—]\s*with\s+\w+.*$/i,
  /\s*\(w\/?\s+\w+.*\)$/i,
  /\s*\(with\s+\w+.*\)$/i,
  // Via platform suffixes
  /\s*[-–—]\s*via\s+(resy|opentable|tock|yelp|thefork)$/i,
  /\s*\(via\s+(resy|opentable|tock|yelp|thefork)\)$/i,
  /\s*\((resy|opentable|tock|yelp|thefork)\)$/i,
  // Location/branch suffixes
  /\s*[-–—]\s*(downtown|midtown|uptown|westside|eastside)$/i,
  /\s*[-–—]\s*(main|flagship|original)\s*(location|branch)?$/i,
  // "reservation" or "booking" at the end
  /\s+reservation$/i,
  /\s+booking$/i,
];

/** Clean and normalize a calendar event title to extract the likely restaurant name */
function _cleanCalendarEventTitle(title: string): string {
  if (!title) {
    return "";
  }
  let cleaned = title
    .trim()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s+/g, " ");
  let prev: string;
  do {
    prev = cleaned;
    for (const p of CALENDAR_TITLE_PREFIXES_TO_STRIP) {
      cleaned = cleaned.replace(p, "");
    }
    for (const p of CALENDAR_TITLE_SUFFIXES_TO_STRIP) {
      cleaned = cleaned.replace(p, "");
    }
    cleaned = cleaned.trim();
  } while (cleaned !== prev);
  return cleaned;
}
export const cleanCalendarEventTitle = memoize(_cleanCalendarEventTitle);

const COMPARISON_SUFFIXES_TO_STRIP = [
  /\s+bar\s+(and|&)\s+restaurant\s*$/i,
  /\s+restaurant\s*$/i,
  /\s+steak ?house\s*$/i,
  /\s+gourmet\s*$/i,
  /\s+cafe\s*$/i,
  /\s+café\s*$/i,
  /\s+bar\s*$/i,
  /\s+bistro\s*$/i,
  /\s+kitchen\s*$/i,
  /\s+grill\s*$/i,
  /\s+company\s*$/i,
  /\s+brewing\s*$/i,
  /\s+house\s*$/i,
  /\s+japanese\s*$/i,
  /\s+farm\s*$/i,
  /\s+inn\s*$/i,
  /\s+room\s*$/i,
  /\s+place\s*$/i,
  /\s+experience\s*$/i,
  /\s+eatery\s*$/i,
  /\s+dining\s*$/i,
  /\s+tavern\s*$/i,
  /\s+pub\s*$/i,
  /\s+pizzeria\s*$/i,
  /\s+trattoria\s*$/i,
  /\s+osteria\s*$/i,
  /\s+ristorante\s*$/i,
  /\s+brasserie\s*$/i,
  /\s+steakhouse\s*$/i,
  /\s+chophouse\s*$/i,
  /\s+seafood\s*$/i,
  /\s+sushi\s*$/i,
  /\s+ramen\s*$/i,
  /\s+izakaya\s*$/i,
  /\s+taqueria\s*$/i,
  /\s+cantina\s*$/i,
  /\s+bodega\s*$/i,
  /\s+diner\s*$/i,
  /\s+lounge\s*$/i,
  /\s+wine\s*bar\s*$/i,
  /\s+cocktail\s*bar\s*$/i,
  /\s+gastropub\s*$/i,
  /\s+bakery\s*$/i,
  /\s+patisserie\s*$/i,
  /\s+delicatessen\s*$/i,
  /\s+deli\s*$/i,
  /\s+creamery\s*$/i,
  /\s+rooftop\s*$/i,
  /\s+terrace\s*$/i,
  /\s+garden\s*$/i,
  /\s+spot\s*$/i,
  /\s+joint\s*$/i,
  /\s+shack\s*$/i,
  /\s+club\s*$/i,
  // City abbreviations at the end
  /\s+(nyc|la|sf|london|dc|atl|chi|bos|sea|pdx|phx|den|mia|dal|hou|austin)\s*$/i,
  /^the\s+/i,
];

const COMPARISON_PREFIXES_TO_STRIP = [
  /^reservation\s+(at|for|@)\s+/i,
  /^upcoming reservation (at|for|@)\s+/i,
  /^reservation\s*:\s+/i,
  /^the\s+(dining room|dining hall|experience|kitchen table|table)?\s*(at)?\s*:?\s*/i,
  /^restaurant\s*:?\s*/i,
  /^bar\s*:?\s*/i,
  /^confirmation\s*:?\s+/i,
  /^booking\s*:?\s+/i,
  /^confirmed\s*:?\s+/i,
  /^dinner\s*(at|@)?\s+/i,
  /^lunch\s*(at|@)?\s+/i,
  /^brunch\s*(at|@)\s+/i,
  /^breakfast\s*(at|@)?\s+/i,
  /^supper\s+(at|@)\s+/i,
  /^meal\s+(at|@)\s+/i,
  /^table\s*(at|for|@)?\s+/i,
  /^eating\s+(at|@)\s+/i,
  /^dining\s+(at|@)\s+/i,
  /^visit\s+to\s+/i,
  /^going\s+to\s+/i,
  /^meet(ing)?\s+(at|@)\s+/i,
  /^date\s+(at|@)\s+/i,
  /^date\s+night\s+(at|@)\s+/i,
  /^anniversary\s+(at|@)\s+/i,
  /^birthday\s+(at|@)\s+/i,
  /^celebration\s+(at|@)\s+/i,
  /^the\s+/i,
  // Platform prefixes
  /^resy\s*[-:@]?\s*/i,
  /^opentable\s*[-:@]?\s*/i,
  /^tock\s*[-:@]?\s*/i,
  /^yelp\s*[-:@]?\s*/i,
  /^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*/i,
];

/** Strip comparison-specific prefixes and suffixes from a name */
function _stripComparisonAffixes(str: string): string {
  let result = str
    .trim()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s+/g, " ");
  let prev: string;
  do {
    prev = result;
    for (const p of COMPARISON_PREFIXES_TO_STRIP) {
      result = result.replace(p, "");
    }
    for (const p of COMPARISON_SUFFIXES_TO_STRIP) {
      result = result.replace(p, "");
    }
    result = result.trim();
  } while (result !== prev);
  return result;
}
export const stripComparisonAffixes = memoize(_stripComparisonAffixes);
/** Compare a restaurant name with a calendar event title to determine if they match */
function _compareRestaurantAndCalendarTitle(calendarTitle: string, restaurantName: string): boolean {
  if (!calendarTitle || !restaurantName) {
    return false;
  }

  const normCalendar = normalizeForComparison(stripComparisonAffixes(cleanCalendarEventTitle(calendarTitle)));
  const normRestaurant = normalizeForComparison(stripComparisonAffixes(restaurantName));

  if (normCalendar.length < 3 || normRestaurant.length < 3) {
    return false;
  }

  return normCalendar === normRestaurant;
}
export const compareRestaurantAndCalendarTitle = memoize(_compareRestaurantAndCalendarTitle);
/** Normalize a string for fuzzy comparison */
function _normalizeForComparison(str: string): string {
  return (
    deburr(str)
      .toLowerCase()
      // Strip all emojis
      .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
      // Normalize various apostrophe/quote styles
      .replace(/[''’`´ʼʻ]/g, "'")
      // Normalize dashes to spaces
      .replace(/[–—−‐‑‒―]/g, " ")
      // Normalize ampersand to "and"
      .replace(/\s*&\s*/g, " and ")
      // Remove possessive 's (so "Joe's" matches "Joes")
      .replace(/'s\b/g, "s")
      // Remove remaining apostrophes (so "rock'n'roll" → "rocknroll")
      .replace(/'/g, "")
      // Replace non-alphanumeric with space
      .replace(/[^\w\s]/g, " ")
      // Collapse multiple spaces
      .replace(/\s+/g, " ")
      .trim()
  );
}
export const normalizeForComparison = memoize(_normalizeForComparison);

const INSIGNIFICANT_WORDS = new Set([
  "the",
  "restaurant",
  "cafe",
  "café",
  "bar",
  "bistro",
  "kitchen",
  "grill",
  "house",
  "room",
  "place",
  "a",
  "an",
  "and",
  "&",
  "eatery",
  "dining",
  "tavern",
  "pub",
  "inn",
  "lounge",
  "spot",
  "joint",
  "diner",
  "at",
  "of",
  "in",
  "on",
  "for",
]);

/** Check if two strings are a fuzzy match for restaurant name comparison */
function _isFuzzyRestaurantMatch(a: string, b: string, threshold: number = 3): boolean {
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);

  if (normA.length < threshold || normB.length < threshold) {
    return false;
  }

  // Exact match or substring match
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return true;
  }

  // Extract significant words
  const getSignificantWords = (s: string) => s.split(" ").filter((w) => w.length > 1 && !INSIGNIFICANT_WORDS.has(w));

  const wordsA = getSignificantWords(normA);
  const wordsB = getSignificantWords(normB);

  // If one has few significant words, check if all are in the other
  if (wordsA.length > 0 && wordsA.length <= 2 && wordsA.every((w) => normB.includes(w))) {
    return true;
  }
  if (wordsB.length > 0 && wordsB.length <= 2 && wordsB.every((w) => normA.includes(w))) {
    return true;
  }

  return false;
}
export const isFuzzyRestaurantMatch = memoize(_isFuzzyRestaurantMatch);
/**
 * Get calendar events that look like restaurant reservations within a date range.
 * Filters to timed (non-all-day) events that match reservation patterns.
 */
export async function getReservationEvents(startDate: number, endDate: number): Promise<CalendarEventInfo[]> {
  const events = await getEventsInRange(startDate, endDate);

  // Filter to timed events that look like reservations
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

interface CreateCalendarEventParams {
  calendarId: string;
  title: string;
  startDate: Date;
  endDate: Date;
  location?: string | null;
  notes?: string | null;
}

// App identifier for calendar events we create - allows us to identify and delete them later
const PHOTO_FOODIE_EVENT_IDENTIFIER = "[Palate Export]";

/** Build notes field with app identifier for tracking */
function buildExportNotes(visitId: string, userNotes: string | null): string {
  const identifier = `${PHOTO_FOODIE_EVENT_IDENTIFIER} Visit ID: ${visitId}`;
  if (userNotes) {
    return `${userNotes}\n\n${identifier}`;
  }
  return identifier;
}

/** Create a calendar event and return its ID */
async function createCalendarEvent(params: CreateCalendarEventParams): Promise<string | null> {
  if (!(await hasCalendarPermission())) {
    return null;
  }

  try {
    const eventId = await Calendar.createEventAsync(params.calendarId, {
      title: params.title,
      startDate: params.startDate,
      endDate: params.endDate,
      location: params.location ?? undefined,
      notes: params.notes ?? undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    return eventId;
  } catch (error) {
    console.warn("Failed to create calendar event:", error);
    return null;
  }
}

export interface VisitForCalendarExport {
  id: string;
  restaurantName: string;
  startTime: number;
  endTime: number;
  address: string | null;
  notes: string | null;
}

/** Batch create calendar events for multiple visits */
export async function batchCreateCalendarEvents(
  visits: VisitForCalendarExport[],
  calendarId: string,
): Promise<{ created: number; failed: number; eventIds: Map<string, string> }> {
  const results = { created: 0, failed: 0, eventIds: new Map<string, string>() };

  for (const visit of visits) {
    const eventId = await createCalendarEvent({
      calendarId,
      title: `${visit.restaurantName}`,
      startDate: new Date(visit.startTime),
      endDate: new Date(visit.endTime),
      location: visit.address,
      notes: buildExportNotes(visit.id, visit.notes),
    });

    if (eventId) {
      results.created++;
      results.eventIds.set(visit.id, eventId);
    } else {
      results.failed++;
    }
  }

  return results;
}

/** Delete a calendar event by ID */
async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  if (!(await hasCalendarPermission())) {
    return false;
  }

  try {
    await Calendar.deleteEventAsync(eventId);
    return true;
  } catch (error) {
    console.warn("Failed to delete calendar event:", error);
    return false;
  }
}

/** Batch delete calendar events and return results */
export async function batchDeleteCalendarEvents(eventIds: string[]): Promise<{ deleted: number; failed: number }> {
  const results = { deleted: 0, failed: 0 };

  for (const eventId of eventIds) {
    const success = await deleteCalendarEvent(eventId);
    if (success) {
      results.deleted++;
    } else {
      results.failed++;
    }
  }

  return results;
}
