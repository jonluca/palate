import type { MichelinRestaurantRecord } from "./types";

export interface MichelinCalendarNameRow {
  readonly id: string;
  readonly name: string;
}

export type MichelinCalendarHydrationRow = MichelinRestaurantRecord & {
  readonly requestedOrdinal: number;
};

export const ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL = `SELECT m.id, m.name
FROM michelin_restaurants m
WHERE NOT EXISTS (
  SELECT 1 FROM app_metadata WHERE key = ?
) OR m.datasetVersion = (
  SELECT value FROM app_metadata WHERE key = ?
)
ORDER BY m.rowid`;

export const ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL = `WITH requested_ids AS (
  SELECT CAST(key AS INTEGER) AS requestedOrdinal, CAST(value AS TEXT) AS id
  FROM json_each(?)
)
SELECT
  requested_ids.requestedOrdinal,
  m.id,
  m.name,
  m.latitude,
  m.longitude,
  m.address,
  m.location,
  m.cuisine,
  m.latestAwardYear,
  m.award
FROM requested_ids
JOIN michelin_restaurants m ON m.id = requested_ids.id
WHERE NOT EXISTS (
  SELECT 1 FROM app_metadata WHERE key = ?
) OR m.datasetVersion = (
  SELECT value FROM app_metadata WHERE key = ?
)
ORDER BY requested_ids.requestedOrdinal`;

/**
 * Selects active guide IDs whose caller-defined normalized name is requested.
 * Input encounter order is retained so equal-relevance Calendar matches keep
 * the same stable ordering as the former full-guide query.
 */
export function selectMichelinCalendarHydrationIds(
  rows: readonly MichelinCalendarNameRow[],
  requestedNormalizedNames: ReadonlySet<string>,
  normalizeRestaurantName: (name: string) => string,
): string[] {
  if (rows.length === 0 || requestedNormalizedNames.size === 0) {
    return [];
  }

  const ids: string[] = [];
  for (const row of rows) {
    if (requestedNormalizedNames.has(normalizeRestaurantName(row.name))) {
      ids.push(row.id);
    }
  }
  return ids;
}

/** Removes the private JSON request ordinal from fully hydrated guide rows. */
export function parseMichelinCalendarHydrationRows(
  rows: readonly MichelinCalendarHydrationRow[],
): MichelinRestaurantRecord[] {
  return rows.map(({ requestedOrdinal: _requestedOrdinal, ...restaurant }) => restaurant);
}
