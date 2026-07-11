export interface ReservationReviewPrefilterCandidate {
  readonly sourceEventId: string;
  readonly sourceName: string;
  readonly restaurantName: string;
  readonly startTime: number;
  readonly restaurantId?: string | null;
  readonly suggestedRestaurantId?: string | null;
}

export interface ReservationReviewPrefilterSnapshot {
  readonly dismissedSourceEventIds: Set<string>;
  readonly excludedSourceEventIds: Set<string>;
  readonly exactConfirmedSourceEventIds: Set<string>;
  readonly sameDateConfirmedSourceEventIds: Set<string>;
}

export interface ReservationReviewPrefilterFactRow {
  readonly kind: "dismissed" | "fingerprint" | "confirmed";
  readonly sourceEventId: string;
}

export interface ReservationReviewPrefilterConfirmedVisitRow {
  readonly dayKey: string;
  readonly restaurantId: string | null;
  readonly suggestedRestaurantId: string | null;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly calendarEventTitle: string | null;
}

export interface ReservationReviewSameDateMatchMetrics {
  readonly candidateCount: number;
  readonly confirmedVisitRowCount: number;
  readonly dayBucketCount: number;
  readonly normalizedNameCount: number;
  readonly fuzzyNameComparisonCount: number;
}

export interface ReservationReviewSameDateMatchResult {
  readonly sourceEventIds: Set<string>;
  readonly metrics: ReservationReviewSameDateMatchMetrics;
}

interface PreparedReservationReviewCandidate extends ReservationReviewPrefilterCandidate {
  readonly fingerprint: string | null;
  readonly dayKey: string;
  readonly dayStartTime: number;
  readonly dayEndTime: number;
}

export interface PreparedReservationReviewPrefilter {
  readonly candidates: readonly PreparedReservationReviewCandidate[];
  readonly exactFactsPayload: string;
}

export interface ReservationReviewPrefilterReadBackend {
  readonly getAllAsync: <Row>(sql: string, parameters: Array<string | number | null>) => Promise<Row[]>;
}

export interface ReservationReviewPrefilterSnapshotRows {
  readonly dismissedSourceEventIds: Set<string>;
  readonly excludedSourceEventIds: Set<string>;
  readonly exactConfirmedSourceEventIds: Set<string>;
  readonly sameDateCandidates: readonly PreparedReservationReviewCandidate[];
  readonly confirmedVisitRows: readonly ReservationReviewPrefilterConfirmedVisitRow[];
}

export const RESERVATION_REVIEW_PREFILTER_EXACT_FACTS_SQL = `
WITH input AS (
  SELECT
    CAST(json_extract(value, '$.sourceEventId') AS TEXT) AS sourceEventId,
    CAST(json_extract(value, '$.fingerprint') AS TEXT) AS fingerprint
  FROM json_each(?)
)
SELECT 'dismissed' AS kind, input.sourceEventId
FROM input
JOIN dismissed_reservation_import_sources AS dismissed
  ON dismissed.sourceEventId = input.sourceEventId
UNION ALL
SELECT 'fingerprint' AS kind, input.sourceEventId
FROM input
JOIN reservation_import_review_exclusions AS exclusions
  ON exclusions.fingerprint = input.fingerprint
LEFT JOIN dismissed_reservation_import_sources AS dismissed
  ON dismissed.sourceEventId = input.sourceEventId
WHERE dismissed.sourceEventId IS NULL
UNION ALL
SELECT 'confirmed' AS kind, input.sourceEventId
FROM input
JOIN reservation_import_sources AS sources
  ON sources.sourceEventId = input.sourceEventId
LEFT JOIN visits AS linked_visit
  ON linked_visit.id = sources.visitId
WHERE linked_visit.status = 'confirmed' OR linked_visit.id IS NULL
UNION ALL
SELECT 'confirmed' AS kind, input.sourceEventId
FROM input
JOIN visits AS legacy_visit INDEXED BY idx_visits_calendar_event
  ON legacy_visit.calendarEventId = input.sourceEventId
WHERE legacy_visit.status = 'confirmed'
`;

export const RESERVATION_REVIEW_PREFILTER_CONFIRMED_DAYS_SQL = `
WITH requested_days AS (
  SELECT
    CAST(json_extract(value, '$.dayKey') AS TEXT) AS dayKey,
    CAST(json_extract(value, '$.startTime') AS INTEGER) AS startTime,
    CAST(json_extract(value, '$.endTime') AS INTEGER) AS endTime
  FROM json_each(?)
)
SELECT
  requested_days.dayKey,
  visit.restaurantId,
  visit.suggestedRestaurantId,
  restaurant.name AS restaurantName,
  suggested.name AS suggestedRestaurantName,
  visit.calendarEventTitle
FROM requested_days
CROSS JOIN visits AS visit INDEXED BY idx_visits_status_time
  ON visit.status = 'confirmed'
 AND visit.startTime >= requested_days.startTime
 AND visit.startTime < requested_days.endTime
LEFT JOIN restaurants AS restaurant
  ON restaurant.id = visit.restaurantId
LEFT JOIN michelin_restaurants AS suggested
  ON suggested.id = visit.suggestedRestaurantId
`;

