import {
  getAllMichelinRestaurants,
  insertReservationOnlyVisits,
  type MichelinRestaurantRecord,
  type ReservationOnlyRestaurantInput,
  type ReservationOnlyVisitInput,
} from "@/utils/db";
import { calculateDistanceMeters } from "@/data/restaurants";
import {
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
  normalizeForComparison,
  stripComparisonAffixes,
} from "@/services/calendar";
import { getAwardForDate } from "@/services/michelin";

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";
const RESY_RESERVATIONS_URL = "https://api.resy.com/3/user/reservations";
const RESY_PAGE_LIMIT = 50;
const DEFAULT_VISIT_DURATION_MS = 2 * 60 * 60 * 1000;
const EXACT_MICHELIN_MATCH_RADIUS_METERS = 1000;
const FUZZY_MICHELIN_MATCH_RADIUS_METERS = 250;
const RESERVATION_DEDUPE_BUFFER_MS = 2 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface ResyReservationsPage {
  reservations?: unknown[];
  venues?: Record<string, unknown>;
  metadata?: {
    total?: number;
    type?: string;
  };
}

export interface ResyImportableReservation {
  id: string;
  sourceEventId: string;
  restaurantName: string;
  restaurantId: string;
  address: string | null;
  startTime: number;
  endTime: number;
  partySize: number | null;
  latitude: number;
  longitude: number;
}

export interface ResyImportProgress {
  fetchedCount: number;
  totalCount: number | null;
  page: number;
}

export interface ResyImportResult {
  fetchedCount: number;
  importableCount: number;
  importedCount: number;
  linkedExistingCount: number;
  confirmedExistingCount: number;
  matchedMichelinCount: number;
  skippedDuplicateCount: number;
  skippedConflictCount: number;
  skippedInvalidCount: number;
}

