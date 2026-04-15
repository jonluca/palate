import {
  asRecord,
  compactAddress,
  defaultReservationEndTime,
  getNumber,
  getPath,
  getString,
  hashString,
  importReservationVisitHistory,
  sanitizeIdPart,
  type ImportableReservation,
  type JsonRecord,
  type ReservationImportResult,
} from "@/services/reservation-import";

const OPENTABLE_SOURCE = "opentable";
const OPENTABLE_IMPORT_LOG_PREFIX = "[OpenTableImport]";
const OPENTABLE_DEBUG_SAMPLE_SIZE = 5;
const MONTH_PATTERN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const OPENTABLE_MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export type OpenTableImportableReservation = ImportableReservation;
export type OpenTableImportResult = ReservationImportResult;

interface NormalizedOpenTableHistory {
  reservations: OpenTableImportableReservation[];
  fetchedCount: number;
  invalidCount: number;
}

function logOpenTableImport(message: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }

  if (details === undefined) {
    console.info(`${OPENTABLE_IMPORT_LOG_PREFIX} ${message}`);
  } else {
    console.info(`${OPENTABLE_IMPORT_LOG_PREFIX} ${message}`, details);
  }
}

function isCanceledReservation(record: JsonRecord): boolean {
  const status = getString(
    record.status,
    record.state,
    record.reservationStatus,
    record.bookingStatus,
    getPath(record, ["reservation", "status"]),
    getPath(record, ["booking", "status"]),
    getPath(record, ["restaurantReservation", "status"]),
  )?.toLowerCase();
  return (
    record.canceled === true ||
    record.cancelled === true ||
    record.isCanceled === true ||
    record.isCancelled === true ||
    Boolean(status && /canceled|cancelled/.test(status))
  );
}

function extractDateTimeFromText(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  const isoMatch = normalized.match(
    /\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/,
  );
  if (isoMatch) {
    return isoMatch[0];
  }

  const dateThenTime = new RegExp(
    `\\b${MONTH_PATTERN}\\s+\\d{1,2}(?:,?\\s+\\d{4})?.{0,40}?(?:\\d{1,2}:\\d{2}|\\d{1,2})(?:\\s*[AP]\\.?M\\.?)\\b`,
    "i",
  );
  const timeThenDate = new RegExp(
    `\\b(?:\\d{1,2}:\\d{2}|\\d{1,2})(?:\\s*[AP]\\.?M\\.?).{0,40}?${MONTH_PATTERN}\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`,
    "i",
  );
  return normalized.match(dateThenTime)?.[0] ?? normalized.match(timeThenDate)?.[0] ?? null;
}

function getOpenTableMonthIndex(monthText: string): number | null {
  const monthIndex = OPENTABLE_MONTHS[monthText.toLowerCase().replace(/\./g, "")];
  return monthIndex ?? null;
}

function toOpenTableHour(hourText: string, meridiemText: string | undefined): number | null {
  const rawHour = Number(hourText);
  if (!Number.isInteger(rawHour)) {
    return null;
  }

  if (!meridiemText) {
    return rawHour >= 0 && rawHour <= 23 ? rawHour : null;
  }

  if (rawHour < 1 || rawHour > 12) {
    return null;
  }

  const isPm = /^p/i.test(meridiemText);
  if (rawHour === 12) {
    return isPm ? 12 : 0;
  }
  return isPm ? rawHour + 12 : rawHour;
}

