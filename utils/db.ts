import * as SQLite from "expo-sqlite";
import KDBush from "kdbush";
import * as geokdbush from "geokdbush";
import { calculateDistanceMeters } from "@/data/restaurants";
import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";

// Debug timing flag - set to true to enable query timing logs
const DEBUG_TIMING = __DEV__;

export interface FoodLabel {
  label: string;
  confidence: number;
}

export interface PhotoRecord {
  id: string;
  uri: string;
  creationTime: number;
  latitude: number | null;
  longitude: number | null;
  visitId: string | null;
  foodDetected: boolean | null;
  foodLabels: FoodLabel[] | null | undefined;
  foodConfidence: number | null | undefined;
  /** All classification labels returned by the ML classifier (not just food-related) */
  allLabels: FoodLabel[] | null | undefined;
}

export interface VisitRecord {
  id: string;
  restaurantId: string | null;
  suggestedRestaurantId: string | null;
  status: "pending" | "confirmed" | "rejected";
  startTime: number;
  endTime: number;
  centerLat: number;
  centerLon: number;
  photoCount: number;
  foodProbable: boolean;
  // Calendar event metadata (from imported calendar events)
  calendarEventId: string | null;
  calendarEventTitle: string | null;
  calendarEventLocation: string | null;
  calendarEventIsAllDay: boolean | null;
  // Exported calendar event tracking (events WE created)
  exportedToCalendarId: string | null;
  // User notes
  notes: string | null;
  // Timestamps
  updatedAt: number | null;
  // Historical Michelin award at the time of visit (for confirmed visits)
  awardAtVisit: string | null;
}

export interface MichelinRestaurantRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  location: string;
  cuisine: string;
  award: string;
}

export interface RestaurantRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  // Extended fields
  address: string | null;
  phone: string | null;
  website: string | null;
  googlePlaceId: string | null;
  cuisine: string | null;
  priceLevel: number | null;
  rating: number | null;
  notes: string | null;
}

export interface VisitSuggestedRestaurant {
  visitId: string;
  restaurantId: string;
  distance: number;
}

export interface IgnoredLocationRecord {
  id: string;
  latitude: number;
  longitude: number;
  radius: number; // in meters
  name: string | null;
  createdAt: number;
}

export interface FoodKeywordRecord {
  id: number;
  keyword: string;
  enabled: boolean;
  isBuiltIn: boolean;
  createdAt: number;
}

// Default food keywords - these will be prepopulated in the database
export const DEFAULT_FOOD_KEYWORDS = [
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
  "cookie",
  "ice_cream",
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

// Spatial index cache for Michelin restaurants
let restaurantIndex: KDBush | null = null;
let indexedRestaurants: MichelinRestaurantRecord[] = [];

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) {
    return db;
  }
  db = await SQLite.openDatabaseAsync("photo_foodie.db");
  await initializeDatabase(db);
  // Auto-reject any pending visits within ignored locations on startup
  await rejectVisitsInIgnoredLocationsInternal(db);
  return db;
}

async function initializeDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
  // Performance PRAGMAs
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;
    PRAGMA mmap_size = 268435456;
    PRAGMA locking_mode = EXCLUSIVE;
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

// Raw photo record as stored in database (foodLabels and allLabels are JSON strings)
interface RawPhotoRecord extends Omit<PhotoRecord, "foodLabels" | "foodDetected" | "allLabels"> {
  foodLabels: string | null;
  foodDetected: number | null;
  allLabels: string | null;
}

// Helper to parse raw database photo record into proper PhotoRecord
function parsePhotoRecord(raw: RawPhotoRecord): PhotoRecord {
  let foodLabels: FoodLabel[] | null = null;
  if (raw.foodLabels) {
    try {
      foodLabels = JSON.parse(raw.foodLabels) as FoodLabel[];
    } catch {
      // Skip malformed JSON
    }
  }

  let allLabels: FoodLabel[] | null = null;
  if (raw.allLabels) {
    try {
      allLabels = JSON.parse(raw.allLabels) as FoodLabel[];
    } catch {
      // Skip malformed JSON
    }
  }

  return {
    ...raw,
    foodDetected: raw.foodDetected === null ? null : raw.foodDetected === 1,
    foodLabels,
    allLabels,
  };
}

