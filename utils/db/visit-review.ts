import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";
import { DEBUG_TIMING, getDatabase } from "./core";
import type { AggregatedFoodLabel, FoodLabel, PendingVisitForReview, SuggestedRestaurantDetail } from "./types";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "./visit-review-core";

// Get pending visits that need review (with suggestions)
export async function getPendingVisitsForReview(): Promise<PendingVisitForReview[]> {
  const start = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();

  const results = await database.getAllAsync<PendingVisitReviewQueryRow>(PENDING_VISITS_FOR_REVIEW_SQL);

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