function buildOpenTableLocalTimestamp(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const date = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }

  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseOpenTableMonthNameTimestamp(text: string): number | null {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/\bat\b/gi, " ")
    .replace(/,/g, " ")
    .trim();
  const dateThenTime = normalized.match(
    new RegExp(
      `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:\\s+(\\d{4}))?(?:\\s+(\\d{1,2})(?::(\\d{2}))?\\s*([AP])\\.?M\\.?)?\\b`,
      "i",
    ),
  );
  const timeThenDate = normalized.match(
    new RegExp(
      `\\b(\\d{1,2})(?::(\\d{2}))?\\s*([AP])\\.?M\\.?\\s+(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:\\s+(\\d{4}))?\\b`,
      "i",
    ),
  );

  const monthText = dateThenTime?.[1] ?? timeThenDate?.[4];
  const dayText = dateThenTime?.[2] ?? timeThenDate?.[5];
  const yearText = dateThenTime?.[3] ?? timeThenDate?.[6];
  const hourText = dateThenTime?.[4] ?? timeThenDate?.[1] ?? "0";
  const minuteText = dateThenTime?.[5] ?? timeThenDate?.[2] ?? "0";
  const meridiemText = dateThenTime?.[6] ?? timeThenDate?.[3];

  if (!monthText || !dayText) {
    return null;
  }

  const monthIndex = getOpenTableMonthIndex(monthText);
  const day = Number(dayText);
  const year = yearText ? Number(yearText) : new Date().getFullYear();
  const minute = Number(minuteText);
  const hour = toOpenTableHour(hourText, meridiemText);

  if (
    monthIndex === null ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year) ||
    year < 1900 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    hour === null
  ) {
    return null;
  }

  return buildOpenTableLocalTimestamp(year, monthIndex, day, hour, minute);
}

