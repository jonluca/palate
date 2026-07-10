export const EXPORT_PHOTO_PAGE_SIZE = 4_000;

export interface ExportPhotoCursor {
  readonly visitId: string;
  readonly foodRank: 0 | 1 | 2;
  readonly creationTime: number;
  readonly id: string;
}

export interface ExportPhotosQuery {
  readonly sql: string;
  readonly parameters: Array<string | number>;
  readonly pageSize: number;
}

/** A parameterized exact-count lookup built by {@linkcode buildExportPhotoCountsQuery}. */
export interface ExportPhotoCountsQuery {
  /** SQL that returns one `visitId`/`photoCount` row per distinct requested ID. */
  readonly sql: string;
  /** The requested IDs encoded as the query's single JSON bind. */
  readonly parameters: [string];
}

const FOOD_RANK_SQL = "CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END";

/**
 * Build one exact photo-count lookup for arbitrary visit IDs.
 *
 * Duplicate IDs are collapsed by SQL, missing IDs produce a zero count, and
 * the IDs remain in one JSON parameter so SQLite's bind-variable limit does
 * not constrain the request.
 *
 * @returns `null` when no visit IDs are requested.
 * @throws {TypeError} When any visit ID is not a string.
 */
export function buildExportPhotoCountsQuery(visitIds: readonly string[]): ExportPhotoCountsQuery | null {
  if (visitIds.length === 0) {
    return null;
  }
  for (const visitId of visitIds) {
    if (typeof visitId !== "string") {
      throw new TypeError("Export photo count queries require string visit IDs.");
    }
  }

  return {
    sql: `WITH requested_visit_ids AS (
        SELECT DISTINCT value AS visitId
        FROM json_each(?)
        WHERE type = 'text'
      )
      SELECT
        requested.visitId AS visitId,
        COUNT(p.visitId) AS photoCount
      FROM requested_visit_ids requested
      LEFT JOIN photos p ON p.visitId = requested.visitId
      GROUP BY requested.visitId
      ORDER BY requested.visitId ASC`,
    parameters: [JSON.stringify(visitIds)],
  };
}

/**
 * Build one arbitrary-ID, bounded-row photo lookup for data export. JSON avoids
 * SQLite's bind-variable limit while keyset paging caps transient row memory.
 */
export function buildExportPhotosQuery(
  visitIds: readonly string[],
  cursor: ExportPhotoCursor | null = null,
  pageSize = EXPORT_PHOTO_PAGE_SIZE,
): ExportPhotosQuery | null {
  if (visitIds.length === 0) {
    return null;
  }
  for (const visitId of visitIds) {
    if (typeof visitId !== "string") {
      throw new TypeError("Export photo queries require string visit IDs.");
    }
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > EXPORT_PHOTO_PAGE_SIZE) {
    throw new RangeError(`Export photo page size must be between 1 and ${EXPORT_PHOTO_PAGE_SIZE}.`);
  }
  if (
    cursor !== null &&
    (typeof cursor.visitId !== "string" ||
      (cursor.foodRank !== 0 && cursor.foodRank !== 1 && cursor.foodRank !== 2) ||
      !Number.isFinite(cursor.creationTime) ||
      typeof cursor.id !== "string")
  ) {
    throw new TypeError("Export photo cursors must contain a valid ordered photo key.");
  }

  const cursorClause = cursor ? `AND (p.visitId, ${FOOD_RANK_SQL}, p.creationTime, p.id) > (?, ?, ?, ?)` : "";
  const parameters: Array<string | number> = [JSON.stringify(visitIds)];
  if (cursor) {
    parameters.push(cursor.visitId, cursor.foodRank, cursor.creationTime, cursor.id);
  }
  // Fetch one lookahead row so callers can stop without an extra empty query.
  parameters.push(pageSize + 1);

  return {
    sql: `SELECT p.*
      FROM photos p
      WHERE p.visitId IN (
        SELECT value
        FROM json_each(?)
        WHERE type = 'text'
      )
      ${cursorClause}
      ORDER BY
        p.visitId ASC,
        ${FOOD_RANK_SQL} ASC,
        p.creationTime ASC,
        p.id ASC
      LIMIT ?`,
    parameters,
    pageSize,
  };
}
