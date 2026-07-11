export const MICHELIN_DATASET_VERSION_KEY = "michelin_dataset_version";
export const MICHELIN_IMPORT_REQUEST_KEY = "michelin_import_validation_request";
export const MICHELIN_IMPORT_ATTESTATION_KEY = "michelin_import_runtime_attestation";

export const MICHELIN_IMPORT_LEGACY_STRATEGY = "legacy-js-v1";
export const MICHELIN_IMPORT_ATTACH_STRATEGY = "attach-insert-select-v1";
export const DEFAULT_MICHELIN_IMPORT_STRATEGY = MICHELIN_IMPORT_LEGACY_STRATEGY;

export const NO_VALID_MICHELIN_ROWS_MESSAGE =
  "The bundled Michelin database did not contain any valid restaurant locations";

export type MichelinImportStrategy = typeof MICHELIN_IMPORT_LEGACY_STRATEGY | typeof MICHELIN_IMPORT_ATTACH_STRATEGY;

export interface MichelinImportValidationRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestedStrategy: MichelinImportStrategy;
  readonly expiresAtEpochSeconds: number;
}

export interface MichelinImportResolution {
  readonly requestedStrategy: MichelinImportStrategy;
  readonly resolvedStrategy: MichelinImportStrategy;
  readonly fallbackReason: "sqlite-uri-unavailable" | null;
  readonly runId: string | null;
}

export interface MichelinImportAttestation extends MichelinImportResolution {
  readonly schemaVersion: 1;
  readonly selectedStrategy: MichelinImportStrategy;
  readonly datasetVersion: string;
  readonly sourceRows: number;
  readonly importedRows: number;
  readonly observedAtEpochSeconds: number;
}

export interface MichelinImportSourceDescriptor {
  readonly datasetVersion: string;
  readonly immutableReadOnlyUri: string;
}

export interface MichelinImportResult {
  readonly importedRows: number;
  readonly sourceRows: number;
  readonly strategy: MichelinImportStrategy;
}

const MAX_VALIDATION_REQUEST_BYTES = 4_096;
const MAX_VALIDATION_REQUEST_LIFETIME_SECONDS = 60 * 60;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function parseMichelinImportValidationRequest(
  value: string | null | undefined,
  nowEpochSeconds: number,
): MichelinImportValidationRequest | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_VALIDATION_REQUEST_BYTES ||
    !Number.isFinite(nowEpochSeconds)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const request = parsed as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (
    keys.join(",") !== "expiresAtEpochSeconds,requestedStrategy,runId,schemaVersion" ||
    request.schemaVersion !== 1 ||
    typeof request.runId !== "string" ||
    !SAFE_RUN_ID_PATTERN.test(request.runId) ||
    (request.requestedStrategy !== MICHELIN_IMPORT_LEGACY_STRATEGY &&
      request.requestedStrategy !== MICHELIN_IMPORT_ATTACH_STRATEGY) ||
    typeof request.expiresAtEpochSeconds !== "number" ||
    !Number.isSafeInteger(request.expiresAtEpochSeconds) ||
    request.expiresAtEpochSeconds < nowEpochSeconds ||
    request.expiresAtEpochSeconds > nowEpochSeconds + MAX_VALIDATION_REQUEST_LIFETIME_SECONDS
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    runId: request.runId,
    requestedStrategy: request.requestedStrategy,
    expiresAtEpochSeconds: request.expiresAtEpochSeconds,
  };
}

export function resolveMichelinImportStrategy(
  request: MichelinImportValidationRequest | null,
  sqliteUriAvailable: boolean,
): MichelinImportResolution {
  const requestedStrategy = request?.requestedStrategy ?? DEFAULT_MICHELIN_IMPORT_STRATEGY;
  if (requestedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY && !sqliteUriAvailable) {
    return {
      requestedStrategy,
      resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
      fallbackReason: "sqlite-uri-unavailable",
      runId: request?.runId ?? null,
    };
  }
  return {
    requestedStrategy,
    resolvedStrategy: requestedStrategy,
    fallbackReason: null,
    runId: request?.runId ?? null,
  };
}

export function serializeMichelinImportAttestation(attestation: MichelinImportAttestation): string {
  const hasKnownRequestedStrategy =
    attestation.requestedStrategy === MICHELIN_IMPORT_LEGACY_STRATEGY ||
    attestation.requestedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY;
  const hasKnownResolvedStrategy =
    attestation.resolvedStrategy === MICHELIN_IMPORT_LEGACY_STRATEGY ||
    attestation.resolvedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY;
  const hasConsistentResolution =
    (attestation.fallbackReason === null && attestation.requestedStrategy === attestation.resolvedStrategy) ||
    (attestation.fallbackReason === "sqlite-uri-unavailable" &&
      attestation.requestedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY &&
      attestation.resolvedStrategy === MICHELIN_IMPORT_LEGACY_STRATEGY);
  if (
    attestation.schemaVersion !== 1 ||
    !hasKnownRequestedStrategy ||
    !hasKnownResolvedStrategy ||
    attestation.selectedStrategy !== attestation.resolvedStrategy ||
    !hasConsistentResolution ||
    (attestation.runId !== null && !SAFE_RUN_ID_PATTERN.test(attestation.runId)) ||
    !attestation.datasetVersion ||
    attestation.datasetVersion.includes("\0") ||
    new TextEncoder().encode(attestation.datasetVersion).byteLength > 512 ||
    !Number.isSafeInteger(attestation.sourceRows) ||
    attestation.sourceRows < 0 ||
    !Number.isSafeInteger(attestation.importedRows) ||
    attestation.importedRows <= 0 ||
    !Number.isSafeInteger(attestation.observedAtEpochSeconds) ||
    attestation.observedAtEpochSeconds < 0
  ) {
    throw new Error("Invalid Michelin import runtime attestation");
  }
  return JSON.stringify(attestation);
}

