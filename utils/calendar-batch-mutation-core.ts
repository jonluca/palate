export const CALENDAR_EXPORTED_EVENT_CLEAR_BATCH_SIZE = 500;

const PALATE_EXPORT_EVENT_IDENTIFIER = "[Palate Export]";

export interface CalendarExportMutationVisit {
  readonly id: string;
  readonly restaurantName: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly address: string | null;
  readonly notes: string | null;
}

export interface NativeCalendarExportEventMutationRequest {
  readonly requestId: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly location: string | null;
  readonly notes: string;
}

export interface NativeCalendarDeleteEventMutationRequest {
  readonly requestId: string;
  readonly eventId: string;
  readonly instanceStartMs: number | null;
  readonly futureEvents: boolean;
}

export type NativeCalendarMutationStatus = "created" | "deleted" | "alreadyAbsent" | "failed";

export interface NativeCalendarMutationResult {
  readonly inputIndex: number;
  readonly requestId: string;
  readonly status: NativeCalendarMutationStatus;
  readonly eventId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface CreatedCalendarMutation {
  readonly inputIndex: number;
  readonly visitId: string;
  readonly eventId: string;
}

export interface CalendarCreateMutationExecutionResult {
  readonly implementation: "native" | "expo";
  readonly createdItems: CreatedCalendarMutation[];
  readonly failedInputIndices: number[];
}

export interface CalendarDeleteMutationExecutionResult {
  readonly implementation: "native" | "expo";
  readonly successfulInputIndices: number[];
  readonly alreadyAbsentInputIndices: number[];
  readonly failedInputIndices: number[];
}

export interface CalendarCreateMutationDependencies {
  readonly invokeNative?: (
    calendarId: string,
    timeZone: string,
    requests: readonly NativeCalendarExportEventMutationRequest[],
  ) => Promise<unknown>;
  readonly hasCalendarPermission: () => Promise<boolean>;
  readonly getTimeZone: () => string;
  readonly createWithExpo: (
    calendarId: string,
    timeZone: string,
    request: NativeCalendarExportEventMutationRequest,
  ) => Promise<string>;
  readonly onExpoError?: (error: unknown, inputIndex: number) => void;
}

export interface CalendarDeleteMutationDependencies {
  readonly invokeNative?: (requests: readonly NativeCalendarDeleteEventMutationRequest[]) => Promise<unknown>;
  readonly hasCalendarPermission: () => Promise<boolean>;
  readonly deleteWithExpo: (request: NativeCalendarDeleteEventMutationRequest) => Promise<void>;
  readonly onExpoError?: (error: unknown, inputIndex: number) => void;
}

export interface CalendarExportClearStatement {
  readonly sql: string;
  readonly parameters: Array<string | number>;
  readonly visitCount: number;
}

/** Preserve the exact notes format used by Palate's existing Expo Calendar path. */
export function buildCalendarExportNotes(visitId: string, userNotes: string | null): string {
  const identifier = `${PALATE_EXPORT_EVENT_IDENTIFIER} Visit ID: ${visitId}`;
  return userNotes ? `${userNotes}\n\n${identifier}` : identifier;
}

export function buildNativeCalendarExportRequests(
  visits: readonly CalendarExportMutationVisit[],
): NativeCalendarExportEventMutationRequest[] {
  const seenVisitIds = new Set<string>();
  return visits.map((visit) => {
    if (seenVisitIds.has(visit.id)) {
      throw new RangeError(`Calendar export visits cannot contain duplicate visit ID ${JSON.stringify(visit.id)}.`);
    }
    seenVisitIds.add(visit.id);
    return {
      requestId: visit.id,
      title: visit.restaurantName,
      startMs: visit.startTime,
      endMs: visit.endTime,
      location: visit.address,
      notes: buildCalendarExportNotes(visit.id, visit.notes),
    };
  });
}

export function buildNativeCalendarDeleteRequests(
  eventIds: readonly string[],
): NativeCalendarDeleteEventMutationRequest[] {
  return eventIds.map((eventId, inputIndex) => ({
    requestId: `calendar-delete-${inputIndex}`,
    eventId,
    instanceStartMs: null,
    futureEvents: false,
  }));
}

/** Select the exact source rows whose itemized mutation outcomes succeeded. */
export function selectCalendarMutationSuccessfulItems<T>(
  items: readonly T[],
  successfulInputIndices: readonly number[],
): T[] {
  const selectedItems: T[] = [];
  const seenIndices = new Set<number>();
  for (const inputIndex of successfulInputIndices) {
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= items.length) {
      throw new RangeError(`Calendar mutation returned invalid successful inputIndex ${inputIndex}.`);
    }
    if (seenIndices.has(inputIndex)) {
      throw new RangeError(`Calendar mutation returned duplicate successful inputIndex ${inputIndex}.`);
    }
    seenIndices.add(inputIndex);
    selectedItems.push(items[inputIndex]!);
  }
  return selectedItems;
}

