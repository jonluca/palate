import {
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
} from "@/services/calendar";
import { DEBUG_TIMING, getDatabase } from "./core";
import type { PendingVisitForReview, SuggestedRestaurantDetail } from "./types";
import {
  PENDING_QUICK_ACTIONS_SQL,
  createPendingQuickActionsData,
  parseLegacyPendingVisitFoodLabels,
  parsePendingQuickActionRows,
  type PendingQuickActionQueryRow,
  type PendingQuickActionsData,
} from "./quick-actions-core";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "./visit-review-core";
import {
  DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
  PENDING_VISIT_REVIEW_MANIFEST_SQL,
  PENDING_VISIT_REVIEW_PAGE_SQL,
  createPendingVisitReviewGeneration,
  parsePendingVisitReviewManifest,
  serializePendingVisitReviewPageKeys,
  validatePendingVisitReviewPageSize,
  type PendingVisitReviewFilters,
  type PendingVisitReviewGeneration,
  type PendingVisitReviewManifestItem,
  type PendingVisitReviewManifestRow,
  type PendingVisitReviewPage,
  type PendingVisitReviewPageKey,
  type PendingVisitReviewPageRequest,
} from "./visit-review-paging-core";

export type PendingVisitReviewProgressivePage = PendingVisitReviewPage<PendingVisitForReview>;
export type {
  PendingQuickActionExactMatch,
  PendingQuickActionSuggestion,
  PendingQuickActionVisit,
  PendingQuickActionsData,
} from "./quick-actions-core";

const PENDING_VISIT_REVIEW_MATCH_TOOLS = {
  cleanCalendarEventTitle,
  isFuzzyRestaurantMatch,
  compareRestaurantAndCalendarTitle,
} as const;

/** Decode card-sized raw rows without changing their caller-supplied order. */
export function mapPendingVisitReviewRows(results: readonly PendingVisitReviewQueryRow[]): PendingVisitForReview[] {
  return results.map((row) => {
    let previewPhotos: string[] = [];
    if (row.previewPhotosJson) {
      try {
        previewPhotos = JSON.parse(row.previewPhotosJson);
      } catch {
        // Preserve legacy tolerance for malformed optional JSON.
      }
    }

    let suggestedRestaurants: SuggestedRestaurantDetail[] = [];
    if (row.suggestedRestaurantsJson) {
      try {
        suggestedRestaurants = JSON.parse(row.suggestedRestaurantsJson);
      } catch {
        // Preserve legacy tolerance for malformed optional JSON.
      }
    }

    const foodLabels = parseLegacyPendingVisitFoodLabels(row.foodLabelsJson, Boolean(row.foodProbable));

    return {
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
      exportedToCalendarId: null,
      notes: row.notes,
      updatedAt: row.updatedAt,
      awardAtVisit: null,
      restaurantName: row.restaurantName,
      suggestedRestaurantName: row.suggestedRestaurantName,
      suggestedRestaurantAward: row.suggestedRestaurantAward,
      suggestedRestaurantCuisine: row.suggestedRestaurantCuisine,
      suggestedRestaurantAddress: row.suggestedRestaurantAddress,
      previewPhotos,
      suggestedRestaurants,
      foodLabels,
      hasUnanalyzedPhotos: row.hasUnanalyzedPhotos === 1,
    };
  });
}

function orderPendingVisitsByFuzzyCalendarMatch(visits: readonly PendingVisitForReview[]): PendingVisitForReview[] {
  const matched: PendingVisitForReview[] = [];
  const remaining: PendingVisitForReview[] = [];
  const restaurantNames = new Map<string, string>();

  for (const visit of visits) {
    let hasMatch = false;
    if (visit.calendarEventTitle && visit.suggestedRestaurants.length > 0) {
      const cleanedTitle = cleanCalendarEventTitle(visit.calendarEventTitle);
      if (cleanedTitle) {
        hasMatch = visit.suggestedRestaurants.some((restaurant) => {
          const restaurantName = restaurantNames.get(restaurant.id) ?? restaurant.name;
          restaurantNames.set(restaurant.id, restaurantName);
          return isFuzzyRestaurantMatch(cleanedTitle, restaurantName);
        });
      }
    }
    (hasMatch ? matched : remaining).push(visit);
  }

  return [...matched, ...remaining];
}

