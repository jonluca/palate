import {
  buildCalendarImportAvailabilityStatement,
  CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE,
  type CalendarImportSnapshotPlan,
  type CalendarImportVisitPlan,
} from "../calendar-import-plan-core.ts";

const CALENDAR_IMPORT_NEARBY_CONFIRMED_BATCH_SIZE = 300;
const CALENDAR_IMPORT_RESTAURANT_BATCH_SIZE = 150;
const CALENDAR_IMPORT_VISIT_BATCH_SIZE = 80;
const CALENDAR_IMPORT_SUGGESTION_BATCH_SIZE = 300;
const ONE_DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

type CalendarImportBindValue = string | number | null;

export interface CalendarImportTransactionBackend {
  readonly getAllAsync: <Row>(sql: string, parameters: CalendarImportBindValue[]) => Promise<Row[]>;
  readonly runAsync: (sql: string, parameters: CalendarImportBindValue[]) => Promise<{ readonly changes: number }>;
}

export interface CalendarImportTransactionResult {
  readonly requestedCalendarEventIds: string[];
  readonly insertedCalendarEventIds: string[];
  readonly unavailableCalendarEventIds: string[];
  readonly nearbyConfirmedCalendarEventIds: string[];
  readonly insertConflictCalendarEventIds: string[];
  readonly insertedCount: number;
}

interface NearbyConfirmedCandidate {
  readonly calendarEventId: string;
  readonly startTime: number;
  readonly restaurantId: string;
}

interface ReturnedVisitRow {
  readonly id: string;
  readonly calendarEventId: string;
}

function chunks<T>(values: readonly T[], maximumSize: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += maximumSize) {
    result.push(values.slice(offset, offset + maximumSize));
  }
  return result;
}

async function loadUnavailableEventIds(
  transaction: CalendarImportTransactionBackend,
  visits: readonly CalendarImportVisitPlan[],
): Promise<Set<string>> {
  const unavailableEventIds = new Set<string>();
  const eventIds = visits.map((visit) => visit.calendarEventId);
  for (const batch of chunks(eventIds, CALENDAR_IMPORT_AVAILABILITY_BATCH_SIZE)) {
    const statement = buildCalendarImportAvailabilityStatement(batch);
    const rows = await transaction.getAllAsync<{ calendarEventId: string }>(statement.sql, statement.parameters);
    for (const row of rows) {
      unavailableEventIds.add(row.calendarEventId);
    }
  }
  return unavailableEventIds;
}

async function loadNearbyConfirmedEventIds(
  transaction: CalendarImportTransactionBackend,
  visits: readonly CalendarImportVisitPlan[],
): Promise<Set<string>> {
  const candidates: NearbyConfirmedCandidate[] = [];
  for (const visit of visits) {
    for (const restaurantId of visit.matchedRestaurantIds) {
      candidates.push({
        calendarEventId: visit.calendarEventId,
        startTime: visit.startTime,
        restaurantId,
      });
    }
  }

  const nearbyEventIds = new Set<string>();
  for (const batch of chunks(candidates, CALENDAR_IMPORT_NEARBY_CONFIRMED_BATCH_SIZE)) {
    const values = batch.map(() => "(?, ?, ?)").join(", ");
    const parameters = batch.flatMap((candidate) => [
      candidate.calendarEventId,
      candidate.startTime,
      candidate.restaurantId,
    ]);
    const rows = await transaction.getAllAsync<{ calendarEventId: string }>(
      `WITH candidates(calendarEventId, eventStartTime, restaurantId) AS (VALUES ${values})
       SELECT DISTINCT candidates.calendarEventId
       FROM candidates
       JOIN visit_suggested_restaurants suggestions
         ON suggestions.restaurantId = candidates.restaurantId
       JOIN visits
         ON visits.id = suggestions.visitId
       WHERE visits.status = 'confirmed'
         AND visits.startTime BETWEEN
           candidates.eventStartTime - ${ONE_DAY_MILLISECONDS}
           AND candidates.eventStartTime + ${ONE_DAY_MILLISECONDS}`,
      parameters,
    );
    for (const row of rows) {
      nearbyEventIds.add(row.calendarEventId);
    }
  }
  return nearbyEventIds;
}

async function insertRestaurants(
  transaction: CalendarImportTransactionBackend,
  visits: readonly CalendarImportVisitPlan[],
): Promise<void> {
  const restaurantsById = new Map<string, CalendarImportVisitPlan["matchedRestaurant"]>();
  for (const visit of visits) {
    if (!restaurantsById.has(visit.matchedRestaurant.id)) {
      restaurantsById.set(visit.matchedRestaurant.id, visit.matchedRestaurant);
    }
  }

  for (const batch of chunks([...restaurantsById.values()], CALENDAR_IMPORT_RESTAURANT_BATCH_SIZE)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const parameters = batch.flatMap((restaurant) => [
      restaurant.id,
      restaurant.name,
      restaurant.latitude,
      restaurant.longitude,
      restaurant.address || null,
      restaurant.cuisine || null,
    ]);
    await transaction.runAsync(
      `INSERT OR IGNORE INTO restaurants (id, name, latitude, longitude, address, cuisine)
       VALUES ${values}`,
      parameters,
    );
  }
}

