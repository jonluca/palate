import type { WrappedStats } from "./types";

export interface WrappedStatsYearlyQueryRow {
  readonly year: number | string | null;
  readonly totalVisits: number;
  readonly uniqueRestaurants: number;
  readonly topRestaurantName: string | null;
  readonly topRestaurantVisits: number | null;
}

export type WrappedStatsYearlyStat = WrappedStats["yearlyStats"][number];

/**
 * Returns every yearly summary and its top restaurant in one SQLite call.
 *
 * The previous implementation fetched the yearly summaries once, then issued
 * one top-restaurant query per returned year. Ranking the already-grouped
 * restaurant counts keeps that work inside one statement and avoids an
 * unbounded JavaScript-to-SQLite N+1 call pattern.
 *
 * The restaurant ID is the explicit final key for equal visit counts. The
 * legacy query left ties unspecified and could change winners when SQLite chose
 * a different index. This stabilizes only that previously undefined case while
 * preserving every ordered/count/null behavior with a defined result.
 */
export const WRAPPED_STATS_YEARLY_SQL = `WITH
  yearly_data AS (
    SELECT
      strftime('%Y', datetime(startTime / 1000, 'unixepoch')) AS year,
      COUNT(*) AS totalVisits,
      COUNT(DISTINCT restaurantId) AS uniqueRestaurants
    FROM visits
    WHERE status = 'confirmed' AND restaurantId IS NOT NULL
    GROUP BY year
  ),
  yearly_restaurant_visits AS (
    SELECT
      strftime('%Y', datetime(v.startTime / 1000, 'unixepoch')) AS year,
      v.restaurantId AS restaurantId,
      r.name AS name,
      COUNT(*) AS visits
    FROM visits v
    JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.status = 'confirmed'
    GROUP BY year, v.restaurantId
  ),
  ranked_yearly_restaurants AS (
    SELECT
      year,
      restaurantId,
      name,
      visits,
      ROW_NUMBER() OVER (
        PARTITION BY year
        ORDER BY visits DESC, restaurantId ASC
      ) AS yearlyRank
    FROM yearly_restaurant_visits
  )
SELECT
  yearly_data.year AS year,
  yearly_data.totalVisits AS totalVisits,
  yearly_data.uniqueRestaurants AS uniqueRestaurants,
  ranked.name AS topRestaurantName,
  ranked.visits AS topRestaurantVisits
FROM yearly_data
LEFT JOIN ranked_yearly_restaurants ranked
  ON ranked.year = yearly_data.year AND ranked.yearlyRank = 1
ORDER BY yearly_data.year DESC`;

function parseYear(value: WrappedStatsYearlyQueryRow["year"]): number {
  if (value === null) {
    throw new TypeError("Wrapped Stats yearly query returned a null year.");
  }
  if (typeof value === "string" && !/^-?\d+$/.test(value)) {
    throw new TypeError(`Wrapped Stats yearly query returned an invalid year: ${value}`);
  }
  const year = Number(value);
  if (!Number.isSafeInteger(year)) {
    throw new TypeError(`Wrapped Stats yearly query returned an invalid year: ${String(value)}`);
  }
  return year;
}

export function parseWrappedStatsYearlyRows(rows: readonly WrappedStatsYearlyQueryRow[]): WrappedStatsYearlyStat[] {
  return rows.map((row) => ({
    year: parseYear(row.year),
    totalVisits: Number(row.totalVisits),
    uniqueRestaurants: Number(row.uniqueRestaurants),
    topRestaurant:
      row.topRestaurantName === null || row.topRestaurantVisits === null
        ? null
        : {
            name: row.topRestaurantName,
            visits: Number(row.topRestaurantVisits),
          },
  }));
}
