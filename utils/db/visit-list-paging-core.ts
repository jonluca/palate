export type VisitListFilter = "pending" | "confirmed" | "rejected" | "food";

export const DEFAULT_VISIT_LIST_PAGE_SIZE = 128;
export const MAX_VISIT_LIST_PAGE_SIZE = 1_000;

export interface VisitListCursor {
  readonly startTime: number;
  readonly id: string;
}

export interface VisitListItem {
  readonly id: string;
  readonly status: "pending" | "confirmed" | "rejected";
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
  readonly id: string;
  readonly status: string;
  readonly startTime: number;
  readonly photoCount: number;
  readonly foodProbable: number | boolean;
  readonly calendarEventTitle: string | null;
  readonly calendarEventIsAllDay: number | boolean | null;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly previewPhotosJson: string | null;
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
  if (!Number.isFinite(cursor.startTime) || typeof cursor.id !== "string") {
    throw new TypeError("Visit-list cursor must contain a finite startTime and string id.");
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
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((uri) => typeof uri === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseVisitListItem(row: VisitListPageRow): VisitListItem {
  if (row.status !== "pending" && row.status !== "confirmed" && row.status !== "rejected") {
    throw new Error(`Visit-list query returned unsupported status: ${row.status}.`);
  }
  return {
    id: row.id,
    status: row.status,
    startTime: row.startTime,
    photoCount: row.photoCount,
    foodProbable: row.foodProbable === true || row.foodProbable === 1,
    calendarEventTitle: row.calendarEventTitle,
    calendarEventIsAllDay:
      row.calendarEventIsAllDay === null ? null : row.calendarEventIsAllDay === true || row.calendarEventIsAllDay === 1,
    restaurantName: row.restaurantName,
    suggestedRestaurantName: row.suggestedRestaurantName,
    previewPhotos: parsePreviewPhotos(row.previewPhotosJson),
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
