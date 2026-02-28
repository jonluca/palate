import { DEBUG_TIMING, getDatabase } from "./core";
import type { VisitRecord, VisitWithDetails } from "./types";

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

export async function getVisitsNeedingFoodDetection(): Promise<VisitRecord[]> {
  const database = await getDatabase();
  // Get visits that have any unanalyzed photos (foodDetected IS NULL)
  // This includes both visits with no analyzed photos and visits with some unanalyzed photos
  return database.getAllAsync<VisitRecord>(
    `SELECT v.* FROM visits v
     WHERE EXISTS (
       SELECT 1 FROM photos p WHERE p.visitId = v.id AND p.foodDetected IS NULL
     )
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
    // Get deterministic sample of photos for this visit:
    // - Only select photos that haven't been analyzed yet (foodDetected IS NULL)
    // - Order by creationTime and id for deterministic selection
    // - Sample based on percentage of total photos in the visit (including analyzed ones)
    const photos = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM photos 
       WHERE visitId = ? AND foodDetected IS NULL 
       ORDER BY creationTime ASC, id ASC 
       LIMIT MAX(1, CAST((SELECT COUNT(*) FROM photos WHERE visitId = ?) * ? AS INTEGER))`,
      [visitId, visitId, samplePercentage],
    );

    for (const photo of photos) {
      samples.push({ visitId, photoId: photo.id });
    }
  }

  return samples;
}

export async function getVisitsByRestaurantId(restaurantId: string): Promise<VisitRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<VisitRecord>(
    `SELECT * FROM visits WHERE restaurantId = ? AND status = 'confirmed' ORDER BY startTime DESC`,
    [restaurantId],
  );
}

export interface BatchVisitConfirmation {
  visitId: string;
  restaurantId: string;
  restaurantName: string;
  latitude: number;
  longitude: number;
  awardAtVisit?: string | null;
}

const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BASE_DELAY_MS = 50;

function isDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function batchConfirmVisits(confirmations: BatchVisitConfirmation[]): Promise<void> {
  if (confirmations.length === 0) {
    return;
  }

  const database = await getDatabase();
  const now = Date.now();
  // Keep the CASE update under SQLite's default 999 bind parameter limit (~5 params per row).
  const batchSize = 150;

  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
    try {
      await database.withExclusiveTransactionAsync(async (tx) => {
        for (let i = 0; i < confirmations.length; i += batchSize) {
          const batch = confirmations.slice(i, i + batchSize);

          // Insert any missing restaurants once per batch before updating visits (foreign key on visits.restaurantId).
          const restaurantsById = new Map<string, { id: string; name: string; latitude: number; longitude: number }>();

          for (const confirmation of batch) {
            if (!restaurantsById.has(confirmation.restaurantId)) {
              restaurantsById.set(confirmation.restaurantId, {
                id: confirmation.restaurantId,
                name: confirmation.restaurantName,
                latitude: confirmation.latitude,
                longitude: confirmation.longitude,
              });
            }
          }

          const restaurants = Array.from(restaurantsById.values());
          const restaurantPlaceholders = restaurants.map(() => "(?, ?, ?, ?)").join(", ");
          const restaurantValues = restaurants.flatMap((restaurant) => [
            restaurant.id,
            restaurant.name,
            restaurant.latitude,
            restaurant.longitude,
          ]);

          await tx.runAsync(
            `INSERT OR IGNORE INTO restaurants (id, name, latitude, longitude) VALUES ${restaurantPlaceholders}`,
            restaurantValues,
          );

          const restaurantWhenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
          const awardWhenClauses = batch.map(() => "WHEN ? THEN ?").join(" ");
          const visitIds = batch.map((confirmation) => confirmation.visitId);
          const visitPlaceholders = visitIds.map(() => "?").join(", ");

          await tx.runAsync(
            `UPDATE visits
             SET restaurantId = CASE id ${restaurantWhenClauses} END,
                 status = 'confirmed',
                 updatedAt = ?,
                 awardAtVisit = CASE id ${awardWhenClauses} END
             WHERE id IN (${visitPlaceholders})`,
            [
              ...batch.flatMap((confirmation) => [confirmation.visitId, confirmation.restaurantId]),
              now,
              ...batch.flatMap((confirmation) => [confirmation.visitId, confirmation.awardAtVisit ?? null]),
              ...visitIds,
            ],
          );
        }
      });
      return;
    } catch (error) {
      const isBusyError = isDatabaseBusyError(error);
      const isLastAttempt = attempt === BUSY_RETRY_ATTEMPTS - 1;
      if (!isBusyError || isLastAttempt) {
        throw error;
      }
      const delayMs = BUSY_RETRY_BASE_DELAY_MS * 2 ** attempt;
      await delay(delayMs);
    }
  }
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
  await batchConfirmVisits([{ visitId, restaurantId, restaurantName, latitude, longitude, awardAtVisit }]);
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
