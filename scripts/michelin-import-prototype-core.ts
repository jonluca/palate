/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  MICHELIN_DATASET_VERSION_KEY,
  MICHELIN_IMPORT_METADATA_UPSERT_SQL,
  NO_VALID_MICHELIN_ROWS_MESSAGE,
} from "../utils/db/michelin-import-core.ts";
import { MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL } from "../utils/db/michelin-provider-spatial-core.ts";

export const CURRENT_MICHELIN_IMPORT_BATCH_SIZE = 1000;
export const IMPORT_FAILURE_MESSAGE = "Injected Michelin import failure after restaurant rows";
export { ATTACHED_MICHELIN_INSERT_SELECT_SQL, MICHELIN_DATASET_VERSION_KEY, NO_VALID_MICHELIN_ROWS_MESSAGE };

const SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export type MichelinImportStrategy = "currentJsOracle" | "attachInsertSelect";
export type ImportFailurePoint = "afterRowsBeforeMetadata";

export interface FileSnapshot {
  readonly present: boolean;
  readonly bytes: number | null;
  readonly device: number | null;
  readonly inode: number | null;
  readonly mode: number | null;
  readonly sha256: string | null;
}

export interface SqliteSourceSnapshot {
  readonly main: FileSnapshot;
  readonly wal: FileSnapshot;
  readonly shm: FileSnapshot;
  readonly journal: FileSnapshot;
}

export interface ImportPhaseDurations {
  sourceConnect: number;
  sourceRead: number;
  transform: number;
  destinationWrite: number;
  sourceDisconnect: number;
  total: number;
}

export interface BridgeModel {
  /** Rows materialized from the reference database into JavaScript. */
  readonly sourceResultRows: number;
  /** UTF-8 bytes of JSON.stringify over those result rows; not measured JSI bytes. */
  readonly sourceResultUtf8Bytes: number;
  /** Calls that bind parameters from JavaScript into SQLite. */
  readonly bindCalls: number;
  /** Individual values bound across those calls. */
  readonly boundValues: number;
}

export interface StatementModel {
  /** SQL statements excluding BEGIN/COMMIT/ROLLBACK. */
  readonly statements: number;
  readonly transactionControlStatements: number;
  readonly transactions: number;
}

export interface ImportMeasurement {
  readonly strategy: MichelinImportStrategy;
  readonly sourceRestaurantRows: number;
  readonly sourceSelectedRows: number;
  readonly importedRowChanges: number;
  readonly bridge: BridgeModel;
  readonly sqlite: StatementModel;
  readonly phasesMilliseconds: ImportPhaseDurations;
}

export interface DestinationRows {
  readonly restaurants: readonly Record<string, unknown>[];
  readonly metadata: readonly Record<string, unknown>[];
  readonly spatial: readonly Record<string, unknown>[];
}

export interface DestinationDigest {
  readonly restaurantRows: number;
  readonly restaurantSha256: string;
  readonly metadataRows: number;
  readonly metadataSha256: string;
  readonly spatialRows: number;
  readonly spatialSha256: string;
  readonly fullTableSha256: string;
}

interface SourceRestaurantRow {
  readonly id: number | string;
  readonly name: string | null;
  readonly latitude: number | string | null;
  readonly longitude: number | string | null;
  readonly address: string | null;
  readonly location: string | null;
  readonly cuisine: string | null;
  readonly latest_distinction: string | null;
  readonly latest_year: number | null;
  readonly has_green_star: number | string | Uint8Array | null;
}

interface ImportedRestaurant {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly location: string | null;
  readonly cuisine: string | null;
  readonly latestAwardYear: number | null;
  readonly award: string;
}

interface CountRow {
  readonly count: number;
}

export interface ImportOptions {
  readonly failurePoint?: ImportFailurePoint;
}

export const DESTINATION_SCHEMA_SQL = `
CREATE TABLE michelin_restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  cuisine TEXT NOT NULL DEFAULT '',
  latestAwardYear INTEGER,
  award TEXT NOT NULL DEFAULT '',
  datasetVersion TEXT
);

CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_michelin_location ON michelin_restaurants(latitude, longitude);
${MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL}`;

/** Exact result shape and join used by loadMichelinRestaurants(). */
export const CURRENT_MICHELIN_SOURCE_ROWS_SQL = `
SELECT
  r.*,
  a.distinction as latest_distinction,
  a.year as latest_year,
  a.green_star as has_green_star
FROM restaurants r
LEFT JOIN (
  SELECT ra.*
  FROM restaurant_awards ra
  INNER JOIN (
    SELECT restaurant_id, MAX(year) as max_year
    FROM restaurant_awards
    GROUP BY restaurant_id
  ) latest ON ra.restaurant_id = latest.restaurant_id AND ra.year = latest.max_year
) a ON r.id = a.restaurant_id
WHERE r.latitude IS NOT NULL
  AND r.longitude IS NOT NULL
  AND r.latitude != ''
  AND r.longitude != ''`;