// Photo operations
export async function insertPhotos(
  photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence" | "allLabels">[],
): Promise<void> {
  if (photos.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  for (let i = 0; i < photos.length; i += batchSize) {
    const batch = photos.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((p) => [p.id, p.uri, p.creationTime, p.latitude, p.longitude]);

    // foodDetected is left as NULL (not set until food detection runs)
    await database.runAsync(
      `INSERT OR IGNORE INTO photos (id, uri, creationTime, latitude, longitude) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function getUnvisitedPhotos(): Promise<PhotoRecord[]> {
  const database = await getDatabase();
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE visitId IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY creationTime ASC`,
  );
  return rawPhotos.map(parsePhotoRecord);
}

export async function getPhotosByVisitId(visitId: string): Promise<PhotoRecord[]> {
  const database = await getDatabase();
  // Order by food detected first (1 = food, 0 = no food, NULL = unknown), then by creation time
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE visitId = ? ORDER BY 
      CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC,
      creationTime ASC`,
    [visitId],
  );
  return rawPhotos.map(parsePhotoRecord);
}

/**
 * Get all photo IDs
 */
export async function getAllPhotoIds(): Promise<{ id: string }[]> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string }>(`SELECT id FROM photos`);
}

export async function getTotalPhotoCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM photos`);
  return result?.count ?? 0;
}

export async function getVisitablePhotoCounts(): Promise<{
  total: number;
  visited: number;
  unvisited: number;
}> {
  const database = await getDatabase();
  const total = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
  );
  const visited = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE visitId IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL`,
  );
  return {
    total: total?.count ?? 0,
    visited: visited?.count ?? 0,
    unvisited: (total?.count ?? 0) - (visited?.count ?? 0),
  };
}

// Visit operations
export async function insertVisits(visits: Omit<VisitRecord, "photoCount" | "foodProbable">[]): Promise<void> {
  if (visits.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;
  const now = Date.now();

  for (let i = 0; i < visits.length; i += batchSize) {
    const batch = visits.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((v) => [
      v.id,
      v.restaurantId,
      v.suggestedRestaurantId,
      v.status,
      v.startTime,
      v.endTime,
      v.centerLat,
      v.centerLon,
      v.calendarEventId,
      v.calendarEventTitle,
      v.calendarEventLocation,
      v.calendarEventIsAllDay !== null ? (v.calendarEventIsAllDay ? 1 : 0) : null,
      now,
    ]);

    await database.runAsync(
      `INSERT OR REPLACE INTO visits (id, restaurantId, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon, photoCount, foodProbable, calendarEventId, calendarEventTitle, calendarEventLocation, calendarEventIsAllDay, updatedAt) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function batchUpdatePhotoVisits(updates: { photoIds: string[]; visitId: string }[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Flatten all updates into a single query using CASE WHEN
  const allPhotoIds: string[] = [];
  const caseStatements: string[] = [];

  for (const { photoIds, visitId } of updates) {
    for (const photoId of photoIds) {
      allPhotoIds.push(photoId);
      caseStatements.push(`WHEN id = '${photoId.replace(/'/g, "''")}' THEN '${visitId.replace(/'/g, "''")}'`);
    }
  }

  if (allPhotoIds.length === 0) {
    return;
  }

  // Process in batches to avoid SQLite limits
  const batchSize = 1000;
  for (let i = 0; i < allPhotoIds.length; i += batchSize) {
    const batchPhotoIds = allPhotoIds.slice(i, i + batchSize);
    const batchCases = caseStatements.slice(i, i + batchSize);
    const placeholders = batchPhotoIds.map(() => "?").join(", ");

    await database.runAsync(
      `UPDATE photos SET visitId = CASE ${batchCases.join(" ")} END WHERE id IN (${placeholders})`,
      batchPhotoIds,
    );
  }
}

export async function batchUpdateVisitPhotoCounts(): Promise<void> {
  const database = await getDatabase();

  // Update all visit photo counts in a single query
  await database.runAsync(
    `UPDATE visits SET photoCount = (
      SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id
    )`,
  );
}

export async function syncAllVisitsFoodProbable(): Promise<void> {
  const database = await getDatabase();

  // Update all visits' foodProbable based on whether any of their photos have foodDetected = true
  await database.runAsync(
    `UPDATE visits SET foodProbable = COALESCE(
      (SELECT MAX(foodDetected) FROM photos WHERE photos.visitId = visits.id),
      0
    )`,
  );
}

export async function batchUpdatePhotosFoodDetected(
  updates: {
    photoId: string;
    foodDetected: boolean;
    foodLabels?: FoodLabel[];
    foodConfidence?: number;
    allLabels?: FoodLabel[];
  }[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // For updates with labels/confidence/allLabels, we need to update individually
  const updatesWithLabels = updates.filter(
    (u) => u.foodLabels !== undefined || u.foodConfidence !== undefined || u.allLabels !== undefined,
  );
  const simpleUpdates = updates.filter(
    (u) => u.foodLabels === undefined && u.foodConfidence === undefined && u.allLabels === undefined,
  );

  // Update photos with labels individually
  for (const update of updatesWithLabels) {
    await database.runAsync(
      `UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ?, allLabels = ? WHERE id = ?`,
      [
        update.foodDetected ? 1 : 0,
        update.foodLabels ? JSON.stringify(update.foodLabels) : null,
        update.foodConfidence ?? null,
        update.allLabels ? JSON.stringify(update.allLabels) : null,
        update.photoId,
      ],
    );
  }

  // For simple updates (no labels), batch by detected/not detected
  if (simpleUpdates.length > 0) {
    const detectedIds = simpleUpdates.filter((u) => u.foodDetected).map((u) => u.photoId);
    const notDetectedIds = simpleUpdates.filter((u) => !u.foodDetected).map((u) => u.photoId);

    const batchSize = 1000;

    // Update detected photos
    for (let i = 0; i < detectedIds.length; i += batchSize) {
      const batch = detectedIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      await database.runAsync(`UPDATE photos SET foodDetected = 1 WHERE id IN (${placeholders})`, batch);
    }

    // Update not detected photos
    for (let i = 0; i < notDetectedIds.length; i += batchSize) {
      const batch = notDetectedIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      await database.runAsync(`UPDATE photos SET foodDetected = 0 WHERE id IN (${placeholders})`, batch);
    }
  }
}

export interface CalendarEventUpdate {
  visitId: string;
  calendarEventId: string;
  calendarEventTitle: string;
  calendarEventLocation: string | null;
  calendarEventIsAllDay: boolean;
}

export async function batchUpdateVisitsCalendarEvents(updates: CalendarEventUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Update each visit individually since each has different calendar data
  for (const update of updates) {
    await database.runAsync(
      `UPDATE visits SET 
        calendarEventId = ?, 
        calendarEventTitle = ?, 
        calendarEventLocation = ?, 
        calendarEventIsAllDay = ? 
      WHERE id = ?`,
      [
        update.calendarEventId,
        update.calendarEventTitle,
        update.calendarEventLocation,
        update.calendarEventIsAllDay ? 1 : 0,
        update.visitId,
      ],
    );
  }
}

/**
 * Get visits that don't have calendar event data yet.
 * Used for enriching visits with calendar metadata.
 */
export async function getVisitsWithoutCalendarData(): Promise<
  Array<{ id: string; startTime: number; endTime: number }>
> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string; startTime: number; endTime: number }>(
    `SELECT id, startTime, endTime FROM visits WHERE calendarEventId IS NULL ORDER BY startTime DESC`,
  );
}

/**
 * Get all calendar event IDs that are already linked to visits.
 * Used to avoid creating duplicate visits from calendar events.
 */
export async function getLinkedCalendarEventIds(): Promise<Set<string>> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ calendarEventId: string }>(
    `SELECT calendarEventId FROM visits WHERE calendarEventId IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.calendarEventId));
}

/**
 * Get all dismissed calendar event IDs.
 * These are events the user has chosen not to import.
 */
export async function getDismissedCalendarEventIds(): Promise<Set<string>> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ calendarEventId: string }>(
    `SELECT calendarEventId FROM dismissed_calendar_events`,
  );
  return new Set(rows.map((r) => r.calendarEventId));
}

/**
 * Dismiss calendar events (mark them as not to be imported).
 */
export async function dismissCalendarEvents(calendarEventIds: string[]): Promise<void> {
  if (calendarEventIds.length === 0) {
    return;
  }

  const database = await getDatabase();
  const now = Date.now();
  const batchSize = 1000;

  for (let i = 0; i < calendarEventIds.length; i += batchSize) {
    const batch = calendarEventIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?)").join(", ");
    const values = batch.flatMap((id) => [id, now]);

    await database.runAsync(
      `INSERT OR IGNORE INTO dismissed_calendar_events (calendarEventId, dismissedAt) VALUES ${placeholders}`,
      values,
    );
  }
}

/**
 * Undismiss a calendar event (remove from dismissed list).
 */
export async function undismissCalendarEvent(calendarEventId: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`DELETE FROM dismissed_calendar_events WHERE calendarEventId = ?`, [calendarEventId]);
}

/**
 * Insert calendar-only visits (visits created from calendar events without photos).
 * These visits have photoCount = 0 and get their location from the matched restaurant.
 * If a matched restaurant is provided, the visit is auto-confirmed with that restaurant.
 */
export async function insertCalendarOnlyVisits(
  visits: Array<{
    id: string;
    calendarEventId: string;
    calendarEventTitle: string;
    calendarEventLocation: string | null;
    startTime: number;
    endTime: number;
    centerLat: number;
    centerLon: number;
    // Full restaurant data for auto-confirmation (from Michelin match)
    matchedRestaurant: {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      address: string;
      cuisine: string;
    } | null;
  }>,
): Promise<void> {
  if (visits.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;
  const now = Date.now();

  // First, insert/update restaurants for visits that have a matched restaurant
  const visitsWithRestaurant = visits.filter((v) => v.matchedRestaurant !== null);
  if (visitsWithRestaurant.length > 0) {
    for (let i = 0; i < visitsWithRestaurant.length; i += batchSize) {
      const batch = visitsWithRestaurant.slice(i, i + batchSize);
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const values = batch.flatMap((v) => [
        v.matchedRestaurant!.id,
        v.matchedRestaurant!.name,
        v.matchedRestaurant!.latitude,
        v.matchedRestaurant!.longitude,
        v.matchedRestaurant!.address || null,
        v.matchedRestaurant!.cuisine || null,
      ]);

      await database.runAsync(
        `INSERT OR IGNORE INTO restaurants (id, name, latitude, longitude, address, cuisine) VALUES ${placeholders}`,
        values,
      );
    }
  }

  // Then insert visits - auto-confirm if we have a matched restaurant
  for (let i = 0; i < visits.length; i += batchSize) {
    const batch = visits.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?)").join(", ");
    const values = batch.flatMap((v) => [
      v.id,
      v.matchedRestaurant?.id ?? null, // restaurantId - links to restaurants table for confirmed
      v.matchedRestaurant?.id ?? null, // suggestedRestaurantId - links to michelin_restaurants
      v.matchedRestaurant ? "confirmed" : "pending", // auto-confirm if we have a restaurant match
      v.startTime,
      v.endTime,
      v.centerLat,
      v.centerLon,
      v.calendarEventId,
      v.calendarEventTitle,
      v.calendarEventLocation,
      now,
    ]);

    await database.runAsync(
      `INSERT OR IGNORE INTO visits (id, restaurantId, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon, photoCount, foodProbable, calendarEventId, calendarEventTitle, calendarEventLocation, calendarEventIsAllDay, updatedAt) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function getVisits(filter?: "pending" | "confirmed" | "rejected" | "food"): Promise<VisitRecord[]> {
  const database = await getDatabase();
  if (filter === "food") {
    return database.getAllAsync<VisitRecord>(`SELECT * FROM visits WHERE foodProbable = 1 ORDER BY startTime DESC`);
  }
  if (filter) {
    return database.getAllAsync<VisitRecord>(`SELECT * FROM visits WHERE status = ? ORDER BY startTime DESC`, [filter]);
  }
  return database.getAllAsync<VisitRecord>(`SELECT * FROM visits ORDER BY startTime DESC`);
}

export type VisitWithDetails = VisitRecord & {
  restaurantName: string | null;
  suggestedRestaurantName: string | null;
  suggestedRestaurantAward: string | null;
  previewPhotos: string[];
  // Calendar event fields are inherited from VisitRecord
};

export async function getVisitsWithDetails(
  filter?: "pending" | "confirmed" | "rejected" | "food",
): Promise<VisitWithDetails[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Build WHERE clause based on filter
  let whereClause = "";
  const params: (string | number)[] = [];
  if (filter === "food") {
    whereClause = "WHERE c.foodProbable = 1";
  } else if (filter) {
    whereClause = "WHERE c.status = ?";
    params.push(filter);
  }

  // Single query joining visits with both restaurants tables
  // For confirmed visits, use awardAtVisit (historical) if available, otherwise fall back to current award
  const visits = await database.getAllAsync<
    VisitRecord & {
      restaurantName: string | null;
      suggestedRestaurantName: string | null;
      suggestedRestaurantAward: string | null;
    }
  >(
    `SELECT c.*, 
            r.name as restaurantName,
            m.name as suggestedRestaurantName,
            COALESCE(c.awardAtVisit, m.award) as suggestedRestaurantAward
     FROM visits c
     LEFT JOIN restaurants r ON c.restaurantId = r.id
     LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
     ${whereClause}
     ORDER BY c.startTime DESC`,
    params,
  );

  if (visits.length === 0) {
    if (DEBUG_TIMING) {
      console.log(
        `[DB] getVisitsWithDetails(${filter ?? "all"}): ${(performance.now() - start).toFixed(2)}ms (0 results)`,
      );
    }
    return [];
  }

  // Get preview photos for all visits in one query using a subquery to limit to 3 per visit
  // Order by food detected first (food photos have priority), then by creation time
  const visitIds = visits.map((c) => c.id);
  const placeholders = visitIds.map(() => "?").join(", ");

  const previewPhotos = await database.getAllAsync<{ visitId: string; uri: string }>(
    `SELECT visitId, uri FROM (
      SELECT visitId, uri, ROW_NUMBER() OVER (
        PARTITION BY visitId 
        ORDER BY CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC, creationTime ASC
      ) as rn
      FROM photos
      WHERE visitId IN (${placeholders})
    ) WHERE rn <= 3
    ORDER BY rn ASC`,
    visitIds,
  );

  // Group photos by visitId
  const photosByVisit = new Map<string, string[]>();
  for (const photo of previewPhotos) {
    const existing = photosByVisit.get(photo.visitId) ?? [];
    existing.push(photo.uri);
    photosByVisit.set(photo.visitId, existing);
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getVisitsWithDetails(${filter ?? "all"}): ${(performance.now() - start).toFixed(2)}ms (${visits.length} results)`,
    );
  }

  // Combine results
  return visits.map((visit) => ({
    ...visit,
    previewPhotos: photosByVisit.get(visit.id) ?? [],
  }));
}

export interface VisitForCalendarExport {
  id: string;
  restaurantName: string;
  startTime: number;
  endTime: number;
  address: string | null;
  notes: string | null;
}

/**
 * Get confirmed visits that don't have an associated calendar event.
 * These are visits that could be exported to the user's calendar.
 */
export async function getConfirmedVisitsWithoutCalendarEvents(): Promise<VisitForCalendarExport[]> {
  const database = await getDatabase();

  return database.getAllAsync<VisitForCalendarExport>(
    `SELECT 
      v.id,
      r.name as restaurantName,
      v.startTime,
      v.endTime,
      r.address,
      v.notes
    FROM visits v
    JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.status = 'confirmed' 
      AND v.calendarEventId IS NULL
      AND v.restaurantId IS NOT NULL
    ORDER BY v.startTime DESC`,
  );
}

export interface ExportedCalendarEvent {
  visitId: string;
  calendarEventId: string;
  exportedToCalendarId: string;
  restaurantName: string;
  startTime: number;
}

/**
 * Get visits that have calendar events WE created (not imported).
 * These can be deleted from the calendar by the user.
 */
export async function getVisitsWithExportedCalendarEvents(): Promise<ExportedCalendarEvent[]> {
  const database = await getDatabase();

  return database.getAllAsync<ExportedCalendarEvent>(
    `SELECT 
      v.id as visitId,
      v.calendarEventId,
      v.exportedToCalendarId,
      COALESCE(r.name, v.calendarEventTitle, 'Unknown') as restaurantName,
      v.startTime
    FROM visits v
    LEFT JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.exportedToCalendarId IS NOT NULL
      AND v.calendarEventId IS NOT NULL
    ORDER BY v.startTime DESC`,
  );
}

/**
 * Clear exported calendar event data from visits after deletion.
 * This removes the calendarEventId and exportedToCalendarId but keeps the visit.
 */
export async function clearExportedCalendarEvents(visitIds: string[]): Promise<void> {
  if (visitIds.length === 0) {
    return;
  }

  const database = await getDatabase();
  const now = Date.now();
  const placeholders = visitIds.map(() => "?").join(", ");

  await database.runAsync(
    `UPDATE visits 
     SET calendarEventId = NULL, 
         calendarEventTitle = NULL, 
         exportedToCalendarId = NULL, 
         updatedAt = ? 
     WHERE id IN (${placeholders})`,
    [now, ...visitIds],
  );
}

/**
 * Batch update visits with calendar event information.
 * When exportedToCalendarId is provided, it indicates we created this event (vs imported).
 */
export async function batchUpdateVisitCalendarEvents(
  updates: Array<{
    visitId: string;
    calendarEventId: string;
    calendarEventTitle: string;
    exportedToCalendarId?: string;
  }>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();
  const now = Date.now();

  // Use a transaction for batch updates
  await database.withExclusiveTransactionAsync(async (tx) => {
    for (const update of updates) {
      if (update.exportedToCalendarId) {
        // We created this event - track which calendar it's in
        await tx.runAsync(
          `UPDATE visits 
           SET calendarEventId = ?, calendarEventTitle = ?, exportedToCalendarId = ?, updatedAt = ? 
           WHERE id = ?`,
          [update.calendarEventId, update.calendarEventTitle, update.exportedToCalendarId, now, update.visitId],
        );
      } else {
        // Imported event - don't set exportedToCalendarId
        await tx.runAsync(
          `UPDATE visits 
           SET calendarEventId = ?, calendarEventTitle = ?, updatedAt = ? 
           WHERE id = ?`,
          [update.calendarEventId, update.calendarEventTitle, now, update.visitId],
        );
      }
    }
  });
}

export async function getVisitById(id: string): Promise<VisitRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<VisitRecord>(`SELECT * FROM visits WHERE id = ?`, [id]);
}

export async function updateVisitStatus(id: string, status: "pending" | "confirmed" | "rejected"): Promise<void> {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(`UPDATE visits SET status = ?, updatedAt = ? WHERE id = ?`, [status, now, id]);
}

export async function updateVisitNotes(id: string, notes: string | null): Promise<void> {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(`UPDATE visits SET notes = ?, updatedAt = ? WHERE id = ?`, [notes, now, id]);
}

// Visit suggested restaurants operations (multiple suggestions per visit)
export async function insertVisitSuggestedRestaurants(suggestions: VisitSuggestedRestaurant[]): Promise<void> {
  if (suggestions.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  for (let i = 0; i < suggestions.length; i += batchSize) {
    const batch = suggestions.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
    const values = batch.flatMap((s) => [s.visitId, s.restaurantId, s.distance]);

    await database.runAsync(
      `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function getSuggestedRestaurantsForVisits(
  visitIds: string[],
): Promise<Map<string, Array<MichelinRestaurantRecord & { distance: number }>>> {
  if (visitIds.length === 0) {
    return new Map();
  }

  const database = await getDatabase();
  const placeholders = visitIds.map(() => "?").join(", ");

  const results = await database.getAllAsync<MichelinRestaurantRecord & { distance: number; visitId: string }>(
    `SELECT m.*, vsr.distance, vsr.visitId
     FROM visit_suggested_restaurants vsr
     JOIN michelin_restaurants m ON vsr.restaurantId = m.id
     WHERE vsr.visitId IN (${placeholders})
     ORDER BY vsr.visitId, vsr.distance ASC`,
    visitIds,
  );

  const grouped = new Map<string, Array<MichelinRestaurantRecord & { distance: number }>>();
  for (const row of results) {
    const { visitId, ...restaurant } = row;
    const existing = grouped.get(visitId) ?? [];
    existing.push(restaurant);
    grouped.set(visitId, existing);
  }

  return grouped;
}

export async function batchUpdateVisitSuggestedRestaurants(
  updates: { visitId: string; suggestedRestaurantId: string }[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Update in batches
  const batchSize = 500;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);

    // Use CASE WHEN for batch update
    const whenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
    const visitIds = batch.map((u) => u.visitId);
    const values = batch.flatMap((u) => [u.visitId, u.suggestedRestaurantId]);
    const placeholders = visitIds.map(() => "?").join(", ");

    await database.runAsync(
      `UPDATE visits SET suggestedRestaurantId = CASE id ${whenClauses} END WHERE id IN (${placeholders})`,
      [...values, ...visitIds],
    );
  }
}

export async function getVisitsNeedingFoodDetection(): Promise<VisitRecord[]> {
  const database = await getDatabase();
  // Get visits that haven't had food detection run yet (no photos with foodDetected set)
  return database.getAllAsync<VisitRecord>(
    `SELECT v.* FROM visits v
     WHERE NOT EXISTS (
       SELECT 1 FROM photos p WHERE p.visitId = v.id AND p.foodDetected IS NOT NULL
     )
     ORDER BY v.startTime DESC`,
  );
}

/**
 * Get confirmed visits with their linked Michelin restaurant IDs and times.
 * Used to filter out calendar events that already have confirmed visits.
 */
export interface ConfirmedVisitForCalendarFilter {
  visitId: string;
  michelinRestaurantId: string;
  startTime: number;
}

export async function getConfirmedVisitsWithMichelinIds(): Promise<ConfirmedVisitForCalendarFilter[]> {
  const database = await getDatabase();

  // Get confirmed visits with their suggested Michelin restaurant IDs
  return database.getAllAsync<ConfirmedVisitForCalendarFilter>(
    `SELECT DISTINCT 
       v.id as visitId,
       vsr.restaurantId as michelinRestaurantId,
       v.startTime
     FROM visits v
     JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
     WHERE v.status = 'confirmed'
     ORDER BY v.startTime DESC`,
  );
}

export async function getVisitPhotoSamples(
  visitIds: string[],
  samplePercentage: number = 0.1,
): Promise<{ visitId: string; photoId: string }[]> {
  if (visitIds.length === 0) {
    return [];
  }

  const database = await getDatabase();

  // Get photo counts per visit and sample accordingly
  const samples: { visitId: string; photoId: string }[] = [];

  for (const visitId of visitIds) {
    // Get random sample of photos for this visit
    const photos = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM photos WHERE visitId = ? ORDER BY RANDOM() LIMIT MAX(1, CAST((SELECT COUNT(*) FROM photos WHERE visitId = ?) * ? AS INTEGER))`,
      [visitId, visitId, samplePercentage],
    );

    for (const photo of photos) {
      samples.push({ visitId, photoId: photo.id });
    }
  }

  return samples;
}

export async function getAllRestaurants(): Promise<RestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<RestaurantRecord>(`SELECT * FROM restaurants`);
}

export async function getRestaurantById(id: string): Promise<RestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<RestaurantRecord>(`SELECT * FROM restaurants WHERE id = ?`, [id]);
}

export interface UpdateRestaurantData {
  name?: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  googlePlaceId?: string | null;
  cuisine?: string | null;
  priceLevel?: number | null;
  rating?: number | null;
  notes?: string | null;
  latitude?: number;
  longitude?: number;
}

export async function updateRestaurant(id: string, data: UpdateRestaurantData): Promise<void> {
  const database = await getDatabase();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.name !== undefined) {
    updates.push("name = ?");
    values.push(data.name);
  }
  if (data.address !== undefined) {
    updates.push("address = ?");
    values.push(data.address);
  }
  if (data.phone !== undefined) {
    updates.push("phone = ?");
    values.push(data.phone);
  }
  if (data.website !== undefined) {
    updates.push("website = ?");
    values.push(data.website);
  }
  if (data.googlePlaceId !== undefined) {
    updates.push("googlePlaceId = ?");
    values.push(data.googlePlaceId);
  }
  if (data.cuisine !== undefined) {
    updates.push("cuisine = ?");
    values.push(data.cuisine);
  }
  if (data.priceLevel !== undefined) {
    updates.push("priceLevel = ?");
    values.push(data.priceLevel);
  }
  if (data.rating !== undefined) {
    updates.push("rating = ?");
    values.push(data.rating);
  }
  if (data.notes !== undefined) {
    updates.push("notes = ?");
    values.push(data.notes);
  }
  if (data.latitude !== undefined) {
    updates.push("latitude = ?");
    values.push(data.latitude);
  }
  if (data.longitude !== undefined) {
    updates.push("longitude = ?");
    values.push(data.longitude);
  }

  if (updates.length === 0) {
    return;
  }

  values.push(id);
  await database.runAsync(`UPDATE restaurants SET ${updates.join(", ")} WHERE id = ?`, values);
}

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
  const totalPhotos = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM photos`);
  const photosWithLocation = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
  );
  const totalVisits = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM visits`);
  const pendingVisits = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM visits WHERE status = 'pending'`,
  );
  const confirmedVisits = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM visits WHERE status = 'confirmed'`,
  );
  const foodProbableVisits = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM visits WHERE foodProbable = 1`,
  );

  return {
    totalPhotos: totalPhotos?.count ?? 0,
    photosWithLocation: photosWithLocation?.count ?? 0,
    totalVisits: totalVisits?.count ?? 0,
    pendingVisits: pendingVisits?.count ?? 0,
    confirmedVisits: confirmedVisits?.count ?? 0,
    foodProbableVisits: foodProbableVisits?.count ?? 0,
  };
}

