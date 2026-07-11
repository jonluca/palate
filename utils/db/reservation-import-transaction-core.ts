import { calculateDistanceMeters } from "../../data/restaurants.ts";
import type { ReservationOnlyVisitImportResult, ReservationOnlyVisitInput, VisitRecord } from "./types.ts";

type ReservationImportBindValue = string | number | null;

export interface ReservationImportTransactionBackend {
  readonly getAllAsync: <Row>(sql: string, parameters: ReservationImportBindValue[]) => Promise<Row[]>;
  readonly runAsync: (sql: string, parameters: ReservationImportBindValue[]) => Promise<{ readonly changes: number }>;
}

type ReservationOverlapVisit = VisitRecord & {
  readonly restaurantName?: string | null;
  readonly suggestedRestaurantName?: string | null;
};

interface ExistingIdentityRow {
  readonly kind: "source" | "calendar" | "visit";
  readonly value: string;
}

interface PlannedVisitInsert {
  readonly ordinal: number;
  readonly visit: ReservationOnlyVisitInput;
}

interface PlannedSourceMapping {
  readonly ordinal: number;
  readonly sourceEventId: string;
  readonly sourceName: string;
  readonly targetVisitId: string;
}

interface PlannedSuggestion {
  readonly ordinal: number;
  readonly visitId: string;
  readonly restaurantId: string;
  readonly distance: number;
}

interface CoalescedVisitUpdate {
  readonly id: string;
  readonly updatedAt: number;
  writeCalendar: boolean;
  calendarEventId: string | null;
  calendarEventTitle: string | null;
  calendarEventLocation: string | null;
  writeSuggestedRestaurant: boolean;
  suggestedRestaurantId: string | null;
  writeConfirmation: boolean;
  restaurantId: string | null;
  writeAward: boolean;
  awardAtVisit: string | null;
}

interface ReservationImportPlan {
  readonly newVisits: ReservationOnlyVisitInput[];
  readonly inserts: PlannedVisitInsert[];
  readonly updates: CoalescedVisitUpdate[];
  readonly sourceMappings: PlannedSourceMapping[];
  readonly suggestions: PlannedSuggestion[];
  readonly linkedExistingCountBeforeInsertConflicts: number;
  readonly confirmedExistingCount: number;
}

interface ReturnedVisitRow {
  readonly id: string;
}

const OVERLAP_BUFFER_MILLISECONDS = 30 * 60 * 1_000;

async function acquireReservationImportWriteIntent(transaction: ReservationImportTransactionBackend): Promise<void> {
  // Expo's exclusive transaction begins deferred. Take the WAL writer lock
  // before any recheck reads so a later write cannot fail with BUSY_SNAPSHOT.
  // Its dedicated connection does not inherit the main connection's timeout,
  // so configure the same five-second contention horizon before locking.
  await transaction.runAsync(`PRAGMA busy_timeout = 5000`, []);
  // The false predicate keeps the lock statement byte-stable and row-neutral.
  await transaction.runAsync(
    `UPDATE reservation_import_sources
     SET importedAt = importedAt
     WHERE 0`,
    [],
  );
}

function dedupeVisitsBySourceEventId(visits: readonly ReservationOnlyVisitInput[]): ReservationOnlyVisitInput[] {
  const uniqueVisits = new Map<string, ReservationOnlyVisitInput>();
  for (const visit of visits) {
    if (!uniqueVisits.has(visit.sourceEventId)) {
      uniqueVisits.set(visit.sourceEventId, visit);
    }
  }
  return [...uniqueVisits.values()];
}

function inputIdentityJson(visits: readonly ReservationOnlyVisitInput[]): string {
  return JSON.stringify(visits.map((visit) => ({ sourceEventId: visit.sourceEventId, visitId: visit.id })));
}

