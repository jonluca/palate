import { getDatabase } from "./core";
import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import { invalidateRestaurantIndex } from "./michelin-index";
import {
  ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  MICHELIN_DATASET_VERSION_KEY,
  MICHELIN_IMPORT_ATTACH_STRATEGY,
  MICHELIN_IMPORT_ATTESTATION_KEY,
  MICHELIN_IMPORT_LEGACY_STRATEGY,
  MICHELIN_IMPORT_METADATA_UPSERT_SQL,
  MICHELIN_IMPORT_REQUEST_KEY,
  MichelinImportTerminalError,
  NO_VALID_MICHELIN_ROWS_MESSAGE,
  parseMichelinImportValidationRequest,
  resolveMichelinImportStrategy,
  serializeMichelinImportAttestation,
  type MichelinImportResolution,
  type MichelinImportResult,
  type MichelinImportSourceDescriptor,
} from "./michelin-import-core";
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
import {
  selectMichelinMapViewport as selectMichelinMapViewportCore,
  type MichelinMapViewportRequest,
  type MichelinMapViewportSelection,
} from "./michelin-map-viewport-core";
import {
  ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL,
  HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL,
  MAX_MICHELIN_NAME_SEARCH_RESULTS,
  assertMichelinNameSearchLimit,
  assertMichelinNameSearchNotAborted,
  createMichelinUnicodeNameIndex,
  isNonAsciiMichelinNameSearchQuery,
  normalizeMichelinNameSearchQuery,
  runStableMichelinNameSearch,
  selectSortedMichelinUnicodeMatchIds,
  type MichelinUnicodeNameRow,
} from "./michelin-name-search-core";
import type { MichelinRestaurantRecord } from "./types";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// Michelin restaurant operations
export async function insertMichelinRestaurants(
  restaurants: MichelinRestaurantRecord[],
  datasetVersion: string,
  resolution: MichelinImportResolution,
  sourceRows: number,
): Promise<MichelinImportResult> {
  if (restaurants.length === 0) {
    throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
  }
  if (
    resolution.resolvedStrategy !== MICHELIN_IMPORT_LEGACY_STRATEGY ||
    !Number.isSafeInteger(sourceRows) ||
    sourceRows < 0
  ) {
    throw new Error("Invalid legacy Michelin import request");
  }

  const database = await getDatabase();
  const batchSize = 1000;
  const importedRows = restaurants.length;
  const attestation = serializeMichelinImportAttestation({
    schemaVersion: 1,
    ...resolution,
    selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    datasetVersion,
    sourceRows,
    importedRows,
    observedAtEpochSeconds: Math.floor(Date.now() / 1000),
  });
  let writeMayHaveOccurred = false;

  try {
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

        writeMayHaveOccurred = true;
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
      await transaction.runAsync(MICHELIN_IMPORT_METADATA_UPSERT_SQL, [MICHELIN_DATASET_VERSION_KEY, datasetVersion]);
      await transaction.runAsync(MICHELIN_IMPORT_METADATA_UPSERT_SQL, [MICHELIN_IMPORT_ATTESTATION_KEY, attestation]);
    });
  } catch (error) {
    if (writeMayHaveOccurred) {
      invalidateRestaurantIndex();
      throw new MichelinImportTerminalError("Legacy Michelin import failed after write dispatch", error);
    }
    throw error;
  }

  // Invalidate spatial index so it rebuilds with new data
  invalidateRestaurantIndex();
  return { importedRows, sourceRows, strategy: MICHELIN_IMPORT_LEGACY_STRATEGY };
}

export async function getMichelinImportResolution(
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): Promise<MichelinImportResolution> {
  const database = await getDatabase();
  const requestRow = await database.getFirstAsync<{ value: string }>(`SELECT value FROM app_metadata WHERE key = ?`, [
    MICHELIN_IMPORT_REQUEST_KEY,
  ]);

  let sqliteUriAvailable = false;
  if (Platform.OS !== "web") {
    try {
      const capability = await database.getFirstAsync<{ enabled: number }>(
        `SELECT sqlite_compileoption_used(?) AS enabled`,
        ["USE_URI"],
      );
      sqliteUriAvailable = capability?.enabled === 1;
    } catch {
      // Older SQLite builds safely stay on the legacy importer.
    }
  }

  return resolveMichelinImportStrategy(
    parseMichelinImportValidationRequest(requestRow?.value, nowEpochSeconds),
    sqliteUriAvailable,
  );
}

