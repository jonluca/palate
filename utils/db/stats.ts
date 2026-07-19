import { DEBUG_TIMING, getDatabase } from "./core";
import type { MichelinStatsBucket, MichelinStatsRestaurantSummary, WrappedStats } from "./types";
import {
  buildWrappedStatsMichelinQuery,
  parseWrappedStatsMichelinRows,
  type WrappedStatsMichelinQueryRow,
} from "./wrapped-stats-michelin-core";
import {
  parseWrappedStatsYearlyRows,
  WRAPPED_STATS_YEARLY_SQL,
  type WrappedStatsYearlyQueryRow,
} from "./wrapped-stats-yearly-core";
import { parseLocalDateInput } from "../local-date.ts";

const MICHELIN_STATS_BUCKET_WHERE: Record<MichelinStatsBucket, string> = {
  "three-stars": "LOWER(COALESCE(v.awardAtVisit, m.award)) LIKE '%3 star%'",
  "two-stars": "LOWER(COALESCE(v.awardAtVisit, m.award)) LIKE '%2 star%'",
  "one-star": "LOWER(COALESCE(v.awardAtVisit, m.award)) LIKE '%1 star%'",
  "bib-gourmand": "LOWER(COALESCE(v.awardAtVisit, m.award)) LIKE '%bib%'",
  selected: "LOWER(COALESCE(v.awardAtVisit, m.award)) LIKE '%selected%'",
};

// Stats
export async function getStats(): Promise<{
  totalPhotos: number;
  photosWithLocation: number;
  totalVisits: number;
  pendingVisits: number;
  confirmedVisits: number;
  foodProbableVisits: number;
}> {
  const database = await getDatabase();
  const [photoCounts, visitCounts] = await Promise.all([
    database.getFirstAsync<{ totalPhotos: number; photosWithLocation: number }>(`
      SELECT 
        COUNT(*) as totalPhotos,
        SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) as photosWithLocation
      FROM photos
    `),
    database.getFirstAsync<{
      totalVisits: number;
      pendingVisits: number;
      confirmedVisits: number;
      foodProbableVisits: number;
    }>(`
      SELECT 
        COUNT(*) as totalVisits,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingVisits,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmedVisits,
        SUM(CASE WHEN foodProbable = 1 THEN 1 ELSE 0 END) as foodProbableVisits
      FROM visits
    `),
  ]);

  return {
    totalPhotos: photoCounts?.totalPhotos ?? 0,
    photosWithLocation: photoCounts?.photosWithLocation ?? 0,
    totalVisits: visitCounts?.totalVisits ?? 0,
    pendingVisits: visitCounts?.pendingVisits ?? 0,
    confirmedVisits: visitCounts?.confirmedVisits ?? 0,
    foodProbableVisits: visitCounts?.foodProbableVisits ?? 0,
  };
}

export async function getMichelinRestaurantsForStatsBucket(
  year: number | null | undefined,
  bucket: MichelinStatsBucket,
): Promise<MichelinStatsRestaurantSummary[]> {
  const database = await getDatabase();
  const yearFilter = year ? `AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) = ?` : "";
  const params = year ? [String(year)] : [];

  const rows = await database.getAllAsync<MichelinStatsRestaurantSummary>(
    `SELECT
      m.id,
      m.name,
      TRIM(COALESCE(m.location, '')) as location,
      TRIM(COALESCE(m.cuisine, '')) as cuisine,
      COUNT(DISTINCT v.id) as visitCount,
      MAX(v.startTime) as latestVisit
    FROM visits v
    JOIN michelin_restaurants m ON v.restaurantId = m.id
    WHERE v.status = 'confirmed'
      ${yearFilter}
      AND ${MICHELIN_STATS_BUCKET_WHERE[bucket]}
    GROUP BY m.id, m.name, m.location, m.cuisine
    ORDER BY visitCount DESC, latestVisit DESC, m.name COLLATE NOCASE ASC`,
    params,
  );

  return rows.map((row) => ({
    ...row,
    visitCount: Number(row.visitCount),
    latestVisit: Number(row.latestVisit),
  }));
}

