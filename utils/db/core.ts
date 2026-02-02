import * as SQLite from "expo-sqlite";
import { calculateDistanceMeters } from "@/data/restaurants";
import type { IgnoredLocationRecord } from "./types";
import { invalidateRestaurantIndex } from "./michelin-index";

// Debug timing flag - set to true to enable query timing logs
export const DEBUG_TIMING = __DEV__;

// Default food keywords - these will be prepopulated in the database
const DEFAULT_FOOD_KEYWORDS = [
  "food",
  "dish",
  "meal",
  "cuisine",
  "snack",
  "breakfast",
  "lunch",
  "dinner",
  "brunch",
  "appetizer",
  "dessert",
  "tableware",
  "utensil",
  "salad",
  "soup",
  "sandwich",
  "pizza",
  "pasta",
  "sushi",
  "burger",
  "steak",
  "chicken",
  "fish",
  "seafood",
  "meat",
  "vegetable",
  "fruit",
  "bread",
  "cake",
  "pie",
  "biscuit",
  "chopsticks",
  "baked_goods",
  "cookie",
  "ice_cream",
  "fork",
  "drinking_glass",
  "chocolate",
  "candy",
  "beverage",
  "coffee",
  "tea",
  "wine",
  "beer",
  "cocktail",
  "juice",
  "smoothie",
  "menu",
  "plate",
  "bowl",
  "restaurant",
  "cafe",
  "dining",
  "table_setting",
  "cutlery",
];

let db: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  // Return cached instance if already initialized
  if (db) {
    return db;
  }

  // Return existing initialization promise if in progress (prevents race conditions)
  if (dbInitPromise) {
    return dbInitPromise;
  }

  // Start initialization and cache the promise
  dbInitPromise = (async () => {
    const database = await SQLite.openDatabaseAsync(__DEV__ ? "photo_foodie_dev.db" : "photo_foodie.db");
    await initializeDatabase(database);
    // Auto-reject any pending visits within ignored locations on startup
    await rejectVisitsInIgnoredLocationsInternal(database);
    db = database;
    return database;
  })();

  return dbInitPromise;
}