// Michelin restaurant operations
export async function insertMichelinRestaurants(restaurants: MichelinRestaurantRecord[]): Promise<void> {
  if (restaurants.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  for (let i = 0; i < restaurants.length; i += batchSize) {
    const batch = restaurants.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((r) => [
      r.id,
      r.name,
      r.latitude,
      r.longitude,
      r.address,
      r.location,
      r.cuisine,
      r.award,
    ]);

    await database.runAsync(
      `INSERT OR IGNORE INTO michelin_restaurants (id, name, latitude, longitude, address, location, cuisine, award) VALUES ${placeholders}`,
      values,
    );
  }

  // Invalidate spatial index so it rebuilds with new data
  invalidateRestaurantIndex();
}

export async function getMichelinRestaurantCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM michelin_restaurants`);
  return result?.count ?? 0;
}

export async function getAllMichelinRestaurants(): Promise<MichelinRestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants`);
}

export async function getMichelinRestaurantById(id: string): Promise<MichelinRestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants WHERE id = ?`, [id]);
}

// Get confirmed restaurants with visit counts
export type RestaurantWithVisits = RestaurantRecord & {
  visitCount: number;
  lastVisit: number;
  lastConfirmedAt: number | null;
  previewPhotos: string[];
};

export async function getConfirmedRestaurantsWithVisits(): Promise<RestaurantWithVisits[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Get restaurants with basic stats
  const restaurants = await database.getAllAsync<
    RestaurantRecord & { visitCount: number; lastVisit: number; lastConfirmedAt: number | null }
  >(
    `SELECT r.*, 
            COUNT(c.id) as visitCount, 
            MAX(c.startTime) as lastVisit,
            MAX(c.updatedAt) as lastConfirmedAt
     FROM restaurants r
     INNER JOIN visits c ON c.restaurantId = r.id AND c.status = 'confirmed'
     GROUP BY r.id
     ORDER BY lastVisit DESC`,
  );

  if (restaurants.length === 0) {
    if (DEBUG_TIMING) {
      console.log(`[DB] getConfirmedRestaurantsWithVisits: ${(performance.now() - start).toFixed(2)}ms (0 results)`);
    }
    return [];
  }

  // Fetch preview photos for each restaurant (up to 3 photos, prioritizing food photos)
  const restaurantIds = restaurants.map((r) => r.id);
  const placeholders = restaurantIds.map(() => "?").join(", ");

  const previewPhotos = await database.getAllAsync<{ restaurantId: string; uri: string }>(
    `SELECT restaurantId, uri FROM (
      SELECT v.restaurantId, p.uri, ROW_NUMBER() OVER (
        PARTITION BY v.restaurantId 
        ORDER BY CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC, p.creationTime DESC
      ) as rn
      FROM photos p
      INNER JOIN visits v ON p.visitId = v.id
      WHERE v.restaurantId IN (${placeholders}) AND v.status = 'confirmed'
    ) WHERE rn <= 3`,
    restaurantIds,
  );

  // Group photos by restaurantId
  const photosByRestaurant = new Map<string, string[]>();
  for (const photo of previewPhotos) {
    const existing = photosByRestaurant.get(photo.restaurantId) ?? [];
    existing.push(photo.uri);
    photosByRestaurant.set(photo.restaurantId, existing);
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getConfirmedRestaurantsWithVisits: ${(performance.now() - start).toFixed(2)}ms (${restaurants.length} results)`,
    );
  }

  // Combine results
  return restaurants.map((restaurant) => ({
    ...restaurant,
    previewPhotos: photosByRestaurant.get(restaurant.id) ?? [],
  }));
}