/** Legacy monolithic API retained as a safe paging fallback and parity oracle. */
export async function getPendingVisitsForReview(): Promise<PendingVisitForReview[]> {
  const startedAt = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();
  const results = await database.getAllAsync<PendingVisitReviewQueryRow>(PENDING_VISITS_FOR_REVIEW_SQL);
  const visits = orderPendingVisitsByFuzzyCalendarMatch(mapPendingVisitReviewRows(results));

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getPendingVisitsForReview: ${(performance.now() - startedAt).toFixed(2)}ms (${visits.length} results)`,
    );
  }
  return visits;
}

/** Fetch the complete Quick Actions queue without hydrating Review card fields. */
export async function getPendingQuickActionsData(): Promise<PendingQuickActionsData> {
  const startedAt = DEBUG_TIMING ? performance.now() : 0;
  const database = await getDatabase();
  const rows = await database.getAllAsync<PendingQuickActionQueryRow>(PENDING_QUICK_ACTIONS_SQL);
  const data = createPendingQuickActionsData(parsePendingQuickActionRows(rows), PENDING_VISIT_REVIEW_MATCH_TOOLS);

  if (DEBUG_TIMING) {
    console.log(
      `[DB] getPendingQuickActionsData: ${(performance.now() - startedAt).toFixed(2)}ms (${data.visits.length} visits, ${data.exactMatches.length} exact matches)`,
    );
  }
  return data;
}

function priorityForVisit(visit: PendingVisitForReview): 1 | 2 | 3 | 4 {
  const hasRestaurantMatch = Boolean(visit.suggestedRestaurantId) || visit.suggestedRestaurants.length > 0;
  if (visit.foodProbable && hasRestaurantMatch) {
    return 1;
  }
  if (hasRestaurantMatch) {
    return 2;
  }
  return visit.foodProbable ? 3 : 4;
}

function manifestItemsFromVisits(visits: readonly PendingVisitForReview[]): PendingVisitReviewManifestItem[] {
  return visits.map((visit) => ({
    id: visit.id,
    priority: priorityForVisit(visit),
    startTime: visit.startTime,
    foodProbable: visit.foodProbable,
    calendarEventTitle: visit.calendarEventTitle,
    suggestedRestaurants: visit.suggestedRestaurants.map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
    })),
  }));
}

function assertPageRowsMatchRequestedOrder(
  rows: readonly PendingVisitReviewQueryRow[],
  requestedKeys: readonly PendingVisitReviewPageKey[],
): void {
  const keyIndexById = new Map(requestedKeys.map((key, index) => [key.id, index]));
  let previousIndex = -1;
  for (const row of rows) {
    const index = keyIndexById.get(row.id);
    if (index === undefined || index <= previousIndex) {
      throw new Error("Pending-review page returned an unexpected or out-of-order visit");
    }
    if (row.priority !== requestedKeys[index]?.priority) {
      throw new Error(`Pending-review page priority changed for visit ${JSON.stringify(row.id)}`);
    }
    previousIndex = index;
  }
}

async function hydratePendingVisitReviewPage(
  generationId: string,
  requestedKeys: readonly PendingVisitReviewPageKey[],
  manifest: PendingVisitReviewGeneration | null,
): Promise<PendingVisitReviewProgressivePage> {
  if (requestedKeys.length === 0) {
    return { generationId, requestedKeys: [], visits: [], manifest };
  }
  const database = await getDatabase();
  const rows = await database.getAllAsync<PendingVisitReviewQueryRow>(
    PENDING_VISIT_REVIEW_PAGE_SQL,
    serializePendingVisitReviewPageKeys(requestedKeys),
  );
  assertPageRowsMatchRequestedOrder(rows, requestedKeys);
  return {
    generationId,
    requestedKeys: [...requestedKeys],
    visits: mapPendingVisitReviewRows(rows),
    manifest,
  };
}

async function legacyFallbackFirstPage(filters: PendingVisitReviewFilters): Promise<PendingVisitReviewProgressivePage> {
  const visits = await getPendingVisitsForReview();
  const items = manifestItemsFromVisits(visits);
  const manifest = createPendingVisitReviewGeneration(
    items,
    filters,
    PENDING_VISIT_REVIEW_MATCH_TOOLS,
    JSON.stringify(items),
    "legacy-fallback",
  );
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  return {
    generationId: manifest.generationId,
    requestedKeys: manifest.selectedKeys,
    visits: manifest.selectedKeys.flatMap((key) => {
      const visit = visitById.get(key.id);
      return visit ? [visit] : [];
    }),
    manifest,
  };
}

export async function getPendingVisitReviewFirstPage(
  filters: PendingVisitReviewFilters,
  pageSize: number = DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
): Promise<PendingVisitReviewProgressivePage> {
  validatePendingVisitReviewPageSize(pageSize);
  try {
    const database = await getDatabase();
    const row = await database.getFirstAsync<PendingVisitReviewManifestRow>(PENDING_VISIT_REVIEW_MANIFEST_SQL);
    if (!row) {
      throw new Error("Pending-review manifest query returned no row");
    }
    const items = parsePendingVisitReviewManifest(row);
    const manifest = createPendingVisitReviewGeneration(
      items,
      filters,
      PENDING_VISIT_REVIEW_MATCH_TOOLS,
      row.manifestJson,
    );
    return hydratePendingVisitReviewPage(manifest.generationId, manifest.selectedKeys.slice(0, pageSize), manifest);
  } catch (error) {
    console.warn("[DB] Progressive pending-review bootstrap failed; using legacy hydration.", error);
    return legacyFallbackFirstPage(filters);
  }
}

export async function getPendingVisitReviewPage(
  request: PendingVisitReviewPageRequest,
): Promise<PendingVisitReviewProgressivePage> {
  try {
    return await hydratePendingVisitReviewPage(request.generationId, request.keys, null);
  } catch (error) {
    console.warn("[DB] Progressive pending-review page failed; using legacy hydration for that page.", error);
    const visits = await getPendingVisitsForReview();
    const visitById = new Map(visits.map((visit) => [visit.id, visit]));
    return {
      generationId: request.generationId,
      requestedKeys: [...request.keys],
      visits: request.keys.flatMap((key) => {
        const visit = visitById.get(key.id);
        return visit ? [visit] : [];
      }),
      manifest: null,
    };
  }
}
