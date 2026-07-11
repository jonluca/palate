export const MAX_MICHELIN_NAME_SEARCH_RESULTS = 50;
export const MICHELIN_NAME_SEARCH_DEBOUNCE_MS = 200;
export const MAX_MICHELIN_NAME_SEARCH_DATASET_ATTEMPTS = 2;

export interface MichelinUnicodeNameRow {
  readonly id: string;
  readonly name: string;
}

export interface MichelinUnicodeNameIndexRow extends MichelinUnicodeNameRow {
  readonly lowerName: string;
}

/**
 * A non-ASCII normalized query cannot match an ASCII-only name after JavaScript
 * lowercasing. Comparing SQLite's UTF-8 byte length with its code-point length
 * keeps the projection restricted to raw names that actually contain non-ASCII.
 */
export const ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL = `SELECT m.id, m.name
FROM michelin_restaurants m
WHERE (
    NOT EXISTS (
      SELECT 1 FROM app_metadata WHERE key = ?
    ) OR m.datasetVersion = (
      SELECT value FROM app_metadata WHERE key = ?
    )
  )
  AND length(CAST(m.name AS BLOB)) > length(m.name)`;

/**
 * Hydrate exact JS-sorted IDs in their supplied order. Confirmed visits and a
 * concurrently replaced guide are rechecked before LIMIT so visited rows cannot
 * crowd unvisited results out of the page.
 */
export const HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL = `WITH requested AS (
  SELECT CAST(value AS TEXT) AS id, CAST(key AS INTEGER) AS ordinal
  FROM json_each(?)
)
SELECT m.*
FROM requested
INNER JOIN michelin_restaurants m ON m.id = requested.id
WHERE (
    NOT EXISTS (
      SELECT 1 FROM app_metadata WHERE key = ?
    ) OR m.datasetVersion = (
      SELECT value FROM app_metadata WHERE key = ?
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM visits v
    WHERE v.restaurantId = m.id AND v.status = 'confirmed'
  )
ORDER BY requested.ordinal ASC
LIMIT ?`;

export function normalizeMichelinNameSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function isNonAsciiMichelinNameSearchQuery(normalizedQuery: string): boolean {
  return /[^\u0000-\u007f]/.test(normalizedQuery);
}

export function createMichelinUnicodeNameIndex(rows: readonly MichelinUnicodeNameRow[]): MichelinUnicodeNameIndexRow[] {
  return rows.map((row) => ({ ...row, lowerName: row.name.toLowerCase() }));
}

/**
 * Preserve the former Unicode path exactly: JavaScript lower()/includes(), then
 * runtime-default localeCompare by name and ID. Visit exclusion intentionally
 * happens during hydration after this total ordering.
 */
export function selectSortedMichelinUnicodeMatchIds(
  index: readonly MichelinUnicodeNameIndexRow[],
  normalizedQuery: string,
): string[] {
  if (!normalizedQuery || !isNonAsciiMichelinNameSearchQuery(normalizedQuery)) {
    return [];
  }

  return index
    .filter((restaurant) => restaurant.lowerName.includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((restaurant) => restaurant.id);
}

export function assertMichelinNameSearchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MICHELIN_NAME_SEARCH_RESULTS) {
    throw new RangeError(`Michelin search limit must be an integer between 1 and ${MAX_MICHELIN_NAME_SEARCH_RESULTS}`);
  }
}

export function assertMichelinNameSearchNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("Michelin restaurant search was cancelled");
}

interface StableMichelinNameSearchOptions<TIndex, TResult> {
  readonly signal?: AbortSignal;
  readonly readDatasetVersion: () => Promise<string | null>;
  readonly loadIndex: (datasetVersion: string | null) => Promise<TIndex>;
  readonly selectMatchingIds: (index: TIndex) => readonly string[];
  readonly hydrateMatchingIds: (ids: readonly string[]) => Promise<TResult>;
  readonly onDatasetChanged?: (previousVersion: string | null, nextVersion: string | null) => void | Promise<void>;
}

/**
 * Optimistically read against one immutable dataset version, then validate the
 * version after hydration. A refresh can reuse IDs for renamed restaurants, so
 * a mismatched attempt must never publish its hydrated rows.
 */
export async function runStableMichelinNameSearch<TIndex, TResult>(
  options: StableMichelinNameSearchOptions<TIndex, TResult>,
): Promise<TResult> {
  for (let attempt = 0; attempt < MAX_MICHELIN_NAME_SEARCH_DATASET_ATTEMPTS; attempt += 1) {
    assertMichelinNameSearchNotAborted(options.signal);
    const versionBefore = await options.readDatasetVersion();
    assertMichelinNameSearchNotAborted(options.signal);
    const index = await options.loadIndex(versionBefore);
    assertMichelinNameSearchNotAborted(options.signal);
    const matchingIds = options.selectMatchingIds(index);
    assertMichelinNameSearchNotAborted(options.signal);
    const result = await options.hydrateMatchingIds(matchingIds);
    assertMichelinNameSearchNotAborted(options.signal);
    const versionAfter = await options.readDatasetVersion();
    assertMichelinNameSearchNotAborted(options.signal);

    if (versionBefore === versionAfter) {
      return result;
    }

    await options.onDatasetChanged?.(versionBefore, versionAfter);
    assertMichelinNameSearchNotAborted(options.signal);
  }

  throw new Error(
    `Michelin dataset changed during ${MAX_MICHELIN_NAME_SEARCH_DATASET_ATTEMPTS} consecutive search attempts`,
  );
}