const UPSERT_ASSIGNMENTS_SQL = `
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  address = excluded.address,
  location = excluded.location,
  cuisine = excluded.cuisine,
  latestAwardYear = excluded.latestAwardYear,
  award = excluded.award,
  datasetVersion = excluded.datasetVersion`;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { present: false, bytes: null, device: null, inode: null, mode: null, sha256: null };
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`SQLite component must be a regular non-symlink file: ${path}`);
  }
  return {
    present: true,
    bytes: metadata.size,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o7777,
    sha256: sha256(readFileSync(path)),
  };
}

export function snapshotSqliteSource(sourcePath: string): SqliteSourceSnapshot {
  return {
    main: fileSnapshot(sourcePath),
    wal: fileSnapshot(`${sourcePath}-wal`),
    shm: fileSnapshot(`${sourcePath}-shm`),
    journal: fileSnapshot(`${sourcePath}-journal`),
  };
}

export function assertSqliteSourceUnchanged(
  before: SqliteSourceSnapshot,
  sourcePath: string,
  context: string,
): SqliteSourceSnapshot {
  const after = snapshotSqliteSource(sourcePath);
  assert.deepEqual(after, before, `${context} mutated a protected source SQLite component`);
  return after;
}

function presentIdentities(snapshot: SqliteSourceSnapshot): Set<string> {
  const identities = new Set<string>();
  for (const component of Object.values(snapshot)) {
    if (!component.present) {
      continue;
    }
    const identity = `${component.device}:${component.inode}`;
    if (identities.has(identity)) {
      throw new Error("Protected SQLite source components alias the same inode");
    }
    identities.add(identity);
  }
  return identities;
}

export function resolveProtectedSourcePath(sourcePath: string): string {
  const unresolved = resolve(sourcePath);
  const sourceMetadata = lstatSync(unresolved);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error("Source database must be a regular non-symlink file");
  }
  if (sourceMetadata.nlink !== 1) {
    throw new Error("Source database must not have hard-link aliases");
  }
  const canonical = realpathSync(unresolved);
  const snapshot = snapshotSqliteSource(canonical);
  if (!snapshot.main.present) {
    throw new Error("Source database does not exist");
  }
  for (const suffix of SIDECAR_SUFFIXES.slice(1)) {
    const componentPath = `${canonical}${suffix}`;
    if (existsSync(componentPath) && statSync(componentPath).nlink !== 1) {
      throw new Error(`Source SQLite sidecar must not have hard-link aliases: ${suffix}`);
    }
  }
  presentIdentities(snapshot);
  return canonical;
}

export function assertMutableDatabaseDoesNotAliasSource(sourcePath: string, destinationPath: string): void {
  const source = snapshotSqliteSource(sourcePath);
  const sourceIdentities = presentIdentities(source);
  for (const suffix of SIDECAR_SUFFIXES) {
    const candidatePath = `${destinationPath}${suffix}`;
    if (!existsSync(candidatePath)) {
      continue;
    }
    const candidate = fileSnapshot(candidatePath);
    if (sourceIdentities.has(`${candidate.device}:${candidate.inode}`)) {
      throw new Error("Mutable destination SQLite component aliases a protected source component");
    }
    if (
      existsSync(`${sourcePath}${suffix}`) &&
      realpathSync(candidatePath) === realpathSync(`${sourcePath}${suffix}`)
    ) {
      throw new Error("Mutable destination SQLite path aliases a protected source component");
    }
  }
}

export function immutableSqliteUri(sourcePath: string): string {
  return `${pathToFileURL(sourcePath).href}?mode=ro&immutable=1`;
}