async function loadExistingIdentities(
  transaction: ReservationImportTransactionBackend,
  visits: readonly ReservationOnlyVisitInput[],
): Promise<ExistingIdentityRow[]> {
  return transaction.getAllAsync<ExistingIdentityRow>(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.sourceEventId') AS TEXT) AS sourceEventId,
         CAST(json_extract(value, '$.visitId') AS TEXT) AS visitId
       FROM json_each(?)
     )
     SELECT 'source' AS kind, sources.sourceEventId AS value
     FROM reservation_import_sources AS sources
     JOIN input ON input.sourceEventId = sources.sourceEventId
     UNION ALL
     SELECT 'calendar' AS kind, visits.calendarEventId AS value
     FROM visits
     JOIN input ON input.sourceEventId = visits.calendarEventId
     UNION ALL
     SELECT 'visit' AS kind, visits.id AS value
     FROM visits
     JOIN input ON input.visitId = visits.id`,
    [inputIdentityJson(visits)],
  );
}

async function loadOverlapVisits(
  transaction: ReservationImportTransactionBackend,
  visits: readonly ReservationOnlyVisitInput[],
): Promise<ReservationOverlapVisit[]> {
  const minimumStartTime = Math.min(...visits.map((visit) => visit.startTime)) - OVERLAP_BUFFER_MILLISECONDS;
  const maximumEndTime = Math.max(...visits.map((visit) => visit.endTime)) + OVERLAP_BUFFER_MILLISECONDS;
  return transaction.getAllAsync<ReservationOverlapVisit>(
    `SELECT v.*,
            r.name AS restaurantName,
            m.name AS suggestedRestaurantName
     FROM visits AS v
     LEFT JOIN restaurants AS r ON v.restaurantId = r.id
     LEFT JOIN michelin_restaurants AS m ON v.suggestedRestaurantId = m.id
     WHERE v.startTime < ?
       AND v.endTime > ?
     ORDER BY v.startTime ASC`,
    [maximumEndTime, minimumStartTime],
  );
}

function getLocalDateRange(timestamp: number): { readonly startTime: number; readonly endTime: number } {
  const date = new Date(timestamp);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { startTime: start.getTime(), endTime: end.getTime() };
}

async function loadSameDateConfirmedVisits(
  transaction: ReservationImportTransactionBackend,
  visits: readonly ReservationOnlyVisitInput[],
): Promise<ReservationOverlapVisit[]> {
  const ranges = visits.map((visit) => getLocalDateRange(visit.startTime));
  const minimumStartTime = Math.min(...ranges.map((range) => range.startTime));
  const maximumEndTime = Math.max(...ranges.map((range) => range.endTime));
  return transaction.getAllAsync<ReservationOverlapVisit>(
    `SELECT v.*,
            r.name AS restaurantName,
            m.name AS suggestedRestaurantName
     FROM visits AS v
     LEFT JOIN restaurants AS r ON v.restaurantId = r.id
     LEFT JOIN michelin_restaurants AS m ON v.suggestedRestaurantId = m.id
     WHERE v.status = 'confirmed'
       AND v.startTime >= ?
       AND v.startTime < ?
     ORDER BY v.startTime ASC`,
    [minimumStartTime, maximumEndTime],
  );
}

function isSameLocalDate(first: number, second: number): boolean {
  const firstDate = new Date(first);
  const secondDate = new Date(second);
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

function normalizeRestaurantName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/'s\b/g, "s")
    .replace(/[''’`´ʼʻ]/g, "")
    .replace(/\b(reservation|booking|dinner|lunch|brunch|breakfast|completed|at|for|via)\b/g, " ")
    .replace(/\b(resy|opentable|open table|tock)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantRestaurantNameWords(value: string): string[] {
  const ignoredWords = new Set([
    "the",
    "restaurant",
    "cafe",
    "bar",
    "bistro",
    "kitchen",
    "grill",
    "house",
    "room",
    "and",
    "of",
    "in",
    "on",
  ]);
  return value.split(" ").filter((word) => word.length > 1 && !ignoredWords.has(word));
}

function restaurantNamesAreSimilar(first: string, second: string): boolean {
  const normalizedFirst = normalizeRestaurantName(first);
  const normalizedSecond = normalizeRestaurantName(second);
  if (normalizedFirst.length < 3 || normalizedSecond.length < 3) {
    return false;
  }
  if (normalizedFirst === normalizedSecond) {
    return true;
  }
  if (normalizedFirst.length >= 6 && normalizedSecond.length >= 6) {
    return normalizedFirst.includes(normalizedSecond) || normalizedSecond.includes(normalizedFirst);
  }

  const firstWords = significantRestaurantNameWords(normalizedFirst);
  const secondWords = significantRestaurantNameWords(normalizedSecond);
  const shorter = firstWords.length <= secondWords.length ? firstWords : secondWords;
  const longer = firstWords.length <= secondWords.length ? secondWords : firstWords;
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}

function reservationMatchesExistingRestaurant(
  reservation: ReservationOnlyVisitInput,
  visit: ReservationOverlapVisit,
): boolean {
  if (
    visit.restaurantId === reservation.restaurant.id ||
    visit.suggestedRestaurantId === reservation.restaurant.id ||
    (Boolean(reservation.suggestedRestaurantId) &&
      (visit.restaurantId === reservation.suggestedRestaurantId ||
        visit.suggestedRestaurantId === reservation.suggestedRestaurantId))
  ) {
    return true;
  }

  const reservationNames = [reservation.restaurant.name, reservation.sourceTitle];
  const existingNames = [visit.restaurantName, visit.suggestedRestaurantName, visit.calendarEventTitle];
  return reservationNames.some((reservationName) =>
    existingNames.some(
      (existingName) => typeof existingName === "string" && restaurantNamesAreSimilar(reservationName, existingName),
    ),
  );
}

function scoreReservationOverlap(reservation: ReservationOnlyVisitInput, visit: ReservationOverlapVisit): number {
  if (visit.status === "rejected") {
    return 0;
  }
  if (visit.calendarEventId === reservation.sourceEventId) {
    return 10_000;
  }

  const overlaps =
    visit.startTime < reservation.endTime + OVERLAP_BUFFER_MILLISECONDS &&
    visit.endTime > reservation.startTime - OVERLAP_BUFFER_MILLISECONDS;
  if (!overlaps) {
    return 0;
  }

  const restaurantMatches = reservationMatchesExistingRestaurant(reservation, visit);
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
  const overlapMilliseconds = Math.max(0, overlapEnd - overlapStart);
  const reservationDuration = Math.max(1, reservation.endTime - reservation.startTime);
  let score = (overlapMilliseconds / reservationDuration) * 100;
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

function findBestReservationOverlap(
  reservation: ReservationOnlyVisitInput,
  existingVisits: readonly ReservationOverlapVisit[],
): ReservationOverlapVisit | null {
  let bestVisit: ReservationOverlapVisit | null = null;
  let bestScore = 0;
  for (const visit of existingVisits) {
    const score = scoreReservationOverlap(reservation, visit);
    if (score > bestScore) {
      bestVisit = visit;
      bestScore = score;
    }
  }
  return bestVisit;
}

function findSameDateRestaurantVisit(
  reservation: ReservationOnlyVisitInput,
  existingVisits: readonly ReservationOverlapVisit[],
): ReservationOverlapVisit | null {
  return (
    existingVisits.find(
      (visit) =>
        visit.status === "confirmed" &&
        isSameLocalDate(visit.startTime, reservation.startTime) &&
        reservationMatchesExistingRestaurant(reservation, visit),
    ) ?? null
  );
}

function isExternalReservationRestaurantId(restaurantId: string | null): boolean {
  return (
    restaurantId?.startsWith("resy-") === true ||
    restaurantId?.startsWith("tock-") === true ||
    restaurantId?.startsWith("opentable-") === true
  );
}

function coalescedUpdateFor(
  updatesByVisitId: Map<string, CoalescedVisitUpdate>,
  visitId: string,
  updatedAt: number,
): CoalescedVisitUpdate {
  let update = updatesByVisitId.get(visitId);
  if (!update) {
    update = {
      id: visitId,
      updatedAt,
      writeCalendar: false,
      calendarEventId: null,
      calendarEventTitle: null,
      calendarEventLocation: null,
      writeSuggestedRestaurant: false,
      suggestedRestaurantId: null,
      writeConfirmation: false,
      restaurantId: null,
      writeAward: false,
      awardAtVisit: null,
    };
    updatesByVisitId.set(visitId, update);
  }
  return update;
}

function appendInsertedVisitSnapshot(
  existingVisits: ReservationOverlapVisit[],
  visit: ReservationOnlyVisitInput,
  updatedAt: number,
): void {
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
    updatedAt,
    awardAtVisit: visit.awardAtVisit ?? null,
  });
}