// Get visits (visits) for a specific restaurant
export async function getVisitsByRestaurantId(restaurantId: string): Promise<VisitRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<VisitRecord>(
    `SELECT * FROM visits WHERE restaurantId = ? AND status = 'confirmed' ORDER BY startTime DESC`,
    [restaurantId],
  );
}

// Confirm a visit by linking visit to restaurant
export async function confirmVisit(
  visitId: string,
  restaurantId: string,
  restaurantName: string,
  latitude: number,
  longitude: number,
  awardAtVisit?: string | null,
): Promise<void> {
  const database = await getDatabase();
  const now = Date.now();

  // Insert restaurant if it doesn't exist
  await database.runAsync(`INSERT OR IGNORE INTO restaurants (id, name, latitude, longitude) VALUES (?, ?, ?, ?)`, [
    restaurantId,
    restaurantName,
    latitude,
    longitude,
  ]);

  // Update visit with restaurant, confirmed status, and the award at time of visit
  await database.runAsync(
    `UPDATE visits SET restaurantId = ?, status = 'confirmed', updatedAt = ?, awardAtVisit = ? WHERE id = ?`,
    [restaurantId, now, awardAtVisit ?? null, visitId],
  );
}

/**
 * Create a manual visit for a restaurant (without photos).
 * This allows users to log past visits that weren't captured by photos.
 */
