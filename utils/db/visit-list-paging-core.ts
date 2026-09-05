import { isJsonString, parseJsonValue } from "../runtime-json.ts";
import { isVisitStatus, type VisitListFilter, type VisitStatus } from "../visit-status.ts";

type SQLiteColumnValue = string | number | boolean | null | ArrayBuffer | Uint8Array;

export type { VisitListFilter } from "../visit-status.ts";

export const DEFAULT_VISIT_LIST_PAGE_SIZE = 128;
export const MAX_VISIT_LIST_PAGE_SIZE = 1_000;

export interface VisitListCursor {
  readonly startTime: number;
  readonly id: string;
}

export interface VisitListItem {
  readonly id: string;
  readonly status: VisitStatus;
  readonly startTime: number;
  readonly photoCount: number;
  readonly foodProbable: boolean;
  readonly calendarEventTitle: string | null;
  readonly calendarEventIsAllDay: boolean | null;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly previewPhotos: string[];
}

export interface VisitListPage {
  readonly visits: VisitListItem[];
  readonly nextCursor: VisitListCursor | null;
}

export interface VisitListPageQuery {
  readonly sql: string;
  readonly parameters: Array<string | number>;
  readonly pageSize: number;
}

export interface VisitListPageRow {
  readonly id: SQLiteColumnValue;
  readonly status: SQLiteColumnValue;
  readonly startTime: SQLiteColumnValue;
  readonly photoCount: SQLiteColumnValue;
  readonly foodProbable: SQLiteColumnValue;
  readonly calendarEventTitle: SQLiteColumnValue;
  readonly calendarEventIsAllDay: SQLiteColumnValue;
  readonly restaurantName: SQLiteColumnValue;
  readonly suggestedRestaurantName: SQLiteColumnValue;
  readonly previewPhotosJson: SQLiteColumnValue;
}

const PREVIEW_PHOTO_PRIORITY_SQL =
  "CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC, p.creationTime ASC, p.id ASC";

function normalizePageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_VISIT_LIST_PAGE_SIZE) {
    throw new RangeError(`Visit-list page size must be an integer from 1 to ${MAX_VISIT_LIST_PAGE_SIZE}.`);
  }
  return pageSize;
}

function validateCursor(cursor: VisitListCursor): void {
  if (!Number.isFinite(cursor.startTime)) {
    throw new TypeError("Visit-list cursor must contain a finite startTime.");
  }
}

/**
 * Build one slim, keyset-paged All Visits query. Both ordering terms descend so
 * SQLite can apply a single row-value comparison for the continuation cursor.
 */
export function buildVisitListPageQuery(
  filter?: VisitListFilter,
  cursor: VisitListCursor | null = null,
  pageSize: number = DEFAULT_VISIT_LIST_PAGE_SIZE,
): VisitListPageQuery {
  const normalizedPageSize = normalizePageSize(pageSize);
  const predicates: string[] = [];
  const parameters: Array<string | number> = [];

  if (filter === "food") {
    predicates.push("c.foodProbable = 1");
  } else if (filter) {
    predicates.push("c.status = ?");
    parameters.push(filter);
  }

  if (cursor) {
    validateCursor(cursor);
    predicates.push("(c.startTime, c.id) < (?, ?)");
    parameters.push(cursor.startTime, cursor.id);
  }

  parameters.push(normalizedPageSize + 1);
  return {
    sql: `SELECT
            c.id,
            c.status,
            c.startTime,
            c.photoCount,
            c.foodProbable,
            c.calendarEventTitle,
            c.calendarEventIsAllDay,
            r.name AS restaurantName,
            m.name AS suggestedRestaurantName,
            (
              SELECT json_group_array(uri)
              FROM (
                SELECT p.uri
                FROM photos p
                WHERE p.visitId = c.id
                ORDER BY ${PREVIEW_PHOTO_PRIORITY_SQL}
                LIMIT 3
              )
            ) AS previewPhotosJson
          FROM visits c
          LEFT JOIN restaurants r ON c.restaurantId = r.id
          LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
          ${predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""}
          ORDER BY c.startTime DESC, c.id COLLATE BINARY DESC
          LIMIT ?`,
    parameters,
    pageSize: normalizedPageSize,
  };
}

function parsePreviewPhotos(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = parseJsonValue(value);
    return Array.isArray(parsed) && parsed.every(isJsonString) ? parsed : [];
  } catch {
    return [];
  }
}

function isSQLiteText(value: SQLiteColumnValue): value is string {
  return typeof value === "string";
}

function isSQLiteFiniteNumber(value: SQLiteColumnValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireSQLiteText(value: SQLiteColumnValue, column: string): string {
  if (!isSQLiteText(value)) {
    throw new TypeError(`Visit-list query ${column} must be SQLite text.`);
  }
  return value;
}

function nullableSQLiteText(value: SQLiteColumnValue, column: string): string | null {
  return value === null ? null : requireSQLiteText(value, column);
}

function requireSQLiteNumber(value: SQLiteColumnValue, column: string): number {
  if (!isSQLiteFiniteNumber(value)) {
    throw new TypeError(`Visit-list query ${column} must be a finite SQLite number.`);
  }
  return value;
}

function requireSQLiteCount(value: SQLiteColumnValue): number {
  const count = requireSQLiteNumber(value, "photoCount");
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Visit-list query photoCount must be a non-negative safe integer.");
  }
  return count;
}

function requireSQLiteBoolean(value: SQLiteColumnValue, column: string): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  throw new TypeError(`Visit-list query ${column} must be a SQLite boolean.`);
}

function nullableSQLiteBoolean(value: SQLiteColumnValue, column: string): boolean | null {
  return value === null ? null : requireSQLiteBoolean(value, column);
}

function parseVisitListItem(row: VisitListPageRow): VisitListItem {
  const status = requireSQLiteText(row.status, "status");
  if (!isVisitStatus(status)) {
    throw new Error(`Visit-list query returned unsupported status: ${status}.`);
  }
  const previewPhotosJson = nullableSQLiteText(row.previewPhotosJson, "previewPhotosJson");
  return {
    id: requireSQLiteText(row.id, "id"),
    status,
    startTime: requireSQLiteNumber(row.startTime, "startTime"),
    photoCount: requireSQLiteCount(row.photoCount),
    foodProbable: requireSQLiteBoolean(row.foodProbable, "foodProbable"),
    calendarEventTitle: nullableSQLiteText(row.calendarEventTitle, "calendarEventTitle"),
    calendarEventIsAllDay: nullableSQLiteBoolean(row.calendarEventIsAllDay, "calendarEventIsAllDay"),
    restaurantName: nullableSQLiteText(row.restaurantName, "restaurantName"),
    suggestedRestaurantName: nullableSQLiteText(row.suggestedRestaurantName, "suggestedRestaurantName"),
    previewPhotos: parsePreviewPhotos(previewPhotosJson),
  };
}

export function parseVisitListPageRows(
  rows: readonly VisitListPageRow[],
  pageSize: number = DEFAULT_VISIT_LIST_PAGE_SIZE,
): VisitListPage {
  const normalizedPageSize = normalizePageSize(pageSize);
  const hasNextPage = rows.length > normalizedPageSize;
  const pageRows = hasNextPage ? rows.slice(0, normalizedPageSize) : rows;
  const visits = pageRows.map(parseVisitListItem);
  const lastVisit = visits.at(-1);
  return {
    visits,
    nextCursor:
      hasNextPage && lastVisit
        ? {
            startTime: lastVisit.startTime,
            id: lastVisit.id,
          }
        : null,
  };
}
