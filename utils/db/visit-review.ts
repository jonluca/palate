import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";
import { DEBUG_TIMING, getDatabase } from "./core";
import type { AggregatedFoodLabel, FoodLabel, PendingVisitForReview, SuggestedRestaurantDetail } from "./types";

// Get pending visits that need review (with suggestions)
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
    hasUnanalyzedPhotos: number;
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
      END as priority,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM photos p_check
          WHERE p_check.visitId = pv.id
            AND p_check.foodDetected IS NULL
        ) THEN 1
        ELSE 0
      END as hasUnanalyzedPhotos
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
      hasUnanalyzedPhotos: row.hasUnanalyzedPhotos === 1,
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
