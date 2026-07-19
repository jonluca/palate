import type { WrappedStats } from "./types";

export interface WrappedStatsMichelinQueryRow {
  readonly award: string | null;
  readonly visitCount: number | null;
  readonly restaurantCount: number | null;
  readonly distinctStarredRestaurants: number;
  readonly distinctStars: number | null;
  readonly greenStarVisits: number;
}

export interface WrappedStatsMichelinQuery {
  readonly sql: string;
  readonly parameters: string[];
}

/**
 * Returns the five Michelin aggregates used by Wrapped Stats in one SQLite call.
 *
 * Exact award strings remain grouped so the JavaScript parser can preserve the
 * legacy ordered classification rules. In particular, per-category distinct
 * counts are sums across exact award strings, while the two global starred
 * metrics retain their separate restaurant-level deduplication rules.
 */
export function buildWrappedStatsMichelinQuery(year?: number | null): WrappedStatsMichelinQuery {
  const yearFilter = year ? "AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) = ?" : "";

  return {
    sql: `WITH
      filtered_awards AS MATERIALIZED (
        SELECT
          v.id AS visitId,
          m.id AS restaurantId,
          COALESCE(v.awardAtVisit, m.award) AS award
        FROM visits v
        JOIN michelin_restaurants m ON v.restaurantId = m.id
        WHERE v.status = 'confirmed' ${yearFilter}
      ),
      award_counts AS (
        SELECT
          award,
          COUNT(DISTINCT visitId) AS visitCount,
          COUNT(DISTINCT restaurantId) AS restaurantCount
        FROM filtered_awards
        GROUP BY award
      ),
      starred_restaurant_awards AS (
        SELECT DISTINCT restaurantId, award
        FROM filtered_awards
        WHERE award LIKE '%star%' OR award LIKE '%Star%'
      ),
      starred_stats AS (
        SELECT
          COUNT(DISTINCT restaurantId) AS distinctStarredRestaurants,
          SUM(
            CASE
              WHEN lower(award) LIKE '%3 star%' THEN 3
              WHEN lower(award) LIKE '%2 star%' THEN 2
              WHEN lower(award) LIKE '%1 star%' THEN 1
              ELSE 0
            END
          ) AS distinctStars
        FROM starred_restaurant_awards
      ),
      green_stats AS (
        SELECT COALESCE(SUM(visitCount), 0) AS greenStarVisits
        FROM award_counts
        WHERE award LIKE '%Green Star%' OR award LIKE '%green star%'
      )
    SELECT
      award_counts.award AS award,
      award_counts.visitCount AS visitCount,
      award_counts.restaurantCount AS restaurantCount,
      starred_stats.distinctStarredRestaurants AS distinctStarredRestaurants,
      starred_stats.distinctStars AS distinctStars,
      green_stats.greenStarVisits AS greenStarVisits
    FROM starred_stats
    CROSS JOIN green_stats
    LEFT JOIN award_counts ON 1 = 1
    ORDER BY award_counts.award`,
    parameters: year ? [String(year)] : [],
  };
}

export function parseWrappedStatsMichelinRows(
  rows: readonly WrappedStatsMichelinQueryRow[],
): WrappedStats["michelinStats"] {
  const global = rows[0];
  const stats: WrappedStats["michelinStats"] = {
    threeStars: 0,
    twoStars: 0,
    oneStars: 0,
    bibGourmand: 0,
    selected: 0,
    distinctThreeStars: 0,
    distinctTwoStars: 0,
    distinctOneStars: 0,
    distinctBibGourmand: 0,
    distinctSelected: 0,
    totalStarredVisits: 0,
    distinctStarredRestaurants: Number(global?.distinctStarredRestaurants ?? 0),
    totalAccumulatedStars: 0,
    distinctStars: Number(global?.distinctStars ?? 0),
    greenStarVisits: Number(global?.greenStarVisits ?? 0),
  };

  for (const row of rows) {
    // The legacy loops skipped both null and empty award strings.
    if (!row.award) {
      continue;
    }

    const award = row.award.toLowerCase();
    const visitCount = Number(row.visitCount ?? 0);
    const restaurantCount = Number(row.restaurantCount ?? 0);

    if (award.includes("3 star")) {
      stats.threeStars += visitCount;
      stats.distinctThreeStars += restaurantCount;
      stats.totalAccumulatedStars += visitCount * 3;
    } else if (award.includes("2 star")) {
      stats.twoStars += visitCount;
      stats.distinctTwoStars += restaurantCount;
      stats.totalAccumulatedStars += visitCount * 2;
    } else if (award.includes("1 star")) {
      stats.oneStars += visitCount;
      stats.distinctOneStars += restaurantCount;
      stats.totalAccumulatedStars += visitCount;
    } else if (award.includes("bib")) {
      stats.bibGourmand += visitCount;
      stats.distinctBibGourmand += restaurantCount;
    } else if (award.includes("selected")) {
      stats.selected += visitCount;
      stats.distinctSelected += restaurantCount;
    }

    // This deliberately retains the legacy meaning: every visit with a
    // non-empty Michelin award contributes, including Bib and Selected rows.
    stats.totalStarredVisits += visitCount;
  }

  return stats;
}
