import { getDatabase, rejectVisitsInIgnoredLocationsInternal } from "./core";
import type { IgnoredLocationRecord } from "./types";

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
 * Reject all visits within ignored locations and return count of affected visits.
 */
export async function rejectVisitsInIgnoredLocations(): Promise<number> {
  const database = await getDatabase();
  return rejectVisitsInIgnoredLocationsInternal(database);
}
