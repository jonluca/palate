import type { MichelinRestaurantRecord } from "./db/types";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;

export const CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE = 1_000;

export interface CalendarImportSnapshot {
  readonly calendarEventId: string;
  readonly calendarEventTitle: string;
  readonly calendarEventLocation: string | null;
  readonly startDate: number;
  readonly endDate: number;
  readonly matchedRestaurants: readonly MichelinRestaurantRecord[];
  readonly matchedRestaurant: MichelinRestaurantRecord;
}

export interface CalendarImportVisitPlan {
  readonly id: string;
  readonly calendarEventId: string;
  readonly calendarEventTitle: string;
  readonly calendarEventLocation: string | null;
  readonly startTime: number;
  readonly endTime: number;
  /** Every original exact-name match, used to recheck the ±1-day invariant. */
  readonly matchedRestaurantIds: readonly string[];
  readonly matchedRestaurant: {
    readonly id: string;
    readonly name: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly address: string;
    readonly cuisine: string;
  };
}

export interface CalendarImportSnapshotPlan {
  readonly visitsToCreate: CalendarImportVisitPlan[];
}

export interface CalendarImportAvailabilityStatement {
  readonly sql: string;
  readonly parameters: string[];
}

export interface CalendarImportSnapshotPlanOptions {
  readonly now: number;
  readonly restaurantOverrides?: ReadonlyMap<string, string>;
}

/** Retain the first rendered snapshot for each EventKit identifier. */
export function dedupeCalendarImportSnapshots(snapshots: readonly CalendarImportSnapshot[]): CalendarImportSnapshot[] {
  const uniqueSnapshots: CalendarImportSnapshot[] = [];
  const seenEventIds = new Set<string>();

  for (const snapshot of snapshots) {
    if (seenEventIds.has(snapshot.calendarEventId)) {
      continue;
    }
    seenEventIds.add(snapshot.calendarEventId);
    uniqueSnapshots.push(snapshot);
  }

  return uniqueSnapshots;
}

/** Build one targeted read for linked or dismissed Calendar event identifiers. */
export function buildCalendarImportAvailabilityStatement(
  calendarEventIds: readonly string[],
): CalendarImportAvailabilityStatement {
  if (calendarEventIds.length === 0) {
    throw new RangeError("At least one Calendar import event ID is required.");
  }
  if (calendarEventIds.length > CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE) {
    throw new RangeError(
      `Calendar import availability batches cannot exceed ${CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE} event IDs.`,
    );
  }
  if (new Set(calendarEventIds).size !== calendarEventIds.length) {
    throw new RangeError("Calendar import availability batches cannot contain duplicate event IDs.");
  }

  const requestedValues = calendarEventIds.map(() => "(?)").join(", ");
  return {
    sql: `WITH requested(calendarEventId) AS (VALUES ${requestedValues})
      SELECT visits.calendarEventId
      FROM visits
      WHERE visits.calendarEventId IN (SELECT calendarEventId FROM requested)
      UNION
      SELECT dismissed_calendar_events.calendarEventId
      FROM dismissed_calendar_events
      WHERE dismissed_calendar_events.calendarEventId IN (SELECT calendarEventId FROM requested)`,
    parameters: [...calendarEventIds],
  };
}

/**
 * Convert the exact Calendar-import snapshots reviewed by the user into the
 * existing persistence inputs. This deliberately performs no EventKit or DB I/O.
 */
export function planCalendarImportFromSnapshots(
  snapshots: readonly CalendarImportSnapshot[],
  options: CalendarImportSnapshotPlanOptions,
): CalendarImportSnapshotPlan {
  if (!Number.isFinite(options.now)) {
    throw new RangeError("Calendar import planning time must be finite.");
  }

  const visitsToCreate: CalendarImportVisitPlan[] = [];

  for (const snapshot of dedupeCalendarImportSnapshots(snapshots)) {
    if (snapshot.startDate > options.now) {
      continue;
    }

    let restaurant = snapshot.matchedRestaurant;
    if (options.restaurantOverrides?.has(snapshot.calendarEventId)) {
      const overrideRestaurantId = options.restaurantOverrides.get(snapshot.calendarEventId)!;
      const overrideRestaurant = snapshot.matchedRestaurants.find((candidate) => candidate.id === overrideRestaurantId);
      if (!overrideRestaurant) {
        throw new RangeError(
          `Calendar import override ${JSON.stringify(overrideRestaurantId)} is not a match for event ${JSON.stringify(snapshot.calendarEventId)}.`,
        );
      }
      restaurant = overrideRestaurant;
    }

    const visitId = `cal-${snapshot.calendarEventId}-${Math.floor(snapshot.startDate / MILLISECONDS_PER_HOUR)}`;
    visitsToCreate.push({
      id: visitId,
      calendarEventId: snapshot.calendarEventId,
      calendarEventTitle: snapshot.calendarEventTitle,
      calendarEventLocation: snapshot.calendarEventLocation,
      startTime: snapshot.startDate,
      endTime: snapshot.endDate,
      matchedRestaurantIds: [...new Set(snapshot.matchedRestaurants.map((match) => match.id))],
      matchedRestaurant: {
        id: restaurant.id,
        name: restaurant.name,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        address: restaurant.address,
        cuisine: restaurant.cuisine,
      },
    });
  }

  return { visitsToCreate };
}
