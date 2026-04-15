import {
  asRecord,
  compactAddress,
  defaultReservationEndTime,
  getNumber,
  getPath,
  getString,
  hashString,
  importReservationVisitHistory,
  parseTimestamp,
  sanitizeIdPart,
  ReservationApiError,
  type ImportableReservation,
  type JsonRecord,
  type ReservationImportProgress,
  type ReservationImportResult,
} from "@/services/reservation-import";

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";
const RESY_RESERVATIONS_URL = "https://api.resy.com/3/user/reservations";
const RESY_PAGE_LIMIT = 50;

interface ResyReservationsPage {
  reservations?: unknown[];
  venues?: Record<string, unknown>;
  metadata?: {
    total?: number;
    type?: string;
  };
}

export type ResyImportableReservation = ImportableReservation;
export type ResyImportProgress = ReservationImportProgress;
export type ResyImportResult = ReservationImportResult;

export class ResyApiError extends ReservationApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "ResyApiError";
  }
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
  const parsedTimestamp = parseTimestamp(reservation.time_slot, reservation.time, reservation.reservation_time);
  if (parsedTimestamp !== null) {
    return parsedTimestamp;
  }

  const day = getString(reservation.day, reservation.date, reservation.reservation_date);
  if (!day) {
    return null;
  }

  const time = getString(reservation.time_slot, reservation.time, reservation.reservation_time) ?? "19:00:00";
  const timestamp = Date.parse(`${day}T${time}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseReservationEndTime(reservation: JsonRecord, startTime: number): number {
  return (
    parseTimestamp(reservation.end_time, reservation.end, reservation.endTime) ?? defaultReservationEndTime(startTime)
  );
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
    sourceName: "resy",
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
  return importReservationVisitHistory(history.reservations, {
    sourceDisplayName: "Resy",
    fetchedCount: history.fetchedCount,
    invalidCount: history.invalidCount,
  });
}