function buildImportPlan(
  newVisits: ReservationOnlyVisitInput[],
  existingVisitIds: ReadonlySet<string>,
  initialOverlapVisits: readonly ReservationOverlapVisit[],
  sameDateConfirmedVisits: readonly ReservationOverlapVisit[],
  updatedAt: number,
): ReservationImportPlan {
  const evolvingOverlapVisits = [...initialOverlapVisits];
  const occupiedVisitIds = new Set(existingVisitIds);
  const inserts: PlannedVisitInsert[] = [];
  const sourceMappings: PlannedSourceMapping[] = [];
  const suggestions: PlannedSuggestion[] = [];
  const updatesByVisitId = new Map<string, CoalescedVisitUpdate>();
  let linkedExistingCountBeforeInsertConflicts = 0;
  let confirmedExistingCount = 0;

  for (let ordinal = 0; ordinal < newVisits.length; ordinal++) {
    const visit = newVisits[ordinal]!;
    const existingVisit =
      findBestReservationOverlap(visit, evolvingOverlapVisits) ??
      findSameDateRestaurantVisit(visit, sameDateConfirmedVisits);
    const targetVisitId = existingVisit?.id ?? visit.id;

    if (existingVisit) {
      const update = coalescedUpdateFor(updatesByVisitId, existingVisit.id, updatedAt);
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

      if (!existingVisit.calendarEventId) {
        update.writeCalendar = true;
        update.calendarEventId = visit.sourceEventId;
        update.calendarEventTitle = visit.sourceTitle;
        update.calendarEventLocation = visit.sourceLocation;
      }
      if (
        visit.suggestedRestaurantId &&
        canUseImportedRestaurant &&
        existingVisit.suggestedRestaurantId !== visit.suggestedRestaurantId
      ) {
        update.writeSuggestedRestaurant = true;
        update.suggestedRestaurantId = visit.suggestedRestaurantId;
      }
      if (shouldConfirmExisting) {
        update.writeConfirmation = true;
        update.restaurantId = visit.restaurant.id;
        update.writeAward = true;
        update.awardAtVisit = visit.awardAtVisit ?? null;
      } else if (
        existingVisit.restaurantId === visit.restaurant.id &&
        !existingVisit.awardAtVisit &&
        visit.awardAtVisit
      ) {
        update.writeAward = true;
        update.awardAtVisit = visit.awardAtVisit;
      }

      linkedExistingCountBeforeInsertConflicts += 1;
      if (!wasConfirmed && shouldConfirmExisting) {
        confirmedExistingCount += 1;
      }
    } else if (occupiedVisitIds.has(visit.id)) {
      linkedExistingCountBeforeInsertConflicts += 1;
    } else {
      occupiedVisitIds.add(visit.id);
      inserts.push({ ordinal, visit });
      appendInsertedVisitSnapshot(evolvingOverlapVisits, visit, updatedAt);
    }

    sourceMappings.push({
      ordinal,
      sourceEventId: visit.sourceEventId,
      sourceName: visit.sourceName,
      targetVisitId,
    });
    if (visit.suggestedRestaurantId) {
      suggestions.push({
        ordinal,
        visitId: targetVisitId,
        restaurantId: visit.suggestedRestaurantId,
        distance: visit.suggestedRestaurantDistance ?? 0,
      });
    }
  }

  return {
    newVisits,
    inserts,
    updates: [...updatesByVisitId.values()],
    sourceMappings,
    suggestions,
    linkedExistingCountBeforeInsertConflicts,
    confirmedExistingCount,
  };
}