/**
 * Route one create batch to the optional native implementation or the Expo fallback.
 * A rejection after native invocation is intentionally allowed to propagate: retrying
 * through Expo could duplicate events after an uncertain native commit.
 */
export async function executeCalendarCreateMutations(
  visits: readonly CalendarExportMutationVisit[],
  calendarId: string,
  dependencies: CalendarCreateMutationDependencies,
): Promise<CalendarCreateMutationExecutionResult> {
  const requests = buildNativeCalendarExportRequests(visits);
  if (requests.length === 0) {
    return { implementation: dependencies.invokeNative ? "native" : "expo", createdItems: [], failedInputIndices: [] };
  }

  if (dependencies.invokeNative) {
    const timeZone = dependencies.getTimeZone();
    const rawResults = await dependencies.invokeNative(calendarId, timeZone, requests);
    const results = validateNativeCalendarMutationResults(requests, rawResults, "create");
    const createdItems: CreatedCalendarMutation[] = [];
    const failedInputIndices: number[] = [];
    for (const result of results) {
      if (result.status === "created") {
        createdItems.push({ inputIndex: result.inputIndex, visitId: result.requestId, eventId: result.eventId! });
      } else {
        failedInputIndices.push(result.inputIndex);
      }
    }
    return { implementation: "native", createdItems, failedInputIndices };
  }

  if (!(await dependencies.hasCalendarPermission())) {
    return {
      implementation: "expo",
      createdItems: [],
      failedInputIndices: requests.map((_, inputIndex) => inputIndex),
    };
  }

  const timeZone = dependencies.getTimeZone();
  const createdItems: CreatedCalendarMutation[] = [];
  const failedInputIndices: number[] = [];
  for (let inputIndex = 0; inputIndex < requests.length; inputIndex++) {
    const request = requests[inputIndex]!;
    try {
      const eventId = await dependencies.createWithExpo(calendarId, timeZone, request);
      if (typeof eventId !== "string" || eventId.length === 0) {
        throw new TypeError("Expo Calendar returned an empty event ID.");
      }
      createdItems.push({ inputIndex, visitId: request.requestId, eventId });
    } catch (error) {
      dependencies.onExpoError?.(error, inputIndex);
      failedInputIndices.push(inputIndex);
    }
  }
  return { implementation: "expo", createdItems, failedInputIndices };
}

/** Native delete statuses `deleted` and `alreadyAbsent` both satisfy the requested postcondition. */
export async function executeCalendarDeleteMutations(
  eventIds: readonly string[],
  dependencies: CalendarDeleteMutationDependencies,
): Promise<CalendarDeleteMutationExecutionResult> {
  const requests = buildNativeCalendarDeleteRequests(eventIds);
  if (requests.length === 0) {
    return {
      implementation: dependencies.invokeNative ? "native" : "expo",
      successfulInputIndices: [],
      alreadyAbsentInputIndices: [],
      failedInputIndices: [],
    };
  }

  if (dependencies.invokeNative) {
    const rawResults = await dependencies.invokeNative(requests);
    const results = validateNativeCalendarMutationResults(requests, rawResults, "delete");
    const successfulInputIndices: number[] = [];
    const alreadyAbsentInputIndices: number[] = [];
    const failedInputIndices: number[] = [];
    for (const result of results) {
      if (result.status === "failed") {
        failedInputIndices.push(result.inputIndex);
      } else {
        successfulInputIndices.push(result.inputIndex);
        if (result.status === "alreadyAbsent") {
          alreadyAbsentInputIndices.push(result.inputIndex);
        }
      }
    }
    return { implementation: "native", successfulInputIndices, alreadyAbsentInputIndices, failedInputIndices };
  }

  if (!(await dependencies.hasCalendarPermission())) {
    return {
      implementation: "expo",
      successfulInputIndices: [],
      alreadyAbsentInputIndices: [],
      failedInputIndices: requests.map((_, inputIndex) => inputIndex),
    };
  }

  const successfulInputIndices: number[] = [];
  const failedInputIndices: number[] = [];
  for (let inputIndex = 0; inputIndex < requests.length; inputIndex++) {
    try {
      await dependencies.deleteWithExpo(requests[inputIndex]!);
      successfulInputIndices.push(inputIndex);
    } catch (error) {
      dependencies.onExpoError?.(error, inputIndex);
      failedInputIndices.push(inputIndex);
    }
  }
  return { implementation: "expo", successfulInputIndices, alreadyAbsentInputIndices: [], failedInputIndices };
}

