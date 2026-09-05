import { isVisitStatus } from "../visit-status.ts";
import type { VisitRecord } from "./types";

/** SQLite returns integer flags; the application record exposes booleans. */
export interface VisitQueryRow extends Omit<VisitRecord, "status" | "foodProbable" | "calendarEventIsAllDay"> {
  status: string;
  foodProbable: number;
  calendarEventIsAllDay: number | null;
}

function parseVisitBoolean(value: number, column: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new TypeError(`Visit query ${column} must be a SQLite boolean (0 or 1).`);
  }
  return value === 1;
}

/** Decode one visit, retaining any additional columns from a joined projection. */
export function parseVisitQueryRow<Row extends VisitQueryRow>(row: Row) {
  const { status, foodProbable, calendarEventIsAllDay, ...fields } = row;
  if (!isVisitStatus(status)) {
    throw new TypeError(`Visit query returned an unsupported status: ${String(status)}.`);
  }
  return {
    ...fields,
    status,
    foodProbable: parseVisitBoolean(foodProbable, "foodProbable"),
    calendarEventIsAllDay:
      calendarEventIsAllDay === null ? null : parseVisitBoolean(calendarEventIsAllDay, "calendarEventIsAllDay"),
  };
}