function restaurantPayload(visits: readonly ReservationOnlyVisitInput[]): string {
  return JSON.stringify(
    visits.map((visit, ordinal) => ({
      ordinal,
      id: visit.restaurant.id,
      name: visit.restaurant.name,
      latitude: visit.restaurant.latitude,
      longitude: visit.restaurant.longitude,
      address: visit.restaurant.address ?? null,
      phone: visit.restaurant.phone ?? null,
      website: visit.restaurant.website ?? null,
      cuisine: visit.restaurant.cuisine ?? null,
    })),
  );
}

async function upsertRestaurants(
  transaction: ReservationImportTransactionBackend,
  visits: readonly ReservationOnlyVisitInput[],
): Promise<void> {
  await transaction.runAsync(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
         CAST(json_extract(value, '$.id') AS TEXT) AS id,
         CAST(json_extract(value, '$.name') AS TEXT) AS name,
         CAST(json_extract(value, '$.latitude') AS REAL) AS latitude,
         CAST(json_extract(value, '$.longitude') AS REAL) AS longitude,
         CAST(json_extract(value, '$.address') AS TEXT) AS address,
         CAST(json_extract(value, '$.phone') AS TEXT) AS phone,
         CAST(json_extract(value, '$.website') AS TEXT) AS website,
         CAST(json_extract(value, '$.cuisine') AS TEXT) AS cuisine
       FROM json_each(?)
     )
     INSERT INTO restaurants (id, name, latitude, longitude, address, phone, website, cuisine)
     SELECT id, name, latitude, longitude, address, phone, website, cuisine
     FROM input
     WHERE true
     ORDER BY ordinal
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       address = COALESCE(excluded.address, restaurants.address),
       phone = COALESCE(excluded.phone, restaurants.phone),
       website = COALESCE(excluded.website, restaurants.website),
       cuisine = COALESCE(excluded.cuisine, restaurants.cuisine)`,
    [restaurantPayload(visits)],
  );
}

async function updateExistingVisits(
  transaction: ReservationImportTransactionBackend,
  updates: readonly CoalescedVisitUpdate[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  await transaction.runAsync(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.id') AS TEXT) AS id,
         CAST(json_extract(value, '$.updatedAt') AS INTEGER) AS updatedAt,
         CAST(json_extract(value, '$.writeCalendar') AS INTEGER) AS writeCalendar,
         CAST(json_extract(value, '$.calendarEventId') AS TEXT) AS calendarEventId,
         CAST(json_extract(value, '$.calendarEventTitle') AS TEXT) AS calendarEventTitle,
         CAST(json_extract(value, '$.calendarEventLocation') AS TEXT) AS calendarEventLocation,
         CAST(json_extract(value, '$.writeSuggestedRestaurant') AS INTEGER) AS writeSuggestedRestaurant,
         CAST(json_extract(value, '$.suggestedRestaurantId') AS TEXT) AS suggestedRestaurantId,
         CAST(json_extract(value, '$.writeConfirmation') AS INTEGER) AS writeConfirmation,
         CAST(json_extract(value, '$.restaurantId') AS TEXT) AS restaurantId,
         CAST(json_extract(value, '$.writeAward') AS INTEGER) AS writeAward,
         CAST(json_extract(value, '$.awardAtVisit') AS TEXT) AS awardAtVisit
       FROM json_each(?)
     )
     UPDATE visits AS visit
     SET updatedAt = input.updatedAt,
         calendarEventId = CASE WHEN input.writeCalendar = 1 THEN input.calendarEventId ELSE visit.calendarEventId END,
         calendarEventTitle = CASE WHEN input.writeCalendar = 1 THEN input.calendarEventTitle ELSE visit.calendarEventTitle END,
         calendarEventLocation = CASE WHEN input.writeCalendar = 1 THEN input.calendarEventLocation ELSE visit.calendarEventLocation END,
         calendarEventIsAllDay = CASE WHEN input.writeCalendar = 1 THEN 0 ELSE visit.calendarEventIsAllDay END,
         suggestedRestaurantId = CASE
           WHEN input.writeSuggestedRestaurant = 1 THEN input.suggestedRestaurantId
           ELSE visit.suggestedRestaurantId
         END,
         restaurantId = CASE WHEN input.writeConfirmation = 1 THEN input.restaurantId ELSE visit.restaurantId END,
         status = CASE WHEN input.writeConfirmation = 1 THEN 'confirmed' ELSE visit.status END,
         awardAtVisit = CASE WHEN input.writeAward = 1 THEN input.awardAtVisit ELSE visit.awardAtVisit END
     FROM input
     WHERE visit.id = input.id`,
    [JSON.stringify(updates)],
  );
}

