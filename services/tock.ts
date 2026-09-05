import {
  asRecord,
  compactAddress,
  defaultReservationEndTime,
  getNumber,
  getPath,
  getString,
  hashString,
  parseTimestamp,
  sanitizeIdPart,
  type ImportableReservation,
  type JsonRecord,
  type JsonValue,
  type NormalizedReservationHistory,
} from "@/services/reservation-import";

const TOCK_SOURCE = "tock";

function getTockResultArray(payload: JsonValue): JsonValue[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const record = asRecord(payload);
  const result = record?.result;
  if (Array.isArray(result)) {
    return result;
  }

  const purchases = record?.purchases;
  if (Array.isArray(purchases)) {
    return purchases;
  }

  const dataPurchases = getPath(record, ["data", "purchases"]);
  if (Array.isArray(dataPurchases)) {
    return dataPurchases;
  }

  return [];
}

function isCanceledPurchase(record: JsonRecord): boolean {
  const status = getString(record.status, record.state, record.reservationStatus)?.toLowerCase();
  return (
    record.cancelledOrRefunded === true ||
    record.canceled === true ||
    record.cancelled === true ||
    status === "canceled" ||
    status === "cancelled"
  );
}

function normalizeTockPurchase(rawPurchase: JsonValue): ImportableReservation | null {
  const purchase = asRecord(rawPurchase);
  if (!purchase || isCanceledPurchase(purchase)) {
    return null;
  }

  const business = asRecord(purchase.business);
  const ticketType = asRecord(purchase.ticketType);
  const restaurantName = getString(business?.name, purchase.restaurantName, purchase.businessName);
  const startTime = parseTimestamp(
    purchase.ticketDateTime,
    purchase.reservationDateTime,
    purchase.dateTime,
    purchase.purchaseTimestamp,
  );

  if (!restaurantName || startTime === null || startTime > Date.now()) {
    return null;
  }

  const latitude = getNumber(
    business?.addressLat,
    business?.latitude,
    getPath(business, ["address", "latitude"]),
    getPath(business, ["location", "latitude"]),
  );
  const longitude = getNumber(
    business?.addressLng,
    business?.longitude,
    getPath(business, ["address", "longitude"]),
    getPath(business, ["location", "longitude"]),
    getPath(business, ["location", "lng"]),
  );
  const purchaseId = getString(purchase.id, purchase.confirmationId, purchase.originalPurchaseId);
  const sourceId = purchaseId ?? hashString(`${restaurantName}:${startTime}`);
  const sourceEventId = `${TOCK_SOURCE}:${sanitizeIdPart(sourceId) || hashString(sourceId)}`;
  const businessDomain = getString(business?.domainName);
  const businessId = getString(business?.id, businessDomain);
  const restaurantId = `tock-${sanitizeIdPart(businessId ?? hashString(`${restaurantName}:${latitude}:${longitude}`))}`;
  const address = compactAddress([
    getString(business?.address1, getPath(business, ["address", "street1"])),
    getString(business?.address2, getPath(business, ["address", "street2"])),
    getString(business?.city, purchase.city, getPath(business, ["address", "city"])),
    getString(business?.state, getPath(business, ["address", "state"])),
    getString(business?.zipCode, getPath(business, ["address", "zipCode"])),
    getString(purchase.country),
  ]);
  const tockUrl = businessDomain ? `https://www.exploretock.com/${businessDomain}` : null;

  return {
    id: `tock-${hashString(`${sourceEventId}:${startTime}`)}`,
    sourceEventId,
    sourceName: TOCK_SOURCE,
    restaurantName,
    restaurantId,
    address,
    startTime,
    endTime: defaultReservationEndTime(startTime),
    partySize: getNumber(purchase.ticketCount, purchase.partySize, purchase.size),
    latitude,
    longitude,
    website: getString(business?.webUrl, business?.website, ticketType?.webUrl, tockUrl),
  };
}

export function normalizeTockVisitHistory(payload: JsonValue): NormalizedReservationHistory {
  const rawPurchases = getTockResultArray(payload);
  const reservations: ImportableReservation[] = [];
  let invalidCount = 0;

  for (const rawPurchase of rawPurchases) {
    const normalized = normalizeTockPurchase(rawPurchase);
    if (normalized) {
      reservations.push(normalized);
    } else {
      invalidCount += 1;
    }
  }

  return {
    reservations: reservations.sort((a, b) => b.startTime - a.startTime),
    fetchedCount: rawPurchases.length,
    invalidCount,
  };
}
