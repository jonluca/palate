import { calculateDistanceMeters } from "@/data/restaurants";
import {
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
  normalizeForComparison,
  stripComparisonAffixes,
} from "@/services/calendar";
import { getAwardForDate } from "@/services/michelin";
import { searchPlaceByText } from "@/services/places";
import {
  batchMergeSameRestaurantVisits,
  getAllMichelinRestaurants,
  getConfirmedLinkedReservationSourceEventIds,
  getMergeableSameRestaurantVisitGroups,
  getReservationOnlyVisitsMappedToConfirmedVisitSourceIds,
  insertReservationOnlyVisits,
  type MichelinRestaurantRecord,
  type ReservationOnlyRestaurantInput,
  type ReservationOnlyVisitInput,
} from "@/utils/db";

const DEFAULT_VISIT_DURATION_MS = 2 * 60 * 60 * 1000;
const EXACT_MICHELIN_MATCH_RADIUS_METERS = 1000;
const FUZZY_MICHELIN_MATCH_RADIUS_METERS = 250;
const RESERVATION_DEDUPE_BUFFER_MS = 2 * 60 * 60 * 1000;
const RESERVATION_IMPORT_LOG_PREFIX = "[ReservationImport]";
const RESERVATION_IMPORT_DEBUG_SAMPLE_SIZE = 5;

export type JsonRecord = Record<string, unknown>;

export interface ImportableReservation {
  id: string;
  sourceEventId: string;
  sourceName: string;
  restaurantName: string;
  restaurantId: string;
  address: string | null;
  startTime: number;
  endTime: number;
  partySize: number | null;
  latitude: number | null;
  longitude: number | null;
  website?: string | null;
  matchedMichelinRestaurant?: {
    id: string;
    name: string;
    award: string;
    distanceMeters: number;
  } | null;
}

export interface ReservationImportProgress {
  fetchedCount: number;
  totalCount: number | null;
  page: number;
}

export interface ReservationImportResult {
  fetchedCount: number;
  importableCount: number;
  importedCount: number;
  linkedExistingCount: number;
  confirmedExistingCount: number;
  matchedMichelinCount: number;
  mergedDuplicateCount: number;
  skippedDuplicateCount: number;
  skippedConflictCount: number;
  skippedInvalidCount: number;
}

export interface NormalizedReservationHistory {
  reservations: ImportableReservation[];
  fetchedCount: number;
  invalidCount: number;
}

export interface ReservationReviewFilterResult {
  reservations: ImportableReservation[];
  skippedExistingConfirmedCount: number;
  skippedDuplicateCount: number;
}

interface LocatedImportableReservation extends ImportableReservation {
  latitude: number;
  longitude: number;
}

interface MichelinMatch {
  restaurant: MichelinRestaurantRecord;
  distance: number;
}

type RestaurantsByNormalizedName = Map<string, MichelinRestaurantRecord[]>;

export class ReservationApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ReservationApiError";
  }
}

function logReservationImport(sourceDisplayName: string, message: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }

  if (details === undefined) {
    console.info(`${RESERVATION_IMPORT_LOG_PREFIX} ${sourceDisplayName}: ${message}`);
  } else {
    console.info(`${RESERVATION_IMPORT_LOG_PREFIX} ${sourceDisplayName}: ${message}`, details);
  }
}

function summarizeImportableReservationForLog(reservation: ImportableReservation): Record<string, unknown> {
  return {
    sourceName: reservation.sourceName,
    restaurantName: reservation.restaurantName,
    startTime: new Date(reservation.startTime).toISOString(),
    endTime: new Date(reservation.endTime).toISOString(),
    hasCoordinates: reservation.latitude !== null && reservation.longitude !== null,
    hasAddress: Boolean(reservation.address),
    partySize: reservation.partySize,
  };
}

function summarizeLocatedReservationForLog(reservation: LocatedImportableReservation): Record<string, unknown> {
  return {
    ...summarizeImportableReservationForLog(reservation),
    latitude: Number(reservation.latitude.toFixed(5)),
    longitude: Number(reservation.longitude.toFixed(5)),
  };
}