export async function createManualVisit(
  restaurantId: string,
  restaurantName: string,
  latitude: number,
  longitude: number,
  visitDate: number,
  notes?: string | null,
): Promise<string> {
  const database = await getDatabase();
  const now = Date.now();

  // Generate a unique visit ID for manual visits
  const latRounded = Math.round(latitude * 1000) / 1000;
  const lonRounded = Math.round(longitude * 1000) / 1000;
  const timeRounded = Math.floor(visitDate / (60 * 60 * 1000));
  const visitId = `manual-${timeRounded}-${latRounded}-${lonRounded}-${now}`;

  // Ensure restaurant exists
  await database.runAsync(`INSERT OR IGNORE INTO restaurants (id, name, latitude, longitude) VALUES (?, ?, ?, ?)`, [
    restaurantId,
    restaurantName,
    latitude,
    longitude,
  ]);

  // Create the visit as confirmed with 0 photos
  // Use visitDate as both start and end time (1 hour duration for display purposes)
  const endTime = visitDate + 60 * 60 * 1000; // 1 hour after start

  await database.runAsync(
    `INSERT INTO visits (id, restaurantId, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon, photoCount, foodProbable, notes, updatedAt) 
     VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      visitId,
      restaurantId,
      restaurantId.startsWith("michelin-") ? restaurantId : null,
      visitDate,
      endTime,
      latitude,
      longitude,
      notes ?? null,
      now,
    ],
  );

  return visitId;
}

// Suggested restaurant with full details
export type SuggestedRestaurantDetail = MichelinRestaurantRecord & {
  distance: number;
};

// Aggregated food label with count across photos
export interface AggregatedFoodLabel {
  label: string;
  maxConfidence: number;
  photoCount: number;
}

// Get pending visits that need review (with suggestions)
export type PendingVisitForReview = VisitWithDetails & {
  suggestedRestaurantCuisine: string | null;
  suggestedRestaurantAddress: string | null;
  // Multiple suggestions for picker UI
  suggestedRestaurants: SuggestedRestaurantDetail[];
  // Aggregated food labels from photos in this visit
  foodLabels: AggregatedFoodLabel[];
};

export async function getPendingVisitsForReview(): Promise<PendingVisitForReview[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Single consolidated query using CTEs to fetch all data efficiently
  // This replaces 4 separate database round-trips with 1 query
  const results = await database.getAllAsync<{
    // Visit fields
    id: string;
    restaurantId: string | null;
    suggestedRestaurantId: string | null;
    status: "pending" | "confirmed" | "rejected";
    startTime: number;
    endTime: number;
    centerLat: number;
    centerLon: number;
    photoCount: number;
    foodProbable: number;
    calendarEventId: string | null;
    calendarEventTitle: string | null;
    calendarEventLocation: string | null;
    calendarEventIsAllDay: number | null;
    notes: string | null;
    updatedAt: number | null;
    // Joined fields
    restaurantName: string | null;
    suggestedRestaurantName: string | null;
    suggestedRestaurantAward: string | null;
    suggestedRestaurantCuisine: string | null;
    suggestedRestaurantAddress: string | null;
    // Aggregated fields
    previewPhotosJson: string | null;
    suggestedRestaurantsJson: string | null;
    foodLabelsJson: string | null;
    priority: number;
  }>(
    `WITH 
      -- Pre-filter pending visits with basic joins
      pending_visits AS (
        SELECT 
          v.*,
          r.name as restaurantName,
          m.name as suggestedRestaurantName,
          m.award as suggestedRestaurantAward,
          m.cuisine as suggestedRestaurantCuisine,
          m.address as suggestedRestaurantAddress
        FROM visits v
        LEFT JOIN restaurants r ON v.restaurantId = r.id
        LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
        WHERE v.status = 'pending'
      ),
      
      -- Get preview photos (top 3 per visit, prioritizing food photos)
      ranked_photos AS (
        SELECT 
          p.visitId,
          p.uri,
          ROW_NUMBER() OVER (
            PARTITION BY p.visitId 
            ORDER BY 
              CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END,
              p.creationTime
          ) as rn
        FROM photos p
        WHERE p.visitId IN (SELECT id FROM pending_visits)
      ),
      preview_photos AS (
        SELECT 
          visitId,
          json_group_array(uri) as uris
        FROM ranked_photos
        WHERE rn <= 3
        GROUP BY visitId
      ),
      
      -- Get suggested restaurants per visit with full details
      suggested_restaurants AS (
        SELECT 
          vsr.visitId,
          json_group_array(
            json_object(
              'id', m.id,
              'name', m.name,
              'latitude', m.latitude,
              'longitude', m.longitude,
              'address', m.address,
              'location', m.location,
              'cuisine', m.cuisine,
              'award', m.award,
              'distance', vsr.distance
            )
          ) as restaurants
        FROM visit_suggested_restaurants vsr
        JOIN michelin_restaurants m ON vsr.restaurantId = m.id
        WHERE vsr.visitId IN (SELECT id FROM pending_visits)
        GROUP BY vsr.visitId
      ),
      
      -- Aggregate food labels per visit (for visits with food detected)
      food_labels AS (
        SELECT 
          p.visitId,
          json_group_array(json(p.foodLabels)) as labelsJson
        FROM photos p
        WHERE p.visitId IN (SELECT id FROM pending_visits WHERE foodProbable = 1)
          AND p.foodDetected = 1
          AND p.foodLabels IS NOT NULL
        GROUP BY p.visitId
      )
      
    SELECT 
      pv.*,
      pp.uris as previewPhotosJson,
      sr.restaurants as suggestedRestaurantsJson,
      fl.labelsJson as foodLabelsJson,
      -- Calculate priority
      CASE 
        WHEN pv.foodProbable = 1 AND (pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL) THEN 1
        WHEN pv.suggestedRestaurantId IS NOT NULL OR sr.restaurants IS NOT NULL THEN 2
        WHEN pv.foodProbable = 1 THEN 3
        ELSE 4
      END as priority
    FROM pending_visits pv
    LEFT JOIN preview_photos pp ON pv.id = pp.visitId
    LEFT JOIN suggested_restaurants sr ON pv.id = sr.visitId
    LEFT JOIN food_labels fl ON pv.id = fl.visitId
    ORDER BY priority ASC, pv.startTime DESC`,
  );

  if (results.length === 0) {
    if (DEBUG_TIMING) {
      console.log(`[DB] getPendingVisitsForReview: ${(performance.now() - start).toFixed(2)}ms (0 results)`);
    }
    return [];
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getPendingVisitsForReview: ${(performance.now() - start).toFixed(2)}ms (${results.length} results)`,
    );
  }
  // Process results - parse JSON and compute calendar matches
  // Pre-build a map of normalized restaurant names for faster calendar matching
  const normalizedRestaurantNames = new Map<string, string>();

  const processedVisits: PendingVisitForReview[] = [];
  const calendarMatchVisitIds = new Set<string>();

  for (const row of results) {
    // Parse preview photos
    let previewPhotos: string[] = [];
    if (row.previewPhotosJson) {
      try {
        previewPhotos = JSON.parse(row.previewPhotosJson);
      } catch {
        // Skip malformed JSON
      }
    }

    // Parse suggested restaurants
    let suggestedRestaurants: SuggestedRestaurantDetail[] = [];
    if (row.suggestedRestaurantsJson) {
      try {
        suggestedRestaurants = JSON.parse(row.suggestedRestaurantsJson);
      } catch {
        // Skip malformed JSON
      }
    }

    // Parse and aggregate food labels
    // json_group_array(json(...)) produces an array of label arrays: [[{label,confidence},...], [...]]
    let foodLabels: AggregatedFoodLabel[] = [];
    if (row.foodLabelsJson && row.foodProbable) {
      try {
        const rawLabelsArrays = JSON.parse(row.foodLabelsJson) as FoodLabel[][];
        const labelMap = new Map<string, AggregatedFoodLabel>();

        for (const labels of rawLabelsArrays) {
          if (!Array.isArray(labels)) {
            continue;
          }
          for (const label of labels) {
            const existing = labelMap.get(label.label);
            if (existing) {
              existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
              existing.photoCount++;
            } else {
              labelMap.set(label.label, {
                label: label.label,
                maxConfidence: label.confidence,
                photoCount: 1,
              });
            }
          }
        }

        // Sort by confidence and limit to top 5
        foodLabels = Array.from(labelMap.values())
          .sort((a, b) => b.maxConfidence - a.maxConfidence)
          .slice(0, 5);
      } catch {
        // Skip malformed JSON
      }
    }

    // Check for calendar match with suggested restaurants
    if (row.calendarEventTitle && suggestedRestaurants.length > 0) {
      const cleanedTitle = cleanCalendarEventTitle(row.calendarEventTitle);
      if (cleanedTitle) {
        for (const restaurant of suggestedRestaurants) {
          // Use cached normalized name or compute and cache
          let normalizedName = normalizedRestaurantNames.get(restaurant.id);
          if (normalizedName === undefined) {
            normalizedName = restaurant.name;
            normalizedRestaurantNames.set(restaurant.id, normalizedName);
          }

          if (isFuzzyRestaurantMatch(cleanedTitle, normalizedName)) {
            calendarMatchVisitIds.add(row.id);
            break;
          }
        }
      }
    }

    processedVisits.push({
      id: row.id,
      restaurantId: row.restaurantId,
      suggestedRestaurantId: row.suggestedRestaurantId,
      status: row.status,
      startTime: row.startTime,
      endTime: row.endTime,
      centerLat: row.centerLat,
      centerLon: row.centerLon,
      photoCount: row.photoCount,
      foodProbable: row.foodProbable === 1,
      calendarEventId: row.calendarEventId,
      calendarEventTitle: row.calendarEventTitle,
      calendarEventLocation: row.calendarEventLocation,
      calendarEventIsAllDay: row.calendarEventIsAllDay === 1,
      exportedToCalendarId: null, // Pending visits don't have exported events
      notes: row.notes,
      updatedAt: row.updatedAt,
      awardAtVisit: null, // Pending visits don't have historical award yet
      restaurantName: row.restaurantName,
      suggestedRestaurantName: row.suggestedRestaurantName,
      suggestedRestaurantAward: row.suggestedRestaurantAward,
      suggestedRestaurantCuisine: row.suggestedRestaurantCuisine,
      suggestedRestaurantAddress: row.suggestedRestaurantAddress,
      previewPhotos,
      suggestedRestaurants,
      foodLabels,
    });
  }

  // Sort with calendar matches first, preserving original order within groups
  // Use a stable sort approach - only swap when calendar match status differs
  if (calendarMatchVisitIds.size > 0) {
    processedVisits.sort((a, b) => {
      const aHasMatch = calendarMatchVisitIds.has(a.id);
      const bHasMatch = calendarMatchVisitIds.has(b.id);
      if (aHasMatch !== bHasMatch) {
        return aHasMatch ? -1 : 1;
      }
      return 0;
    });
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getPendingVisitsForReview: ${(performance.now() - start).toFixed(2)}ms Post-processing: ${processedVisits.length} results`,
    );
  }

  return processedVisits;
}

// ============================================================================
// IGNORED LOCATIONS OPERATIONS
// ============================================================================

/**
 * Add an ignored location. All visits within this location's radius will be hidden.
 */
export async function addIgnoredLocation(
  latitude: number,
  longitude: number,
  radius: number = 100,
  name: string | null = null,
): Promise<string> {
  const database = await getDatabase();
  const id = `ignored-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const createdAt = Date.now();

  await database.runAsync(
    `INSERT INTO ignored_locations (id, latitude, longitude, radius, name, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, latitude, longitude, radius, name, createdAt],
  );

  return id;
}

/**
 * Remove an ignored location by ID
 */
export async function removeIgnoredLocation(id: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`DELETE FROM ignored_locations WHERE id = ?`, [id]);
}

/**
 * Get all ignored locations
 */
export async function getIgnoredLocations(): Promise<IgnoredLocationRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<IgnoredLocationRecord>(`SELECT * FROM ignored_locations ORDER BY createdAt DESC`);
}

/**
 * Internal helper to reject visits within ignored locations (accepts database to avoid circular deps)
 */
async function rejectVisitsInIgnoredLocationsInternal(database: SQLite.SQLiteDatabase): Promise<number> {
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

/**
 * Reject all visits within ignored locations and return count of affected visits.
 */
export async function rejectVisitsInIgnoredLocations(): Promise<number> {
  const database = await getDatabase();
  return rejectVisitsInIgnoredLocationsInternal(database);
}

// Constants for restaurant matching (same as services/visit.ts)
const RESTAURANT_MATCH_THRESHOLD = 100; // 100 meters for primary suggestion
const RESTAURANT_SEARCH_RADIUS = 200; // 200 meters for multiple suggestions
const RESTAURANT_SUGGESTION_LIMIT = 5;

/**
 * Build or rebuild the spatial index for Michelin restaurants.
 * Uses kdbush for efficient nearest-neighbor queries.
 */
async function buildRestaurantSpatialIndex(database: SQLite.SQLiteDatabase): Promise<boolean> {
  indexedRestaurants = await database.getAllAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants`);

  if (indexedRestaurants.length === 0) {
    restaurantIndex = null;
    return false;
  }

  // Build spatial index - O(n log n) once
  restaurantIndex = new KDBush(indexedRestaurants.length);
  for (const r of indexedRestaurants) {
    restaurantIndex.add(r.longitude, r.latitude); // Note: lon, lat order for geokdbush
  }
  restaurantIndex.finish();

  if (DEBUG_TIMING) {
    console.log(`[DB] Built spatial index for ${indexedRestaurants.length} restaurants`);
  }

  return true;
}

/**
 * Invalidate the restaurant spatial index (call when Michelin data changes).
 */
function invalidateRestaurantIndex(): void {
  restaurantIndex = null;
  indexedRestaurants = [];
}

/**
 * Internal helper to recompute suggested restaurants for all pending visits.
 * This ensures the visit_suggested_restaurants table is up-to-date.
 * Called during database initialization.
 *
 * Optimized to use kdbush/geokdbush spatial index for O(log n) lookups
 * instead of O(n) database queries per visit.
 */
async function recomputeSuggestedRestaurantsInternal(database: SQLite.SQLiteDatabase): Promise<number> {
  const start = DEBUG_TIMING ? performance.now() : 0;

  // Build spatial index if needed (loads all restaurants into memory once)
  if (!restaurantIndex) {
    const hasRestaurants = await buildRestaurantSpatialIndex(database);
    if (!hasRestaurants) {
      // No Michelin data loaded yet, skip
      return 0;
    }
  }

  // Get all pending visits
  const pendingVisits = await database.getAllAsync<{ id: string; centerLat: number; centerLon: number }>(
    `SELECT id, centerLat, centerLon FROM visits WHERE status = 'pending'`,
  );

  if (pendingVisits.length === 0) {
    return 0;
  }

  // Clear existing suggestions for pending visits first
  const visitIds = pendingVisits.map((v) => v.id);
  const placeholders = visitIds.map(() => "?").join(", ");
  await database.runAsync(`DELETE FROM visit_suggested_restaurants WHERE visitId IN (${placeholders})`, visitIds);

  // Also clear primary suggestions that will be recomputed
  await database.runAsync(`UPDATE visits SET suggestedRestaurantId = NULL WHERE id IN (${placeholders})`, visitIds);

  // Process all visits using spatial index - no per-visit DB queries!
  const allSuggestions: VisitSuggestedRestaurant[] = [];
  const primarySuggestionUpdates: { visitId: string; suggestedRestaurantId: string }[] = [];

  // Convert search radius to kilometers for geokdbush
  const searchRadiusKm = RESTAURANT_SEARCH_RADIUS / 1000;

  for (const visit of pendingVisits) {
    // geokdbush.around returns indices sorted by distance - O(log n + k)
    // Much faster than DB query per visit
    const nearbyIndices = geokdbush.around(
      restaurantIndex!,
      visit.centerLon, // lon first
      visit.centerLat,
      RESTAURANT_SUGGESTION_LIMIT,
      searchRadiusKm,
    );

    let hasPrimarySuggestion = false;

    for (const idx of nearbyIndices) {
      const restaurant = indexedRestaurants[idx];
      // Calculate precise distance for storage
      const distance = calculateDistanceMeters(
        visit.centerLat,
        visit.centerLon,
        restaurant.latitude,
        restaurant.longitude,
      );

      allSuggestions.push({
        visitId: visit.id,
        restaurantId: restaurant.id,
        distance,
      });

      // First result within threshold is primary suggestion (results are sorted by distance)
      if (!hasPrimarySuggestion && distance <= RESTAURANT_MATCH_THRESHOLD) {
        primarySuggestionUpdates.push({
          visitId: visit.id,
          suggestedRestaurantId: restaurant.id,
        });
        hasPrimarySuggestion = true;
      }
    }
  }

  // Insert new suggestions in batches
  if (allSuggestions.length > 0) {
    const batchSize = 1000;
    for (let i = 0; i < allSuggestions.length; i += batchSize) {
      const batch = allSuggestions.slice(i, i + batchSize);
      const insertPlaceholders = batch.map(() => "(?, ?, ?)").join(", ");
      const values = batch.flatMap((s) => [s.visitId, s.restaurantId, s.distance]);

      await database.runAsync(
        `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES ${insertPlaceholders}`,
        values,
      );
    }
  }

  // Batch update primary suggestions using CASE WHEN (much faster than individual updates)
  if (primarySuggestionUpdates.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < primarySuggestionUpdates.length; i += batchSize) {
      const batch = primarySuggestionUpdates.slice(i, i + batchSize);
      const whenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
      const batchVisitIds = batch.map((u) => u.visitId);
      const values = batch.flatMap((u) => [u.visitId, u.suggestedRestaurantId]);
      const batchPlaceholders = batchVisitIds.map(() => "?").join(", ");

      await database.runAsync(
        `UPDATE visits SET suggestedRestaurantId = CASE id ${whenClauses} END WHERE id IN (${batchPlaceholders})`,
        [...values, ...batchVisitIds],
      );
    }
  }

  if (DEBUG_TIMING) {
    console.log(
      `[DB] recomputeSuggestedRestaurants: ${(performance.now() - start).toFixed(2)}ms (${pendingVisits.length} visits, ${allSuggestions.length} suggestions)`,
    );
  }

  return pendingVisits.length;
}