function parseOpenTableTimestampValue(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{10,13}$/.test(value.trim())
        ? Number(value.trim())
        : null;
  if (numeric !== null && Number.isFinite(numeric)) {
    if (numeric > 100000000000) {
      return numeric;
    }
    if (numeric > 1000000000) {
      return numeric * 1000;
    }
  }

  const text = getString(value);
  if (!text) {
    return null;
  }
  const openTableParsed = parseOpenTableMonthNameTimestamp(text);
  if (openTableParsed !== null) {
    return openTableParsed;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOpenTableTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseOpenTableTimestampValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseOpenTableStartTime(record: JsonRecord): number | null {
  const directTimestamp = parseOpenTableTimestamp(
    record.startTime,
    record.start_time,
    record.startDateTime,
    record.startsAt,
    record.starts_at,
    record.dateTime,
    record.datetime,
    record.dateTimeUtc,
    record.reservationDateTime,
    record.bookingDateTime,
    record.visitDateTime,
    record.diningDateTime,
    record.scheduledAt,
    record.dateText,
    record.detailDateTimeText,
    getPath(record, ["reservation", "startTime"]),
    getPath(record, ["reservation", "startDateTime"]),
    getPath(record, ["reservation", "dateTime"]),
    getPath(record, ["reservation", "dateTimeUtc"]),
    getPath(record, ["reservation", "scheduledAt"]),
    getPath(record, ["booking", "startTime"]),
    getPath(record, ["booking", "startDateTime"]),
    getPath(record, ["booking", "dateTime"]),
    getPath(record, ["booking", "dateTimeUtc"]),
    getPath(record, ["dining", "startTime"]),
    getPath(record, ["dining", "startDateTime"]),
    getPath(record, ["dining", "dateTime"]),
    getPath(record, ["restaurantReservation", "startTime"]),
    getPath(record, ["restaurantReservation", "startDateTime"]),
    getPath(record, ["restaurantReservation", "dateTime"]),
    extractDateTimeFromText(getString(record.text, record.description, record.label, record.ariaLabel)),
  );
  if (directTimestamp !== null) {
    return directTimestamp;
  }

  const date = getString(
    record.date,
    record.reservationDate,
    record.bookingDate,
    record.visitDate,
    record.diningDate,
    getPath(record, ["reservation", "date"]),
    getPath(record, ["booking", "date"]),
    getPath(record, ["dining", "date"]),
    getPath(record, ["restaurantReservation", "date"]),
  );
  const time = getString(
    record.time,
    record.reservationTime,
    record.bookingTime,
    record.visitTime,
    record.diningTime,
    getPath(record, ["reservation", "time"]),
    getPath(record, ["booking", "time"]),
    getPath(record, ["dining", "time"]),
    getPath(record, ["restaurantReservation", "time"]),
  );

  if (!date) {
    return null;
  }

  return parseOpenTableTimestamp(time ? `${date} ${time}` : date);
}

function getRestaurantRecord(record: JsonRecord): JsonRecord | null {
  return (
    asRecord(record.restaurant) ??
    asRecord(record.restaurantDetails) ??
    asRecord(record.venue) ??
    asRecord(record.venueDetails) ??
    asRecord(record.merchant) ??
    asRecord(record.business) ??
    asRecord(record.ridInfo) ??
    asRecord(record.listing) ??
    asRecord(getPath(record, ["reservation", "restaurant"])) ??
    asRecord(getPath(record, ["reservation", "venue"])) ??
    asRecord(getPath(record, ["booking", "restaurant"])) ??
    asRecord(getPath(record, ["booking", "venue"])) ??
    asRecord(getPath(record, ["dining", "restaurant"])) ??
    asRecord(getPath(record, ["restaurantReservation", "restaurant"]))
  );
}

function getRestaurantName(record: JsonRecord, restaurant: JsonRecord | null): string | null {
  return getString(
    record.restaurantName,
    record.restaurant_name,
    record.venueName,
    record.venue_name,
    record.merchantName,
    record.businessName,
    record.ridName,
    getPath(record, ["reservation", "restaurantName"]),
    getPath(record, ["booking", "restaurantName"]),
    getPath(record, ["dining", "restaurantName"]),
    getPath(record, ["restaurantReservation", "restaurantName"]),
    restaurant?.name,
    restaurant?.displayName,
    restaurant?.title,
    record.name,
    record.title,
  );
}

function getRestaurantAddress(record: JsonRecord, restaurant: JsonRecord | null): string | null {
  const address = getString(
    record.address,
    record.restaurantAddress,
    getPath(record, ["reservation", "restaurantAddress"]),
    restaurant?.address,
    restaurant?.formattedAddress,
    restaurant?.displayAddress,
    restaurant?.fullAddress,
    restaurant?.streetAddress,
  );
  if (address) {
    return address;
  }

  const addressRecord =
    asRecord(record.address) ??
    asRecord(record.restaurantAddress) ??
    asRecord(restaurant?.address) ??
    asRecord(getPath(record, ["reservation", "restaurantAddress"])) ??
    asRecord(getPath(restaurant, ["location", "address"]));

  return compactAddress([
    getString(
      restaurant?.streetAddress,
      restaurant?.street,
      restaurant?.street1,
      restaurant?.address1,
      restaurant?.addressLine1,
      addressRecord?.street,
      addressRecord?.street1,
      addressRecord?.address1,
      addressRecord?.addressLine1,
      addressRecord?.line1,
    ),
    getString(
      restaurant?.street2,
      restaurant?.address2,
      restaurant?.addressLine2,
      addressRecord?.street2,
      addressRecord?.address2,
      addressRecord?.addressLine2,
      addressRecord?.line2,
    ),
    getString(restaurant?.city, restaurant?.locality, addressRecord?.city, addressRecord?.locality),
    getString(
      restaurant?.state,
      restaurant?.province,
      restaurant?.region,
      addressRecord?.state,
      addressRecord?.province,
      addressRecord?.region,
    ),
    getString(
      restaurant?.postalCode,
      restaurant?.zip,
      restaurant?.zipCode,
      addressRecord?.postalCode,
      addressRecord?.zip,
      addressRecord?.zipCode,
    ),
    getString(restaurant?.country, addressRecord?.country),
  ]);
}

function getOpenTableTopLevelReservations(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }

  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const directKeys = ["reservations", "result", "items"];
  for (const key of directKeys) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }

  const data = asRecord(record.data);
  if (data) {
    for (const key of directKeys) {
      if (Array.isArray(data[key])) {
        return data[key];
      }
    }
  }

  return null;
}

