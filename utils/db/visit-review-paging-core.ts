import { PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL, type PendingVisitReviewQueryRow } from "./visit-review-core.ts";

export const DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE = 128;
export const MAX_PENDING_VISIT_REVIEW_PAGE_SIZE = 1_024;

export type PendingVisitReviewFilterToggle = "on" | "off";

export interface PendingVisitReviewFilters {
  readonly food: PendingVisitReviewFilterToggle;
  readonly restaurantMatches: PendingVisitReviewFilterToggle;
}

export const DEFAULT_PENDING_VISIT_REVIEW_FILTERS: PendingVisitReviewFilters = {
  food: "off",
  restaurantMatches: "off",
};

export interface PendingVisitReviewManifestSuggestion {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface PendingVisitReviewManifestItem {
  readonly id: string;
  readonly priority: 1 | 2 | 3 | 4;
  readonly startTime: number;
  readonly foodProbable: boolean;
  readonly calendarEventTitle: string | null;
  readonly suggestedRestaurants: readonly PendingVisitReviewManifestSuggestion[];
}

export interface PendingVisitReviewManifestRow {
  readonly manifestJson: string;
}

export interface PendingVisitReviewExactConfirmation {
  readonly visitId: string;
  readonly restaurantId: string;
  readonly restaurantName: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly calendarTitle: string;
  readonly startTime: number;
}

export interface PendingVisitReviewGenerationRecord {
  readonly id: string;
  readonly key: PendingVisitReviewPageKey;
  readonly isExactMatch: boolean;
  readonly foodProbable: boolean;
  readonly hasRestaurantMatches: boolean;
  readonly hasCalendarEventTitle: boolean;
}

export interface PendingVisitReviewGenerationSummary {
  readonly totalPending: number;
  readonly exactMatchCount: number;
  readonly reviewableCount: number;
  readonly filteredManualCount: number;
  readonly reviewableFoodCount: number;
}

export interface PendingVisitReviewGeneration {
  readonly generationId: string;
  readonly filters: PendingVisitReviewFilters;
  readonly records: readonly PendingVisitReviewGenerationRecord[];
  readonly selectedKeys: readonly PendingVisitReviewPageKey[];
  readonly exactConfirmations: readonly PendingVisitReviewExactConfirmation[];
  readonly summary: PendingVisitReviewGenerationSummary;
  readonly strategy: "progressive" | "legacy-fallback";
}

export interface PendingVisitReviewPageRequest {
  readonly generationId: string;
  readonly keys: readonly PendingVisitReviewPageKey[];
}

export interface PendingVisitReviewPage<Visit> {
  readonly generationId: string;
  readonly requestedKeys: readonly PendingVisitReviewPageKey[];
  readonly visits: readonly Visit[];
  readonly manifest: PendingVisitReviewGeneration | null;
}

export interface PendingVisitReviewMatchTools {
  readonly cleanCalendarEventTitle: (title: string) => string;
  readonly isFuzzyRestaurantMatch: (cleanedTitle: string, restaurantName: string) => boolean;
  readonly compareRestaurantAndCalendarTitle: (calendarTitle: string, restaurantName: string) => boolean;
}

export interface PendingVisitReviewPageKey {
  readonly id: string;
  readonly priority: 1 | 2 | 3 | 4;
}

export interface PendingVisitReviewOrderedKeysRow {
  readonly keysJson: string;
}

/**
 * Return the complete lightweight Review generation in one row.
 *
 * This intentionally excludes previews, labels, notes, addresses, and other
 * card-only fields. Calendar title and minimal suggested-restaurant identity
 * are retained so JavaScript can preserve the existing global fuzzy/exact
 * ordering before any heavy page is hydrated.
 */
export const PENDING_VISIT_REVIEW_MANIFEST_SQL = `WITH
  suggested_restaurants AS (
    SELECT
      vsr.visitId,
      json_group_array(
        json_array(m.id, m.name, m.latitude, m.longitude)
        ORDER BY ${PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL}
      ) AS restaurants
    FROM visit_suggested_restaurants vsr
    JOIN michelin_restaurants m ON vsr.restaurantId = m.id
    GROUP BY vsr.visitId
  ),
  scored_pending_visits AS (
    SELECT
      v.id,
      v.startTime,
      v.foodProbable,
      v.calendarEventTitle,
      COALESCE(sr.restaurants, '[]') AS suggestedRestaurantsJson,
      CASE
        WHEN v.foodProbable = 1 AND (
          v.suggestedRestaurantId IS NOT NULL
          OR sr.restaurants IS NOT NULL
        ) THEN 1
        WHEN v.suggestedRestaurantId IS NOT NULL
          OR sr.restaurants IS NOT NULL THEN 2
        WHEN v.foodProbable = 1 THEN 3
        ELSE 4
      END AS priority
    FROM visits v
    LEFT JOIN suggested_restaurants sr ON sr.visitId = v.id
    WHERE v.status = 'pending'
  )
SELECT COALESCE(
  json_group_array(
    json_array(
      id,
      priority,
      startTime,
      foodProbable,
      calendarEventTitle,
      json(suggestedRestaurantsJson)
    )
  ),
  '[]'
) AS manifestJson
FROM (
  SELECT *
  FROM scored_pending_visits
  ORDER BY priority ASC, startTime DESC, id ASC
) AS ordered_pending_visits`;

/**
 * Return the complete pending-review order as one bounded SQLite row.
 *
 * The heavy visit, suggestion, preview, and food-label fields are deliberately
 * absent. `id` matches the monolithic query's total-order refinement so equal
 * priority/time rows remain deterministic across both strategies and page
 * boundaries.
 */
export const PENDING_VISIT_REVIEW_ORDERED_KEYS_SQL = `WITH
  scored_pending_visits AS (
    SELECT
      v.id,
      v.startTime,
      CASE
        WHEN v.foodProbable = 1 AND (
          v.suggestedRestaurantId IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM visit_suggested_restaurants vsr
            JOIN michelin_restaurants m ON m.id = vsr.restaurantId
            WHERE vsr.visitId = v.id
          )
        ) THEN 1
        WHEN v.suggestedRestaurantId IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM visit_suggested_restaurants vsr
            JOIN michelin_restaurants m ON m.id = vsr.restaurantId
            WHERE vsr.visitId = v.id
          ) THEN 2
        WHEN v.foodProbable = 1 THEN 3
        ELSE 4
      END AS priority
    FROM visits v
    WHERE v.status = 'pending'
  )
SELECT json_group_array(json_object('id', id, 'priority', priority)) AS keysJson
FROM (
  SELECT id, priority
  FROM scored_pending_visits
  ORDER BY priority ASC, startTime DESC, id ASC
) AS ordered_pending_visits`;

/**
 * Hydrate one ordered page supplied as a JSON array of `{ id, priority }`.
 *
 * `json_each(?)` keeps the API at one bind regardless of page size. Its array
 * key is retained as `ordinal`, so SQLite returns rows in the caller's exact
 * order instead of relying on an `IN (...)` scan order.
 */
export const PENDING_VISIT_REVIEW_PAGE_SQL = `WITH
  page_input AS MATERIALIZED (
    SELECT
      CAST(key AS INTEGER) AS ordinal,
      json_extract(value, '$.id') AS id,
      json_extract(value, '$.priority') AS priority
    FROM json_each(?)
  ),
  pending_visits AS (
    SELECT
      v.*,
      r.name AS restaurantName,
      m.name AS suggestedRestaurantName,
      m.award AS suggestedRestaurantAward,
      m.cuisine AS suggestedRestaurantCuisine,
      m.address AS suggestedRestaurantAddress
    FROM visits v
    LEFT JOIN restaurants r ON v.restaurantId = r.id
    LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
    WHERE v.status = 'pending'
      AND v.id IN (SELECT id FROM page_input)
  ),
  suggested_restaurants AS (
    SELECT
      vsr.visitId,
      json_group_array(
        json_object(
          'id', m.id,
          'name', m.name,
          'latitude', m.latitude,
          'longitude', m.longitude,
          'address', m.address,
          'location', m.location,
          'cuisine', m.cuisine,
          'latestAwardYear', m.latestAwardYear,
          'award', m.award,
          'distance', vsr.distance
        ) ORDER BY ${PENDING_VISIT_REVIEW_SUGGESTION_ORDER_SQL}
      ) AS restaurants
    FROM visit_suggested_restaurants vsr
    JOIN michelin_restaurants m ON vsr.restaurantId = m.id
    WHERE vsr.visitId IN (SELECT id FROM pending_visits)
    GROUP BY vsr.visitId
  ),
  food_labels AS (
    SELECT
      p.visitId,
      json_group_array(json(p.foodLabels)) AS labelsJson
    FROM photos p
    WHERE p.visitId IN (SELECT id FROM pending_visits WHERE foodProbable = 1)
      AND p.foodDetected = 1
      AND p.foodLabels IS NOT NULL
    GROUP BY p.visitId
  )
SELECT
  pv.*,
  NULLIF((
    SELECT json_group_array(preview.uri)
    FROM (
      SELECT p.uri
      FROM photos p
      WHERE p.visitId = pv.id
      ORDER BY
        CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC,
        p.creationTime ASC,
        p.id ASC
      LIMIT 3
    ) AS preview
  ), '[]') AS previewPhotosJson,
  sr.restaurants AS suggestedRestaurantsJson,
  fl.labelsJson AS foodLabelsJson,
  pi.priority AS priority,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM photos p_check
      WHERE p_check.visitId = pv.id
        AND p_check.foodDetected IS NULL
    ) THEN 1
    ELSE 0
  END AS hasUnanalyzedPhotos
FROM page_input pi
JOIN pending_visits pv ON pv.id = pi.id
LEFT JOIN suggested_restaurants sr ON pv.id = sr.visitId
LEFT JOIN food_labels fl ON pv.id = fl.visitId
ORDER BY pi.ordinal ASC`;

function requirePageKey(value: unknown, context: string): PendingVisitReviewPageKey {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${context} must be an object`);
  }
  const candidate = value as { readonly id?: unknown; readonly priority?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new TypeError(`${context}.id must be a non-empty string`);
  }
  if (
    typeof candidate.priority !== "number" ||
    !Number.isInteger(candidate.priority) ||
    candidate.priority < 1 ||
    candidate.priority > 4
  ) {
    throw new RangeError(`${context}.priority must be an integer from 1 through 4`);
  }
  return candidate as PendingVisitReviewPageKey;
}

function assertUniquePageKeys(keys: readonly PendingVisitReviewPageKey[], context: string): void {
  const identifiers = new Set<string>();
  for (const [index, key] of keys.entries()) {
    requirePageKey(key, `${context}[${index}]`);
    if (identifiers.has(key.id)) {
      throw new RangeError(`${context} contains duplicate visit id ${JSON.stringify(key.id)}`);
    }
    identifiers.add(key.id);
  }
}

export function parsePendingVisitReviewOrderedKeys(row: PendingVisitReviewOrderedKeysRow): PendingVisitReviewPageKey[] {
  if (typeof row?.keysJson !== "string") {
    throw new TypeError("Pending-review ordered-key query must return keysJson as a string");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.keysJson);
  } catch (error) {
    throw new SyntaxError(`Pending-review ordered keys are not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(decoded)) {
    throw new TypeError("Pending-review ordered keys must decode to an array");
  }
  const keys = decoded.map((value, index) => requirePageKey(value, `orderedKeys[${index}]`));
  assertUniquePageKeys(keys, "orderedKeys");
  return keys;
}

