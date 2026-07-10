import type { MichelinRestaurantRecord } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;
const BOUND_EPSILON_DEGREES = 1e-9;
const ACTIVE_DATASET_KEY = "michelin_dataset_version";
const SPATIAL_TABLE = "michelin_restaurant_spatial_index";
const VALID_GUIDE_COORDINATE_SQL =
  "latitude BETWEEN -90.0 AND 90.0 AND longitude BETWEEN -180.0 AND 180.0 AND NOT (latitude = 0.0 AND longitude = 0.0)";
const VALID_ALIASED_GUIDE_COORDINATE_SQL =
  "m.latitude BETWEEN -90.0 AND 90.0 AND m.longitude BETWEEN -180.0 AND 180.0 AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)";

export const MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS = 1000;
export const MICHELIN_PROVIDER_SPATIAL_BATCH_SIZE = 64;
export const MICHELIN_PROVIDER_SPATIAL_BINDS_PER_INPUT = 8;
export const MICHELIN_PROVIDER_SPATIAL_FIXED_BINDS = 2;
export const MICHELIN_PROVIDER_SPATIAL_MAX_BINDS = 999;

let spatialIndexRequiresValidation = false;

export interface MichelinProviderSpatialInput {
  readonly latitude: number;
  readonly longitude: number;
}

export interface MichelinProviderLongitudeInterval {
  readonly minimum: number;
  readonly maximum: number;
}

export interface MichelinProviderSpatialBounds {
  readonly minimumLatitude: number;
  readonly maximumLatitude: number;
  readonly longitudeIntervals:
    | readonly [MichelinProviderLongitudeInterval]
    | readonly [MichelinProviderLongitudeInterval, MichelinProviderLongitudeInterval];
}

export interface MichelinProviderSpatialQueryPlan {
  readonly startIndex: number;
  readonly inputCount: number;
  readonly sql: string;
  readonly parameters: readonly (number | string)[];
}