function insertedVisitPayload(inserts: readonly PlannedVisitInsert[], updatedAt: number): string {
  return JSON.stringify(
    inserts.map(({ ordinal, visit }) => ({
      ordinal,
      id: visit.id,
      restaurantId: visit.restaurant.id,
      suggestedRestaurantId: visit.suggestedRestaurantId ?? null,
      startTime: visit.startTime,
      endTime: visit.endTime,
      centerLat: visit.restaurant.latitude,
      centerLon: visit.restaurant.longitude,
      calendarEventId: visit.sourceEventId,
      calendarEventTitle: visit.sourceTitle,
      calendarEventLocation: visit.sourceLocation,
      notes: visit.notes ?? null,
      updatedAt,
      awardAtVisit: visit.awardAtVisit ?? null,
    })),
  );
}

async function insertNewVisits(
  transaction: ReservationImportTransactionBackend,
  inserts: readonly PlannedVisitInsert[],
  updatedAt: number,
): Promise<ReturnedVisitRow[]> {
  if (inserts.length === 0) {
    return [];
  }
  return transaction.getAllAsync<ReturnedVisitRow>(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
         CAST(json_extract(value, '$.id') AS TEXT) AS id,
         CAST(json_extract(value, '$.restaurantId') AS TEXT) AS restaurantId,
         CAST(json_extract(value, '$.suggestedRestaurantId') AS TEXT) AS suggestedRestaurantId,
         CAST(json_extract(value, '$.startTime') AS INTEGER) AS startTime,
         CAST(json_extract(value, '$.endTime') AS INTEGER) AS endTime,
         CAST(json_extract(value, '$.centerLat') AS REAL) AS centerLat,
         CAST(json_extract(value, '$.centerLon') AS REAL) AS centerLon,
         CAST(json_extract(value, '$.calendarEventId') AS TEXT) AS calendarEventId,
         CAST(json_extract(value, '$.calendarEventTitle') AS TEXT) AS calendarEventTitle,
         CAST(json_extract(value, '$.calendarEventLocation') AS TEXT) AS calendarEventLocation,
         CAST(json_extract(value, '$.notes') AS TEXT) AS notes,
         CAST(json_extract(value, '$.updatedAt') AS INTEGER) AS updatedAt,
         CAST(json_extract(value, '$.awardAtVisit') AS TEXT) AS awardAtVisit
       FROM json_each(?)
     )
     INSERT OR IGNORE INTO visits (
       id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
       centerLat, centerLon, photoCount, foodProbable, calendarEventId,
       calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
       notes, updatedAt, awardAtVisit
     )
     SELECT
       id, restaurantId, suggestedRestaurantId, 'confirmed', startTime, endTime,
       centerLat, centerLon, 0, 0, calendarEventId, calendarEventTitle,
       calendarEventLocation, 0, notes, updatedAt, awardAtVisit
     FROM input
     WHERE true
     ORDER BY ordinal
     RETURNING id`,
    [insertedVisitPayload(inserts, updatedAt)],
  );
}

async function insertSourceMappings(
  transaction: ReservationImportTransactionBackend,
  mappings: readonly PlannedSourceMapping[],
  importedAt: number,
): Promise<void> {
  if (mappings.length === 0) {
    return;
  }
  await transaction.runAsync(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
         CAST(json_extract(value, '$.sourceEventId') AS TEXT) AS sourceEventId,
         CAST(json_extract(value, '$.sourceName') AS TEXT) AS sourceName,
         CAST(json_extract(value, '$.targetVisitId') AS TEXT) AS targetVisitId
       FROM json_each(?)
     )
     INSERT OR IGNORE INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
     SELECT sourceEventId, sourceName, targetVisitId, ?
     FROM input
     WHERE true
     ORDER BY ordinal`,
    [JSON.stringify(mappings), importedAt],
  );
}

