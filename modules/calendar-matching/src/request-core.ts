const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export interface CalendarMatchingVisitTimeRange {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
}

export function assertValidCalendarTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_DATE_TIMESTAMP_MS) {
    throw new TypeError(`${name} must be a valid ECMAScript Date timestamp in milliseconds.`);
  }
}

/**
 * Validate native matching inputs without cloning them. Expo serializes the
 * readonly values into native `Record` instances before Swift handles them.
 */
export function validateCalendarVisitsForNativeMatching<Visit extends CalendarMatchingVisitTimeRange>(
  visits: readonly Visit[],
): readonly Visit[] {
  visits.forEach((visit) => {
    assertValidCalendarTimestamp(visit.startTime, "visit.startTime");
    assertValidCalendarTimestamp(visit.endTime, "visit.endTime");
    if (visit.endTime < visit.startTime) {
      throw new RangeError(`Visit ${visit.id} has an endTime before its startTime.`);
    }
  });

  return visits;
}