async function mergeDuplicateVisitsAfterProviderImport(sourceDisplayName: string): Promise<number> {
  const mergeableGroups = await getMergeableSameRestaurantVisitGroups();
  if (mergeableGroups.length === 0) {
    logReservationImport(sourceDisplayName, "No duplicate visits found after provider import");
    return 0;
  }

  const mergeCount = await batchMergeSameRestaurantVisits(mergeableGroups);
  logReservationImport(sourceDisplayName, "Merged duplicate visits after provider import", {
    mergeableGroupCount: mergeableGroups.length,
    mergeCount,
  });
  return mergeCount;
}

function dedupeImportableReservationsBySourceEventId(reservations: ImportableReservation[]): {
  reservations: ImportableReservation[];
  duplicateCount: number;
} {
  const reservationsBySourceEventId = new Map<string, ImportableReservation>();
  let duplicateCount = 0;

  for (const reservation of reservations) {
    if (reservationsBySourceEventId.has(reservation.sourceEventId)) {
      duplicateCount += 1;
      continue;
    }
    reservationsBySourceEventId.set(reservation.sourceEventId, reservation);
  }

  return {
    reservations: Array.from(reservationsBySourceEventId.values()).sort((a, b) => b.startTime - a.startTime),
    duplicateCount,
  };
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

export function getString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

export function getNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

export function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function sanitizeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function compactAddress(parts: Array<string | null>): string | null {
  const compacted = parts.filter((part): part is string => Boolean(part));
  return compacted.length > 0 ? compacted.join(", ") : null;
}

export function parseTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    const text = getString(value);
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function defaultReservationEndTime(startTime: number): number {
  return startTime + DEFAULT_VISIT_DURATION_MS;
}

function buildRestaurantsByNormalizedName(restaurants: MichelinRestaurantRecord[]): RestaurantsByNormalizedName {
  const map: RestaurantsByNormalizedName = new Map();
  for (const restaurant of restaurants) {
    const key = normalizeForComparison(stripComparisonAffixes(restaurant.name));
    if (!key) {
      continue;
    }
    const existing = map.get(key);
    if (existing) {
      existing.push(restaurant);
    } else {
      map.set(key, [restaurant]);
    }
  }
  return map;
}

function getDistanceToMichelinReservation(
  reservation: LocatedImportableReservation,
  restaurant: MichelinRestaurantRecord,
): number {
  return calculateDistanceMeters(
    reservation.latitude,
    reservation.longitude,
    restaurant.latitude,
    restaurant.longitude,
  );
}

function findMichelinMatch(
  reservation: LocatedImportableReservation,
  restaurants: MichelinRestaurantRecord[],
  restaurantsByName: RestaurantsByNormalizedName,
): MichelinMatch | null {
  const normalizedName = normalizeForComparison(stripComparisonAffixes(reservation.restaurantName));
  const exactMatches = restaurantsByName.get(normalizedName) ?? [];
  const exactCandidates = exactMatches
    .map((restaurant) => ({
      restaurant,
      distance: getDistanceToMichelinReservation(reservation, restaurant),
    }))
    .filter((match) => match.distance <= EXACT_MICHELIN_MATCH_RADIUS_METERS)
    .sort((a, b) => a.distance - b.distance);

  if (exactCandidates.length > 0) {
    return exactCandidates[0];
  }

  let bestFuzzyMatch: MichelinMatch | null = null;
  for (const restaurant of restaurants) {
    const distance = getDistanceToMichelinReservation(reservation, restaurant);
    if (distance > FUZZY_MICHELIN_MATCH_RADIUS_METERS) {
      continue;
    }

    const namesMatch =
      compareRestaurantAndCalendarTitle(reservation.restaurantName, restaurant.name) ||
      isFuzzyRestaurantMatch(reservation.restaurantName, restaurant.name);
    if (!namesMatch) {
      continue;
    }

    if (!bestFuzzyMatch || distance < bestFuzzyMatch.distance) {
      bestFuzzyMatch = { restaurant, distance };
    }
  }

  return bestFuzzyMatch;
}

function withMichelinReviewMatch(
  reservation: ImportableReservation,
  match: MichelinMatch | null,
): ImportableReservation {
  if (!match) {
    return { ...reservation, matchedMichelinRestaurant: null };
  }

  return {
    ...reservation,
    matchedMichelinRestaurant: {
      id: match.restaurant.id,
      name: match.restaurant.name,
      award: match.restaurant.award,
      distanceMeters: Math.round(match.distance),
    },
  };
}

function getReservationDedupeKey(visit: ReservationOnlyVisitInput): string {
  return visit.suggestedRestaurantId ?? normalizeForComparison(stripComparisonAffixes(visit.restaurant.name));
}

function areReservationVisitsDuplicate(
  a: ReservationOnlyVisitInput,
  b: ReservationOnlyVisitInput,
  timeBufferMs: number = RESERVATION_DEDUPE_BUFFER_MS,
): boolean {
  const keyA = getReservationDedupeKey(a);
  const keyB = getReservationDedupeKey(b);
  if (!keyA || keyA !== keyB) {
    return false;
  }

  return a.startTime <= b.endTime + timeBufferMs && a.endTime >= b.startTime - timeBufferMs;
}

function dedupeReservationOnlyVisits(visits: ReservationOnlyVisitInput[]): {
  visits: ReservationOnlyVisitInput[];
  duplicateCount: number;
} {
  const sorted = [...visits].sort((a, b) => a.startTime - b.startTime);
  const deduped: ReservationOnlyVisitInput[] = [];
  let duplicateCount = 0;

  for (const visit of sorted) {
    const duplicateIndex = deduped.findIndex((existing) => areReservationVisitsDuplicate(existing, visit));
    if (duplicateIndex === -1) {
      deduped.push(visit);
      continue;
    }

    duplicateCount += 1;
    const existing = deduped[duplicateIndex];
    const shouldReplace =
      (visit.suggestedRestaurantId ? 1 : 0) > (existing.suggestedRestaurantId ? 1 : 0) ||
      (visit.sourceLocation ? 1 : 0) > (existing.sourceLocation ? 1 : 0);
    if (shouldReplace) {
      deduped[duplicateIndex] = visit;
    }
  }

  return { visits: deduped.sort((a, b) => b.startTime - a.startTime), duplicateCount };
}

async function getAwardForReservationVisit(restaurantId: string | null, startTime: number): Promise<string | null> {
  if (!restaurantId?.startsWith("michelin-")) {
    return null;
  }

  return getAwardForDate(restaurantId, startTime);
}

function getRestaurantInputForReservation(
  reservation: LocatedImportableReservation,
  match: MichelinMatch | null,
): ReservationOnlyRestaurantInput {
  if (match) {
    return {
      id: match.restaurant.id,
      name: match.restaurant.name,
      latitude: match.restaurant.latitude,
      longitude: match.restaurant.longitude,
      address: match.restaurant.address || reservation.address,
      cuisine: match.restaurant.cuisine || null,
      website: reservation.website ?? null,
    };
  }

  return {
    id: reservation.restaurantId,
    name: reservation.restaurantName,
    latitude: reservation.latitude,
    longitude: reservation.longitude,
    address: reservation.address,
    website: reservation.website ?? null,
  };
}

async function toReservationOnlyVisit(
  reservation: LocatedImportableReservation,
  match: MichelinMatch | null,
  sourceDisplayName: string,
): Promise<ReservationOnlyVisitInput> {
  const partyText = reservation.partySize ? `Party of ${reservation.partySize}` : null;
  const suggestedRestaurantId = match?.restaurant.id ?? null;
  return {
    id: reservation.id,
    sourceEventId: reservation.sourceEventId,
    sourceName: reservation.sourceName,
    sourceTitle: reservation.restaurantName,
    sourceLocation: reservation.address,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    restaurant: getRestaurantInputForReservation(reservation, match),
    suggestedRestaurantId,
    suggestedRestaurantDistance: match?.distance ?? null,
    awardAtVisit: await getAwardForReservationVisit(suggestedRestaurantId, reservation.startTime),
    notes: partyText ? `Imported from ${sourceDisplayName}. ${partyText}.` : `Imported from ${sourceDisplayName}.`,
  };
}

async function resolveReservationLocation(
  reservation: ImportableReservation,
  restaurantsByName: RestaurantsByNormalizedName,
): Promise<LocatedImportableReservation | null> {
  if (reservation.latitude !== null && reservation.longitude !== null) {
    return reservation as LocatedImportableReservation;
  }

  const placeQuery = [reservation.restaurantName, reservation.address].filter(Boolean).join(" ");
  if (placeQuery) {
    const places = await searchPlaceByText(placeQuery);
    const place = places[0];
    if (place) {
      return {
        ...reservation,
        latitude: place.latitude,
        longitude: place.longitude,
        address: reservation.address ?? place.address ?? null,
      };
    }
  }

  const normalizedName = normalizeForComparison(stripComparisonAffixes(reservation.restaurantName));
  const exactMichelinMatches = restaurantsByName.get(normalizedName) ?? [];
  if (exactMichelinMatches.length === 1) {
    const restaurant = exactMichelinMatches[0];
    return {
      ...reservation,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      address: reservation.address ?? restaurant.address ?? null,
    };
  }

  return null;
}

export async function importReservationVisitHistory(
  reservations: ImportableReservation[],
  options: {
    sourceDisplayName: string;
    fetchedCount?: number;
    invalidCount?: number;
  },
): Promise<ReservationImportResult> {
  logReservationImport(options.sourceDisplayName, "Starting import", {
    receivedReservations: reservations.length,
    fetchedCount: options.fetchedCount ?? null,
    upstreamInvalidCount: options.invalidCount ?? 0,
    reservationsWithCoordinates: reservations.filter(
      (reservation) => reservation.latitude !== null && reservation.longitude !== null,
    ).length,
    reservationsWithAddress: reservations.filter((reservation) => Boolean(reservation.address)).length,
    sample: reservations.slice(0, RESERVATION_IMPORT_DEBUG_SAMPLE_SIZE).map(summarizeImportableReservationForLog),
  });

  const michelinRestaurants = await getAllMichelinRestaurants();
  const restaurantsByName = buildRestaurantsByNormalizedName(michelinRestaurants);
  const locatedReservations: LocatedImportableReservation[] = [];
  let missingLocationCount = 0;
  const missingLocationSamples: Array<Record<string, unknown>> = [];

  for (const reservation of reservations) {
    const located = await resolveReservationLocation(reservation, restaurantsByName);
    if (located) {
      locatedReservations.push(located);
    } else {
      missingLocationCount += 1;
      if (missingLocationSamples.length < RESERVATION_IMPORT_DEBUG_SAMPLE_SIZE) {
        missingLocationSamples.push(summarizeImportableReservationForLog(reservation));
      }
    }
  }

  logReservationImport(options.sourceDisplayName, "Location resolution complete", {
    receivedReservations: reservations.length,
    locatedReservations: locatedReservations.length,
    missingLocationCount,
    missingLocationSamples,
    locatedSample: locatedReservations
      .slice(0, RESERVATION_IMPORT_DEBUG_SAMPLE_SIZE)
      .map(summarizeLocatedReservationForLog),
  });

  const matchesBySourceEventId = new Map<string, MichelinMatch | null>();
  for (const reservation of locatedReservations) {
    matchesBySourceEventId.set(
      reservation.sourceEventId,
      findMichelinMatch(reservation, michelinRestaurants, restaurantsByName),
    );
  }
  const preDedupeMichelinMatchCount = Array.from(matchesBySourceEventId.values()).filter(Boolean).length;
  logReservationImport(options.sourceDisplayName, "Michelin matching complete", {
    locatedReservations: locatedReservations.length,
    matchedMichelinCount: preDedupeMichelinMatchCount,
  });

  const visits = await Promise.all(
    locatedReservations.map((reservation) =>
      toReservationOnlyVisit(
        reservation,
        matchesBySourceEventId.get(reservation.sourceEventId) ?? null,
        options.sourceDisplayName,
      ),
    ),
  );
  const deduped = dedupeReservationOnlyVisits(visits);
  logReservationImport(options.sourceDisplayName, "Prepared visits for database insert", {
    visitsBeforeDedupe: visits.length,
    visitsAfterDedupe: deduped.visits.length,
    inPayloadDuplicateCount: deduped.duplicateCount,
  });
  const importResult = await insertReservationOnlyVisits(deduped.visits);
  const matchedMichelinCount = deduped.visits.filter((visit) => Boolean(visit.suggestedRestaurantId)).length;
  const invalidCount = (options.invalidCount ?? 0) + missingLocationCount;
  let mergedDuplicateCount = 0;
  try {
    mergedDuplicateCount = await mergeDuplicateVisitsAfterProviderImport(options.sourceDisplayName);
  } catch (error) {
    console.error(
      `[ReservationImport] ${options.sourceDisplayName}: Error auto-merging duplicate visits after provider import:`,
      error,
    );
  }

  const result = {
    fetchedCount: options.fetchedCount ?? reservations.length + invalidCount,
    importableCount: deduped.visits.length,
    importedCount: importResult.insertedCount,
    linkedExistingCount: importResult.linkedExistingCount,
    confirmedExistingCount: importResult.confirmedExistingCount,
    matchedMichelinCount,
    mergedDuplicateCount,
    skippedDuplicateCount: importResult.skippedDuplicateCount + deduped.duplicateCount,
    skippedConflictCount: importResult.skippedConflictCount,
    skippedInvalidCount: invalidCount,
  };

  logReservationImport(options.sourceDisplayName, "Finished import", {
    result,
    databaseResult: importResult,
    missingLocationCount,
    inPayloadDuplicateCount: deduped.duplicateCount,
  });

  return result;
}

export async function filterProviderReservationReviewCandidates(
  reservations: ImportableReservation[],
  options: { sourceDisplayName: string },
): Promise<ReservationReviewFilterResult> {
  const deduped = dedupeImportableReservationsBySourceEventId(reservations);
  if (deduped.reservations.length === 0) {
    return {
      reservations: [],
      skippedExistingConfirmedCount: 0,
      skippedDuplicateCount: deduped.duplicateCount,
    };
  }

  const exactSourceEventIdsMappedToConfirmedVisits = await getConfirmedLinkedReservationSourceEventIds(
    deduped.reservations.map((reservation) => reservation.sourceEventId),
  );
  const reservationsNeedingLocationCheck = deduped.reservations.filter(
    (reservation) => !exactSourceEventIdsMappedToConfirmedVisits.has(reservation.sourceEventId),
  );
  const michelinRestaurants = await getAllMichelinRestaurants();
  const restaurantsByName = buildRestaurantsByNormalizedName(michelinRestaurants);
  const locatedReservations: LocatedImportableReservation[] = [];

  for (const reservation of reservationsNeedingLocationCheck) {
    const located = await resolveReservationLocation(reservation, restaurantsByName);
    if (located) {
      locatedReservations.push(located);
    }
  }

  const matchesBySourceEventId = new Map<string, MichelinMatch | null>();
  for (const reservation of locatedReservations) {
    matchesBySourceEventId.set(
      reservation.sourceEventId,
      findMichelinMatch(reservation, michelinRestaurants, restaurantsByName),
    );
  }

  const visits = await Promise.all(
    locatedReservations.map((reservation) =>
      toReservationOnlyVisit(
        reservation,
        matchesBySourceEventId.get(reservation.sourceEventId) ?? null,
        options.sourceDisplayName,
      ),
    ),
  );
  const overlapSourceEventIdsMappedToConfirmedVisits =
    await getReservationOnlyVisitsMappedToConfirmedVisitSourceIds(visits);
  const sourceEventIdsMappedToConfirmedVisits = new Set([
    ...exactSourceEventIdsMappedToConfirmedVisits,
    ...overlapSourceEventIdsMappedToConfirmedVisits,
  ]);
  const reviewReservations = deduped.reservations
    .filter((reservation) => !sourceEventIdsMappedToConfirmedVisits.has(reservation.sourceEventId))
    .map((reservation) =>
      withMichelinReviewMatch(reservation, matchesBySourceEventId.get(reservation.sourceEventId) ?? null),
    );

  logReservationImport(options.sourceDisplayName, "Prepared provider review candidates", {
    receivedReservations: reservations.length,
    reviewReservations: reviewReservations.length,
    matchedMichelinReviewCount: reviewReservations.filter((reservation) => reservation.matchedMichelinRestaurant)
      .length,
    skippedDuplicateCount: deduped.duplicateCount,
    skippedExistingConfirmedCount: sourceEventIdsMappedToConfirmedVisits.size,
    exactConfirmedLinkCount: exactSourceEventIdsMappedToConfirmedVisits.size,
    overlapConfirmedVisitCount: overlapSourceEventIdsMappedToConfirmedVisits.size,
    unresolvedLocationCount: reservationsNeedingLocationCheck.length - locatedReservations.length,
  });

  return {
    reservations: reviewReservations,
    skippedExistingConfirmedCount: sourceEventIdsMappedToConfirmedVisits.size,
    skippedDuplicateCount: deduped.duplicateCount,
  };
}