function describeOpenTablePayloadForLog(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    return { type: "array", length: payload.length };
  }

  if (!payload || typeof payload !== "object") {
    return { type: payload === null ? "null" : typeof payload };
  }

  const record = payload as Record<string, unknown>;
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 12),
    reservationsLength: Array.isArray(record.reservations) ? record.reservations.length : null,
    resultLength: Array.isArray(record.result) ? record.result.length : null,
    fetchedCount: typeof record.fetchedCount === "number" ? record.fetchedCount : null,
    endpoint: typeof record.endpoint === "string" ? record.endpoint : null,
    detailEndpoint: typeof record.detailEndpoint === "string" ? record.detailEndpoint : null,
  };
}

function getOpenTableRawDateTimeText(record: JsonRecord): string | null {
  return getString(
    record.dateTime,
    record.datetime,
    record.dateTimeUtc,
    record.reservationDateTime,
    record.bookingDateTime,
    record.visitDateTime,
    record.diningDateTime,
    record.dateText,
    record.detailDateTimeText,
    record.date,
    record.reservationDate,
    record.bookingDate,
    record.visitDate,
    record.diningDate,
    extractDateTimeFromText(getString(record.text, record.description, record.label, record.ariaLabel)),
  );
}

function getOpenTableCandidateRejectionReason(rawReservation: unknown): string | null {
  const record = asRecord(rawReservation);
  if (!record) {
    return "not-object";
  }

  if (isCanceledReservation(record)) {
    return "canceled";
  }

  const restaurant = getRestaurantRecord(record);
  if (!getRestaurantName(record, restaurant)) {
    return "missing-restaurant-name";
  }

  const startTime = parseOpenTableStartTime(record);
  if (startTime === null) {
    return "missing-start-time";
  }

  if (startTime > Date.now()) {
    return "future-start-time";
  }

  return null;
}

function summarizeOpenTableRawReservationForLog(rawReservation: unknown): Record<string, unknown> {
  const record = asRecord(rawReservation);
  if (!record) {
    return { type: typeof rawReservation };
  }

  const restaurant = getRestaurantRecord(record);
  const restaurantName = getRestaurantName(record, restaurant);
  const startTime = parseOpenTableStartTime(record);

  return {
    keys: Object.keys(record).slice(0, 14),
    restaurantName: restaurantName ?? null,
    status: getString(record.status, record.state, record.reservationStatus, record.bookingStatus) ?? null,
    partySize:
      getNumber(
        record.partySize,
        record.party_size,
        record.covers,
        record.numGuests,
        record.guestCount,
        record.numberOfGuests,
      ) ?? null,
    rawDateTimeText: getOpenTableRawDateTimeText(record),
    parsedStartTime: startTime !== null ? new Date(startTime).toISOString() : null,
    isFutureStartTime: startTime !== null ? startTime > Date.now() : null,
    rejectionReason: getOpenTableCandidateRejectionReason(record),
    hasCoordinates:
      getNumber(record.latitude, record.lat, restaurant?.latitude, restaurant?.lat) !== null &&
      getNumber(record.longitude, record.lng, record.lon, restaurant?.longitude, restaurant?.lng, restaurant?.lon) !==
        null,
    hasAddress: Boolean(getRestaurantAddress(record, restaurant)),
  };
}

function summarizeOpenTableTopLevelReservationsForLog(payload: unknown): Record<string, unknown> {
  const topLevelReservations = getOpenTableTopLevelReservations(payload);
  if (!topLevelReservations) {
    return {
      topLevelReservationCount: null,
      reasonCounts: null,
      sample: [],
    };
  }

  const reasonCounts: Record<string, number> = {};
  for (const rawReservation of topLevelReservations) {
    const reason = getOpenTableCandidateRejectionReason(rawReservation) ?? "candidate";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }

  return {
    topLevelReservationCount: topLevelReservations.length,
    reasonCounts,
    sample: topLevelReservations.slice(0, OPENTABLE_DEBUG_SAMPLE_SIZE).map(summarizeOpenTableRawReservationForLog),
  };
}