async function openDedicatedMichelinImportConnection(): Promise<SQLite.SQLiteDatabase> {
  const mainDatabase = await getDatabase();
  const separatorIndex = mainDatabase.databasePath.lastIndexOf("/");
  if (separatorIndex <= 0 || separatorIndex === mainDatabase.databasePath.length - 1) {
    throw new Error("Main database path cannot be opened as a dedicated connection");
  }
  return SQLite.openDatabaseAsync(
    mainDatabase.databasePath.slice(separatorIndex + 1),
    {
      ...mainDatabase.options,
      enableChangeListener: false,
      useNewConnection: true,
      finalizeUnusedStatementsBeforeClosing: false,
    },
    mainDatabase.databasePath.slice(0, separatorIndex),
  );
}

function assertSafeMichelinSource(source: MichelinImportSourceDescriptor): void {
  const requiredUriSuffix = "?mode=ro&immutable=1&cache=private";
  const sourcePath = source.immutableReadOnlyUri.endsWith(requiredUriSuffix)
    ? source.immutableReadOnlyUri.slice(0, -requiredUriSuffix.length)
    : "";
  if (
    source.datasetVersion.length === 0 ||
    source.datasetVersion.includes("\0") ||
    !sourcePath.startsWith("file:") ||
    sourcePath.length <= "file:".length ||
    /[?#]/.test(sourcePath) ||
    /[\0\r\n]/.test(source.immutableReadOnlyUri)
  ) {
    throw new Error("Invalid Michelin import source descriptor");
  }
}

/**
 * Import the guide entirely inside SQLite. Once this strategy is selected, any
 * error is terminal for the process: replaying the legacy importer after an
 * ambiguous COMMIT could duplicate expensive work or expose mixed state.
 */
export async function importMichelinRestaurantsFromAttachedSource(
  source: MichelinImportSourceDescriptor,
  resolution: MichelinImportResolution,
): Promise<MichelinImportResult> {
  if (resolution.resolvedStrategy !== MICHELIN_IMPORT_ATTACH_STRATEGY) {
    throw new Error("ATTACH Michelin importer was invoked for a different strategy");
  }

  let database: SQLite.SQLiteDatabase | null = null;
  let attached = false;
  let transactionOpen = false;
  let writeMayHaveOccurred = false;
  let committed = false;
  let sourceRows = 0;
  let importedRows = 0;

  try {
    assertSafeMichelinSource(source);
    database = await openDedicatedMichelinImportConnection();
    await database.execAsync(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -128000;
      PRAGMA mmap_size = 268435456;
    `);
    await database.runAsync(`ATTACH DATABASE ? AS michelin_source`, [source.immutableReadOnlyUri]);
    attached = true;

    const schema = await database.getFirstAsync<{ tableCount: number }>(
      `SELECT COUNT(*) AS tableCount
       FROM michelin_source.sqlite_schema
       WHERE type = 'table' AND name IN ('restaurants', 'restaurant_awards')`,
    );
    if (schema?.tableCount !== 2) {
      throw new Error("Michelin reference database schema is incomplete");
    }
    const count = await database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM michelin_source.restaurants`,
    );
    sourceRows = count?.count ?? 0;
    if (!Number.isSafeInteger(sourceRows) || sourceRows <= 0) {
      throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
    }

    await database.execAsync("BEGIN IMMEDIATE");
    transactionOpen = true;
    writeMayHaveOccurred = true;
    const insertResult = await database.runAsync(ATTACHED_MICHELIN_INSERT_SELECT_SQL, [source.datasetVersion]);
    importedRows = insertResult.changes;
    if (!Number.isSafeInteger(importedRows) || importedRows <= 0) {
      throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
    }

    const attestation = serializeMichelinImportAttestation({
      schemaVersion: 1,
      ...resolution,
      selectedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
      datasetVersion: source.datasetVersion,
      sourceRows,
      importedRows,
      observedAtEpochSeconds: Math.floor(Date.now() / 1000),
    });
    await database.runAsync(MICHELIN_IMPORT_METADATA_UPSERT_SQL, [MICHELIN_DATASET_VERSION_KEY, source.datasetVersion]);
    await database.runAsync(MICHELIN_IMPORT_METADATA_UPSERT_SQL, [MICHELIN_IMPORT_ATTESTATION_KEY, attestation]);
    await database.execAsync("COMMIT");
    transactionOpen = false;
    committed = true;
  } catch (error) {
    if (transactionOpen) {
      try {
        await database?.execAsync("ROLLBACK");
      } catch {
        // Preserve the original failure; the terminal error forbids replay.
      }
      transactionOpen = false;
    }
    if (attached) {
      try {
        await database?.execAsync("DETACH DATABASE michelin_source");
      } catch {
        // Closing below is the final cleanup attempt.
      }
      attached = false;
    }
    try {
      await database?.closeAsync();
    } catch {
      // The operation is terminal regardless of cleanup outcome.
    }
    if (writeMayHaveOccurred) {
      invalidateRestaurantIndex();
    }
    throw new MichelinImportTerminalError("Set-based Michelin import failed", error);
  }

  if (committed) {
    const cleanupErrors: unknown[] = [];
    try {
      await database.execAsync("DETACH DATABASE michelin_source");
      attached = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await database.closeAsync();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      invalidateRestaurantIndex();
      throw new MichelinImportTerminalError(
        "Set-based Michelin import committed but its connection did not close cleanly",
        cleanupErrors,
      );
    }
  }

  invalidateRestaurantIndex();
  return { importedRows, sourceRows, strategy: MICHELIN_IMPORT_ATTACH_STRATEGY };
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
 * Select only the active guide rows that can be rendered in the current map
 * viewport. Filtering and the bounded ranking prefix run inside SQLite over
 * the persistent R-Tree; JavaScript receives only the final tie group and
 * applies the existing locale-aware ordering before returning at most 500 rows.
 */
export async function getMichelinMapViewport(
  request: MichelinMapViewportRequest,
): Promise<MichelinMapViewportSelection> {
  const database = await getDatabase();
  await ensureInvalidatedMichelinProviderSpatialIndex(database);
  return selectMichelinMapViewportCore(
    {
      getAllAsync: (source, parameters) => database.getAllAsync(source, [...parameters]),
      withReadTransaction: async (task) => {
        let completed = false;
        let result: Awaited<ReturnType<typeof task>> | undefined;
        if (Platform.OS === "web") {
          // Expo does not expose a dedicated exclusive connection on web.
          // This fallback preserves the unsupported-map screen's List mode,
          // but unrelated web queries may share its deferred transaction.
          await database.withTransactionAsync(async () => {
            result = await task({
              getAllAsync: (source, parameters) => database.getAllAsync(source, [...parameters]),
            });
            completed = true;
          });
          if (!completed) {
            throw new Error("Michelin map viewport web read transaction did not complete");
          }
          return result as Awaited<ReturnType<typeof task>>;
        }
        await database.withExclusiveTransactionAsync(async (transaction) => {
          result = await task({
            getAllAsync: (source, parameters) => transaction.getAllAsync(source, [...parameters]),
          });
          completed = true;
        });
        if (!completed) {
          throw new Error("Michelin map viewport read transaction did not complete");
        }
        return result as Awaited<ReturnType<typeof task>>;
      },
    },
    request,
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
  signal?: AbortSignal,
): Promise<MichelinRestaurantRecord[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }
  assertMichelinNameSearchLimit(limit);
  assertMichelinNameSearchNotAborted(signal);

  const normalizedSearchText = normalizeMichelinNameSearchQuery(normalizedQuery);

  if (isNonAsciiMichelinNameSearchQuery(normalizedSearchText)) {
    return runStableMichelinNameSearch({
      signal,
      readDatasetVersion: getImportedMichelinDatasetVersion,
      loadIndex: async () => createMichelinUnicodeNameIndex(await getActiveMichelinUnicodeNameRows()),
      selectMatchingIds: (index) => selectSortedMichelinUnicodeMatchIds(index, normalizedSearchText),
      hydrateMatchingIds: (ids) => hydrateUnvisitedMichelinNameSearchIds(ids, limit),
    });
  }

  const database = await getDatabase();
  assertMichelinNameSearchNotAborted(signal);
  const escapedPattern = `%${escapeLikePattern(normalizedQuery)}%`;

  const result = await database.getAllAsync<MichelinRestaurantRecord>(
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
  assertMichelinNameSearchNotAborted(signal);
  return result;
}

export async function getActiveMichelinUnicodeNameRows(): Promise<MichelinUnicodeNameRow[]> {
  const database = await getDatabase();
  return database.getAllAsync<MichelinUnicodeNameRow>(ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL, [
    MICHELIN_DATASET_VERSION_KEY,
    MICHELIN_DATASET_VERSION_KEY,
  ]);
}

export async function hydrateUnvisitedMichelinNameSearchIds(
  sortedMatchingIds: readonly string[],
  limit: number = MAX_MICHELIN_NAME_SEARCH_RESULTS,
): Promise<MichelinRestaurantRecord[]> {
  assertMichelinNameSearchLimit(limit);
  if (sortedMatchingIds.length === 0) {
    return [];
  }

  const database = await getDatabase();
  return database.getAllAsync<MichelinRestaurantRecord>(HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL, [
    JSON.stringify(sortedMatchingIds),
    MICHELIN_DATASET_VERSION_KEY,
    MICHELIN_DATASET_VERSION_KEY,
    limit,
  ]);
}

export async function getMichelinRestaurantById(id: string): Promise<MichelinRestaurantRecord | null> {
  const database = await getDatabase();
  return database.getFirstAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants WHERE id = ?`, [id]);
}