function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  return value;
}

function requireManifestSuggestion(value: unknown, context: string): PendingVisitReviewManifestSuggestion {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${context} must be a four-value array`);
  }
  const [id, name, latitude, longitude] = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`${context}.id must be a non-empty string`);
  }
  if (typeof name !== "string") {
    throw new TypeError(`${context}.name must be a string`);
  }
  return {
    id,
    name,
    latitude: requireFiniteNumber(latitude, `${context}.latitude`),
    longitude: requireFiniteNumber(longitude, `${context}.longitude`),
  };
}

function requireManifestItem(value: unknown, context: string): PendingVisitReviewManifestItem {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new TypeError(`${context} must be a six-value array`);
  }
  const [id, priority, startTime, foodProbable, calendarEventTitle, suggestedRestaurants] = value;
  const key = requirePageKey({ id, priority }, context);
  if (foodProbable !== 0 && foodProbable !== 1) {
    throw new TypeError(`${context}.foodProbable must be 0 or 1`);
  }
  if (calendarEventTitle !== null && typeof calendarEventTitle !== "string") {
    throw new TypeError(`${context}.calendarEventTitle must be a string or null`);
  }
  if (!Array.isArray(suggestedRestaurants)) {
    throw new TypeError(`${context}.suggestedRestaurants must be an array`);
  }
  return {
    ...key,
    startTime: requireFiniteNumber(startTime, `${context}.startTime`),
    foodProbable: foodProbable === 1,
    calendarEventTitle,
    suggestedRestaurants: suggestedRestaurants.map((suggestion, index) =>
      requireManifestSuggestion(suggestion, `${context}.suggestedRestaurants[${index}]`),
    ),
  };
}

export function parsePendingVisitReviewManifest(row: PendingVisitReviewManifestRow): PendingVisitReviewManifestItem[] {
  if (typeof row?.manifestJson !== "string") {
    throw new TypeError("Pending-review manifest query must return manifestJson as a string");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.manifestJson);
  } catch (error) {
    throw new SyntaxError(`Pending-review manifest is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(decoded)) {
    throw new TypeError("Pending-review manifest must decode to an array");
  }
  const items = decoded.map((value, index) => requireManifestItem(value, `manifest[${index}]`));
  assertUniquePageKeys(items, "manifest");
  return items;
}