export function validateNativeCalendarMutationResults(
  requests: readonly { readonly requestId: string }[],
  rawResults: unknown,
  operation: "create" | "delete",
): NativeCalendarMutationResult[] {
  assertUniqueRequestIds(requests);
  if (!Array.isArray(rawResults)) {
    throw new TypeError(`Native calendar ${operation} returned a non-array result.`);
  }
  if (rawResults.length !== requests.length) {
    throw new RangeError(
      `Native calendar ${operation} returned ${rawResults.length} results for ${requests.length} requests.`,
    );
  }

  const orderedResults = new Array<NativeCalendarMutationResult | undefined>(requests.length);
  for (const rawResult of rawResults) {
    if (!isRecord(rawResult)) {
      throw new TypeError(`Native calendar ${operation} returned a non-object item.`);
    }
    const inputIndex = rawResult.inputIndex;
    if (!Number.isInteger(inputIndex) || (inputIndex as number) < 0 || (inputIndex as number) >= requests.length) {
      throw new RangeError(`Native calendar ${operation} returned invalid inputIndex ${String(inputIndex)}.`);
    }
    const index = inputIndex as number;
    if (orderedResults[index]) {
      throw new RangeError(`Native calendar ${operation} returned duplicate inputIndex ${index}.`);
    }
    const requestId = requireString(rawResult.requestId, "requestId", operation);
    if (requestId !== requests[index]!.requestId) {
      throw new Error(
        `Native calendar ${operation} result ${index} has requestId ${JSON.stringify(requestId)}; expected ${JSON.stringify(requests[index]!.requestId)}.`,
      );
    }
    const status = rawResult.status;
    if (!isNativeCalendarMutationStatus(status)) {
      throw new TypeError(`Native calendar ${operation} returned invalid status ${JSON.stringify(status)}.`);
    }
    if (operation === "create" && status !== "created" && status !== "failed") {
      throw new Error(`Native calendar create returned impossible status ${status}.`);
    }
    if (operation === "delete" && status !== "deleted" && status !== "alreadyAbsent" && status !== "failed") {
      throw new Error(`Native calendar delete returned impossible status ${status}.`);
    }
    const eventId = requireNullableString(rawResult.eventId, "eventId", operation);
    const errorCode = requireNullableString(rawResult.errorCode, "errorCode", operation);
    const errorMessage = requireNullableString(rawResult.errorMessage, "errorMessage", operation);
    if (status === "created" && (!eventId || eventId.length === 0)) {
      throw new Error(`Native calendar create result ${index} is missing its event ID.`);
    }
    if (status === "failed" && eventId !== null) {
      throw new Error(`Native calendar ${operation} failure result ${index} unexpectedly contains an event ID.`);
    }
    orderedResults[index] = { inputIndex: index, requestId, status, eventId, errorCode, errorMessage };
  }

  return orderedResults.map((result, inputIndex) => {
    if (!result) {
      throw new RangeError(`Native calendar ${operation} omitted result for inputIndex ${inputIndex}.`);
    }
    return result;
  });
}

/** Build bounded statements so ExpoSQLite's 32,766-variable ceiling is never approached. */
export function planCalendarExportClearStatements(
  visitIds: readonly string[],
  updatedAt: number,
): CalendarExportClearStatement[] {
  if (!Number.isFinite(updatedAt)) {
    throw new RangeError(`updatedAt must be finite; received ${updatedAt}.`);
  }
  const uniqueVisitIds = [...new Set(visitIds)];
  const statements: CalendarExportClearStatement[] = [];
  for (let offset = 0; offset < uniqueVisitIds.length; offset += CALENDAR_EXPORTED_EVENT_CLEAR_BATCH_SIZE) {
    const batch = uniqueVisitIds.slice(offset, offset + CALENDAR_EXPORTED_EVENT_CLEAR_BATCH_SIZE);
    statements.push({
      sql: `UPDATE visits
        SET calendarEventId = NULL,
            calendarEventTitle = NULL,
            exportedToCalendarId = NULL,
            updatedAt = ?
        WHERE id IN (${batch.map(() => "?").join(", ")})`,
      parameters: [updatedAt, ...batch],
      visitCount: batch.length,
    });
  }
  return statements;
}

function assertUniqueRequestIds(requests: readonly { readonly requestId: string }[]): void {
  const requestIds = new Set<string>();
  for (const request of requests) {
    if (requestIds.has(request.requestId)) {
      throw new RangeError(
        `Calendar mutation requests cannot contain duplicate request ID ${JSON.stringify(request.requestId)}.`,
      );
    }
    requestIds.add(request.requestId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeCalendarMutationStatus(value: unknown): value is NativeCalendarMutationStatus {
  return value === "created" || value === "deleted" || value === "alreadyAbsent" || value === "failed";
}

function requireString(value: unknown, field: string, operation: "create" | "delete"): string {
  if (typeof value !== "string") {
    throw new TypeError(`Native calendar ${operation} result field ${field} must be a string.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string, operation: "create" | "delete"): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`Native calendar ${operation} result field ${field} must be a string or null.`);
  }
  return value as string | null;
}
