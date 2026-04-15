import { getDatabase } from "./core";
import { calculateDistanceMeters } from "@/data/restaurants";
import type {
  CalendarEventUpdate,
  ConfirmedVisitForCalendarFilter,
  ExportedCalendarEvent,
  ReservationOnlyVisitImportResult,
  ReservationOnlyVisitInput,
  VisitForCalendarExport,
  VisitRecord,
} from "./types";

export async function batchUpdateVisitsCalendarEvents(updates: CalendarEventUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await getDatabase();

  // Update each visit individually since each has different calendar data
  await database.withExclusiveTransactionAsync(async (tx) => {
    for (const update of updates) {
      await tx.runAsync(
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
  });
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
 * Insert or link confirmed reservation-only visits for sources that provide
 * their own venue coordinates, such as Resy, Tock, and OpenTable. When possible, these source
 * reservations are attached to an existing overlapping photo visit instead of
 * creating a duplicate reservation-only visit.
 */
export async function insertReservationOnlyVisits(
  visits: ReservationOnlyVisitInput[],
): Promise<ReservationOnlyVisitImportResult> {
  if (visits.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: 0,
      skippedConflictCount: 0,
    };
  }

  const uniqueVisitsBySource = new Map<string, ReservationOnlyVisitInput>();
  for (const visit of visits) {
    if (!uniqueVisitsBySource.has(visit.sourceEventId)) {
      uniqueVisitsBySource.set(visit.sourceEventId, visit);
    }
  }

  const uniqueVisits = Array.from(uniqueVisitsBySource.values());
  const database = await getDatabase();
  const sourceEventIds = uniqueVisits.map((visit) => visit.sourceEventId);
  const existingSourceEventIds = new Set<string>();
  const batchSize = 1000;

  for (let i = 0; i < sourceEventIds.length; i += batchSize) {
    const batch = sourceEventIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const linkedRows = await database.getAllAsync<{ sourceEventId: string }>(
      `SELECT sourceEventId FROM reservation_import_sources WHERE sourceEventId IN (${placeholders})`,
      batch,
    );
    const legacyRows = await database.getAllAsync<{ calendarEventId: string }>(
      `SELECT calendarEventId FROM visits WHERE calendarEventId IN (${placeholders})`,
      batch,
    );
    for (const row of linkedRows) {
      existingSourceEventIds.add(row.sourceEventId);
    }
    for (const row of legacyRows) {
      existingSourceEventIds.add(row.calendarEventId);
    }
  }

  const newVisits = uniqueVisits.filter((visit) => !existingSourceEventIds.has(visit.sourceEventId));
  if (newVisits.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: visits.length,
      skippedConflictCount: 0,
    };
  }

  const now = Date.now();
  const overlapBufferMs = 30 * 60 * 1000;
  const minStartTime = Math.min(...newVisits.map((visit) => visit.startTime)) - overlapBufferMs;
  const maxEndTime = Math.max(...newVisits.map((visit) => visit.endTime)) + overlapBufferMs;
  const existingVisits = await database.getAllAsync<VisitRecord>(
    `SELECT * FROM visits
     WHERE startTime < ?
       AND endTime > ?
     ORDER BY startTime ASC`,
    [maxEndTime, minStartTime],
  );

  let insertedCount = 0;
  let linkedExistingCount = 0;
  let confirmedExistingCount = 0;
  const skippedConflictCount = 0;

  await database.withExclusiveTransactionAsync(async (tx) => {
    for (let i = 0; i < newVisits.length; i += batchSize) {
      const batch = newVisits.slice(i, i + batchSize);
      const restaurantPlaceholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const restaurantValues = batch.flatMap((visit) => [
        visit.restaurant.id,
        visit.restaurant.name,
        visit.restaurant.latitude,
        visit.restaurant.longitude,
        visit.restaurant.address ?? null,
        visit.restaurant.phone ?? null,
        visit.restaurant.website ?? null,
        visit.restaurant.cuisine ?? null,
      ]);

      await tx.runAsync(
        `INSERT INTO restaurants (id, name, latitude, longitude, address, phone, website, cuisine)
         VALUES ${restaurantPlaceholders}
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           address = COALESCE(excluded.address, restaurants.address),
           phone = COALESCE(excluded.phone, restaurants.phone),
           website = COALESCE(excluded.website, restaurants.website),
           cuisine = COALESCE(excluded.cuisine, restaurants.cuisine)`,
        restaurantValues,
      );
    }

    for (const visit of newVisits) {
      const existingVisit = findBestReservationOverlap(visit, existingVisits, overlapBufferMs);
      const targetVisitId = existingVisit?.id ?? visit.id;

      if (existingVisit) {
        const wasConfirmed = existingVisit.status === "confirmed" && Boolean(existingVisit.restaurantId);
        const canUpgradeExternalRestaurant =
          Boolean(visit.suggestedRestaurantId) && isExternalReservationRestaurantId(existingVisit.restaurantId);
        const canUseImportedRestaurant =
          existingVisit.status !== "rejected" &&
          (existingVisit.status !== "confirmed" ||
            !existingVisit.restaurantId ||
            existingVisit.restaurantId === visit.restaurant.id ||
            canUpgradeExternalRestaurant);
        const shouldConfirmExisting = canUseImportedRestaurant && existingVisit.restaurantId !== visit.restaurant.id;
        const updates: string[] = ["updatedAt = ?"];
        const values: Array<string | number | null> = [now];

        if (!existingVisit.calendarEventId) {
          updates.push(
            "calendarEventId = ?",
            "calendarEventTitle = ?",
            "calendarEventLocation = ?",
            "calendarEventIsAllDay = 0",
          );
          values.push(visit.sourceEventId, visit.sourceTitle, visit.sourceLocation);
        }

        if (
          visit.suggestedRestaurantId &&
          canUseImportedRestaurant &&
          existingVisit.suggestedRestaurantId !== visit.suggestedRestaurantId
        ) {
          updates.push("suggestedRestaurantId = ?");
          values.push(visit.suggestedRestaurantId);
        }

        if (shouldConfirmExisting) {
          updates.push("restaurantId = ?", "status = 'confirmed'", "awardAtVisit = ?");
          values.push(visit.restaurant.id, visit.awardAtVisit ?? null);
        } else if (
          existingVisit.restaurantId === visit.restaurant.id &&
          !existingVisit.awardAtVisit &&
          visit.awardAtVisit
        ) {
          updates.push("awardAtVisit = ?");
          values.push(visit.awardAtVisit);
        }

        values.push(existingVisit.id);
        await tx.runAsync(`UPDATE visits SET ${updates.join(", ")} WHERE id = ?`, values);

        linkedExistingCount++;
        if (!wasConfirmed && shouldConfirmExisting) {
          confirmedExistingCount++;
        }
      } else {
        const visitResult = await tx.runAsync(
          `INSERT OR IGNORE INTO visits (
            id,
            restaurantId,
            suggestedRestaurantId,
            status,
            startTime,
            endTime,
            centerLat,
            centerLon,
            photoCount,
            foodProbable,
            calendarEventId,
            calendarEventTitle,
            calendarEventLocation,
            calendarEventIsAllDay,
            notes,
            updatedAt,
            awardAtVisit
          ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?, ?, ?)`,
          [
            visit.id,
            visit.restaurant.id,
            visit.suggestedRestaurantId ?? null,
            visit.startTime,
            visit.endTime,
            visit.restaurant.latitude,
            visit.restaurant.longitude,
            visit.sourceEventId,
            visit.sourceTitle,
            visit.sourceLocation,
            visit.notes ?? null,
            now,
            visit.awardAtVisit ?? null,
          ],
        );

        if (visitResult.changes > 0) {
          insertedCount++;
          existingVisits.push({
            id: visit.id,
            restaurantId: visit.restaurant.id,
            suggestedRestaurantId: visit.suggestedRestaurantId ?? null,
            status: "confirmed",
            startTime: visit.startTime,
            endTime: visit.endTime,
            centerLat: visit.restaurant.latitude,
            centerLon: visit.restaurant.longitude,
            photoCount: 0,
            foodProbable: false,
            calendarEventId: visit.sourceEventId,
            calendarEventTitle: visit.sourceTitle,
            calendarEventLocation: visit.sourceLocation,
            calendarEventIsAllDay: false,
            exportedToCalendarId: null,
            notes: visit.notes ?? null,
            updatedAt: now,
            awardAtVisit: visit.awardAtVisit ?? null,
          });
        } else {
          linkedExistingCount++;
        }
      }

      await tx.runAsync(
        `INSERT OR IGNORE INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
         VALUES (?, ?, ?, ?)`,
        [visit.sourceEventId, visit.sourceName, targetVisitId, now],
      );

      if (visit.suggestedRestaurantId) {
        await tx.runAsync(
          `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
           VALUES (?, ?, ?)`,
          [targetVisitId, visit.suggestedRestaurantId, visit.suggestedRestaurantDistance ?? 0],
        );
      }
    }
  });

  return {
    insertedCount,
    linkedExistingCount,
    confirmedExistingCount,
    skippedDuplicateCount: visits.length - newVisits.length,
    skippedConflictCount,
  };
}

function findBestReservationOverlap(
  reservation: ReservationOnlyVisitInput,
  existingVisits: VisitRecord[],
  bufferMs: number,
): VisitRecord | null {
  let bestVisit: VisitRecord | null = null;
  let bestScore = 0;

  for (const visit of existingVisits) {
    const score = scoreReservationOverlap(reservation, visit, bufferMs);
    if (score > bestScore) {
      bestVisit = visit;
      bestScore = score;
    }
  }

  return bestVisit;
}

function scoreReservationOverlap(reservation: ReservationOnlyVisitInput, visit: VisitRecord, bufferMs: number): number {
  if (visit.status === "rejected") {
    return 0;
  }

  if (visit.calendarEventId === reservation.sourceEventId) {
    return 10000;
  }

  const overlaps = visit.startTime < reservation.endTime + bufferMs && visit.endTime > reservation.startTime - bufferMs;
  if (!overlaps) {
    return 0;
  }

  const restaurantMatches =
    visit.restaurantId === reservation.restaurant.id ||
    (Boolean(reservation.suggestedRestaurantId) &&
      (visit.restaurantId === reservation.suggestedRestaurantId ||
        visit.suggestedRestaurantId === reservation.suggestedRestaurantId));
  const distance = calculateDistanceMeters(
    visit.centerLat,
    visit.centerLon,
    reservation.restaurant.latitude,
    reservation.restaurant.longitude,
  );

  if (visit.status === "confirmed" && visit.restaurantId && !restaurantMatches && distance > 100) {
    return 0;
  }

  if (!restaurantMatches && distance > 350) {
    return 0;
  }

  const overlapStart = Math.max(visit.startTime, reservation.startTime);
  const overlapEnd = Math.min(visit.endTime, reservation.endTime);
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  const reservationDuration = Math.max(1, reservation.endTime - reservation.startTime);
  const overlapRatio = overlapMs / reservationDuration;

  let score = overlapRatio * 100;
  if (restaurantMatches) {
    score += 500;
  }
  if (distance <= 75) {
    score += 250;
  } else if (distance <= 150) {
    score += 150;
  } else if (distance <= 250) {
    score += 75;
  }
  if (visit.photoCount > 0) {
    score += 25;
  }
  if (visit.status === "pending") {
    score += 20;
  }

  return score;
}

function isExternalReservationRestaurantId(restaurantId: string | null): boolean {
  return (
    restaurantId?.startsWith("resy-") === true ||
    restaurantId?.startsWith("tock-") === true ||
    restaurantId?.startsWith("opentable-") === true
  );
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
