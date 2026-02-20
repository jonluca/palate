import { File, Paths } from "expo-file-system";
import { Asset } from "expo-asset";
import * as SQLite from "expo-sqlite";
import type { MichelinRestaurantRecord } from "@/utils/db";
import michelinDb from "@/assets/michelin.db";

// Re-export the type for convenience
export type MichelinRestaurant = MichelinRestaurantRecord;

// Cache the database connection and in-flight initialization
let michelinDatabase: SQLite.SQLiteDatabase | null = null;
let michelinDatabaseInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// Types matching the michelin.db schema
interface MichelinDbRestaurant {
  id: number;
  url: string;
  name: string | null;
  description: string;
  address: string;
  location: string;
  latitude: string;
  longitude: string;
  cuisine: string;
  phone_number: string | null;
  facilities_and_services: string | null;
  website_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Get or initialize the Michelin database connection.
 * Copies the bundled asset to document directory if needed.
 */
async function getMichelinDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (michelinDatabase) {
    return michelinDatabase;
  }

  if (michelinDatabaseInitPromise) {
    return michelinDatabaseInitPromise;
  }

  michelinDatabaseInitPromise = (async () => {
    // Load the asset and get its local URI
    const asset = Asset.fromModule(michelinDb);
    await asset.downloadAsync();

    if (!asset.localUri) {
      throw new Error("Could not load Michelin database asset");
    }

    // Create destination file in document directory
    const destFile = new File(Paths.document, "michelin_reference.db");

    // Check if we need to copy
    if (!destFile.exists) {
      console.log("Copying Michelin database to document directory...");
      // Create a source file reference from the asset URI
      const sourceFile = new File(asset.localUri);
      sourceFile.copy(destFile);
    }

    // Open the database read-only
    const database = await SQLite.openDatabaseAsync(
      "michelin_reference.db",
      {
        enableChangeListener: false,
      },
      Paths.document.uri,
    );

    // Set read-only pragmas for performance
    await database.execAsync(`
      PRAGMA query_only = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -64000;
      PRAGMA mmap_size = 134217728;
    `);

    michelinDatabase = database;
    return database;
  })();

  return michelinDatabaseInitPromise;
}

/**
 * Load Michelin restaurants from the bundled SQLite database.
 * Joins restaurants with their latest awards.
 */
