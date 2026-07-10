import type { CalendarEventUpdate } from "./types";

export interface CalendarPersistenceStatement {
  readonly sql: string;
  readonly parameters: Array<string | number | null>;
}

export interface CalendarExportUpdate {
  readonly visitId: string;
  readonly calendarEventId: string;
  readonly calendarEventTitle: string;
  readonly exportedToCalendarId?: string;
}

export interface CoalescedCalendarExportUpdate {
  readonly visitId: string;
  readonly calendarEventId: string;
  readonly calendarEventTitle: string;
  readonly exportedToCalendarId: string | null;
  readonly updatesExportedCalendar: boolean;
}

// Both statement shapes use five bindings per row. A 160-row batch keeps 800
// row bindings beneath SQLite's historical 999-variable default with room for
// statement-level values such as updatedAt.
export const CALENDAR_PERSISTENCE_BATCH_SIZE = 160;

export function coalesceCalendarEventUpdates(updates: readonly CalendarEventUpdate[]): CalendarEventUpdate[] {
  const byVisitId = new Map<string, CalendarEventUpdate>();
  for (const update of updates) {
    byVisitId.set(update.visitId, update);
  }
  return [...byVisitId.values()];
}

export function buildCalendarEventPersistenceStatement(
  updates: readonly CalendarEventUpdate[],
): CalendarPersistenceStatement {
  validateBatch(updates.map(({ visitId }) => visitId));
  const values = updates.map(() => "(?, ?, ?, ?, ?)").join(", ");
  return {
    sql: `WITH calendar_updates(id, eventId, title, location, isAllDay) AS (VALUES ${values})
      UPDATE visits AS target
      SET calendarEventId = calendar_updates.eventId,
          calendarEventTitle = calendar_updates.title,
          calendarEventLocation = calendar_updates.location,
          calendarEventIsAllDay = calendar_updates.isAllDay
      FROM calendar_updates
      WHERE target.id = calendar_updates.id`,
    parameters: updates.flatMap((update) => [
      update.visitId,
      update.calendarEventId,
      update.calendarEventTitle,
      update.calendarEventLocation,
      update.calendarEventIsAllDay ? 1 : 0,
    ]),
  };
}

/**
 * Collapse sequential calendar-export updates without changing their behavior.
 * Event ID/title always come from the final update. A truthy exported calendar
 * ID persists through later imported-event updates, because the prior writer
 * deliberately left that column untouched in its imported branch.
 */
export function coalesceCalendarExportUpdates(
  updates: readonly CalendarExportUpdate[],
): CoalescedCalendarExportUpdate[] {
  const byVisitId = new Map<string, CoalescedCalendarExportUpdate>();
  for (const update of updates) {
    const previous = byVisitId.get(update.visitId);
    const updatesExportedCalendar = Boolean(update.exportedToCalendarId) || Boolean(previous?.updatesExportedCalendar);
    byVisitId.set(update.visitId, {
      visitId: update.visitId,
      calendarEventId: update.calendarEventId,
      calendarEventTitle: update.calendarEventTitle,
      exportedToCalendarId: update.exportedToCalendarId || previous?.exportedToCalendarId || null,
      updatesExportedCalendar,
    });
  }
  return [...byVisitId.values()];
}

export function buildCalendarExportPersistenceStatement(
  updates: readonly CoalescedCalendarExportUpdate[],
  updatedAt: number,
): CalendarPersistenceStatement {
  validateBatch(updates.map(({ visitId }) => visitId));
  if (!Number.isFinite(updatedAt)) {
    throw new RangeError(`updatedAt must be finite; received ${updatedAt}.`);
  }
  const values = updates.map(() => "(?, ?, ?, ?, ?)").join(", ");
  return {
    sql: `WITH calendar_updates(id, eventId, title, exportedCalendarId, updatesExportedCalendar) AS (VALUES ${values})
      UPDATE visits AS target
      SET calendarEventId = calendar_updates.eventId,
          calendarEventTitle = calendar_updates.title,
          exportedToCalendarId = CASE
            WHEN calendar_updates.updatesExportedCalendar = 1 THEN calendar_updates.exportedCalendarId
            ELSE target.exportedToCalendarId
          END,
          updatedAt = ?
      FROM calendar_updates
      WHERE target.id = calendar_updates.id`,
    parameters: [
      ...updates.flatMap((update) => [
        update.visitId,
        update.calendarEventId,
        update.calendarEventTitle,
        update.exportedToCalendarId,
        update.updatesExportedCalendar ? 1 : 0,
      ]),
      updatedAt,
    ],
  };
}

function validateBatch(visitIds: readonly string[]): void {
  if (visitIds.length === 0) {
    throw new RangeError("At least one calendar persistence update is required.");
  }
  if (visitIds.length > CALENDAR_PERSISTENCE_BATCH_SIZE) {
    throw new RangeError(
      `Calendar persistence batches cannot exceed ${CALENDAR_PERSISTENCE_BATCH_SIZE} rows; received ${visitIds.length}.`,
    );
  }
  if (new Set(visitIds).size !== visitIds.length) {
    throw new RangeError("Calendar persistence batches cannot contain duplicate visit IDs.");
  }
}
