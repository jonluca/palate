import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type {
  NativeCalendarDeleteEventMutationRequest,
  NativeCalendarExportEventMutationRequest,
  NativeCalendarMutationResult,
} from "../../../utils/calendar-batch-mutation-core";
import { assertValidCalendarTimestamp, validateCalendarVisitsForNativeMatching } from "./request-core";

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
  suggestedRestaurants: readonly CalendarSuggestedRestaurant[];
}

export interface CalendarVisitMatch extends CalendarEvent {
  visitId: string;
  suggestedRestaurantId: string | null;
}

interface NativeCalendarMatchingModule {
  getRevision?: () => Promise<string>;
  readonly calendarQueryStrategy?: string;
  readonly calendarQueryGapDays?: number;
  getEvents(startMs: number, endMs: number, selectedCalendarIds: readonly string[] | null): Promise<CalendarEvent[]>;
  matchVisits(
    visits: readonly CalendarVisit[],
    selectedCalendarIds: readonly string[] | null,
    bufferMinutes: number,
  ): Promise<CalendarVisitMatch[]>;
  batchCreateExportEvents?: (
    calendarId: string,
    timeZone: string,
    requests: readonly NativeCalendarExportEventMutationRequest[],
  ) => Promise<NativeCalendarMutationResult[]>;
  batchDeleteEvents?: (
    requests: readonly NativeCalendarDeleteEventMutationRequest[],
  ) => Promise<NativeCalendarMutationResult[]>;
}

const CalendarMatchingModule =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeCalendarMatchingModule>("CalendarMatching") : null;

function hasNativeMethod<Module, MethodName extends keyof Module>(
  module: Module | null,
  methodName: MethodName,
): module is Module & Required<Pick<Module, MethodName>> {
  return module !== null && module !== undefined && typeof module[methodName] === "function";
}

function requireCalendarMatchingModule(): NativeCalendarMatchingModule {
  if (!CalendarMatchingModule) {
    throw new Error("CalendarMatching native module is unavailable on this platform or binary.");
  }
  return CalendarMatchingModule;
}

/** Whether this binary contains the Apple-native calendar matching module. */
export function isCalendarMatchingAvailable(): boolean {
  return CalendarMatchingModule !== null;
}

/** Null disables negative caching on older binaries without change observation. */
export async function getCalendarRevision(): Promise<string | null> {
  if (!hasNativeMethod(CalendarMatchingModule, "getRevision")) {
    return null;
  }
  return CalendarMatchingModule.getRevision();
}

/** Whether this binary contains the native EventKit batch-create method. */
export function isCalendarBatchCreateAvailable(): boolean {
  return hasNativeMethod(CalendarMatchingModule, "batchCreateExportEvents");
}

/** Whether this binary contains the native EventKit batch-delete method. */
export function isCalendarBatchDeleteAvailable(): boolean {
  return hasNativeMethod(CalendarMatchingModule, "batchDeleteEvents");
}

/** Invoke native batch creation. Call only after checking its independent capability. */
export async function batchCreateExportEvents(
  calendarId: string,
  timeZone: string,
  requests: readonly NativeCalendarExportEventMutationRequest[],
): Promise<NativeCalendarMutationResult[]> {
  const module = CalendarMatchingModule;
  if (!hasNativeMethod(module, "batchCreateExportEvents")) {
    throw new Error("Native calendar batch creation is unavailable on this platform or binary.");
  }
  // Expo converts arrays and scalar Records before dispatching async Swift work.
  // Pass the readonly values directly; a JS clone adds no isolation here.
  return module.batchCreateExportEvents(calendarId, timeZone, requests);
}

/** Invoke native batch deletion. Call only after checking its independent capability. */
export async function batchDeleteEvents(
  requests: readonly NativeCalendarDeleteEventMutationRequest[],
): Promise<NativeCalendarMutationResult[]> {
  const module = CalendarMatchingModule;
  if (!hasNativeMethod(module, "batchDeleteEvents")) {
    throw new Error("Native calendar batch deletion is unavailable on this platform or binary.");
  }
  return module.batchDeleteEvents(requests);
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
  assertValidCalendarTimestamp(startMs, "startMs");
  assertValidCalendarTimestamp(endMs, "endMs");
  if (endMs < startMs) {
    throw new RangeError("endMs must be greater than or equal to startMs.");
  }

  return requireCalendarMatchingModule().getEvents(startMs, endMs, selectedCalendarIds);
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

  const nativeVisits = validateCalendarVisitsForNativeMatching(visits);

  if (nativeVisits.length === 0) {
    return [];
  }

  return requireCalendarMatchingModule().matchVisits(nativeVisits, selectedCalendarIds, bufferMinutes);
}