function hashGenerationSeed(seed: string): string {
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ 0x9e37_79b9;
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619) >>> 0;
    second = Math.imul(second ^ (code + index), 2_246_822_519) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function stablePartition<Item>(items: readonly Item[], predicate: (item: Item) => boolean): Item[] {
  const matching: Item[] = [];
  const remaining: Item[] = [];
  for (const item of items) {
    (predicate(item) ? matching : remaining).push(item);
  }
  return [...matching, ...remaining];
}

function validatePendingVisitReviewFilters(filters: PendingVisitReviewFilters): PendingVisitReviewFilters {
  if (
    (filters.food !== "on" && filters.food !== "off") ||
    (filters.restaurantMatches !== "on" && filters.restaurantMatches !== "off")
  ) {
    throw new RangeError("Pending-review filters must use on/off toggles");
  }
  return filters;
}

export function summarizePendingVisitReviewGeneration(
  records: readonly PendingVisitReviewGenerationRecord[],
  selectedKeys: readonly PendingVisitReviewPageKey[],
  exactConfirmations: readonly PendingVisitReviewExactConfirmation[],
): PendingVisitReviewGenerationSummary {
  const exactIds = new Set(exactConfirmations.map((confirmation) => confirmation.visitId));
  const selectedIds = new Set(selectedKeys.map((key) => key.id));
  return {
    totalPending: records.length,
    exactMatchCount: exactConfirmations.length,
    reviewableCount: records.filter((record) => !record.isExactMatch).length,
    filteredManualCount: records.filter((record) => !exactIds.has(record.id) && selectedIds.has(record.id)).length,
    reviewableFoodCount: records.filter((record) => !record.isExactMatch && record.foodProbable).length,
  };
}