export class ResyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ResyApiError";
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function getPath(value: unknown, path: string[]): unknown {
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

function getString(...values: unknown[]): string | null {
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

function getNumber(...values: unknown[]): number | null {
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

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function compactAddress(parts: Array<string | null>): string | null {
  const compacted = parts.filter((part): part is string => Boolean(part));
  return compacted.length > 0 ? compacted.join(", ") : null;
}

function getVenueForReservation(reservation: JsonRecord, venues: Record<string, unknown>): JsonRecord | null {
  const reservationVenue = asRecord(reservation.venue);
  const venueId = getString(
    getPath(reservationVenue, ["id", "resy"]),
    reservationVenue?.id,
    reservation.venue_id,
    getPath(reservation, ["venue", "id"]),
  );

  if (venueId) {
    const fromPage = asRecord(venues[venueId]);
    if (fromPage) {
      return fromPage;
    }
  }

  return reservationVenue;
}

function parseReservationStartTime(reservation: JsonRecord): number | null {
  const day = getString(reservation.day, reservation.date, reservation.reservation_date);
  const time = getString(reservation.time_slot, reservation.time, reservation.reservation_time);

  if (time && Number.isFinite(Date.parse(time))) {
    return Date.parse(time);
  }

  if (!day) {
    return null;
  }

  const normalizedTime = time || "19:00:00";
  const timestamp = Date.parse(`${day}T${normalizedTime}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseReservationEndTime(reservation: JsonRecord, startTime: number): number {
  const endTime = getString(reservation.end_time, reservation.end, reservation.endTime);
  if (endTime && Number.isFinite(Date.parse(endTime))) {
    return Date.parse(endTime);
  }
  return startTime + DEFAULT_VISIT_DURATION_MS;
}

function normalizeReservation(reservation: unknown, venues: Record<string, unknown>): ResyImportableReservation | null {
  const record = asRecord(reservation);
  if (!record) {
    return null;
  }

  const venue = getVenueForReservation(record, venues);
  if (!venue) {
    return null;
  }

  const restaurantName = getString(venue.name, record.venue_name, getPath(record, ["venue", "name"]));
  const startTime = parseReservationStartTime(record);
  const latitude = getNumber(
    getPath(venue, ["location", "latitude"]),
    getPath(venue, ["location", "coords", "lat"]),
    venue.latitude,
  );
  const longitude = getNumber(
    getPath(venue, ["location", "longitude"]),
    getPath(venue, ["location", "coords", "long"]),
    getPath(venue, ["location", "coords", "lng"]),
    venue.longitude,
  );

  if (!restaurantName || startTime === null || latitude === null || longitude === null) {
    return null;
  }

  const reservationId = getString(record.reservation_id, record.id);
  const token = getString(record.resy_token, record.token);
  const sourceId =
    reservationId ?? (token ? `token-${hashString(token)}` : hashString(`${restaurantName}:${startTime}`));
  const sourceEventId = `resy:${sanitizeIdPart(sourceId) || hashString(sourceId)}`;
  const venueId = getString(getPath(venue, ["id", "resy"]), venue.id, getPath(record, ["venue", "id"]));
  const restaurantId = `resy-${sanitizeIdPart(venueId ?? hashString(`${restaurantName}:${latitude}:${longitude}`))}`;

  const location = asRecord(venue.location);
  const address = compactAddress([
    getString(location?.address_1, getPath(venue, ["location", "address1"])),
    getString(location?.address_2, getPath(venue, ["location", "address2"])),
    getString(location?.locality, getPath(venue, ["location", "city"])),
    getString(location?.region, getPath(venue, ["location", "state"])),
    getString(location?.postal_code, getPath(venue, ["location", "postalCode"])),
  ]);

  return {
    id: `resy-${hashString(`${sourceEventId}:${startTime}`)}`,
    sourceEventId,
    restaurantName,
    restaurantId,
    address,
    startTime,
    endTime: parseReservationEndTime(record, startTime),
    partySize: getNumber(record.num_seats, record.party_size, record.seats),
    latitude,
    longitude,
  };
}

interface MichelinMatch {
  restaurant: MichelinRestaurantRecord;
  distance: number;
}

type RestaurantsByNormalizedName = Map<string, MichelinRestaurantRecord[]>;

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
  reservation: ResyImportableReservation,
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
  reservation: ResyImportableReservation,
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
  reservation: ResyImportableReservation,
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
    };
  }

  return {
    id: reservation.restaurantId,
    name: reservation.restaurantName,
    latitude: reservation.latitude,
    longitude: reservation.longitude,
    address: reservation.address,
  };
}

async function toReservationOnlyVisit(
  reservation: ResyImportableReservation,
  match: MichelinMatch | null,
): Promise<ReservationOnlyVisitInput> {
  const partyText = reservation.partySize ? `Party of ${reservation.partySize}` : null;
  const suggestedRestaurantId = match?.restaurant.id ?? null;
  return {
    id: reservation.id,
    sourceEventId: reservation.sourceEventId,
    sourceName: "resy",
    sourceTitle: reservation.restaurantName,
    sourceLocation: reservation.address,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    restaurant: getRestaurantInputForReservation(reservation, match),
    suggestedRestaurantId,
    suggestedRestaurantDistance: match?.distance ?? null,
    awardAtVisit: await getAwardForReservationVisit(suggestedRestaurantId, reservation.startTime),
    notes: partyText ? `Imported from Resy. ${partyText}.` : "Imported from Resy.",
  };
}

function buildResyHeaders(authToken: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "Cache-Control": "no-cache",
    "X-Origin": "https://resy.com",
    "X-Resy-Auth-Token": authToken,
    "X-Resy-Universal-Auth": authToken,
  };
}

async function fetchReservationsPage(authToken: string, offset: number): Promise<ResyReservationsPage> {
  const url = new URL(RESY_RESERVATIONS_URL);
  url.searchParams.set("limit", String(RESY_PAGE_LIMIT));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("type", "past");
  url.searchParams.set("book_on_behalf_of", "false");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildResyHeaders(authToken),
  });

  const data = (await response.json().catch(() => null)) as ResyReservationsPage | null;

  if (!response.ok) {
    const message = getString(asRecord(data)?.message) ?? `Resy request failed with ${response.status}`;
    throw new ResyApiError(message, response.status);
  }

  return data ?? {};
}

async function fetchPastResyReservationHistory(
  authToken: string,
  options: { onProgress?: (progress: ResyImportProgress) => void } = {},
): Promise<{ reservations: ResyImportableReservation[]; fetchedCount: number; invalidCount: number }> {
  const reservations: ResyImportableReservation[] = [];
  let offset = 1;
  let total: number | null = null;
  let invalidCount = 0;

  while (true) {
    const page = await fetchReservationsPage(authToken, offset);
    const rawReservations = Array.isArray(page.reservations) ? page.reservations : [];
    const venues = page.venues ?? {};

    for (const rawReservation of rawReservations) {
      const normalized = normalizeReservation(rawReservation, venues);
      if (normalized) {
        reservations.push(normalized);
      } else {
        invalidCount += 1;
      }
    }

    total = typeof page.metadata?.total === "number" ? page.metadata.total : total;
    options.onProgress?.({
      fetchedCount: reservations.length + invalidCount,
      totalCount: total,
      page: offset,
    });

    const fetchedRawCount = reservations.length + invalidCount;
    if (rawReservations.length === 0 || (total !== null && fetchedRawCount >= total)) {
      break;
    }

    offset += 1;
  }

  return {
    reservations: reservations.sort((a, b) => b.startTime - a.startTime),
    fetchedCount: reservations.length + invalidCount,
    invalidCount,
  };
}

export async function fetchAllPastResyReservations(
  authToken: string,
  options: { onProgress?: (progress: ResyImportProgress) => void } = {},
): Promise<ResyImportableReservation[]> {
  const history = await fetchPastResyReservationHistory(authToken, options);
  return history.reservations;
}

export async function importResyVisitHistory(
  authToken: string,
  options: { onProgress?: (progress: ResyImportProgress) => void } = {},
): Promise<ResyImportResult> {
  const history = await fetchPastResyReservationHistory(authToken, options);
  const michelinRestaurants = await getAllMichelinRestaurants();
  const restaurantsByName = buildRestaurantsByNormalizedName(michelinRestaurants);
  const matchesBySourceEventId = new Map<string, MichelinMatch | null>();

  for (const reservation of history.reservations) {
    matchesBySourceEventId.set(
      reservation.sourceEventId,
      findMichelinMatch(reservation, michelinRestaurants, restaurantsByName),
    );
  }

  const visits = await Promise.all(
    history.reservations.map((reservation) =>
      toReservationOnlyVisit(reservation, matchesBySourceEventId.get(reservation.sourceEventId) ?? null),
    ),
  );
  const deduped = dedupeReservationOnlyVisits(visits);
  const importResult = await insertReservationOnlyVisits(deduped.visits);
  const matchedMichelinCount = deduped.visits.filter((visit) => Boolean(visit.suggestedRestaurantId)).length;

  return {
    fetchedCount: history.fetchedCount,
    importableCount: deduped.visits.length,
    importedCount: importResult.insertedCount,
    linkedExistingCount: importResult.linkedExistingCount,
    confirmedExistingCount: importResult.confirmedExistingCount,
    matchedMichelinCount,
    skippedDuplicateCount: importResult.skippedDuplicateCount + deduped.duplicateCount,
    skippedConflictCount: importResult.skippedConflictCount,
    skippedInvalidCount: history.invalidCount,
  };
}