function summarizeOpenTableReservationForLog(reservation: OpenTableImportableReservation): Record<string, unknown> {
  return {
    restaurantName: reservation.restaurantName,
    sourceName: reservation.sourceName,
    startTime: new Date(reservation.startTime).toISOString(),
    endTime: new Date(reservation.endTime).toISOString(),
    hasCoordinates: reservation.latitude !== null && reservation.longitude !== null,
    hasAddress: Boolean(reservation.address),
    partySize: reservation.partySize,
  };
}

function normalizeOpenTableCandidate(rawReservation: unknown): OpenTableImportableReservation | null {
  const record = asRecord(rawReservation);
  if (!record || isCanceledReservation(record)) {
    return null;
  }

  const restaurant = getRestaurantRecord(record);
  const restaurantName = getRestaurantName(record, restaurant);
  const startTime = parseOpenTableStartTime(record);
  if (!restaurantName || startTime === null || startTime > Date.now()) {
    return null;
  }

  const reservationId = getString(
    record.reservationId,
    record.reservation_id,
    record.bookingId,
    record.booking_id,
    record.confirmationNumber,
    record.confirmationId,
    record.confirmationCode,
    record.reference,
    record.uuid,
    record.id,
    getPath(record, ["reservation", "id"]),
    getPath(record, ["reservation", "confirmationNumber"]),
    getPath(record, ["booking", "id"]),
    getPath(record, ["booking", "confirmationNumber"]),
    getPath(record, ["restaurantReservation", "id"]),
  );
  const sourceId = reservationId ?? hashString(`${restaurantName}:${startTime}`);
  const sourceEventId = `${OPENTABLE_SOURCE}:${sanitizeIdPart(sourceId) || hashString(sourceId)}`;
  const restaurantSourceId = getString(
    record.rid,
    record.restaurantId,
    record.restaurant_id,
    record.ridInt,
    record.venueId,
    record.venue_id,
    restaurant?.id,
    restaurant?.rid,
    restaurant?.ridInt,
    restaurant?.restaurantId,
    restaurant?.restaurant_id,
    restaurant?.venueId,
  );
  const latitude = getNumber(
    record.latitude,
    record.lat,
    restaurant?.latitude,
    restaurant?.lat,
    restaurant?.latitudeDecimal,
    getPath(restaurant, ["location", "latitude"]),
    getPath(restaurant, ["location", "lat"]),
    getPath(restaurant, ["coordinates", "latitude"]),
    getPath(restaurant, ["coordinates", "lat"]),
    getPath(restaurant, ["geo", "latitude"]),
    getPath(restaurant, ["geo", "lat"]),
    getPath(restaurant, ["geocode", "latitude"]),
    getPath(restaurant, ["latLong", "latitude"]),
  );
  const longitude = getNumber(
    record.longitude,
    record.lng,
    record.lon,
    record.long,
    restaurant?.longitude,
    restaurant?.lng,
    restaurant?.lon,
    restaurant?.long,
    restaurant?.longitudeDecimal,
    getPath(restaurant, ["location", "longitude"]),
    getPath(restaurant, ["location", "lng"]),
    getPath(restaurant, ["location", "lon"]),
    getPath(restaurant, ["coordinates", "longitude"]),
    getPath(restaurant, ["coordinates", "lng"]),
    getPath(restaurant, ["coordinates", "lon"]),
    getPath(restaurant, ["geo", "longitude"]),
    getPath(restaurant, ["geo", "lng"]),
    getPath(restaurant, ["geo", "lon"]),
    getPath(restaurant, ["geocode", "longitude"]),
    getPath(restaurant, ["latLong", "longitude"]),
  );
  const restaurantId = `opentable-${sanitizeIdPart(
    restaurantSourceId ?? hashString(`${restaurantName}:${latitude}:${longitude}`),
  )}`;

  return {
    id: `opentable-${hashString(`${sourceEventId}:${startTime}`)}`,
    sourceEventId,
    sourceName: OPENTABLE_SOURCE,
    restaurantName,
    restaurantId,
    address: getRestaurantAddress(record, restaurant),
    startTime,
    endTime: parseOpenTableTimestamp(record.endTime, record.endsAt) ?? defaultReservationEndTime(startTime),
    partySize: getNumber(
      record.partySize,
      record.party_size,
      record.covers,
      record.numGuests,
      record.guestCount,
      record.numberOfGuests,
      record.numberOfPeople,
      record.guests,
      record.size,
      getPath(record, ["reservation", "partySize"]),
      getPath(record, ["reservation", "guestCount"]),
      getPath(record, ["booking", "partySize"]),
      getPath(record, ["booking", "guestCount"]),
      getPath(record, ["restaurantReservation", "partySize"]),
    ),
    latitude,
    longitude,
    website: getString(
      record.website,
      record.profileUrl,
      restaurant?.website,
      restaurant?.url,
      restaurant?.profileUrl,
      restaurant?.reservationUrl,
    ),
  };
}