export interface MichelinProviderSpatialCandidate {
  readonly sourceOrder: number;
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface MichelinProviderSpatialCandidateRow {
  readonly reservationOrdinal: unknown;
  readonly sourceOrder: unknown;
  readonly id: unknown;
  readonly name: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
}

interface MichelinProviderSpatialHealthRow {
  readonly issueCount: number;
}

export interface MichelinProviderSpatialSqlExecutor {
  readonly execAsync: (source: string) => Promise<void>;
  readonly getFirstAsync: <T>(source: string) => Promise<T | null>;
}

export interface MichelinProviderSpatialDatabase extends MichelinProviderSpatialSqlExecutor {
  readonly withExclusiveTransactionAsync: (
    task: (transaction: MichelinProviderSpatialSqlExecutor) => Promise<void>,
  ) => Promise<void>;
}

const BACKFILL_SELECT_SQL = `SELECT rowid, latitude, latitude, longitude, longitude
FROM michelin_restaurants
WHERE ${VALID_GUIDE_COORDINATE_SQL}`;

/** Persistent R-Tree plus triggers. Existing rows are populated separately. */
export const MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${SPATIAL_TABLE} USING rtree(
  restaurantRowId,
  minimumLatitude,
  maximumLatitude,
  minimumLongitude,
  maximumLongitude
);

CREATE TRIGGER IF NOT EXISTS michelin_provider_spatial_insert
AFTER INSERT ON michelin_restaurants
WHEN NEW.latitude BETWEEN -90.0 AND 90.0
 AND NEW.longitude BETWEEN -180.0 AND 180.0
 AND NOT (NEW.latitude = 0.0 AND NEW.longitude = 0.0)
BEGIN
  INSERT OR REPLACE INTO ${SPATIAL_TABLE}
    (restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude)
  VALUES (NEW.rowid, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

CREATE TRIGGER IF NOT EXISTS michelin_provider_spatial_update
AFTER UPDATE OF latitude, longitude ON michelin_restaurants
WHEN OLD.latitude IS NOT NEW.latitude OR OLD.longitude IS NOT NEW.longitude
BEGIN
  DELETE FROM ${SPATIAL_TABLE} WHERE restaurantRowId = OLD.rowid;
  INSERT OR REPLACE INTO ${SPATIAL_TABLE}
    (restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude)
  SELECT NEW.rowid, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude
  WHERE NEW.latitude BETWEEN -90.0 AND 90.0
    AND NEW.longitude BETWEEN -180.0 AND 180.0
    AND NOT (NEW.latitude = 0.0 AND NEW.longitude = 0.0);
END;

CREATE TRIGGER IF NOT EXISTS michelin_provider_spatial_delete
AFTER DELETE ON michelin_restaurants
BEGIN
  DELETE FROM ${SPATIAL_TABLE} WHERE restaurantRowId = OLD.rowid;
END;`;

/** Initial population is idempotent and does not delete existing index rows. */
export const MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL = `INSERT OR REPLACE INTO ${SPATIAL_TABLE}
  (restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude)
${BACKFILL_SELECT_SQL}`;

/** Returns issueCount=0 when every valid row is conservatively covered and no stale rows remain. */
export const MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL = `SELECT
  (
    SELECT COUNT(*)
    FROM michelin_restaurants m
    LEFT JOIN ${SPATIAL_TABLE} spatial ON spatial.restaurantRowId = m.rowid
    WHERE ${VALID_ALIASED_GUIDE_COORDINATE_SQL}
      AND (
        spatial.restaurantRowId IS NULL
        OR NOT (m.latitude BETWEEN spatial.minimumLatitude AND spatial.maximumLatitude)
        OR NOT (m.longitude BETWEEN spatial.minimumLongitude AND spatial.maximumLongitude)
        OR spatial.maximumLatitude - spatial.minimumLatitude > 0.001
        OR spatial.maximumLongitude - spatial.minimumLongitude > 0.001
      )
  ) + (
    SELECT COUNT(*)
    FROM ${SPATIAL_TABLE} spatial
    LEFT JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
    WHERE m.rowid IS NULL
       OR NOT (${VALID_ALIASED_GUIDE_COORDINATE_SQL})
  ) AS issueCount`;

/** Run inside the caller's transaction after a non-zero health result. */
export const MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL = `DELETE FROM ${SPATIAL_TABLE};
${MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL};`;

export const MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL = `WITH requested_ids AS (
  SELECT DISTINCT CAST(value AS TEXT) AS id
  FROM json_each(?)
)
SELECT
  m.id,
  m.name,
  m.latitude,
  m.longitude,
  m.address,
  m.location,
  m.cuisine,
  m.latestAwardYear,
  m.award
FROM requested_ids
JOIN michelin_restaurants m ON m.id = requested_ids.id
WHERE (
  NOT EXISTS (SELECT 1 FROM app_metadata WHERE key = ?)
  OR m.datasetVersion = (SELECT value FROM app_metadata WHERE key = ?)
)
ORDER BY m.rowid`;

function parseHealthIssueCount(row: MichelinProviderSpatialHealthRow | null): number {
  const issueCount = row?.issueCount;
  if (typeof issueCount !== "number" || !Number.isSafeInteger(issueCount) || issueCount < 0) {
    throw new Error("Michelin provider spatial health query returned an invalid issueCount.");
  }
  return issueCount;
}

async function repairInsideTransaction(database: MichelinProviderSpatialDatabase): Promise<boolean> {
  spatialIndexRequiresValidation = true;
  let repaired = false;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const issueCount = parseHealthIssueCount(
      await transaction.getFirstAsync<MichelinProviderSpatialHealthRow>(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL),
    );
    if (issueCount > 0) {
      await transaction.execAsync(MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL);
      repaired = true;
    }
  });
  spatialIndexRequiresValidation = false;
  return repaired;
}

export async function rebuildMichelinProviderSpatialIndex(database: MichelinProviderSpatialDatabase): Promise<void> {
  spatialIndexRequiresValidation = true;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL);
  });
  spatialIndexRequiresValidation = false;
}

/** Mark rowid-backed entries unsafe before an operation such as VACUUM. */
export function invalidateMichelinProviderSpatialIndex(): void {
  spatialIndexRequiresValidation = true;
}

/**
 * Revalidate only after a known same-session risk. Normal reads avoid an extra
 * full-guide health scan, while a failed post-VACUUM rebuild cannot expose
 * stale rowid mappings to provider matching.
 */
export async function ensureInvalidatedMichelinProviderSpatialIndex(
  database: MichelinProviderSpatialDatabase,
): Promise<boolean> {
  return spatialIndexRequiresValidation ? ensureMichelinProviderSpatialIndex(database) : false;
}

/** Healthy launches execute schema guards plus one read-only health query and no transaction. */
export async function ensureMichelinProviderSpatialIndex(database: MichelinProviderSpatialDatabase): Promise<boolean> {
  await database.execAsync(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
  const issueCount = parseHealthIssueCount(
    await database.getFirstAsync<MichelinProviderSpatialHealthRow>(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL),
  );
  if (issueCount === 0) {
    spatialIndexRequiresValidation = false;
    return false;
  }
  return repairInsideTransaction(database);
}

/** Deep coordinate/orphan validation for explicit database maintenance, not normal launch. */
export async function repairMichelinProviderSpatialIndexIfNeeded(
  database: MichelinProviderSpatialDatabase,
): Promise<boolean> {
  const issueCount = parseHealthIssueCount(
    await database.getFirstAsync<MichelinProviderSpatialHealthRow>(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL),
  );
  if (issueCount === 0) {
    spatialIndexRequiresValidation = false;
    return false;
  }
  return repairInsideTransaction(database);
}

function assertCoordinate(latitude: number, longitude: number, label: string): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`${label} latitude must be finite and between -90 and 90.`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`${label} longitude must be finite and between -180 and 180.`);
  }
}

export function isValidMichelinProviderSpatialCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}

/** A conservative spherical bounding box for the maximum legacy match radius. */
export function buildMichelinProviderSpatialBounds(latitude: number, longitude: number): MichelinProviderSpatialBounds {
  assertCoordinate(latitude, longitude, "Provider reservation");
  const angularRadius = MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS / EARTH_RADIUS_METERS;
  const latitudeDelta = angularRadius * (180 / Math.PI);
  const minimumLatitude = Math.max(-90, latitude - latitudeDelta - BOUND_EPSILON_DEGREES);
  const maximumLatitude = Math.min(90, latitude + latitudeDelta + BOUND_EPSILON_DEGREES);
  if (minimumLatitude <= -90 || maximumLatitude >= 90) {
    return {
      minimumLatitude,
      maximumLatitude,
      longitudeIntervals: [{ minimum: -180, maximum: 180 }],
    };
  }

  const latitudeRadians = latitude * (Math.PI / 180);
  const longitudeDelta =
    Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitudeRadians))) * (180 / Math.PI) +
    BOUND_EPSILON_DEGREES;
  const minimumUnwrapped = longitude - longitudeDelta;
  const maximumUnwrapped = longitude + longitudeDelta;
  if (minimumUnwrapped < -180) {
    return {
      minimumLatitude,
      maximumLatitude,
      longitudeIntervals: [
        { minimum: -180, maximum: normalizeLongitude(maximumUnwrapped) },
        { minimum: normalizeLongitude(minimumUnwrapped), maximum: 180 },
      ],
    };
  }
  if (maximumUnwrapped > 180) {
    return {
      minimumLatitude,
      maximumLatitude,
      longitudeIntervals: [
        { minimum: minimumUnwrapped, maximum: 180 },
        { minimum: -180, maximum: normalizeLongitude(maximumUnwrapped) },
      ],
    };
  }
  return {
    minimumLatitude,
    maximumLatitude,
    longitudeIntervals: [{ minimum: minimumUnwrapped, maximum: maximumUnwrapped }],
  };
}

export function buildMichelinProviderSpatialCandidateSql(inputCount: number): string {
  if (!Number.isSafeInteger(inputCount) || inputCount <= 0) {
    throw new RangeError("Spatial candidate inputCount must be a positive safe integer.");
  }
  const maximumInputCount = Math.floor(
    (MICHELIN_PROVIDER_SPATIAL_MAX_BINDS - MICHELIN_PROVIDER_SPATIAL_FIXED_BINDS) /
      MICHELIN_PROVIDER_SPATIAL_BINDS_PER_INPUT,
  );
  if (inputCount > maximumInputCount) {
    throw new RangeError(`Spatial candidate inputCount must not exceed ${maximumInputCount}.`);
  }
  const values = Array.from({ length: inputCount }, () => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  return `WITH reservation_bounds(
    reservationOrdinal,
    minimumLatitude,
    maximumLatitude,
    firstMinimumLongitude,
    firstMaximumLongitude,
    hasSecondLongitudeInterval,
    secondMinimumLongitude,
    secondMaximumLongitude
  ) AS (VALUES ${values})
  SELECT
    q.reservationOrdinal AS reservationOrdinal,
    m.rowid AS sourceOrder,
    m.id,
    m.name,
    m.latitude,
    m.longitude
  FROM reservation_bounds q
  CROSS JOIN ${SPATIAL_TABLE} spatial
    ON spatial.minimumLatitude <= q.maximumLatitude
   AND spatial.maximumLatitude >= q.minimumLatitude
   AND (
     (
       spatial.minimumLongitude <= q.firstMaximumLongitude
       AND spatial.maximumLongitude >= q.firstMinimumLongitude
     ) OR (
       q.hasSecondLongitudeInterval = 1
       AND spatial.minimumLongitude <= q.secondMaximumLongitude
       AND spatial.maximumLongitude >= q.secondMinimumLongitude
     )
   )
  CROSS JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
  WHERE (
    NOT EXISTS (SELECT 1 FROM app_metadata WHERE key = ?)
    OR m.datasetVersion = (SELECT value FROM app_metadata WHERE key = ?)
  )
    AND m.latitude BETWEEN -90.0 AND 90.0
    AND m.longitude BETWEEN -180.0 AND 180.0
    AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)`;
}

export function buildMichelinProviderSpatialQueryPlans(
  inputs: readonly MichelinProviderSpatialInput[],
  batchSize: number = MICHELIN_PROVIDER_SPATIAL_BATCH_SIZE,
): MichelinProviderSpatialQueryPlan[] {
  const maximumBatchSize = Math.floor(
    (MICHELIN_PROVIDER_SPATIAL_MAX_BINDS - MICHELIN_PROVIDER_SPATIAL_FIXED_BINDS) /
      MICHELIN_PROVIDER_SPATIAL_BINDS_PER_INPUT,
  );
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > maximumBatchSize) {
    throw new RangeError(`Spatial candidate batchSize must be an integer between 1 and ${maximumBatchSize}.`);
  }

  const plans: MichelinProviderSpatialQueryPlan[] = [];
  for (let startIndex = 0; startIndex < inputs.length; startIndex += batchSize) {
    const batch = inputs.slice(startIndex, startIndex + batchSize);
    const parameters: Array<number | string> = [];
    for (let localIndex = 0; localIndex < batch.length; localIndex++) {
      const input = batch[localIndex]!;
      const bounds = buildMichelinProviderSpatialBounds(input.latitude, input.longitude);
      const first = bounds.longitudeIntervals[0];
      const second = bounds.longitudeIntervals[1];
      parameters.push(
        startIndex + localIndex,
        bounds.minimumLatitude,
        bounds.maximumLatitude,
        first.minimum,
        first.maximum,
        second ? 1 : 0,
        second?.minimum ?? 0,
        second?.maximum ?? 0,
      );
    }
    parameters.push(ACTIVE_DATASET_KEY, ACTIVE_DATASET_KEY);
    plans.push({
      startIndex,
      inputCount: batch.length,
      sql: buildMichelinProviderSpatialCandidateSql(batch.length),
      parameters,
    });
  }
  return plans;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

/** Parse bridge rows, deduplicate R-Tree OR results, and restore guide rowid order per input. */
export function groupMichelinProviderSpatialCandidates(
  rows: readonly MichelinProviderSpatialCandidateRow[],
  inputCount: number,
): MichelinProviderSpatialCandidate[][] {
  if (!Number.isSafeInteger(inputCount) || inputCount < 0) {
    throw new RangeError("Spatial candidate inputCount must be a non-negative safe integer.");
  }
  const grouped = Array.from({ length: inputCount }, () => new Map<number, MichelinProviderSpatialCandidate>());
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const ordinal = requiredFiniteNumber(row.reservationOrdinal, `Candidate row ${rowIndex} reservationOrdinal`);
    const sourceOrder = requiredFiniteNumber(row.sourceOrder, `Candidate row ${rowIndex} sourceOrder`);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= inputCount) {
      throw new RangeError(`Candidate row ${rowIndex} reservationOrdinal is outside the input range.`);
    }
    if (!Number.isSafeInteger(sourceOrder)) {
      throw new RangeError(`Candidate row ${rowIndex} sourceOrder must be a safe integer.`);
    }
    const latitude = requiredFiniteNumber(row.latitude, `Candidate row ${rowIndex} latitude`);
    const longitude = requiredFiniteNumber(row.longitude, `Candidate row ${rowIndex} longitude`);
    assertCoordinate(latitude, longitude, `Candidate row ${rowIndex}`);
    if (latitude === 0 && longitude === 0) {
      throw new RangeError(`Candidate row ${rowIndex} contains the excluded 0,0 guide coordinate.`);
    }
    const candidate = {
      sourceOrder,
      id: requiredString(row.id, `Candidate row ${rowIndex} id`),
      name: requiredString(row.name, `Candidate row ${rowIndex} name`),
      latitude,
      longitude,
    };
    const existing = grouped[ordinal]!.get(sourceOrder);
    if (existing) {
      if (
        existing.id !== candidate.id ||
        existing.name !== candidate.name ||
        existing.latitude !== candidate.latitude ||
        existing.longitude !== candidate.longitude
      ) {
        throw new Error(`Candidate row ${rowIndex} conflicts with an earlier sourceOrder.`);
      }
    } else {
      grouped[ordinal]!.set(sourceOrder, candidate);
    }
  }
  return grouped.map((candidates) =>
    [...candidates.values()].sort((left, right) => left.sourceOrder - right.sourceOrder),
  );
}

export function collectMichelinProviderSpatialCandidateIds(
  groups: readonly (readonly MichelinProviderSpatialCandidate[])[],
): string[] {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const candidate of group) {
      ids.add(candidate.id);
    }
  }
  return [...ids];
}

/** Replace lightweight spatial rows with exact nine-column records without changing rowid order. */
export function hydrateMichelinProviderSpatialCandidateGroups(
  groups: readonly (readonly MichelinProviderSpatialCandidate[])[],
  hydratedRestaurants: readonly MichelinRestaurantRecord[],
): MichelinRestaurantRecord[][] {
  const hydratedById = new Map<string, MichelinRestaurantRecord>();
  for (const restaurant of hydratedRestaurants) {
    if (hydratedById.has(restaurant.id)) {
      throw new Error(`Michelin provider hydration returned duplicate id ${restaurant.id}.`);
    }
    hydratedById.set(restaurant.id, restaurant);
  }
  return groups.map((group) =>
    group.map(({ id }) => {
      const restaurant = hydratedById.get(id);
      if (!restaurant) {
        throw new Error(`Michelin provider hydration omitted active candidate ${id}.`);
      }
      return restaurant;
    }),
  );
}
