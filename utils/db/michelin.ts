import { getDatabase } from "./core";
import { invalidateRestaurantIndex } from "./michelin-index";
import {
  ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL,
  ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL,
  parseMichelinCalendarHydrationRows,
  selectMichelinCalendarHydrationIds,
  type MichelinCalendarHydrationRow,
  type MichelinCalendarNameRow,
} from "./michelin-calendar-match-core";
import {
  buildMichelinProviderSpatialQueryPlans,
  ensureInvalidatedMichelinProviderSpatialIndex,
  groupMichelinProviderSpatialCandidates,
  isValidMichelinProviderSpatialCoordinate,
  MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL,
  type MichelinProviderSpatialCandidate,
  type MichelinProviderSpatialCandidateRow,
  type MichelinProviderSpatialInput,
} from "./michelin-provider-spatial-core";
import type { MichelinRestaurantRecord } from "./types";

const MICHELIN_DATASET_VERSION_KEY = "michelin_dataset_version";
const MAX_MICHELIN_NAME_SEARCH_RESULTS = 50;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// Michelin restaurant operations
export async function insertMichelinRestaurants(
  restaurants: MichelinRestaurantRecord[],
  datasetVersion: string,
): Promise<void> {
  if (restaurants.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (let i = 0; i < restaurants.length; i += batchSize) {
      const batch = restaurants.slice(i, i + batchSize);
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const values = batch.flatMap((restaurant) => [
        restaurant.id,
        restaurant.name,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.address,
        restaurant.location,
        restaurant.cuisine,
        restaurant.latestAwardYear,
        restaurant.award,
        datasetVersion,
      ]);

      await transaction.runAsync(
        `INSERT INTO michelin_restaurants
           (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
         VALUES ${placeholders}
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           address = excluded.address,
           location = excluded.location,
           cuisine = excluded.cuisine,
           latestAwardYear = excluded.latestAwardYear,
           award = excluded.award,
           datasetVersion = excluded.datasetVersion`,
        values,
      );
    }

    // Keep rows that disappeared from the latest guide. Confirmed visits and old
    // suggestions still reference them, and deleting them would erase historical
    // Michelin attribution. Current search/index queries filter by datasetVersion.
    await transaction.runAsync(
      `INSERT INTO app_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [MICHELIN_DATASET_VERSION_KEY, datasetVersion],
    );
  });

  // Invalidate spatial index so it rebuilds with new data
  invalidateRestaurantIndex();
}

export async function getImportedMichelinDatasetVersion(): Promise<string | null> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ value: string }>(`SELECT value FROM app_metadata WHERE key = ?`, [
    MICHELIN_DATASET_VERSION_KEY,
  ]);
  return result?.value ?? null;
}

export async function getMichelinRestaurantCount(datasetVersion?: string): Promise<number> {
  const database = await getDatabase();
  const result = datasetVersion
    ? await database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) as count FROM michelin_restaurants WHERE datasetVersion = ?`,
        [datasetVersion],
      )
    : await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM michelin_restaurants`);
  return result?.count ?? 0;
}

export async function getAllMichelinRestaurants(): Promise<MichelinRestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<MichelinRestaurantRecord>(
    `SELECT m.*
     FROM michelin_restaurants m
     WHERE NOT EXISTS (
       SELECT 1 FROM app_metadata WHERE key = ?
     ) OR m.datasetVersion = (
       SELECT value FROM app_metadata WHERE key = ?
     )`,
    [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY],
  );
}

/**
 * Loads only the guide rows that can satisfy located provider matching. Every
 * candidate query and the unique-ID hydration share one dedicated deferred
 * read snapshot so a concurrent guide refresh cannot mix dataset versions.
 */
export interface MichelinProviderSpatialSelection<Value> {
  readonly restaurantId: string;
  readonly value: Value;
}

export interface MichelinProviderHydratedSelection<Value> {
  readonly restaurant: MichelinRestaurantRecord;
  readonly value: Value;
}

export async function selectMichelinProviderSpatialCandidates<Value>(
  inputs: readonly MichelinProviderSpatialInput[],
  select: (
    candidates: readonly MichelinProviderSpatialCandidate[],
    inputIndex: number,
  ) => MichelinProviderSpatialSelection<Value> | null,
): Promise<Array<MichelinProviderHydratedSelection<Value> | null>> {
  const output = Array.from({ length: inputs.length }, () => null as MichelinProviderHydratedSelection<Value> | null);
  const validInputs: MichelinProviderSpatialInput[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    if (!isValidMichelinProviderSpatialCoordinate(input.latitude, input.longitude)) {
      continue;
    }
    validInputs.push(input);
    originalIndices.push(index);
  }
  if (validInputs.length === 0) {
    return output;
  }

  const database = await getDatabase();
  await ensureInvalidatedMichelinProviderSpatialIndex(database);
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const candidateRows: MichelinProviderSpatialCandidateRow[] = [];
    for (const plan of buildMichelinProviderSpatialQueryPlans(validInputs)) {
      candidateRows.push(
        ...(await transaction.getAllAsync<MichelinProviderSpatialCandidateRow>(plan.sql, [...plan.parameters])),
      );
    }
    const lightweightGroups = groupMichelinProviderSpatialCandidates(candidateRows, validInputs.length);
    const selections = lightweightGroups.map((group, validIndex) => {
      const selection = select(group, originalIndices[validIndex]!);
      if (selection && !group.some(({ id }) => id === selection.restaurantId)) {
        throw new Error(`Provider Michelin selector returned id ${selection.restaurantId} outside its candidate group`);
      }
      return selection;
    });
    const selectedIds = [...new Set(selections.flatMap((selection) => (selection ? [selection.restaurantId] : [])))];
    if (selectedIds.length === 0) {
      return;
    }

    const hydrated = await transaction.getAllAsync<MichelinRestaurantRecord>(MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL, [
      JSON.stringify(selectedIds),
      MICHELIN_DATASET_VERSION_KEY,
      MICHELIN_DATASET_VERSION_KEY,
    ]);
    if (hydrated.length !== selectedIds.length) {
      throw new Error(
        `Provider Michelin hydration returned ${hydrated.length} of ${selectedIds.length} selected guide rows`,
      );
    }
    const hydratedById = new Map(hydrated.map((restaurant) => [restaurant.id, restaurant]));
    for (let validIndex = 0; validIndex < selections.length; validIndex++) {
      const selection = selections[validIndex];
      if (!selection) {
        continue;
      }
      const restaurant = hydratedById.get(selection.restaurantId);
      if (!restaurant) {
        throw new Error(`Provider Michelin hydration omitted selected id ${selection.restaurantId}`);
      }
      output[originalIndices[validIndex]!] = { restaurant, value: selection.value };
    }
  });
  return output;
}

/**
 * Loads only active guide restaurants that can match one of the supplied
 * normalized Calendar names. The name scan and selective hydration share one
 * dedicated SQLite read transaction, so a concurrent guide refresh cannot mix
 * rows from different dataset snapshots.
 */
export async function getMichelinRestaurantsForCalendarNormalizedNames(
  requestedNormalizedNames: ReadonlySet<string>,
  normalizeRestaurantName: (name: string) => string,
): Promise<MichelinRestaurantRecord[]> {
  if (requestedNormalizedNames.size === 0) {
    return [];
  }

  const database = await getDatabase();
  let restaurants: MichelinRestaurantRecord[] = [];

  // Expo 57's dedicated transaction implementation issues a deferred `BEGIN`,
  // not BEGIN IMMEDIATE/EXCLUSIVE. This SELECT-only callback therefore reserves
  // no WAL writer; keep it short because its read snapshot can retain WAL frames
  // until name normalization and selective hydration finish.
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const nameRows = await transaction.getAllAsync<MichelinCalendarNameRow>(ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL, [
      MICHELIN_DATASET_VERSION_KEY,
      MICHELIN_DATASET_VERSION_KEY,
    ]);
    const hydrationIds = selectMichelinCalendarHydrationIds(
      nameRows,
      requestedNormalizedNames,
      normalizeRestaurantName,
    );
    if (hydrationIds.length === 0) {
      return;
    }

    const hydratedRows = await transaction.getAllAsync<MichelinCalendarHydrationRow>(
      ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL,
      [JSON.stringify(hydrationIds), MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY],
    );
    if (hydratedRows.length !== hydrationIds.length) {
      throw new Error(
        `Calendar Michelin hydration returned ${hydratedRows.length} of ${hydrationIds.length} active guide rows`,
      );
    }
    restaurants = parseMichelinCalendarHydrationRows(hydratedRows);
  });

  return restaurants;
}

/**
 * Search the active Michelin dataset without transferring the full guide to JS.
 * Confirmed restaurants are excluded in SQL before applying the result cap so
 * visited matches cannot crowd unvisited results out of the first page.
 */
export async function searchUnvisitedMichelinRestaurantsByName(
  query: string,
  limit: number = MAX_MICHELIN_NAME_SEARCH_RESULTS,
): Promise<MichelinRestaurantRecord[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MICHELIN_NAME_SEARCH_RESULTS) {
    throw new RangeError(`Michelin search limit must be an integer between 1 and ${MAX_MICHELIN_NAME_SEARCH_RESULTS}`);
  }

  const database = await getDatabase();
  const normalizedSearchText = normalizedQuery.toLowerCase();

  // SQLite's built-in NOCASE collation only folds ASCII. Preserve the prior
  // Unicode-aware JS search semantics for explicit non-ASCII queries without
  // paying the full-guide bridge cost during app startup or ordinary searches.
  if (/[^\u0000-\u007f]/.test(normalizedSearchText)) {
    const candidates = await database.getAllAsync<MichelinRestaurantRecord>(
      `SELECT m.*
       FROM michelin_restaurants m
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
         )`,
      [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY],
    );

    return candidates
      .filter((restaurant) => restaurant.name.toLowerCase().includes(normalizedSearchText))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  const escapedPattern = `%${escapeLikePattern(normalizedQuery)}%`;

  return database.getAllAsync<MichelinRestaurantRecord>(
    `SELECT m.*
     FROM michelin_restaurants m
     WHERE (
       NOT EXISTS (
         SELECT 1 FROM app_metadata WHERE key = ?
       ) OR m.datasetVersion = (
         SELECT value FROM app_metadata WHERE key = ?
       )
     )
       AND m.name COLLATE NOCASE LIKE ? ESCAPE '\\'
       AND NOT EXISTS (
         SELECT 1
         FROM visits v
         WHERE v.restaurantId = m.id AND v.status = 'confirmed'
       )
     ORDER BY m.name COLLATE NOCASE ASC, m.name ASC, m.id ASC
     LIMIT ?`,
    [MICHELIN_DATASET_VERSION_KEY, MICHELIN_DATASET_VERSION_KEY, escapedPattern, limit],
  );
}

export async function getMichelinRestaurantById(id: string): Promise<MichelinRestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants WHERE id = ?`, [id]);
}
