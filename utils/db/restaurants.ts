import { DEBUG_TIMING, getDatabase } from "./core";
import type { RestaurantRecord, RestaurantWithVisits, UpdateRestaurantData } from "./types";

export async function getAllRestaurants(): Promise<RestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<RestaurantRecord>(`SELECT * FROM restaurants`);
}

export async function getRestaurantById(id: string): Promise<RestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<RestaurantRecord>(`SELECT * FROM restaurants WHERE id = ?`, [id]);
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

// Get confirmed restaurants with visit counts
export async function getConfirmedRestaurantsWithVisits(): Promise<RestaurantWithVisits[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  // Single query with CTEs to get restaurants, stats, preview photos, and Michelin awards
  const rows = await database.getAllAsync<
    RestaurantRecord & {
      visitCount: number;
      lastVisit: number;
      lastConfirmedAt: number | null;
      previewPhotosJson: string | null;
      currentAward: string | null;
      visitedAward: string | null;
    }
  >(
    `WITH 
      -- Get restaurant stats from confirmed visits
      restaurant_stats AS (
        SELECT 
          restaurantId,
          COUNT(id) as visitCount,
          MAX(startTime) as lastVisit,
          MAX(updatedAt) as lastConfirmedAt
        FROM visits
        WHERE status = 'confirmed' AND restaurantId IS NOT NULL
        GROUP BY restaurantId
      ),
      
      -- Rank photos for each restaurant (prioritize food photos, then by time)
      ranked_photos AS (
        SELECT 
          v.restaurantId,
          p.uri,
          ROW_NUMBER() OVER (
            PARTITION BY v.restaurantId 
            ORDER BY 
              CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC, 
              p.creationTime DESC
          ) as rn
        FROM photos p
        INNER JOIN visits v ON p.visitId = v.id
        WHERE v.status = 'confirmed' AND v.restaurantId IS NOT NULL
      ),
      
      -- Aggregate top 3 photos per restaurant as JSON array
      preview_photos AS (
        SELECT 
          restaurantId,
          json_group_array(uri) as uris
        FROM ranked_photos
        WHERE rn <= 3
        GROUP BY restaurantId
      ),
      
      -- Get the first visit's award for each restaurant (to show if it changed)
      first_visit_award AS (
        SELECT 
          restaurantId,
          awardAtVisit as visitedAward
        FROM (
          SELECT 
            restaurantId,
            awardAtVisit,
            ROW_NUMBER() OVER (PARTITION BY restaurantId ORDER BY startTime ASC) as rn
          FROM visits
          WHERE status = 'confirmed' AND restaurantId IS NOT NULL AND awardAtVisit IS NOT NULL
        )
        WHERE rn = 1
      )
      
    SELECT 
      r.*,
      rs.visitCount,
      rs.lastVisit,
      rs.lastConfirmedAt,
      pp.uris as previewPhotosJson,
      m.award as currentAward,
      fva.visitedAward
    FROM restaurants r
    INNER JOIN restaurant_stats rs ON rs.restaurantId = r.id
    LEFT JOIN preview_photos pp ON pp.restaurantId = r.id
    LEFT JOIN michelin_restaurants m ON r.id = m.id
    LEFT JOIN first_visit_award fva ON fva.restaurantId = r.id
    ORDER BY rs.lastVisit DESC`,
  );

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getConfirmedRestaurantsWithVisits: ${(performance.now() - start).toFixed(2)}ms (${rows.length} results)`,
    );
  }

  // Parse JSON and build result
  return rows.map((row) => {
    let previewPhotos: string[] = [];
    if (row.previewPhotosJson) {
      try {
        previewPhotos = JSON.parse(row.previewPhotosJson) as string[];
      } catch {
        // Skip malformed JSON
      }
    }

    // Destructure to separate previewPhotosJson from the rest
    const { previewPhotosJson: _, currentAward, visitedAward, ...restaurantData } = row;

    return {
      ...restaurantData,
      previewPhotos,
      currentAward: currentAward ?? null,
      // Only include visitedAward if it's different from the current award
      visitedAward: visitedAward && visitedAward !== currentAward ? visitedAward : null,
    };
  });
}