function looksLikeReservationCandidate(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  const restaurant = getRestaurantRecord(record);
  const startTime = parseOpenTableStartTime(record);
  return Boolean(
    getRestaurantName(record, restaurant) &&
    startTime !== null &&
    startTime <= Date.now() &&
    !isCanceledReservation(record),
  );
}

function collectReservationCandidates(payload: unknown): unknown[] {
  const candidates: unknown[] = [];
  const stack: unknown[] = [payload];
  const seen = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (typeof current === "object") {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    if (looksLikeReservationCandidate(current)) {
      candidates.push(current);
      continue;
    }

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return candidates;
}

export function normalizeOpenTableVisitHistory(payload: unknown): NormalizedOpenTableHistory {
  const rawReservations = collectReservationCandidates(payload);
  const reservationsBySourceEventId = new Map<string, OpenTableImportableReservation>();
  let invalidCount = 0;

  for (const rawReservation of rawReservations) {
    const normalized = normalizeOpenTableCandidate(rawReservation);
    if (normalized) {
      reservationsBySourceEventId.set(normalized.sourceEventId, normalized);
    } else {
      invalidCount += 1;
    }
  }

  const reservations = Array.from(reservationsBySourceEventId.values()).sort((a, b) => b.startTime - a.startTime);

  logOpenTableImport("Normalized history", {
    payload: describeOpenTablePayloadForLog(payload),
    topLevelReservations: summarizeOpenTableTopLevelReservationsForLog(payload),
    rawCandidateCount: rawReservations.length,
    normalizedCount: reservations.length,
    invalidCandidateCount: invalidCount,
    duplicateCandidateCount: Math.max(0, rawReservations.length - invalidCount - reservations.length),
    normalizedSample: reservations.slice(0, OPENTABLE_DEBUG_SAMPLE_SIZE).map(summarizeOpenTableReservationForLog),
  });

  return {
    reservations,
    fetchedCount: rawReservations.length,
    invalidCount,
  };
}

export async function importOpenTableVisitHistory(payload: unknown): Promise<OpenTableImportResult> {
  const history = normalizeOpenTableVisitHistory(payload);
  const result = await importReservationVisitHistory(history.reservations, {
    sourceDisplayName: "OpenTable",
    fetchedCount: history.fetchedCount,
    invalidCount: history.invalidCount,
  });
  logOpenTableImport("Import complete", result);
  return result;
}