/**
 * Recompute suggested restaurants for all pending visits.
 * This ensures the visit_suggested_restaurants table is up-to-date
 * based on the current Michelin restaurant data.
 */
export async function recomputeSuggestedRestaurants(): Promise<number> {
  const database = await getDatabase();
  return recomputeSuggestedRestaurantsInternal(database);
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

  // Invalidate spatial index since Michelin data is wiped
  invalidateRestaurantIndex();

  // Reinitialize the database with fresh tables
  await getDatabase();
}

/**
 * Get visits that can be merged with the given visit.
 * Returns visits that are different from the current one, ordered by time proximity.
 */
export async function getMergeableVisits(
  currentVisitId: string,
  currentStartTime: number,
): Promise<VisitWithDetails[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Get visits excluding the current one, ordered by time proximity
  // Use awardAtVisit (historical) if available, otherwise fall back to current award
  const visits = await database.getAllAsync<
    VisitRecord & {
      restaurantName: string | null;
      suggestedRestaurantName: string | null;
      suggestedRestaurantAward: string | null;
    }
  >(
    `SELECT c.*, 
            r.name as restaurantName,
            m.name as suggestedRestaurantName,
            COALESCE(c.awardAtVisit, m.award) as suggestedRestaurantAward,
            ABS(c.startTime - ?) as timeDiff
     FROM visits c
     LEFT JOIN restaurants r ON c.restaurantId = r.id
     LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
     WHERE c.id != ?
     ORDER BY timeDiff ASC
     LIMIT 50`,
    [currentStartTime, currentVisitId],
  );

  if (visits.length === 0) {
    if (DEBUG_TIMING) {
      console.log(`[DB] getMergeableVisits: ${(performance.now() - start).toFixed(2)}ms (0 results)`);
    }
    return [];
  }

  // Get preview photos
  const visitIds = visits.map((c) => c.id);
  const placeholders = visitIds.map(() => "?").join(", ");

  const previewPhotos = await database.getAllAsync<{ visitId: string; uri: string }>(
    `SELECT visitId, uri FROM (
      SELECT visitId, uri, ROW_NUMBER() OVER (
        PARTITION BY visitId 
        ORDER BY CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END ASC, creationTime ASC
      ) as rn
      FROM photos
      WHERE visitId IN (${placeholders})
    ) WHERE rn <= 3
    ORDER BY rn ASC`,
    visitIds,
  );

  const photosByVisit = new Map<string, string[]>();
  for (const photo of previewPhotos) {
    const existing = photosByVisit.get(photo.visitId) ?? [];
    existing.push(photo.uri);
    photosByVisit.set(photo.visitId, existing);
  }

  if (DEBUG_TIMING) {
    console.log(`[DB] getMergeableVisits: ${(performance.now() - start).toFixed(2)}ms (${visits.length} results)`);
  }

  return visits.map((visit) => ({
    ...visit,
    previewPhotos: photosByVisit.get(visit.id) ?? [],
  }));
}

/**
 * Merge two visits together.
 * Photos from sourceVisitId are moved to targetVisitId, and the source visit is deleted.
 * The target visit's time range and center coordinates are updated.
 */
export async function mergeVisits(targetVisitId: string, sourceVisitId: string): Promise<void> {
  const database = await getDatabase();

  // Get both visits
  const [targetVisit, sourceVisit] = await Promise.all([
    database.getFirstAsync<VisitRecord>(`SELECT * FROM visits WHERE id = ?`, [targetVisitId]),
    database.getFirstAsync<VisitRecord>(`SELECT * FROM visits WHERE id = ?`, [sourceVisitId]),
  ]);

  if (!targetVisit || !sourceVisit) {
    throw new Error("One or both visits not found");
  }

  // Move all photos from source to target
  await database.runAsync(`UPDATE photos SET visitId = ? WHERE visitId = ?`, [targetVisitId, sourceVisitId]);

  // Calculate new time range
  const newStartTime = Math.min(targetVisit.startTime, sourceVisit.startTime);
  const newEndTime = Math.max(targetVisit.endTime, sourceVisit.endTime);

  // Calculate new centroid from all photos
  const photos = await database.getAllAsync<{ latitude: number; longitude: number }>(
    `SELECT latitude, longitude FROM photos WHERE visitId = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    [targetVisitId],
  );

  let newCenterLat = targetVisit.centerLat;
  let newCenterLon = targetVisit.centerLon;

  if (photos.length > 0) {
    const sumLat = photos.reduce((sum, p) => sum + p.latitude, 0);
    const sumLon = photos.reduce((sum, p) => sum + p.longitude, 0);
    newCenterLat = sumLat / photos.length;
    newCenterLon = sumLon / photos.length;
  }

  // Get new photo count
  const photoCountResult = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE visitId = ?`,
    [targetVisitId],
  );
  const newPhotoCount = photoCountResult?.count ?? 0;

  // Check if any photos have food detected
  const foodResult = await database.getFirstAsync<{ hasFood: number }>(
    `SELECT MAX(CASE WHEN foodDetected = 1 THEN 1 ELSE 0 END) as hasFood FROM photos WHERE visitId = ?`,
    [targetVisitId],
  );
  const foodProbable = (foodResult?.hasFood ?? 0) === 1 || targetVisit.foodProbable || sourceVisit.foodProbable;

  // Update target visit
  const now = Date.now();
  await database.runAsync(
    `UPDATE visits SET startTime = ?, endTime = ?, centerLat = ?, centerLon = ?, photoCount = ?, foodProbable = ?, updatedAt = ? WHERE id = ?`,
    [newStartTime, newEndTime, newCenterLat, newCenterLon, newPhotoCount, foodProbable ? 1 : 0, now, targetVisitId],
  );

  // Move suggested restaurants from source to target (if not already present)
  await database.runAsync(
    `INSERT OR IGNORE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
     SELECT ?, restaurantId, distance FROM visit_suggested_restaurants WHERE visitId = ?`,
    [targetVisitId, sourceVisitId],
  );

  // Delete source visit's suggested restaurants
  await database.runAsync(`DELETE FROM visit_suggested_restaurants WHERE visitId = ?`, [sourceVisitId]);

  // Delete source visit
  await database.runAsync(`DELETE FROM visits WHERE id = ?`, [sourceVisitId]);
}

// Wrapped statistics types
export interface WrappedStats {
  // Available years for filtering (only present when year is null/all-time)
  availableYears: number[];
  // Per-year data (only present when year is null/all-time)
  yearlyStats: Array<{
    year: number;
    totalVisits: number;
    uniqueRestaurants: number;
    topRestaurant: { name: string; visits: number } | null;
  }>;
  // Monthly visits data for chart
  monthlyVisits: Array<{ month: number; year: number; visits: number }>;
  // Michelin stars breakdown
  michelinStats: {
    threeStars: number;
    twoStars: number;
    oneStars: number;
    bibGourmand: number;
    selected: number;
    totalStarredVisits: number;
    distinctStarredRestaurants: number; // unique starred restaurants visited
    totalAccumulatedStars: number; // sum of stars across all visits (2 visits to 3-star = 6)
    distinctStars: number; // sum of star rating across distinct starred restaurants (5 visits to 3-star = 3)
    greenStarVisits: number; // eco-conscious Green Star restaurant visits
  };
  // Cuisine breakdown (top 5)
  topCuisines: Array<{ cuisine: string; count: number }>;
  // Time patterns
  busiestMonth: { month: number; year: number; visits: number } | null;
  busiestDayOfWeek: { day: number; visits: number } | null;
  // Overall stats
  totalUniqueRestaurants: number;
  totalConfirmedVisits: number;
  firstVisitDate: number | null;
  longestStreak: { days: number; startDate: number; endDate: number } | null;
  // Fun facts
  mostRevisitedRestaurant: { name: string; visits: number } | null;
  averageVisitsPerMonth: number;
  // Geographic stats - parsed from michelin_restaurants.location
  topLocations: Array<{ location: string; country: string; city: string; visits: number }>;
  uniqueCountries: number;
  uniqueCities: number;
  // Dining time patterns
  mealTimeBreakdown: {
    breakfast: number; // 6-10am
    lunch: number; // 11am-2pm
    dinner: number; // 5-9pm
    lateNight: number; // 9pm+
  };
  weekendVsWeekday: {
    weekend: number;
    weekday: number;
  };
  peakDiningHour: { hour: number; visits: number } | null;
  // Photo stats
  photoStats: {
    totalPhotos: number;
    averagePerVisit: number;
    mostPhotographedVisit: { restaurantName: string; photoCount: number } | null;
  };
  // Dining style / loyalty
  diningStyle: {
    newRestaurants: number; // restaurants visited only once
    returningVisits: number; // visits to restaurants visited more than once
    explorerRatio: number; // percentage of unique restaurants vs total visits (0-1)
  };
}

