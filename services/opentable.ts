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
const MONTH_PATTERN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

export type OpenTableImportableReservation = ImportableReservation;
export type OpenTableImportResult = ReservationImportResult;

interface NormalizedOpenTableHistory {
  reservations: OpenTableImportableReservation[];
  fetchedCount: number;
  invalidCount: number;
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
    website: getString(restaurant?.website, restaurant?.url, restaurant?.profileUrl, restaurant?.reservationUrl),
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

  return {
    reservations,
    fetchedCount: rawReservations.length,
    invalidCount,
  };
}

export async function importOpenTableVisitHistory(payload: unknown): Promise<OpenTableImportResult> {
  const history = normalizeOpenTableVisitHistory(payload);
  return importReservationVisitHistory(history.reservations, {
    sourceDisplayName: "OpenTable",
    fetchedCount: history.fetchedCount,
    invalidCount: history.invalidCount,
  });
}