export class MichelinImportTerminalError extends Error {
  override readonly name = "MichelinImportTerminalError";
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

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

/*
 * SQLite CAST and JavaScript parseFloat agree after a valid decimal prefix has
 * been established. This prefix guard prevents CAST('invalid' AS REAL) from
 * turning the legacy JavaScript path's NaN into an importable zero. The ltrim
 * set is ECMAScript WhiteSpace and LineTerminator, including BOM.
 */
const ECMASCRIPT_LEFT_TRIM_SQL = `char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
  || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195)
  || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201)
  || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)
  || char(65279)`;

function decimalPrefixSql(column: string): string {
  return `(
    substr(${column}, 1, 1) BETWEEN '0' AND '9'
    OR (
      substr(${column}, 1, 1) = '.'
      AND substr(${column}, 2, 1) BETWEEN '0' AND '9'
    )
    OR (
      substr(${column}, 1, 1) IN ('+', '-')
      AND (
        substr(${column}, 2, 1) BETWEEN '0' AND '9'
        OR (
          substr(${column}, 2, 1) = '.'
          AND substr(${column}, 3, 1) BETWEEN '0' AND '9'
        )
      )
    )
  )`;
}

const JAVASCRIPT_TRUTHY_GREEN_STAR_SQL = `CASE typeof(has_green_star)
  WHEN 'null' THEN 0
  WHEN 'integer' THEN has_green_star != 0
  WHEN 'real' THEN has_green_star != 0
  WHEN 'text' THEN length(has_green_star) != 0
  WHEN 'blob' THEN 1
  ELSE 0
END`;

export const ATTACHED_MICHELIN_INSERT_SELECT_SQL = `
WITH latest_years AS (
  SELECT restaurant_id, MAX(year) AS max_year
  FROM michelin_source.restaurant_awards
  GROUP BY restaurant_id
), latest_awards AS (
  SELECT award.*
  FROM michelin_source.restaurant_awards award
  INNER JOIN latest_years latest
    ON award.restaurant_id = latest.restaurant_id
   AND award.year = latest.max_year
), raw_source AS (
  SELECT
    r.id,
    r.name,
    r.address,
    r.location,
    r.cuisine,
    a.distinction AS latest_distinction,
    a.year AS latest_year,
    a.green_star AS has_green_star,
    ltrim(CAST(r.latitude AS TEXT), ${ECMASCRIPT_LEFT_TRIM_SQL}) AS latitude_text,
    ltrim(CAST(r.longitude AS TEXT), ${ECMASCRIPT_LEFT_TRIM_SQL}) AS longitude_text
  FROM michelin_source.restaurants r
  LEFT JOIN latest_awards a ON r.id = a.restaurant_id
  WHERE r.latitude IS NOT NULL
    AND r.longitude IS NOT NULL
    AND r.latitude != ''
    AND r.longitude != ''
), parsed_source AS (
  SELECT
    *,
    CAST(latitude_text AS REAL) AS parsed_latitude,
    CAST(longitude_text AS REAL) AS parsed_longitude
  FROM raw_source
  WHERE ${decimalPrefixSql("latitude_text")}
    AND ${decimalPrefixSql("longitude_text")}
), importable AS (
  SELECT *
  FROM parsed_source
  WHERE parsed_latitude BETWEEN -90.0 AND 90.0
    AND parsed_longitude BETWEEN -180.0 AND 180.0
    AND NOT (parsed_latitude = 0.0 AND parsed_longitude = 0.0)
)
INSERT INTO michelin_restaurants
  (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
SELECT
  'michelin-' || CAST(id AS TEXT),
  COALESCE(name, ''),
  parsed_latitude,
  parsed_longitude,
  address,
  location,
  cuisine,
  latest_year,
  CASE
    WHEN ${JAVASCRIPT_TRUTHY_GREEN_STAR_SQL} THEN
      CASE
        WHEN COALESCE(latest_distinction, '') != '' THEN latest_distinction || ', Green Star'
        ELSE 'Green Star'
      END
    ELSE COALESCE(latest_distinction, '')
  END,
  ?
FROM importable
WHERE TRUE
ON CONFLICT(id) DO UPDATE SET${UPSERT_ASSIGNMENTS_SQL}`;

export const MICHELIN_IMPORT_METADATA_UPSERT_SQL = `INSERT INTO app_metadata (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