// Get wrapped statistics for confirmed visits
// When year is provided, filters all stats to that year only
export async function getWrappedStats(year?: number | null): Promise<WrappedStats> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Build year filter clause
  const yearFilter = year ? `AND strftime('%Y', datetime(startTime/1000, 'unixepoch')) = '${year}'` : "";
  const yearFilterForV = year ? `AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) = '${year}'` : "";

  // Run all independent queries in parallel
  const [
    yearlyData,
    monthlyVisitsData,
    michelinData,
    distinctStarredResult,
    distinctStarsResult,
    topCuisines,
    busiestMonth,
    busiestDayOfWeek,
    totalUniqueRestaurants,
    totalConfirmedVisits,
    firstVisit,
    mostRevisitedRestaurant,
    visitDates,
    // New stats queries
    topLocationsData,
    greenStarResult,
    mealTimeData,
    weekendWeekdayData,
    peakHourData,
    photoStatsResult,
    mostPhotographedVisit,
    diningStyleData,
  ] = await Promise.all([
    // Yearly stats (only for all-time view)
    year
      ? Promise.resolve([])
      : database.getAllAsync<{
          year: number;
          totalVisits: number;
          uniqueRestaurants: number;
        }>(
          `SELECT 
          strftime('%Y', datetime(startTime/1000, 'unixepoch')) as year,
          COUNT(*) as totalVisits,
          COUNT(DISTINCT restaurantId) as uniqueRestaurants
        FROM visits 
        WHERE status = 'confirmed' AND restaurantId IS NOT NULL
        GROUP BY year
        ORDER BY year DESC`,
        ),
    // Monthly visits data for chart
    database.getAllAsync<{ month: number; year: number; visits: number }>(
      `SELECT 
        CAST(strftime('%m', datetime(startTime/1000, 'unixepoch')) AS INTEGER) as month,
        CAST(strftime('%Y', datetime(startTime/1000, 'unixepoch')) AS INTEGER) as year,
        COUNT(*) as visits
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      GROUP BY year, month
      ORDER BY year ASC, month ASC`,
    ),
    // Michelin stats - uses awardAtVisit for historical accuracy, falls back to current award
    database.getAllAsync<{ award: string; count: number }>(
      `SELECT COALESCE(v.awardAtVisit, m.award) as award, COUNT(DISTINCT v.id) as count
      FROM visits v
      JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
      JOIN michelin_restaurants m ON vsr.restaurantId = m.id
      WHERE v.status = 'confirmed' ${yearFilterForV}
      GROUP BY COALESCE(v.awardAtVisit, m.award)`,
    ),
    // Distinct starred restaurants count - uses awardAtVisit or falls back to current award
    database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(DISTINCT m.id) as count
      FROM visits v
      JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
      JOIN michelin_restaurants m ON vsr.restaurantId = m.id
      WHERE v.status = 'confirmed' ${yearFilterForV}
        AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')`,
    ),
    // Distinct stars (sum of star rating across unique starred restaurants at time of visit or current)
    database.getFirstAsync<{ distinctStars: number | null }>(
      `SELECT SUM(
        CASE
          WHEN lower(t.award) LIKE '%3 star%' THEN 3
          WHEN lower(t.award) LIKE '%2 star%' THEN 2
          WHEN lower(t.award) LIKE '%1 star%' THEN 1
          ELSE 0
        END
      ) as distinctStars
      FROM (
        SELECT DISTINCT m.id, COALESCE(v.awardAtVisit, m.award) as award
        FROM visits v
        JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
        JOIN michelin_restaurants m ON vsr.restaurantId = m.id
        WHERE v.status = 'confirmed' ${yearFilterForV}
          AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')
      ) t`,
    ),
    // Top cuisines
    database.getAllAsync<{ cuisine: string; count: number }>(
      `SELECT m.cuisine, COUNT(DISTINCT v.id) as count
      FROM visits v
      JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
      JOIN michelin_restaurants m ON vsr.restaurantId = m.id
      WHERE v.status = 'confirmed' AND m.cuisine != '' ${yearFilterForV}
      GROUP BY m.cuisine
      ORDER BY count DESC
      LIMIT 5`,
    ),
    // Busiest month
    database.getFirstAsync<{ month: number; year: number; visits: number }>(
      `SELECT 
        CAST(strftime('%m', datetime(startTime/1000, 'unixepoch')) AS INTEGER) as month,
        CAST(strftime('%Y', datetime(startTime/1000, 'unixepoch')) AS INTEGER) as year,
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
        CAST(strftime('%w', datetime(startTime/1000, 'unixepoch')) AS INTEGER) as day,
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
      `SELECT DISTINCT date(datetime(startTime/1000, 'unixepoch')) as date
      FROM visits 
      WHERE status = 'confirmed' ${yearFilter}
      ORDER BY date ASC`,
    ),
    // Top locations (cities/countries from michelin_restaurants.location)
    // Normalize locations by trimming whitespace and using case-insensitive grouping
    database.getAllAsync<{ location: string; visits: number }>(
      `SELECT 
        TRIM(m.location) as location, 
        COUNT(DISTINCT v.id) as visits
      FROM visits v
      JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
      JOIN michelin_restaurants m ON vsr.restaurantId = m.id
      WHERE v.status = 'confirmed' 
        AND TRIM(COALESCE(m.location, '')) != '' 
        ${yearFilterForV}
      GROUP BY LOWER(TRIM(m.location))
      ORDER BY visits DESC
      LIMIT 10`,
    ),
    // Green star visits count
    database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(DISTINCT v.id) as count
      FROM visits v
      JOIN visit_suggested_restaurants vsr ON v.id = vsr.visitId
      JOIN michelin_restaurants m ON vsr.restaurantId = m.id
      WHERE v.status = 'confirmed' ${yearFilterForV}
        AND (COALESCE(v.awardAtVisit, m.award) LIKE '%Green Star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%green star%')`,
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
          WHEN strftime('%w', datetime(startTime/1000, 'unixepoch')) IN ('0','6') THEN 'weekend' 
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

  // Get top restaurant per year (parallelized)
  const yearlyStats = await Promise.all(
    yearlyData.map(async (yearData) => {
      const topRestaurant = await database.getFirstAsync<{ name: string; visits: number }>(
        `SELECT r.name, COUNT(*) as visits
        FROM visits v
        JOIN restaurants r ON v.restaurantId = r.id
        WHERE v.status = 'confirmed' 
          AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) = ?
        GROUP BY v.restaurantId
        ORDER BY visits DESC
        LIMIT 1`,
        [yearData.year.toString()],
      );
      return {
        year: Number(yearData.year),
        totalVisits: yearData.totalVisits,
        uniqueRestaurants: yearData.uniqueRestaurants,
        topRestaurant: topRestaurant ?? null,
      };
    }),
  );

  // Process Michelin stats
  const michelinStats = {
    threeStars: 0,
    twoStars: 0,
    oneStars: 0,
    bibGourmand: 0,
    selected: 0,
    totalStarredVisits: 0,
    distinctStarredRestaurants: distinctStarredResult?.count ?? 0,
    totalAccumulatedStars: 0,
    distinctStars: distinctStarsResult?.distinctStars ?? 0,
    greenStarVisits: greenStarResult?.count ?? 0,
  };

  for (const row of michelinData) {
    if (!row.award) {
      continue;
    }
    const award = row.award.toLowerCase();
    if (award.includes("3 star")) {
      michelinStats.threeStars += row.count;
      michelinStats.totalAccumulatedStars += row.count * 3;
    } else if (award.includes("2 star")) {
      michelinStats.twoStars += row.count;
      michelinStats.totalAccumulatedStars += row.count * 2;
    } else if (award.includes("1 star")) {
      michelinStats.oneStars += row.count;
      michelinStats.totalAccumulatedStars += row.count * 1;
    } else if (award.includes("bib")) {
      michelinStats.bibGourmand += row.count;
    } else if (award.includes("selected")) {
      michelinStats.selected += row.count;
    }
    michelinStats.totalStarredVisits += row.count;
  }

  // Calculate longest streak of consecutive dining days
  let longestStreak: { days: number; startDate: number; endDate: number } | null = null;
  if (visitDates.length > 0) {
    let currentStreak = 1;
    let maxStreak = 1;
    let streakStart = new Date(visitDates[0].date).getTime();
    let maxStreakStart = streakStart;
    let maxStreakEnd = streakStart;

    for (let i = 1; i < visitDates.length; i++) {
      const prevDate = new Date(visitDates[i - 1].date);
      const currDate = new Date(visitDates[i].date);
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
  const cityVisitsMap = new Map<string, { city: string; country: string; visits: number }>();
  for (const loc of topLocationsData) {
    const parts = loc.location.split(",").map((s) => s.trim());
    // Location format is typically "City, Region/Country" or "City, Country"
    const city = parts[0] || loc.location;
    const country = parts.length > 1 ? parts[parts.length - 1] : "";
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

  // Count unique countries and cities
  const uniqueCountriesSet = new Set(topLocations.map((l) => l.country).filter(Boolean));
  const uniqueCitiesSet = new Set(topLocations.map((l) => l.city).filter(Boolean));

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
    uniqueCountries: uniqueCountriesSet.size,
    uniqueCities: uniqueCitiesSet.size,
    mealTimeBreakdown,
    weekendVsWeekday,
    peakDiningHour: peakHourData ?? null,
    photoStats,
    diningStyle,
  };
}

/**
 * Perform database maintenance operations to optimize performance and reclaim space.
 * Should be called after large batch operations like scanning.
 *
 * Operations:
 * - WAL checkpoint: Forces WAL file to be written to main database
 * - VACUUM: Rebuilds database file, reclaiming unused space and defragmenting
 * - ANALYZE: Updates query planner statistics for better query optimization
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
    // Force WAL checkpoint to merge WAL file into main database
    // TRUNCATE mode: checkpoint and truncate WAL file to zero bytes
    await database.execAsync(`PRAGMA wal_checkpoint(TRUNCATE);`);
    results.walCheckpoint = true;
  } catch (error) {
    console.warn("[DB] WAL checkpoint failed:", error);
  }

  try {
    // VACUUM rebuilds the database file:
    // - Reclaims space from deleted records
    // - Defragments the database for faster reads
    // - Reduces file size
    // Note: This can be slow for large databases, but is worth it after bulk operations
    await database.execAsync(`VACUUM;`);
    results.vacuum = true;
  } catch (error) {
    console.warn("[DB] VACUUM failed:", error);
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

// ============================================================================
// FOOD KEYWORDS OPERATIONS
// ============================================================================

/**
 * Get all food keywords from the database
 */
export async function getAllFoodKeywords(): Promise<FoodKeywordRecord[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    id: number;
    keyword: string;
    enabled: number;
    isBuiltIn: number;
    createdAt: number;
  }>(`SELECT * FROM food_keywords ORDER BY keyword ASC`);

  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    enabled: row.enabled === 1,
    isBuiltIn: row.isBuiltIn === 1,
    createdAt: row.createdAt,
  }));
}