export async function loadMichelinRestaurants(
  onProgress?: (loaded: number, total: number) => void,
): Promise<MichelinRestaurant[]> {
  try {
    const db = await getMichelinDatabase();

    // Get total count first for progress reporting
    const countResult = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM restaurants`);
    const total = countResult?.count ?? 0;

    if (onProgress) {
      onProgress(0, total);
    }

    // Query restaurants with their most recent award (by year)
    // Using a subquery to get the latest award for each restaurant
    const rows = await db.getAllAsync<
      MichelinDbRestaurant & {
        latest_distinction: string | null;
        latest_year: number | null;
        has_green_star: number | null;
      }
    >(`
      SELECT 
        r.*,
        a.distinction as latest_distinction,
        a.year as latest_year,
        a.green_star as has_green_star
      FROM restaurants r
      LEFT JOIN (
        SELECT ra.*
        FROM restaurant_awards ra
        INNER JOIN (
          SELECT restaurant_id, MAX(year) as max_year
          FROM restaurant_awards
          GROUP BY restaurant_id
        ) latest ON ra.restaurant_id = latest.restaurant_id AND ra.year = latest.max_year
      ) a ON r.id = a.restaurant_id
      WHERE r.latitude IS NOT NULL 
        AND r.longitude IS NOT NULL
        AND r.latitude != ''
        AND r.longitude != ''
    `);

    const restaurants: MichelinRestaurant[] = [];
    let processed = 0;

    for (const row of rows) {
      const latitude = parseFloat(row.latitude);
      const longitude = parseFloat(row.longitude);

      // Skip invalid coordinates
      if (isNaN(latitude) || isNaN(longitude)) {
        continue;
      }
      if (latitude === 0 && longitude === 0) {
        continue;
      }

      // Format award string (include green star if present)
      let award = row.latest_distinction ?? "";
      if (row.has_green_star) {
        award = award ? `${award}, Green Star` : "Green Star";
      }

      restaurants.push({
        id: `michelin-${row.id}`,
        name: row.name ?? "",
        latitude,
        longitude,
        address: row.address,
        location: row.location,
        cuisine: row.cuisine,
        latestAwardYear: row.latest_year,
        award,
      });

      processed++;
      if (onProgress && processed % 1000 === 0) {
        onProgress(processed, total);
      }
    }

    if (onProgress) {
      onProgress(restaurants.length, total);
    }

    console.log(`Loaded ${restaurants.length} Michelin restaurants from database`);
    return restaurants;
  } catch (error) {
    console.error("Error loading Michelin data:", error);
    return [];
  }
}

// ============================================================================
// AWARD HISTORY
// ============================================================================

/** Award history entry for a single year */
export interface MichelinAward {
  year: number;
  distinction: string;
  price: string;
  greenStar: boolean;
}

/** Full restaurant details from the Michelin database */
export interface MichelinRestaurantDetails {
  id: number;
  name: string;
  description: string;
  address: string;
  location: string;
  latitude: number;
  longitude: number;
  cuisine: string;
  phoneNumber: string | null;
  facilitiesAndServices: string | null;
  websiteUrl: string | null;
  url: string;
  awards: MichelinAward[];
}

/**
 * Get the award for a restaurant at a specific date.
 * Uses the award from the year of the visit, or the closest previous year if not available.
 * Accepts either a single Michelin ID or multiple IDs for the same date.
 * @param michelinId - The michelin ID in format "michelin-{dbId}"
 * @param timestamp - Unix timestamp in milliseconds of the visit date
 * @returns The award string at that time, or null if not found.
 * For array input, returns a map of Michelin ID -> award string/null.
 */
export async function getAwardForDate(michelinId: string, timestamp: number): Promise<string | null>;
export async function getAwardForDate(michelinIds: string[], timestamp: number): Promise<Record<string, string | null>>;
export async function getAwardForDate(
  michelinIdOrIds: string | string[],
  timestamp: number,
): Promise<string | null | Record<string, string | null>> {
  try {
    const isBatch = Array.isArray(michelinIdOrIds);
    const michelinIds = isBatch ? michelinIdOrIds : [michelinIdOrIds];
    const result: Record<string, string | null> = Object.fromEntries(michelinIds.map((id) => [id, null]));

    const parsedIds: Array<{ michelinId: string; dbId: number }> = [];
    for (const michelinId of michelinIds) {
      const match = michelinId.match(/^michelin-(\d+)$/);
      if (!match) {
        continue;
      }
      parsedIds.push({ michelinId, dbId: parseInt(match[1], 10) });
    }

    if (parsedIds.length === 0) {
      return isBatch ? result : null;
    }

    const db = await getMichelinDatabase();
    const visitYear = new Date(timestamp).getFullYear();
    const uniqueDbIds = [...new Set(parsedIds.map((p) => p.dbId))];
    const placeholders = uniqueDbIds.map(() => "?").join(", ");

    // Load all award history rows for the requested restaurants in one query.
    // We then select the latest award <= visitYear in JS, with earliest-year fallback.
    const awardRows = await db.getAllAsync<{
      restaurant_id: number;
      year: number;
      distinction: string | null;
      green_star: number | null;
    }>(
      `SELECT restaurant_id, year, distinction, green_star
       FROM restaurant_awards
       WHERE restaurant_id IN (${placeholders})
       ORDER BY restaurant_id ASC, year ASC`,
      uniqueDbIds,
    );

    const awardsByRestaurantId = new Map<
      number,
      Array<{
        year: number;
        distinction: string | null;
        green_star: number | null;
      }>
    >();
    for (const row of awardRows) {
      const rows = awardsByRestaurantId.get(row.restaurant_id);
      if (rows) {
        rows.push({ year: row.year, distinction: row.distinction, green_star: row.green_star });
      } else {
        awardsByRestaurantId.set(row.restaurant_id, [
          { year: row.year, distinction: row.distinction, green_star: row.green_star },
        ]);
      }
    }

    const formatAward = (award: { distinction: string | null; green_star: number | null }) => {
      let awardStr = award.distinction ?? "";
      if (award.green_star === 1) {
        awardStr = awardStr ? `${awardStr}, Green Star` : "Green Star";
      }
      return awardStr || null;
    };

    for (const { michelinId, dbId } of parsedIds) {
      const awards = awardsByRestaurantId.get(dbId);
      if (!awards || awards.length === 0) {
        result[michelinId] = null;
        continue;
      }

      let selectedAward = awards[0];
      let foundHistoricalMatch = false;
      for (const award of awards) {
        if (award.year > visitYear) {
          break;
        }
        selectedAward = award;
        foundHistoricalMatch = true;
      }

      // If nothing exists at or before the visit year, keep earliest award as fallback.
      result[michelinId] = formatAward(foundHistoricalMatch ? selectedAward : awards[0]);
    }

    return isBatch ? result : (result[michelinIds[0]] ?? null);
  } catch (error) {
    console.error("Error getting award for date:", error);
    if (Array.isArray(michelinIdOrIds)) {
      return Object.fromEntries(michelinIdOrIds.map((id) => [id, null]));
    }
    return null;
  }
}

/**
 * Get detailed restaurant information including full award history.
 * @param michelinId - The michelin ID in format "michelin-{dbId}"
 */
export async function getMichelinRestaurantDetails(michelinId: string): Promise<MichelinRestaurantDetails | null> {
  try {
    // Extract the numeric ID from "michelin-123" format
    const match = michelinId.match(/^michelin-(\d+)$/);
    if (!match) {
      console.warn(`Invalid michelin ID format: ${michelinId}`);
      return null;
    }
    const dbId = parseInt(match[1], 10);

    const db = await getMichelinDatabase();

    // Get restaurant details
    const restaurant = await db.getFirstAsync<MichelinDbRestaurant>(`SELECT * FROM restaurants WHERE id = ?`, [dbId]);

    if (!restaurant) {
      return null;
    }

    // Get all awards for this restaurant, ordered by year descending (newest first)
    const awards = await db.getAllAsync<{
      year: number;
      distinction: string;
      price: string;
      green_star: number | null;
    }>(
      `SELECT year, distinction, price, green_star 
       FROM restaurant_awards 
       WHERE restaurant_id = ? 
       ORDER BY year DESC`,
      [dbId],
    );

    return {
      id: restaurant.id,
      name: restaurant.name ?? "",
      description: restaurant.description,
      address: restaurant.address,
      location: restaurant.location,
      latitude: parseFloat(restaurant.latitude),
      longitude: parseFloat(restaurant.longitude),
      cuisine: restaurant.cuisine,
      phoneNumber: restaurant.phone_number,
      facilitiesAndServices: restaurant.facilities_and_services,
      websiteUrl: restaurant.website_url,
      url: restaurant.url,
      awards: awards.map((a) => ({
        year: a.year,
        distinction: a.distinction,
        price: a.price,
        greenStar: a.green_star === 1,
      })),
    };
  } catch (error) {
    console.error("Error fetching Michelin restaurant details:", error);
    return null;
  }
}