/** Build the exact global Review order before hydrating card-sized rows. */
export function createPendingVisitReviewGeneration(
  items: readonly PendingVisitReviewManifestItem[],
  filters: PendingVisitReviewFilters,
  tools: PendingVisitReviewMatchTools,
  generationSeed: string,
  strategy: PendingVisitReviewGeneration["strategy"] = "progressive",
): PendingVisitReviewGeneration {
  validatePendingVisitReviewFilters(filters);
  assertUniquePageKeys(items, "manifestItems");

  const fuzzyMatchIds = new Set<string>();
  for (const item of items) {
    if (!item.calendarEventTitle || item.suggestedRestaurants.length === 0) {
      continue;
    }
    const cleanedTitle = tools.cleanCalendarEventTitle(item.calendarEventTitle);
    if (
      cleanedTitle &&
      item.suggestedRestaurants.some((restaurant) => tools.isFuzzyRestaurantMatch(cleanedTitle, restaurant.name))
    ) {
      fuzzyMatchIds.add(item.id);
    }
  }

  const backendOrderedItems = stablePartition(items, (item) => fuzzyMatchIds.has(item.id));
  const exactConfirmations: PendingVisitReviewExactConfirmation[] = [];
  const exactIds = new Set<string>();
  for (const item of backendOrderedItems) {
    if (!item.calendarEventTitle) {
      continue;
    }
    const restaurant = item.suggestedRestaurants.find((suggestion) =>
      tools.compareRestaurantAndCalendarTitle(item.calendarEventTitle!, suggestion.name),
    );
    if (!restaurant) {
      continue;
    }
    exactIds.add(item.id);
    exactConfirmations.push({
      visitId: item.id,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      calendarTitle: item.calendarEventTitle,
      startTime: item.startTime,
    });
  }

  const records: PendingVisitReviewGenerationRecord[] = backendOrderedItems.map((item) => ({
    id: item.id,
    key: { id: item.id, priority: item.priority },
    isExactMatch: exactIds.has(item.id),
    foodProbable: item.foodProbable,
    hasRestaurantMatches: item.suggestedRestaurants.length > 0,
    hasCalendarEventTitle: Boolean(item.calendarEventTitle),
  }));
  const filteredManualRecords = records.filter(
    (record) =>
      !record.isExactMatch &&
      (filters.food === "off" || record.foodProbable) &&
      (filters.restaurantMatches === "off" || record.hasRestaurantMatches),
  );
  const orderedManualRecords = stablePartition(filteredManualRecords, (record) => record.hasCalendarEventTitle);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const selectedKeys = [
    ...exactConfirmations.map((confirmation) => recordById.get(confirmation.visitId)!.key),
    ...orderedManualRecords.map((record) => record.key),
  ];
  const generationId = `pending-review-v1-${items.length}-${filters.food}-${filters.restaurantMatches}-${hashGenerationSeed(
    generationSeed,
  )}`;

  return {
    generationId,
    filters: { ...filters },
    records,
    selectedKeys,
    exactConfirmations,
    summary: summarizePendingVisitReviewGeneration(records, selectedKeys, exactConfirmations),
    strategy,
  };
}

export function validatePendingVisitReviewPageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PENDING_VISIT_REVIEW_PAGE_SIZE) {
    throw new RangeError(
      `Pending-review page size must be an integer from 1 through ${MAX_PENDING_VISIT_REVIEW_PAGE_SIZE}; received ${pageSize}`,
    );
  }
  return pageSize;
}

export function partitionPendingVisitReviewKeys(
  keys: readonly PendingVisitReviewPageKey[],
  pageSize: number = DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
): PendingVisitReviewPageKey[][] {
  validatePendingVisitReviewPageSize(pageSize);
  assertUniquePageKeys(keys, "keys");
  const pages: PendingVisitReviewPageKey[][] = [];
  for (let offset = 0; offset < keys.length; offset += pageSize) {
    pages.push(keys.slice(offset, offset + pageSize));
  }
  return pages;
}

export function serializePendingVisitReviewPageKeys(keys: readonly PendingVisitReviewPageKey[]): string {
  if (keys.length > MAX_PENDING_VISIT_REVIEW_PAGE_SIZE) {
    throw new RangeError(
      `Pending-review page contains ${keys.length} keys; maximum is ${MAX_PENDING_VISIT_REVIEW_PAGE_SIZE}`,
    );
  }
  assertUniquePageKeys(keys, "pageKeys");
  return JSON.stringify(keys);
}

export function getNextPendingVisitReviewPageRequest<Visit>(
  pages: readonly PendingVisitReviewPage<Visit>[],
  pageSize: number = DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
): PendingVisitReviewPageRequest | undefined {
  validatePendingVisitReviewPageSize(pageSize);
  const manifest = pages[0]?.manifest;
  if (!manifest) {
    return undefined;
  }
  const requestedIds = new Set(
    pages
      .filter((page) => page.generationId === manifest.generationId)
      .flatMap((page) => page.requestedKeys.map((key) => key.id)),
  );
  const keys = manifest.selectedKeys.filter((key) => !requestedIds.has(key.id)).slice(0, pageSize);
  return keys.length === 0 ? undefined : { generationId: manifest.generationId, keys };
}

/**
 * Fully hydrate pages without exposing a partial result if a later page fails.
 * The caller should execute this inside one read transaction when a single
 * database snapshot across every page is required.
 */
export async function hydratePendingVisitReviewPages(
  keys: readonly PendingVisitReviewPageKey[],
  fetchPage: (
    serializedKeys: string,
    keys: readonly PendingVisitReviewPageKey[],
  ) => Promise<PendingVisitReviewQueryRow[]>,
  pageSize: number = DEFAULT_PENDING_VISIT_REVIEW_PAGE_SIZE,
): Promise<PendingVisitReviewQueryRow[]> {
  const pages = partitionPendingVisitReviewKeys(keys, pageSize);
  const hydrated: PendingVisitReviewQueryRow[] = [];

  for (const pageKeys of pages) {
    const rows = await fetchPage(serializePendingVisitReviewPageKeys(pageKeys), pageKeys);
    if (!Array.isArray(rows)) {
      throw new TypeError("Pending-review page fetch must return an array");
    }
    if (rows.length !== pageKeys.length) {
      throw new Error(`Pending-review page returned ${rows.length} rows for ${pageKeys.length} keys`);
    }
    for (const [index, row] of rows.entries()) {
      const key = pageKeys[index];
      if (row.id !== key.id || row.priority !== key.priority) {
        throw new Error(
          `Pending-review page row ${index} did not match its ordered key: expected ${JSON.stringify(key)}, received ${JSON.stringify(
            { id: row.id, priority: row.priority },
          )}`,
        );
      }
    }
    hydrated.push(...rows);
  }

  return hydrated;
}