// Get wrapped statistics for confirmed visits
// When year is provided, filters all stats to that year only
export async function getWrappedStats(year?: number | null): Promise<WrappedStats> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Build year filter clause
  const yearFilter = year ? `AND strftime('%Y', datetime(startTime/1000, 'unixepoch', 'localtime')) = '${year}'` : "";
  const yearFilterForV = year
    ? `AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) = '${year}'`
    : "";
  const michelinQuery = buildWrappedStatsMichelinQuery(year);

  // Run all independent queries in parallel
  const [
    yearlyStatsRows,
    monthlyVisitsData,
    michelinStatsRows,
    topCuisines,
    busiestMonth,
    busiestDayOfWeek,
    totalUniqueRestaurants,
    totalConfirmedVisits,
    firstVisit,
    mostRevisitedRestaurant,
    visitDates,
    // New stats queries
    allLocationsData,
    topLocationsData,
    topMapPointsData,
    mealTimeData,
    weekendWeekdayData,
    peakHourData,
    photoStatsResult,
    mostPhotographedVisit,
    diningStyleData,
  ] = await Promise.all([
    // Yearly stats (only for all-time view)
    year ? Promise.resolve([]) : database.getAllAsync<WrappedStatsYearlyQueryRow>(WRAPPED_STATS_YEARLY_SQL),
    // Monthly visits data for chart
    database.getAllAsync<{ month: number; year: number; visits: number }>(
      `SELECT 
        CAST(strftime('%m', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as month,
        CAST(strftime('%Y', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as year,
        COUNT(*) as visits
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY year, month
      ORDER BY year ASC, month ASC`,
    ),
    // Michelin award stats share one filtered native query while preserving
    // the historical-award fallback and legacy JavaScript categorization.
    database.getAllAsync<WrappedStatsMichelinQueryRow>(michelinQuery.sql, michelinQuery.parameters),
    // Top cuisines
    database.getAllAsync<{ cuisine: string; count: number }>(
      `SELECT m.cuisine, COUNT(DISTINCT v.id) as count
      FROM visits v
      JOIN michelin_restaurants m ON v.restaurantId = m.id
      WHERE v.status = 'confirmed' AND m.cuisine != '' ${yearFilterForV}
      GROUP BY m.cuisine
      ORDER BY count DESC
      LIMIT 5`,
    ),
    // Busiest month
    database.getFirstAsync<{ month: number; year: number; visits: number }>(
      `SELECT 
        CAST(strftime('%m', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as month,
        CAST(strftime('%Y', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as year,
        COUNT(*) as visits
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY year, month
      ORDER BY visits DESC
      LIMIT 1`,
    ),
    // Busiest day of week
    database.getFirstAsync<{ day: number; visits: number }>(
      `SELECT 
        CAST(strftime('%w', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as day,
        COUNT(*) as visits
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY day
      ORDER BY visits DESC
      LIMIT 1`,
    ),
    // Total unique restaurants
    database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(DISTINCT restaurantId) as count FROM visits WHERE status = 'confirmed' AND restaurantId IS NOT NULL ${yearFilter}`,
    ),
    // Total confirmed visits
    database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM visits WHERE status = 'confirmed' ${yearFilter}`,
    ),
    // First visit date
    database.getFirstAsync<{ startTime: number }>(
      `SELECT startTime FROM visits WHERE status = 'confirmed' ${yearFilter} ORDER BY startTime ASC LIMIT 1`,
    ),
    // Most revisited restaurant
    database.getFirstAsync<{ name: string; visits: number }>(
      `SELECT r.name, COUNT(*) as visits
      FROM visits v
      JOIN restaurants r ON v.restaurantId = r.id
      WHERE v.status = 'confirmed' ${yearFilterForV}
      GROUP BY v.restaurantId
      HAVING visits > 1
      ORDER BY visits DESC
      LIMIT 1`,
    ),
    // Visit dates for streak calculation
    database.getAllAsync<{ date: string }>(
      `SELECT DISTINCT date(datetime(startTime/1000, 'unixepoch', 'localtime')) as date
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      ORDER BY date ASC`,
    ),
    // All distinct locations for accurate country/city counts
    database.getAllAsync<{ location: string }>(
      `SELECT DISTINCT TRIM(m.location) as location
      FROM visits v
      JOIN michelin_restaurants m ON v.restaurantId = m.id
      WHERE v.status = 'confirmed'
        AND TRIM(COALESCE(m.location, '')) != ''
        ${yearFilterForV}`,
    ),
    // Top locations (cities/countries from michelin_restaurants.location)
    // Normalize locations by trimming whitespace and using case-insensitive grouping
    database.getAllAsync<{ location: string; visits: number }>(
      `SELECT 
        TRIM(m.location) as location, 
        COUNT(DISTINCT v.id) as visits
      FROM visits v
      JOIN michelin_restaurants m ON v.restaurantId = m.id
      WHERE v.status = 'confirmed' 
        AND TRIM(COALESCE(m.location, '')) != '' 
        ${yearFilterForV}
      GROUP BY LOWER(TRIM(m.location))
      ORDER BY visits DESC
      LIMIT 10`,
    ),
    // Top restaurant coordinates for map markers
    database.getAllAsync<{ id: string; name: string; latitude: number; longitude: number; visits: number }>(
      `SELECT
        r.id as id,
        r.name as name,
        r.latitude as latitude,
        r.longitude as longitude,
        COUNT(DISTINCT v.id) as visits
      FROM visits v
      JOIN restaurants r ON v.restaurantId = r.id
      WHERE v.status = 'confirmed'
        AND v.restaurantId IS NOT NULL
        AND r.latitude IS NOT NULL
        AND r.longitude IS NOT NULL
        ${yearFilterForV}
      GROUP BY r.id
      ORDER BY visits DESC, r.name ASC`,
    ),
    // Meal time breakdown (using local time approximation)
    database.getAllAsync<{ mealTime: string; count: number }>(
      `SELECT 
        CASE 
          WHEN CAST(strftime('%H', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 6 AND 10 THEN 'breakfast'
          WHEN CAST(strftime('%H', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 11 AND 14 THEN 'lunch'
          WHEN CAST(strftime('%H', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) BETWEEN 17 AND 20 THEN 'dinner'
          WHEN CAST(strftime('%H', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) >= 21 THEN 'lateNight'
          ELSE 'other'
        END as mealTime,
        COUNT(*) as count
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY mealTime`,
    ),
    // Weekend vs weekday breakdown
    database.getAllAsync<{ dayType: string; count: number }>(
      `SELECT 
        CASE 
          WHEN strftime('%w', datetime(startTime/1000, 'unixepoch', 'localtime')) IN ('0','6') THEN 'weekend'
          ELSE 'weekday' 
        END as dayType,
        COUNT(*) as count
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY dayType`,
    ),
    // Peak dining hour
    database.getFirstAsync<{ hour: number; visits: number }>(
      `SELECT 
        CAST(strftime('%H', datetime(startTime/1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
        COUNT(*) as visits
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY hour
      ORDER BY visits DESC
      LIMIT 1`,
    ),
    // Photo stats (total and average)
    database.getFirstAsync<{ totalPhotos: number; avgPhotos: number }>(
      `SELECT 
        COALESCE(SUM(photoCount), 0) as totalPhotos,
        COALESCE(AVG(photoCount), 0) as avgPhotos
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}`,
    ),
    // Most photographed visit
    database.getFirstAsync<{ restaurantName: string; photoCount: number }>(
      `SELECT r.name as restaurantName, v.photoCount
      FROM visits v
      JOIN restaurants r ON v.restaurantId = r.id
      WHERE v.status = 'confirmed' AND v.photoCount > 0 ${yearFilterForV}
      ORDER BY v.photoCount DESC
      LIMIT 1`,
    ),
    // Dining style: count restaurants visited only once vs more than once
    database.getFirstAsync<{
      singleVisitRestaurants: number;
      multiVisitRestaurants: number;
      totalVisitsToReturning: number;
    }>(
      `SELECT 
        SUM(CASE WHEN visitCount = 1 THEN 1 ELSE 0 END) as singleVisitRestaurants,
        SUM(CASE WHEN visitCount > 1 THEN 1 ELSE 0 END) as multiVisitRestaurants,
        SUM(CASE WHEN visitCount > 1 THEN visitCount ELSE 0 END) as totalVisitsToReturning
      FROM (
        SELECT restaurantId, COUNT(*) as visitCount
        FROM visits 
        WHERE status = 'confirmed' AND restaurantId IS NOT NULL ${yearFilter}
        GROUP BY restaurantId
      )`,
    ),
  ]);

  const yearlyStats = parseWrappedStatsYearlyRows(yearlyStatsRows);
  const michelinStats = parseWrappedStatsMichelinRows(michelinStatsRows);

  // Calculate longest streak of consecutive dining days
  let longestStreak: { days: number; startDate: number; endDate: number } | null = null;
  if (visitDates.length > 0) {
    let currentStreak = 1;
    let maxStreak = 1;
    let streakStart = parseLocalDateInput(visitDates[0].date)!.getTime();
    let maxStreakStart = streakStart;
    let maxStreakEnd = streakStart;

    for (let i = 1; i < visitDates.length; i++) {
      const prevDate = parseLocalDateInput(visitDates[i - 1].date)!;
      const currDate = parseLocalDateInput(visitDates[i].date)!;
      const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);

      if (diffDays === 1) {
        currentStreak++;
        if (currentStreak > maxStreak) {
          maxStreak = currentStreak;
          maxStreakStart = streakStart;
          maxStreakEnd = currDate.getTime();
        }
      } else {
        currentStreak = 1;
        streakStart = currDate.getTime();
      }
    }

    if (maxStreak >= 2) {
      longestStreak = {
        days: maxStreak,
        startDate: maxStreakStart,
        endDate: maxStreakEnd,
      };
    }
  }

  // Calculate average visits per month
  let averageVisitsPerMonth = 0;
  if (firstVisit && totalConfirmedVisits) {
    const firstDate = new Date(firstVisit.startTime);
    const now = new Date();
    const monthsDiff = (now.getFullYear() - firstDate.getFullYear()) * 12 + (now.getMonth() - firstDate.getMonth()) + 1;
    averageVisitsPerMonth = monthsDiff > 0 ? totalConfirmedVisits.count / monthsDiff : totalConfirmedVisits.count;
  }

  // Process location data - parse "City, Country" format and dedupe by city
  const parseLocationParts = (rawLocation: string) => {
    const parts = rawLocation
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const city = parts[0] || rawLocation;
    const country = parts.length > 1 ? parts[parts.length - 1] : "";
    return { city, country };
  };

  const cityVisitsMap = new Map<string, { city: string; country: string; visits: number }>();
  for (const loc of topLocationsData) {
    // Location format is typically "City, Region/Country" or "City, Country"
    const { city, country } = parseLocationParts(loc.location);
    // Normalize city key for deduplication (lowercase, trimmed)
    const cityKey = city.toLowerCase().trim();

    const existing = cityVisitsMap.get(cityKey);
    if (existing) {
      // Sum visits for the same city
      existing.visits += loc.visits;
    } else {
      cityVisitsMap.set(cityKey, { city, country, visits: loc.visits });
    }
  }
  // Convert to array and sort by visits descending
  const topLocations = Array.from(cityVisitsMap.values())
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10)
    .map((item) => ({
      location: item.city, // Use city as the primary location now
      city: item.city,
      country: item.country,
      visits: item.visits,
    }));

  const mapPoints = topMapPointsData
    .map((row) => ({
      id: row.id,
      name: row.name,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      visits: Number(row.visits),
    }))
    .filter(
      (row) =>
        row.id &&
        row.name &&
        Number.isFinite(row.latitude) &&
        Number.isFinite(row.longitude) &&
        Number.isFinite(row.visits) &&
        row.visits > 0,
    );

  // Count unique countries and cities
  const normalizeLocation = (value: string) => value.toLowerCase().trim();
  const uniqueCountriesSet = new Set<string>();
  const uniqueCitiesSet = new Set<string>();

  for (const loc of allLocationsData) {
    if (!loc.location) {
      continue;
    }
    const { city, country } = parseLocationParts(loc.location);
    if (city) {
      uniqueCitiesSet.add(normalizeLocation(city));
    }
    if (country) {
      uniqueCountriesSet.add(normalizeLocation(country));
    }
  }

  // Process meal time breakdown
  const mealTimeBreakdown = {
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    lateNight: 0,
  };
  for (const row of mealTimeData) {
    if (row.mealTime === "breakfast") {
      mealTimeBreakdown.breakfast = row.count;
    } else if (row.mealTime === "lunch") {
      mealTimeBreakdown.lunch = row.count;
    } else if (row.mealTime === "dinner") {
      mealTimeBreakdown.dinner = row.count;
    } else if (row.mealTime === "lateNight") {
      mealTimeBreakdown.lateNight = row.count;
    }
  }

  // Process weekend vs weekday
  const weekendVsWeekday = { weekend: 0, weekday: 0 };
  for (const row of weekendWeekdayData) {
    if (row.dayType === "weekend") {
      weekendVsWeekday.weekend = row.count;
    } else if (row.dayType === "weekday") {
      weekendVsWeekday.weekday = row.count;
    }
  }

  // Process photo stats
  const photoStats = {
    totalPhotos: photoStatsResult?.totalPhotos ?? 0,
    averagePerVisit: Math.round((photoStatsResult?.avgPhotos ?? 0) * 10) / 10,
    mostPhotographedVisit: mostPhotographedVisit ?? null,
  };

  // Process dining style
  const totalVisitsCount = totalConfirmedVisits?.count ?? 0;
  const newRestaurants = diningStyleData?.singleVisitRestaurants ?? 0;
  const returningVisits = diningStyleData?.totalVisitsToReturning ?? 0;
  const uniqueRestaurantsCount = totalUniqueRestaurants?.count ?? 0;
  const diningStyle = {
    newRestaurants,
    returningVisits,
    explorerRatio: totalVisitsCount > 0 ? uniqueRestaurantsCount / totalVisitsCount : 0,
  };

  if (DEBUG_TIMING) {
    console.log(`[DB] getWrappedStats: ${(performance.now() - start).toFixed(2)}ms`);
  }

  // Extract available years from yearly data (only for all-time view)
  const availableYears = yearlyStats.map((y) => y.year).sort((a, b) => b - a);

  return {
    availableYears,
    yearlyStats,
    monthlyVisits: monthlyVisitsData,
    michelinStats,
    topCuisines,
    busiestMonth: busiestMonth ?? null,
    busiestDayOfWeek: busiestDayOfWeek ?? null,
    totalUniqueRestaurants: totalUniqueRestaurants?.count ?? 0,
    totalConfirmedVisits: totalConfirmedVisits?.count ?? 0,
    firstVisitDate: firstVisit?.startTime ?? null,
    longestStreak,
    mostRevisitedRestaurant: mostRevisitedRestaurant ?? null,
    averageVisitsPerMonth: Math.round(averageVisitsPerMonth * 10) / 10,
    // New stats
    topLocations,
    mapPoints,
    uniqueCountries: uniqueCountriesSet.size,
    uniqueCities: uniqueCitiesSet.size,
    mealTimeBreakdown,
    weekendVsWeekday,
    peakDiningHour: peakHourData ?? null,
    photoStats,
    diningStyle,
  };
}