async function insertSuggestions(
  transaction: ReservationImportTransactionBackend,
  suggestions: readonly PlannedSuggestion[],
): Promise<void> {
  if (suggestions.length === 0) {
    return;
  }
  await transaction.runAsync(
    `WITH input AS (
       SELECT
         CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
         CAST(json_extract(value, '$.visitId') AS TEXT) AS visitId,
         CAST(json_extract(value, '$.restaurantId') AS TEXT) AS restaurantId,
         CAST(json_extract(value, '$.distance') AS REAL) AS distance
       FROM json_each(?)
     )
     INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
     SELECT visitId, restaurantId, distance
     FROM input
     WHERE true
     ORDER BY ordinal`,
    [JSON.stringify(suggestions)],
  );
}

/**
 * Execute the candidate inside one caller-owned exclusive transaction. Decision
 * matching deliberately uses the original read snapshot after updates; only
 * successfully plannable inserts are appended, matching the row-by-row path.
 */
export async function executeSetBasedReservationImportTransaction(
  transaction: ReservationImportTransactionBackend,
  visits: readonly ReservationOnlyVisitInput[],
  updatedAt: number,
): Promise<ReservationOnlyVisitImportResult> {
  if (!Number.isFinite(updatedAt)) {
    throw new RangeError("Reservation import persistence time must be finite.");
  }
  if (visits.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: 0,
      skippedConflictCount: 0,
    };
  }

  await acquireReservationImportWriteIntent(transaction);
  const uniqueVisits = dedupeVisitsBySourceEventId(visits);
  const identities = await loadExistingIdentities(transaction, uniqueVisits);
  const unavailableSourceIds = new Set(identities.filter((row) => row.kind !== "visit").map((row) => row.value));
  const existingVisitIds = new Set(identities.filter((row) => row.kind === "visit").map((row) => row.value));
  const newVisits = uniqueVisits.filter((visit) => !unavailableSourceIds.has(visit.sourceEventId));
  if (newVisits.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: visits.length,
      skippedConflictCount: 0,
    };
  }

  const overlapVisits = await loadOverlapVisits(transaction, newVisits);
  const sameDateConfirmedVisits = await loadSameDateConfirmedVisits(transaction, newVisits);
  const plan = buildImportPlan(newVisits, existingVisitIds, overlapVisits, sameDateConfirmedVisits, updatedAt);

  await upsertRestaurants(transaction, plan.newVisits);
  const returnedRows = await insertNewVisits(transaction, plan.inserts, updatedAt);
  const plannedInsertIds = new Set(plan.inserts.map(({ visit }) => visit.id));
  const returnedInsertIds = new Set<string>();
  for (const row of returnedRows) {
    if (!plannedInsertIds.has(row.id) || returnedInsertIds.has(row.id)) {
      throw new Error("Reservation import INSERT RETURNING produced an invalid or duplicate visit row.");
    }
    returnedInsertIds.add(row.id);
  }
  // Some updates target a visit inserted by an earlier input. Insert the complete
  // planned set before applying the coalesced last-writer assignments.
  await updateExistingVisits(transaction, plan.updates);
  await insertSourceMappings(transaction, plan.sourceMappings, updatedAt);
  await insertSuggestions(transaction, plan.suggestions);

  return {
    insertedCount: returnedInsertIds.size,
    linkedExistingCount: plan.linkedExistingCountBeforeInsertConflicts + (plan.inserts.length - returnedInsertIds.size),
    confirmedExistingCount: plan.confirmedExistingCount,
    skippedDuplicateCount: visits.length - plan.newVisits.length,
    skippedConflictCount: 0,
  };
}