/**
 * Get only enabled food keywords (for classification)
 */
export async function getEnabledFoodKeywords(): Promise<string[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ keyword: string }>(
    `SELECT keyword FROM food_keywords WHERE enabled = 1 ORDER BY keyword ASC`,
  );
  return rows.map((row) => row.keyword);
}

/**
 * Add a new food keyword
 */
export async function addFoodKeyword(keyword: string): Promise<FoodKeywordRecord> {
  const database = await getDatabase();
  const now = Date.now();
  const normalizedKeyword = keyword.trim().toLowerCase();

  await database.runAsync(`INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt) VALUES (?, 1, 0, ?)`, [
    normalizedKeyword,
    now,
  ]);

  const result = await database.getFirstAsync<{
    id: number;
    keyword: string;
    enabled: number;
    isBuiltIn: number;
    createdAt: number;
  }>(`SELECT * FROM food_keywords WHERE keyword = ?`, [normalizedKeyword]);

  if (!result) {
    throw new Error("Failed to add food keyword");
  }

  return {
    id: result.id,
    keyword: result.keyword,
    enabled: result.enabled === 1,
    isBuiltIn: result.isBuiltIn === 1,
    createdAt: result.createdAt,
  };
}

/**
 * Remove a food keyword (only user-added keywords can be removed)
 */
export async function removeFoodKeyword(id: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`DELETE FROM food_keywords WHERE id = ? AND isBuiltIn = 0`, [id]);
}

/**
 * Toggle a food keyword on/off
 */
export async function toggleFoodKeyword(id: number, enabled: boolean): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(`UPDATE food_keywords SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
}

/**
 * Reset food keywords to defaults (re-enable all built-in, remove user-added)
 */
export async function resetFoodKeywordsToDefaults(): Promise<void> {
  const database = await getDatabase();

  // Remove user-added keywords
  await database.runAsync(`DELETE FROM food_keywords WHERE isBuiltIn = 0`);

  // Re-enable all built-in keywords
  await database.runAsync(`UPDATE food_keywords SET enabled = 1 WHERE isBuiltIn = 1`);
}

/**
 * Get photos that have allLabels stored (for reclassification)
 */
export async function getPhotosWithAllLabels(): Promise<
  Array<{ id: string; visitId: string | null; allLabels: string }>
> {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string; visitId: string | null; allLabels: string }>(
    `SELECT id, visitId, allLabels FROM photos WHERE allLabels IS NOT NULL`,
  );
}

/**
 * Get count of photos that have classification data for reclassification progress
 */
export async function getPhotosWithLabelsCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE allLabels IS NOT NULL`,
  );
  return result?.count ?? 0;
}

export interface ReclassifyProgress {
  total: number;
  processed: number;
  updated: number;
  isComplete: boolean;
}

/**
 * Reclassify all photos based on current enabled food keywords.
 * This re-evaluates allLabels against the current keyword set and updates:
 * - foodDetected (true/false based on whether any enabled keyword matches)
 * - foodLabels (filtered labels that match enabled keywords)
 * - foodConfidence (max confidence among matched labels)
 */
export async function reclassifyPhotosWithCurrentKeywords(
  onProgress?: (progress: ReclassifyProgress) => void,
): Promise<ReclassifyProgress> {
  const database = await getDatabase();
  const start = DEBUG_TIMING ? performance.now() : 0;

  // Get enabled keywords as a Set for fast lookup
  const enabledKeywords = new Set(await getEnabledFoodKeywords());

  // Get all photos that have allLabels stored
  const photosToProcess = await getPhotosWithAllLabels();

  const progress: ReclassifyProgress = {
    total: photosToProcess.length,
    processed: 0,
    updated: 0,
    isComplete: false,
  };

  if (photosToProcess.length === 0) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  onProgress?.(progress);

  const BATCH_SIZE = 500;
  const updates: Array<{
    photoId: string;
    foodDetected: boolean;
    foodLabels: FoodLabel[];
    foodConfidence: number | null;
  }> = [];

  for (let i = 0; i < photosToProcess.length; i++) {
    const photo = photosToProcess[i];

    let allLabels: FoodLabel[] = [];
    try {
      allLabels = JSON.parse(photo.allLabels) as FoodLabel[];
    } catch {
      continue; // Skip malformed JSON
    }

    // Filter labels that match enabled keywords
    const matchedLabels = allLabels.filter((label) => {
      const lowerLabel = label.label.trim().toLowerCase();
      return enabledKeywords.has(lowerLabel);
    });

    const foodDetected = matchedLabels.length > 0;
    const foodConfidence = matchedLabels.length > 0 ? Math.max(...matchedLabels.map((l) => l.confidence)) : null;

    updates.push({
      photoId: photo.id,
      foodDetected,
      foodLabels: matchedLabels,
      foodConfidence,
    });

    progress.processed = i + 1;

    // Process in batches
    if (updates.length >= BATCH_SIZE || i === photosToProcess.length - 1) {
      // Update photos in database
      for (const update of updates) {
        await database.runAsync(`UPDATE photos SET foodDetected = ?, foodLabels = ?, foodConfidence = ? WHERE id = ?`, [
          update.foodDetected ? 1 : 0,
          update.foodLabels.length > 0 ? JSON.stringify(update.foodLabels) : null,
          update.foodConfidence,
          update.photoId,
        ]);
      }

      progress.updated += updates.length;
      updates.length = 0; // Clear the array

      onProgress?.(progress);
    }
  }

  // Update visit food probable flags
  await syncAllVisitsFoodProbable();

  progress.isComplete = true;
  onProgress?.(progress);

  if (DEBUG_TIMING) {
    console.log(
      `[DB] reclassifyPhotosWithCurrentKeywords: ${(performance.now() - start).toFixed(2)}ms (${progress.total} photos)`,
    );
  }

  return progress;
}

// ============================================================================
// PHOTO-VISIT ASSOCIATION
// ============================================================================

/**
 * Get photos by their asset IDs (for checking if photos exist in the database)
 */
export async function getPhotosByAssetIds(assetIds: string[]): Promise<PhotoRecord[]> {
  if (assetIds.length === 0) {
    return [];
  }

  const database = await getDatabase();
  const placeholders = assetIds.map(() => "?").join(", ");
  const rawPhotos = await database.getAllAsync<RawPhotoRecord>(
    `SELECT * FROM photos WHERE id IN (${placeholders})`,
    assetIds,
  );
  return rawPhotos.map(parsePhotoRecord);
}

export interface MovePhotosResult {
  movedCount: number;
  fromVisitIds: string[];
}

/**
 * Move photos to a different visit.
 * Updates the visitId for each photo and recalculates photo counts for affected visits.
 * Returns the count of photos moved and the visit IDs they were moved from.
 */
export async function movePhotosToVisit(photoIds: string[], targetVisitId: string): Promise<MovePhotosResult> {
  if (photoIds.length === 0) {
    return { movedCount: 0, fromVisitIds: [] };
  }

  const database = await getDatabase();

  // Get the current visit IDs for these photos (to update their counts later)
  const placeholders = photoIds.map(() => "?").join(", ");
  const existingPhotos = await database.getAllAsync<{ id: string; visitId: string | null }>(
    `SELECT id, visitId FROM photos WHERE id IN (${placeholders})`,
    photoIds,
  );

  // Collect unique source visit IDs (excluding null and the target)
  const sourceVisitIds = new Set<string>();
  for (const photo of existingPhotos) {
    if (photo.visitId && photo.visitId !== targetVisitId) {
      sourceVisitIds.add(photo.visitId);
    }
  }

  // Update the photos to point to the target visit
  await database.runAsync(`UPDATE photos SET visitId = ? WHERE id IN (${placeholders})`, [targetVisitId, ...photoIds]);

  // Update photo counts for all affected visits (target + sources)
  const allAffectedVisitIds = [...sourceVisitIds, targetVisitId];
  const visitPlaceholders = allAffectedVisitIds.map(() => "?").join(", ");

  await database.runAsync(
    `UPDATE visits SET photoCount = (
      SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id
    ) WHERE id IN (${visitPlaceholders})`,
    allAffectedVisitIds,
  );

  // Update the target visit's time range if needed (expand to include new photos)
  await database.runAsync(
    `UPDATE visits SET 
      startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
      endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?)
    WHERE id = ?`,
    [targetVisitId, targetVisitId, targetVisitId],
  );

  // Sync food probable status for affected visits
  await syncAllVisitsFoodProbable();

  return {
    movedCount: existingPhotos.length,
    fromVisitIds: Array.from(sourceVisitIds),
  };
}

export interface RemovePhotosResult {
  removedCount: number;
}

/**
 * Remove photos from a visit by setting their visitId to null.
 * This disassociates the photos from the visit without deleting them.
 * Updates the visit's photo count and time range after removal.
 */
export async function removePhotosFromVisit(photoIds: string[], visitId: string): Promise<RemovePhotosResult> {
  if (photoIds.length === 0) {
    return { removedCount: 0 };
  }

  const database = await getDatabase();

  // Verify these photos belong to the specified visit
  const placeholders = photoIds.map(() => "?").join(", ");
  const matchingPhotos = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM photos WHERE id IN (${placeholders}) AND visitId = ?`,
    [...photoIds, visitId],
  );

  if (matchingPhotos.length === 0) {
    return { removedCount: 0 };
  }

  const matchingPhotoIds = matchingPhotos.map((p) => p.id);
  const matchingPlaceholders = matchingPhotoIds.map(() => "?").join(", ");

  // Set visitId to null for the photos
  await database.runAsync(`UPDATE photos SET visitId = NULL WHERE id IN (${matchingPlaceholders})`, matchingPhotoIds);

  // Update the visit's photo count
  await database.runAsync(
    `UPDATE visits SET photoCount = (
      SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id
    ) WHERE id = ?`,
    [visitId],
  );

  // Update the visit's time range based on remaining photos
  const remainingPhotos = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM photos WHERE visitId = ?`,
    [visitId],
  );

  if (remainingPhotos && remainingPhotos.count > 0) {
    // Update time range to match remaining photos
    await database.runAsync(
      `UPDATE visits SET 
        startTime = (SELECT MIN(creationTime) FROM photos WHERE visitId = ?),
        endTime = (SELECT MAX(creationTime) FROM photos WHERE visitId = ?)
      WHERE id = ?`,
      [visitId, visitId, visitId],
    );
  }

  // Sync food probable status for the visit
  await syncAllVisitsFoodProbable();

  return {
    removedCount: matchingPhotos.length,
  };
}