const IGNORED_RESERVATION_NAME_WORDS = new Set([
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

export function getReservationReviewLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getReservationReviewLocalDateRange(timestamp: number): {
  readonly startTime: number;
  readonly endTime: number;
} {
  const date = new Date(timestamp);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { startTime: start.getTime(), endTime: end.getTime() };
}

export function normalizeReservationReviewRestaurantName(value: string): string {
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

function getSignificantReservationNameWords(value: string): string[] {
  return value.split(" ").filter((word) => word.length > 1 && !IGNORED_RESERVATION_NAME_WORDS.has(word));
}

export function areNormalizedReservationReviewRestaurantNamesSimilar(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.length >= 6 && b.length >= 6) {
    return a.includes(b) || b.includes(a);
  }

  const wordsA = getSignificantReservationNameWords(a);
  const wordsB = getSignificantReservationNameWords(b);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}

export function getReservationImportReviewFingerprint(
  reservation: Pick<ReservationReviewPrefilterCandidate, "sourceName" | "restaurantName" | "startTime">,
): string | null {
  const sourceName = reservation.sourceName.trim().toLowerCase();
  const restaurantName = normalizeReservationReviewRestaurantName(reservation.restaurantName);
  if (!sourceName || restaurantName.length < 3) {
    return null;
  }
  return `${sourceName}:${getReservationReviewLocalDateKey(reservation.startTime)}:${restaurantName}`;
}

export function prepareReservationReviewPrefilter(
  candidates: readonly ReservationReviewPrefilterCandidate[],
): PreparedReservationReviewPrefilter {
  const preparedCandidates = candidates.map((candidate) => {
    const range = getReservationReviewLocalDateRange(candidate.startTime);
    return {
      ...candidate,
      fingerprint: getReservationImportReviewFingerprint(candidate),
      dayKey: getReservationReviewLocalDateKey(candidate.startTime),
      dayStartTime: range.startTime,
      dayEndTime: range.endTime,
    };
  });
  return {
    candidates: preparedCandidates,
    exactFactsPayload: JSON.stringify(
      preparedCandidates.map(({ sourceEventId, fingerprint }) => ({ sourceEventId, fingerprint })),
    ),
  };
}

function collectExactFacts(rows: readonly ReservationReviewPrefilterFactRow[]): {
  readonly dismissedSourceEventIds: Set<string>;
  readonly excludedSourceEventIds: Set<string>;
  readonly exactConfirmedSourceEventIds: Set<string>;
} {
  const dismissedSourceEventIds = new Set<string>();
  const excludedSourceEventIds = new Set<string>();
  const exactConfirmedSourceEventIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === "dismissed") {
      dismissedSourceEventIds.add(row.sourceEventId);
      excludedSourceEventIds.add(row.sourceEventId);
    } else if (row.kind === "fingerprint") {
      excludedSourceEventIds.add(row.sourceEventId);
    } else if (row.kind === "confirmed") {
      exactConfirmedSourceEventIds.add(row.sourceEventId);
    } else {
      throw new Error(`Unexpected reservation review prefilter fact kind: ${String(row.kind)}.`);
    }
  }
  return { dismissedSourceEventIds, excludedSourceEventIds, exactConfirmedSourceEventIds };
}

function buildRequestedDaysPayload(candidates: readonly PreparedReservationReviewCandidate[]): string {
  const days = new Map<string, { readonly dayKey: string; readonly startTime: number; readonly endTime: number }>();
  for (const candidate of candidates) {
    if (!days.has(candidate.dayKey)) {
      days.set(candidate.dayKey, {
        dayKey: candidate.dayKey,
        startTime: candidate.dayStartTime,
        endTime: candidate.dayEndTime,
      });
    }
  }
  return JSON.stringify([...days.values()]);
}

/**
 * Run the only database reads in the provider-review prefilter. The caller must
 * supply one transaction-scoped backend so both SELECTs share a read snapshot.
 */