async function insertVisits(
  transaction: CalendarImportTransactionBackend,
  visits: readonly CalendarImportVisitPlan[],
  updatedAt: number,
): Promise<ReturnedVisitRow[]> {
  const insertedRows: ReturnedVisitRow[] = [];
  for (const batch of chunks(visits, CALENDAR_IMPORT_VISIT_BATCH_SIZE)) {
    const values = batch.map(() => "(?, ?, ?, 'confirmed', ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?)").join(", ");
    const parameters = batch.flatMap((visit) => [
      visit.id,
      visit.matchedRestaurant.id,
      visit.matchedRestaurant.id,
      visit.startTime,
      visit.endTime,
      visit.matchedRestaurant.latitude,
      visit.matchedRestaurant.longitude,
      visit.calendarEventId,
      visit.calendarEventTitle,
      visit.calendarEventLocation,
      updatedAt,
    ]);
    insertedRows.push(
      ...(await transaction.getAllAsync<ReturnedVisitRow>(
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
           updatedAt
         ) VALUES ${values}
         RETURNING id, calendarEventId`,
        parameters,
      )),
    );
  }
  return insertedRows;
}

async function insertSuggestions(
  transaction: CalendarImportTransactionBackend,
  visits: readonly CalendarImportVisitPlan[],
): Promise<void> {
  for (const batch of chunks(visits, CALENDAR_IMPORT_SUGGESTION_BATCH_SIZE)) {
    const values = batch.map(() => "(?, ?, 0)").join(", ");
    const parameters = batch.flatMap((visit) => [visit.id, visit.matchedRestaurant.id]);
    await transaction.runAsync(
      `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
       VALUES ${values}`,
      parameters,
    );
  }
}

/**
 * Execute one already-open transaction. The caller owns commit/rollback; every
 * conflict read and every write intentionally uses this same transaction object.
 */
export async function executeCalendarImportTransaction(
  transaction: CalendarImportTransactionBackend,
  plan: CalendarImportSnapshotPlan,
  updatedAt: number,
): Promise<CalendarImportTransactionResult> {
  if (!Number.isFinite(updatedAt)) {
    throw new RangeError("Calendar import persistence time must be finite.");
  }

  const requestedCalendarEventIds = plan.visitsToCreate.map((visit) => visit.calendarEventId);
  if (plan.visitsToCreate.length === 0) {
    return {
      requestedCalendarEventIds,
      insertedCalendarEventIds: [],
      unavailableCalendarEventIds: [],
      nearbyConfirmedCalendarEventIds: [],
      insertConflictCalendarEventIds: [],
      insertedCount: 0,
    };
  }

  const unavailableEventIds = await loadUnavailableEventIds(transaction, plan.visitsToCreate);
  const availableVisits = plan.visitsToCreate.filter((visit) => !unavailableEventIds.has(visit.calendarEventId));
  const nearbyConfirmedEventIds = await loadNearbyConfirmedEventIds(transaction, availableVisits);
  const eligibleVisits = availableVisits.filter((visit) => !nearbyConfirmedEventIds.has(visit.calendarEventId));

  await insertRestaurants(transaction, eligibleVisits);
  const returnedRows = await insertVisits(transaction, eligibleVisits, updatedAt);
  const eligibleVisitsById = new Map(eligibleVisits.map((visit) => [visit.id, visit]));
  const returnedVisitIds = new Set<string>();
  for (const row of returnedRows) {
    const visit = eligibleVisitsById.get(row.id);
    if (!visit || visit.calendarEventId !== row.calendarEventId || returnedVisitIds.has(row.id)) {
      throw new Error("Calendar import INSERT RETURNING produced an invalid or duplicate visit row.");
    }
    returnedVisitIds.add(row.id);
  }
  const insertedVisits = eligibleVisits.filter((visit) => returnedVisitIds.has(visit.id));
  await insertSuggestions(transaction, insertedVisits);

  const insertedCalendarEventIds = insertedVisits.map((visit) => visit.calendarEventId);
  const insertedEventIdSet = new Set(insertedCalendarEventIds);
  return {
    requestedCalendarEventIds,
    insertedCalendarEventIds,
    unavailableCalendarEventIds: requestedCalendarEventIds.filter((eventId) => unavailableEventIds.has(eventId)),
    nearbyConfirmedCalendarEventIds: requestedCalendarEventIds.filter((eventId) =>
      nearbyConfirmedEventIds.has(eventId),
    ),
    insertConflictCalendarEventIds: eligibleVisits
      .filter((visit) => !insertedEventIdSet.has(visit.calendarEventId))
      .map((visit) => visit.calendarEventId),
    insertedCount: insertedCalendarEventIds.length,
  };
}
