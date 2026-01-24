import { getDatabase } from "./core";
import type {
  CalendarEventUpdate,
  ConfirmedVisitForCalendarFilter,
  ExportedCalendarEvent,
  VisitForCalendarExport,
} from "./types";

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

/**
 * Get confirmed visits with their linked Michelin restaurant IDs and times.
 * Used to filter out calendar events that already have confirmed visits.
 */
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