async function initializeDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
  // Performance PRAGMAs
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;
    PRAGMA mmap_size = 268435456;
    PRAGMA auto_vacuum = NONE;
    PRAGMA secure_delete = OFF;
    PRAGMA wal_autocheckpoint = 10000;
    PRAGMA foreign_keys = ON;
  `);

  await database.execAsync(`
    -- Michelin reference data (read-only, ~15k restaurants)
    CREATE TABLE IF NOT EXISTS michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      cuisine TEXT NOT NULL DEFAULT '',
      award TEXT NOT NULL DEFAULT ''
    );
    
    -- User's confirmed restaurants (only populated when user confirms a visit)
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      googlePlaceId TEXT,
      cuisine TEXT,
      priceLevel INTEGER,
      rating REAL,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL DEFAULT 0,
      foodProbable INTEGER NOT NULL DEFAULT 0,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      notes TEXT,
      updatedAt INTEGER,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );
    
    -- Multiple suggested restaurants per visit (for when there are multiple nearby matches)
    CREATE TABLE IF NOT EXISTS visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );
    
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_photos_creation_time ON photos(creationTime);
    CREATE INDEX IF NOT EXISTS idx_photos_visit ON photos(visitId);
    CREATE INDEX IF NOT EXISTS idx_photos_location ON photos(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_photos_food ON photos(foodDetected);
    CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
    CREATE INDEX IF NOT EXISTS idx_visits_food ON visits(foodProbable);
    CREATE INDEX IF NOT EXISTS idx_visits_suggested ON visits(suggestedRestaurantId);
    CREATE INDEX IF NOT EXISTS idx_michelin_location ON michelin_restaurants(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_visit_suggested_restaurants_visit ON visit_suggested_restaurants(visitId);
    CREATE INDEX IF NOT EXISTS idx_visit_suggested_restaurants_restaurant ON visit_suggested_restaurants(restaurantId);
    
    -- Optimized composite indexes for getPendingVisitsForReview query
    -- Covers the ranked_photos CTE: ORDER BY foodDetected, creationTime per visit
    CREATE INDEX IF NOT EXISTS idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    
    -- Covers pending visits filter + priority ordering
    CREATE INDEX IF NOT EXISTS idx_visits_pending_priority ON visits(status, foodProbable DESC, suggestedRestaurantId, startTime DESC);
    
    -- Covers suggested restaurants lookup with distance ordering
    CREATE INDEX IF NOT EXISTS idx_visit_suggested_distance ON visit_suggested_restaurants(visitId, distance);
    
    -- Partial index for food labels query (only photos with food detected and labels)
    CREATE INDEX IF NOT EXISTS idx_photos_food_labels ON photos(visitId) WHERE foodDetected = 1 AND foodLabels IS NOT NULL;

    -- Ignored locations (user can skip/ignore locations to hide all visits there)
    CREATE TABLE IF NOT EXISTS ignored_locations (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius REAL NOT NULL DEFAULT 100,
      name TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ignored_locations_coords ON ignored_locations(latitude, longitude);

    -- Composite index for status-filtered time-ordered queries (getVisits, getVisitsWithDetails)
    CREATE INDEX IF NOT EXISTS idx_visits_status_time ON visits(status, startTime DESC);

    -- Composite index for restaurant-specific queries (getVisitsByRestaurantId, getConfirmedRestaurantsWithVisits)
    CREATE INDEX IF NOT EXISTS idx_visits_restaurant_status_time ON visits(restaurantId, status, startTime DESC);

    -- Composite index for food-filtered time-ordered queries
    CREATE INDEX IF NOT EXISTS idx_visits_food_time ON visits(foodProbable, startTime DESC);

    -- Partial index for unvisited photos with location (getUnvisitedPhotos)
    CREATE INDEX IF NOT EXISTS idx_photos_unvisited_with_location ON photos(creationTime) 
      WHERE visitId IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

    -- General time index for visits (getMergeableVisits, getWrappedStats)
    CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(startTime);

    -- Dismissed calendar events (calendar events the user doesn't want to import)
    CREATE TABLE IF NOT EXISTS dismissed_calendar_events (
      calendarEventId TEXT PRIMARY KEY,
      dismissedAt INTEGER NOT NULL
    );

    -- Food keywords for customizable food detection
    CREATE TABLE IF NOT EXISTS food_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      isBuiltIn INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_food_keywords_enabled ON food_keywords(enabled);
  `);

  // Migration: Add exportedToCalendarId column to track which calendar we exported events to
  // This allows us to identify and delete exported events later
  try {
    await database.execAsync(`ALTER TABLE visits ADD COLUMN exportedToCalendarId TEXT`);
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add awardAtVisit column to store the restaurant's Michelin award at the time of visit
  // This allows historical accuracy - if a restaurant was 2 stars when visited but is now 3 stars,
  // it should show as 2 stars for that visit
  try {
    await database.execAsync(`ALTER TABLE visits ADD COLUMN awardAtVisit TEXT`);
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add allLabels column to store all classifier labels (not just food-related)
  try {
    await database.execAsync(`ALTER TABLE photos ADD COLUMN allLabels TEXT`);
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add mediaType column to distinguish between photos and videos
  try {
    await database.execAsync(`ALTER TABLE photos ADD COLUMN mediaType TEXT DEFAULT 'photo'`);
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add duration column for video assets
  try {
    await database.execAsync(`ALTER TABLE photos ADD COLUMN duration REAL`);
  } catch {
    // Column already exists, ignore
  }

  // Prepopulate food_keywords table with default keywords if empty
  await prepopulateFoodKeywords(database);
}

/**
 * Prepopulate the food_keywords table with default keywords if it's empty.
 */
async function prepopulateFoodKeywords(database: SQLite.SQLiteDatabase): Promise<void> {
  const count = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM food_keywords`);
  if (count && count.count > 0) {
    return; // Already populated
  }

  const now = Date.now();
  const batchSize = 50;

  for (let i = 0; i < DEFAULT_FOOD_KEYWORDS.length; i += batchSize) {
    const batch = DEFAULT_FOOD_KEYWORDS.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, 1, 1, ?)").join(", ");
    const values = batch.flatMap((keyword) => [keyword, now]);

    await database.runAsync(
      `INSERT OR IGNORE INTO food_keywords (keyword, enabled, isBuiltIn, createdAt) VALUES ${placeholders}`,
      values,
    );
  }
}

/**
 * Internal helper to reject visits within ignored locations (accepts database to avoid circular deps)
 */
export async function rejectVisitsInIgnoredLocationsInternal(database: SQLite.SQLiteDatabase): Promise<number> {
  // Get all ignored locations
  const ignoredLocations = await database.getAllAsync<IgnoredLocationRecord>(`SELECT * FROM ignored_locations`);
  if (ignoredLocations.length === 0) {
    return 0;
  }

  // Get all pending visits with their coordinates
  const pendingVisits = await database.getAllAsync<{ id: string; centerLat: number; centerLon: number }>(
    `SELECT id, centerLat, centerLon FROM visits WHERE status = 'pending'`,
  );

  if (pendingVisits.length === 0) {
    return 0;
  }

  // Find visits that fall within any ignored location (using JS distance calculation)
  const visitsToReject: string[] = [];
  for (const visit of pendingVisits) {
    for (const loc of ignoredLocations) {
      const distance = calculateDistanceMeters(visit.centerLat, visit.centerLon, loc.latitude, loc.longitude);
      if (distance <= loc.radius) {
        visitsToReject.push(visit.id);
        break; // Already matched, no need to check other locations
      }
    }
  }

  if (visitsToReject.length === 0) {
    return 0;
  }

  // Update visits to rejected by their IDs
  const placeholders = visitsToReject.map(() => "?").join(", ");
  const result = await database.runAsync(
    `UPDATE visits SET status = 'rejected' WHERE id IN (${placeholders})`,
    visitsToReject,
  );

  return result.changes;
}

// Nuke database completely - drops all tables and recreates them fresh
export async function nukeDatabase(): Promise<void> {
  const database = await getDatabase();

  // Drop all tables in correct order (respecting foreign keys)
  await database.execAsync(`
    PRAGMA foreign_keys = OFF;
    
    DROP TABLE IF EXISTS visit_suggested_restaurants;
    DROP TABLE IF EXISTS photos;
    DROP TABLE IF EXISTS visits;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS michelin_restaurants;
    DROP TABLE IF EXISTS ignored_locations;
    
    PRAGMA foreign_keys = ON;
  `);

  // Reset the module-level db reference so initializeDatabase runs again
  db = null;
  dbInitPromise = null;

  // Invalidate spatial index since Michelin data is wiped
  invalidateRestaurantIndex();

  // Reinitialize the database with fresh tables
  await getDatabase();
}

/**
 * Perform database maintenance operations to optimize performance and reclaim space.
 * Should be called after large batch operations like scanning.
 *
 * Operations:
 * - WAL checkpoint: Forces WAL file to be written to main database (using PASSIVE mode to avoid locks)
 * - ANALYZE: Updates query planner statistics for better query optimization
 *
 * Note: VACUUM is intentionally excluded from regular maintenance because:
 * - It requires exclusive database access and fails if any statements are active
 * - It's a heavy operation that rebuilds the entire database file
 * - In WAL mode with EXCLUSIVE locking, it can cause "database is locked" errors
 * - Call performFullMaintenance() separately when the app is idle for VACUUM
 */
export async function performDatabaseMaintenance(): Promise<{
  walCheckpoint: boolean;
  vacuum: boolean;
  analyze: boolean;
}> {
  const database = await getDatabase();
  const results = { walCheckpoint: false, vacuum: false, analyze: false };

  const start = DEBUG_TIMING ? performance.now() : 0;

  try {
    // Use PASSIVE checkpoint mode - it won't block and won't fail if there are active readers
    // This checkpoints as much as possible without waiting for locks
    await database.execAsync(`PRAGMA wal_checkpoint(PASSIVE);`);
    results.walCheckpoint = true;
  } catch (error) {
    console.warn("[DB] WAL checkpoint failed:", error);
  }

  try {
    // ANALYZE updates statistics used by the query planner
    // This helps SQLite choose optimal query execution plans
    await database.execAsync(`ANALYZE;`);
    results.analyze = true;
  } catch (error) {
    console.warn("[DB] ANALYZE failed:", error);
  }

  if (DEBUG_TIMING) {
    console.log(`[DB] performDatabaseMaintenance: ${(performance.now() - start).toFixed(2)}ms`);
  }

  return results;
}

/**
 * Perform full database maintenance including VACUUM.
 * This is a heavier operation that should only be called when the app is idle
 * and no other database operations are in progress.
 *
 * VACUUM rebuilds the database file:
 * - Reclaims space from deleted records
 * - Defragments the database for faster reads
 * - Reduces file size
 *
 * Note: This can fail with "database is locked" if called while other operations
 * are in progress. Best called on app background or after extended idle time.
 */
export async function performFullMaintenance(): Promise<{
  walCheckpoint: boolean;
  vacuum: boolean;
  analyze: boolean;
}> {
  const database = await getDatabase();
  const results = { walCheckpoint: false, vacuum: false, analyze: false };

  const start = DEBUG_TIMING ? performance.now() : 0;

  try {
    // Force WAL checkpoint with TRUNCATE mode before VACUUM
    await database.execAsync(`PRAGMA wal_checkpoint(TRUNCATE);`);
    results.walCheckpoint = true;
  } catch (error) {
    console.warn("[DB] WAL checkpoint failed:", error);
  }

  try {
    await database.execAsync(`VACUUM;`);
    results.vacuum = true;
  } catch (error) {
    console.warn("[DB] VACUUM failed (this is expected if database is busy):", error);
  }

  try {
    await database.execAsync(`ANALYZE;`);
    results.analyze = true;
  } catch (error) {
    console.warn("[DB] ANALYZE failed:", error);
  }

  if (DEBUG_TIMING) {
    console.log(`[DB] performFullMaintenance: ${(performance.now() - start).toFixed(2)}ms`);
  }

  return results;
}