export async function readReservationReviewPrefilterSnapshotRows(
  backend: ReservationReviewPrefilterReadBackend,
  prepared: PreparedReservationReviewPrefilter,
): Promise<ReservationReviewPrefilterSnapshotRows> {
  if (prepared.candidates.length === 0) {
    return {
      dismissedSourceEventIds: new Set(),
      excludedSourceEventIds: new Set(),
      exactConfirmedSourceEventIds: new Set(),
      sameDateCandidates: [],
      confirmedVisitRows: [],
    };
  }

  const factRows = await backend.getAllAsync<ReservationReviewPrefilterFactRow>(
    RESERVATION_REVIEW_PREFILTER_EXACT_FACTS_SQL,
    [prepared.exactFactsPayload],
  );
  const facts = collectExactFacts(factRows);
  const sameDateCandidates = prepared.candidates.filter(
    (candidate) => !facts.excludedSourceEventIds.has(candidate.sourceEventId),
  );
  const confirmedVisitRows =
    sameDateCandidates.length === 0
      ? []
      : await backend.getAllAsync<ReservationReviewPrefilterConfirmedVisitRow>(
          RESERVATION_REVIEW_PREFILTER_CONFIRMED_DAYS_SQL,
          [buildRequestedDaysPayload(sameDateCandidates)],
        );

  return { ...facts, sameDateCandidates, confirmedVisitRows };
}

interface SameDateBucket {
  readonly restaurantIds: Set<string>;
  readonly normalizedNames: Set<string>;
}

export function matchReservationReviewCandidatesToSameDateConfirmedVisits(
  candidates: readonly ReservationReviewPrefilterCandidate[],
  confirmedVisits: readonly ReservationReviewPrefilterConfirmedVisitRow[],
): ReservationReviewSameDateMatchResult {
  const buckets = new Map<string, SameDateBucket>();
  let normalizedNameCount = 0;
  let fuzzyNameComparisonCount = 0;

  for (const visit of confirmedVisits) {
    let bucket = buckets.get(visit.dayKey);
    if (!bucket) {
      bucket = { restaurantIds: new Set(), normalizedNames: new Set() };
      buckets.set(visit.dayKey, bucket);
    }
    if (visit.restaurantId) {
      bucket.restaurantIds.add(visit.restaurantId);
    }
    if (visit.suggestedRestaurantId) {
      bucket.restaurantIds.add(visit.suggestedRestaurantId);
    }
    for (const name of [visit.restaurantName, visit.suggestedRestaurantName, visit.calendarEventTitle]) {
      if (typeof name !== "string") {
        continue;
      }
      normalizedNameCount += 1;
      bucket.normalizedNames.add(normalizeReservationReviewRestaurantName(name));
    }
  }

  const sourceEventIds = new Set<string>();
  for (const candidate of candidates) {
    const bucket = buckets.get(getReservationReviewLocalDateKey(candidate.startTime));
    if (!bucket) {
      continue;
    }
    if (
      (Boolean(candidate.restaurantId) && bucket.restaurantIds.has(candidate.restaurantId!)) ||
      (Boolean(candidate.suggestedRestaurantId) && bucket.restaurantIds.has(candidate.suggestedRestaurantId!))
    ) {
      sourceEventIds.add(candidate.sourceEventId);
      continue;
    }
    if (bucket.normalizedNames.size === 0) {
      continue;
    }

    normalizedNameCount += 1;
    const normalizedCandidateName = normalizeReservationReviewRestaurantName(candidate.restaurantName);
    for (const normalizedExistingName of bucket.normalizedNames) {
      fuzzyNameComparisonCount += 1;
      if (areNormalizedReservationReviewRestaurantNamesSimilar(normalizedCandidateName, normalizedExistingName)) {
        sourceEventIds.add(candidate.sourceEventId);
        break;
      }
    }
  }

  return {
    sourceEventIds,
    metrics: {
      candidateCount: candidates.length,
      confirmedVisitRowCount: confirmedVisits.length,
      dayBucketCount: buckets.size,
      normalizedNameCount,
      fuzzyNameComparisonCount,
    },
  };
}

/** Complete the CPU-only portion after the transaction has committed. */
export function finalizeReservationReviewPrefilterSnapshot(
  rows: ReservationReviewPrefilterSnapshotRows,
): ReservationReviewPrefilterSnapshot {
  const sameDate = matchReservationReviewCandidatesToSameDateConfirmedVisits(
    rows.sameDateCandidates,
    rows.confirmedVisitRows,
  );
  return {
    dismissedSourceEventIds: rows.dismissedSourceEventIds,
    excludedSourceEventIds: rows.excludedSourceEventIds,
    exactConfirmedSourceEventIds: rows.exactConfirmedSourceEventIds,
    sameDateConfirmedSourceEventIds: sameDate.sourceEventIds,
  };
}
