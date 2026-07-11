export interface ConfirmedRestaurantSearchRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly cuisine: string | null;
  readonly visitCount: number;
  readonly lastVisit: number;
  readonly currentAward: string | null;
}

export const CONFIRMED_RESTAURANTS_QUERY_KEY = ["confirmedRestaurants"] as const;

export const CONFIRMED_RESTAURANT_SEARCH_QUERY_KEY = [...CONFIRMED_RESTAURANTS_QUERY_KEY, "searchProjection"] as const;

export const CONFIRMED_RESTAURANT_SEARCH_SQL = `WITH restaurant_stats AS (
  SELECT
    restaurantId,
    COUNT(id) AS visitCount,
    MAX(startTime) AS lastVisit
  FROM visits
  WHERE status = 'confirmed' AND restaurantId IS NOT NULL
  GROUP BY restaurantId
)
SELECT
  r.id,
  r.name,
  r.latitude,
  r.longitude,
  r.address,
  r.cuisine,
  rs.visitCount,
  rs.lastVisit,
  m.award AS currentAward
FROM restaurants r
INNER JOIN restaurant_stats rs ON rs.restaurantId = r.id
LEFT JOIN michelin_restaurants m ON m.id = r.id
ORDER BY rs.lastVisit DESC`;

export function shouldLoadConfirmedRestaurantSearch(visible: boolean, searchQuery: string): boolean {
  return visible && searchQuery.trim().length > 0;
}

export function filterConfirmedRestaurantSearchRows(
  rows: readonly ConfirmedRestaurantSearchRow[],
  searchQuery: string,
): ConfirmedRestaurantSearchRow[] {
  if (!searchQuery.trim()) {
    return [];
  }

  // Keep the modal's historical JavaScript matching behavior. In particular,
  // the trimmed value only controls whether search is active; matching itself
  // uses the original query string and JavaScript's locale-independent lower().
  const query = searchQuery.toLowerCase();
  return rows.filter((restaurant) => restaurant.name.toLowerCase().includes(query));
}