export function openDestinationDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    PRAGMA wal_autocheckpoint = 0;
    ${DESTINATION_SCHEMA_SQL}
  `);
  return database;
}

function parseCurrentRestaurant(row: SourceRestaurantRow): ImportedRestaurant | null {
  const latitude = Number.parseFloat(String(row.latitude));
  const longitude = Number.parseFloat(String(row.longitude));
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  let award: string = row.latest_distinction ?? "";
  if (row.has_green_star) {
    award = award ? `${String(award)}, Green Star` : "Green Star";
  }
  return {
    id: `michelin-${String(row.id)}`,
    name: row.name ?? "",
    latitude,
    longitude,
    address: row.address,
    location: row.location,
    cuisine: row.cuisine,
    latestAwardYear: row.latest_year,
    award,
  };
}

function begin(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
}

function commit(database: DatabaseSync): void {
  database.exec("COMMIT");
}

function rollback(database: DatabaseSync): void {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
}

function metadataUpsert(database: DatabaseSync, datasetVersion: string): void {
  database.prepare(MICHELIN_IMPORT_METADATA_UPSERT_SQL).run(MICHELIN_DATASET_VERSION_KEY, datasetVersion);
}

function emptyPhases(): ImportPhaseDurations {
  return {
    sourceConnect: 0,
    sourceRead: 0,
    transform: 0,
    destinationWrite: 0,
    sourceDisconnect: 0,
    total: 0,
  };
}

export function runCurrentJsOracleImport(
  destination: DatabaseSync,
  sourcePath: string,
  datasetVersion: string,
  options: ImportOptions = {},
): ImportMeasurement {
  const protectedSource = resolveProtectedSourcePath(sourcePath);
  const destinationPath = destination.location();
  if (destinationPath === null) {
    throw new Error("Michelin import prototype requires a file-backed disposable destination");
  }
  assertMutableDatabaseDoesNotAliasSource(protectedSource, destinationPath);
  const sourceBefore = snapshotSqliteSource(protectedSource);
  const phases = emptyPhases();
  const totalStarted = performance.now();
  let source: DatabaseSync | null = null;
  let sourceRestaurantRows = 0;
  let sourceRows: SourceRestaurantRow[] = [];
  let restaurants: ImportedRestaurant[] = [];
  let importedRowChanges = 0;

  try {
    let phaseStarted = performance.now();
    source = new DatabaseSync(immutableSqliteUri(protectedSource), { readOnly: true });
    phases.sourceConnect = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const countRow = source.prepare("SELECT COUNT(*) AS count FROM restaurants").get() as unknown as CountRow;
    sourceRestaurantRows = countRow.count;
    sourceRows = source.prepare(CURRENT_MICHELIN_SOURCE_ROWS_SQL).all() as unknown as SourceRestaurantRow[];
    phases.sourceRead = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    restaurants = [];
    for (const row of sourceRows) {
      const restaurant = parseCurrentRestaurant(row);
      if (restaurant !== null) {
        restaurants.push(restaurant);
      }
    }
    phases.transform = performance.now() - phaseStarted;

    if (restaurants.length === 0) {
      throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
    }

    phaseStarted = performance.now();
    begin(destination);
    try {
      for (let index = 0; index < restaurants.length; index += CURRENT_MICHELIN_IMPORT_BATCH_SIZE) {
        const batch = restaurants.slice(index, index + CURRENT_MICHELIN_IMPORT_BATCH_SIZE);
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
        importedRowChanges += Number(
          destination
            .prepare(`INSERT INTO michelin_restaurants
            (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
            VALUES ${placeholders}
            ON CONFLICT(id) DO UPDATE SET${UPSERT_ASSIGNMENTS_SQL}`)
            .run(...values).changes,
        );
      }
      if (options.failurePoint === "afterRowsBeforeMetadata") {
        throw new Error(IMPORT_FAILURE_MESSAGE);
      }
      metadataUpsert(destination, datasetVersion);
      commit(destination);
    } catch (error) {
      rollback(destination);
      throw error;
    }
    phases.destinationWrite = performance.now() - phaseStarted;
  } finally {
    const phaseStarted = performance.now();
    source?.close();
    phases.sourceDisconnect = performance.now() - phaseStarted;
    phases.total = performance.now() - totalStarted;
    assertSqliteSourceUnchanged(sourceBefore, protectedSource, "Current JS oracle import");
  }

  const insertionStatements = Math.ceil(restaurants.length / CURRENT_MICHELIN_IMPORT_BATCH_SIZE);
  return {
    strategy: "currentJsOracle",
    sourceRestaurantRows,
    sourceSelectedRows: sourceRows.length,
    importedRowChanges,
    bridge: {
      sourceResultRows: sourceRows.length + 1,
      sourceResultUtf8Bytes:
        Buffer.byteLength(JSON.stringify([{ count: sourceRestaurantRows }])) +
        Buffer.byteLength(JSON.stringify(sourceRows)),
      bindCalls: insertionStatements + 1,
      boundValues: restaurants.length * 10 + 2,
    },
    sqlite: {
      statements: 2 + insertionStatements + 1,
      transactionControlStatements: 2,
      transactions: 1,
    },
    phasesMilliseconds: phases,
  };
}

export function runAttachInsertSelectImport(
  destination: DatabaseSync,
  sourcePath: string,
  datasetVersion: string,
  options: ImportOptions = {},
): ImportMeasurement {
  const protectedSource = resolveProtectedSourcePath(sourcePath);
  const destinationPath = destination.location();
  if (destinationPath === null) {
    throw new Error("Michelin import prototype requires a file-backed disposable destination");
  }
  assertMutableDatabaseDoesNotAliasSource(protectedSource, destinationPath);
  const sourceBefore = snapshotSqliteSource(protectedSource);
  const phases = emptyPhases();
  const totalStarted = performance.now();
  let attached = false;
  let importedRowChanges = 0;
  let sourceRestaurantRows = 0;

  try {
    let phaseStarted = performance.now();
    destination.prepare("ATTACH DATABASE ? AS michelin_source").run(immutableSqliteUri(protectedSource));
    attached = true;
    phases.sourceConnect = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    sourceRestaurantRows = (
      destination.prepare("SELECT COUNT(*) AS count FROM michelin_source.restaurants").get() as unknown as CountRow
    ).count;
    phases.sourceRead = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    begin(destination);
    try {
      importedRowChanges = Number(destination.prepare(ATTACHED_MICHELIN_INSERT_SELECT_SQL).run(datasetVersion).changes);
      if (importedRowChanges === 0) {
        throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
      }
      if (options.failurePoint === "afterRowsBeforeMetadata") {
        throw new Error(IMPORT_FAILURE_MESSAGE);
      }
      metadataUpsert(destination, datasetVersion);
      commit(destination);
    } catch (error) {
      rollback(destination);
      throw error;
    }
    phases.destinationWrite = performance.now() - phaseStarted;
  } finally {
    const phaseStarted = performance.now();
    if (attached) {
      destination.exec("DETACH DATABASE michelin_source");
    }
    phases.sourceDisconnect = performance.now() - phaseStarted;
    phases.total = performance.now() - totalStarted;
    assertSqliteSourceUnchanged(sourceBefore, protectedSource, "Set-based ATTACH import");
  }

  return {
    strategy: "attachInsertSelect",
    sourceRestaurantRows,
    sourceSelectedRows: 0,
    importedRowChanges,
    bridge: {
      sourceResultRows: 1,
      sourceResultUtf8Bytes: Buffer.byteLength(JSON.stringify([{ count: sourceRestaurantRows }])),
      bindCalls: 3,
      boundValues: 4,
    },
    sqlite: {
      statements: 5,
      transactionControlStatements: 2,
      transactions: 1,
    },
    phasesMilliseconds: phases,
  };
}

export function readDestinationRows(database: DatabaseSync): DestinationRows {
  const restaurants = database
    .prepare(`SELECT
      id, name, latitude, longitude, address, location, cuisine,
      latestAwardYear, award, datasetVersion
    FROM michelin_restaurants
    ORDER BY id COLLATE BINARY`)
    .all() as Record<string, unknown>[];
  const metadata = database.prepare("SELECT key, value FROM app_metadata ORDER BY key COLLATE BINARY").all() as Record<
    string,
    unknown
  >[];
  const spatial = database
    .prepare(`SELECT
      spatial.restaurantRowId,
      restaurant.id,
      spatial.minimumLatitude,
      spatial.maximumLatitude,
      spatial.minimumLongitude,
      spatial.maximumLongitude
    FROM michelin_restaurant_spatial_index spatial
    LEFT JOIN michelin_restaurants restaurant ON restaurant.rowid = spatial.restaurantRowId
    ORDER BY spatial.restaurantRowId`)
    .all() as Record<string, unknown>[];
  return { restaurants, metadata, spatial };
}

export function destinationDigest(database: DatabaseSync): DestinationDigest {
  const rows = readDestinationRows(database);
  const restaurantJson = JSON.stringify(rows.restaurants);
  const metadataJson = JSON.stringify(rows.metadata);
  const spatialJson = JSON.stringify(rows.spatial);
  return {
    restaurantRows: rows.restaurants.length,
    restaurantSha256: sha256(restaurantJson),
    metadataRows: rows.metadata.length,
    metadataSha256: sha256(metadataJson),
    spatialRows: rows.spatial.length,
    spatialSha256: sha256(spatialJson),
    fullTableSha256: sha256(JSON.stringify(rows)),
  };
}

export function destinationWalBytes(databasePath: string): number {
  const walPath = `${databasePath}-wal`;
  return existsSync(walPath) ? statSync(walPath).size : 0;
}
