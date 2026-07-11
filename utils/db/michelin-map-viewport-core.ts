import {
  DEFAULT_MAX_RESTAURANTS_IN_VIEW,
  RestaurantViewportIndex,
  type RestaurantViewportEntry,
  type RestaurantViewportQuery,
} from "../restaurant-viewport-index.ts";
import type { MichelinRestaurantRecord } from "./types";

const ACTIVE_DATASET_KEY = "michelin_dataset_version";
const MAX_MERCATOR_LATITUDE = 85.05112878;
const MAXIMUM_VIEWPORT_RESULTS = DEFAULT_MAX_RESTAURANTS_IN_VIEW;
const NATIVE_RANKING_OVERSCAN_ROWS = 32;

export type MichelinMapVisitStatusFilter = "visited" | "unvisited" | "all";
export type MichelinMapAwardFilter = "all" | "1star" | "2star" | "3star" | "bib" | "selected" | "green";

export interface MichelinMapViewportRequest extends RestaurantViewportQuery {
  readonly minimumAwardYear: number;
  readonly visitStatusFilter: MichelinMapVisitStatusFilter;
  readonly awardFilter: MichelinMapAwardFilter;
  readonly maximumResults?: number;
}

export type MichelinMapViewportRestaurant = MichelinRestaurantRecord & {
  readonly visited: boolean;
};

export interface MichelinMapViewportSelection {
  readonly restaurants: MichelinMapViewportRestaurant[];
  readonly totalInView: number;
  /** Rows retained for exact JavaScript finalization, not cumulative native transfer. */
  readonly nativeCandidateRows: number;
}

export interface MichelinMapViewportQueryRow extends MichelinRestaurantRecord {
  readonly sourceOrder: number;
  readonly visited: number;
  readonly totalInView: number;
  readonly centerDistanceScore: number;
  readonly awardPriority: number;
}

export interface MichelinMapViewportReader {
  readonly getAllAsync: <T>(source: string, parameters: readonly (number | string)[]) => Promise<T[]>;
}

export interface MichelinMapViewportDatabase extends MichelinMapViewportReader {
  readonly withReadTransaction: <T>(task: (transaction: MichelinMapViewportReader) => Promise<T>) => Promise<T>;
}

export interface MichelinMapViewportQueryPlan {
  readonly sql: string;
  readonly boundaryTieSql: string;
  readonly parameters: readonly (number | string)[];
  readonly maximumResults: number;
  readonly request: MichelinMapViewportRequest;
}

interface ViewportBounds {
  readonly minimumLatitude: number;
  readonly maximumLatitude: number;
  readonly minimumLongitude: number;
  readonly maximumLongitude: number;
  readonly wrapsDateLine: boolean;
}

function clampLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function mercatorScale(zoom: number): number {
  return 256 * Math.pow(2, Math.max(0, zoom));
}

function longitudeToPixelX(longitude: number, zoom: number): number {
  return ((normalizeLongitude(longitude) + 180) / 360) * mercatorScale(zoom);
}

function latitudeToPixelY(latitude: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const sine = Math.sin((clampLatitude(latitude) * Math.PI) / 180);
  return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale;
}

function pixelXToLongitude(pixelX: number, zoom: number): number {
  return normalizeLongitude((pixelX / mercatorScale(zoom)) * 360 - 180);
}

function pixelYToLatitude(pixelY: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const n = Math.PI - (2 * Math.PI * pixelY) / scale;
  return clampLatitude((180 / Math.PI) * Math.atan(Math.sinh(n)));
}

function getViewportBounds(request: MichelinMapViewportRequest): ViewportBounds | null {
  if (request.width <= 0 || request.height <= 0) {
    return null;
  }
  const zoom = Math.max(0, request.camera.zoom);
  const scale = mercatorScale(zoom);
  const centerX = longitudeToPixelX(request.camera.longitude, zoom);
  const centerY = latitudeToPixelY(request.camera.latitude, zoom);
  const minimumX = centerX - request.width / 2;
  const maximumX = centerX + request.width / 2;
  const minimumY = centerY - request.height / 2;
  const maximumY = centerY + request.height / 2;
  const latitudeCoversWorld = request.height >= scale;
  const longitudeCoversWorld = request.width >= scale;
  const latitudeA = latitudeCoversWorld
    ? -MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, maximumY)), zoom);
  const latitudeB = latitudeCoversWorld
    ? MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, minimumY)), zoom);
  const minimumLongitude = longitudeCoversWorld ? -180 : pixelXToLongitude(minimumX, zoom);
  const maximumLongitude = longitudeCoversWorld ? 180 : pixelXToLongitude(maximumX, zoom);
  return {
    minimumLatitude: Math.min(latitudeA, latitudeB),
    maximumLatitude: Math.max(latitudeA, latitudeB),
    minimumLongitude,
    maximumLongitude,
    wrapsDateLine: !longitudeCoversWorld && minimumLongitude > maximumLongitude,
  };
}

function validateRequest(request: MichelinMapViewportRequest): number {
  for (const [label, value] of [
    ["camera.latitude", request.camera.latitude],
    ["camera.longitude", request.camera.longitude],
    ["camera.zoom", request.camera.zoom],
    ["width", request.width],
    ["height", request.height],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} must be finite; received ${String(value)}`);
    }
  }
  if (!Number.isSafeInteger(request.minimumAwardYear)) {
    throw new RangeError(`minimumAwardYear must be a safe integer; received ${request.minimumAwardYear}`);
  }
  if (!Number.isFinite(mercatorScale(request.camera.zoom))) {
    throw new RangeError(`camera.zoom produces a non-finite Mercator scale; received ${request.camera.zoom}`);
  }
  if (!["visited", "unvisited", "all"].includes(request.visitStatusFilter)) {
    throw new RangeError(`Unsupported visitStatusFilter: ${String(request.visitStatusFilter)}`);
  }
  if (!["all", "1star", "2star", "3star", "bib", "selected", "green"].includes(request.awardFilter)) {
    throw new RangeError(`Unsupported awardFilter: ${String(request.awardFilter)}`);
  }
  const maximumResults = request.maximumResults ?? MAXIMUM_VIEWPORT_RESULTS;
  if (!Number.isSafeInteger(maximumResults) || maximumResults <= 0 || maximumResults > MAXIMUM_VIEWPORT_RESULTS) {
    throw new RangeError(
      `maximumResults must be an integer from 1 through ${MAXIMUM_VIEWPORT_RESULTS}; received ${maximumResults}`,
    );
  }
  return maximumResults;
}

function awardPredicate(filter: MichelinMapAwardFilter): string {
  const starCount = `CASE
    WHEN lower(m.award) LIKE '%3 star%' THEN 3
    WHEN lower(m.award) LIKE '%2 star%' THEN 2
    WHEN lower(m.award) LIKE '%1 star%' THEN 1
    ELSE 0
  END`;
  switch (filter) {
    case "1star":
      return `${starCount} = 1`;
    case "2star":
      return `${starCount} = 2`;
    case "3star":
      return `${starCount} = 3`;
    case "bib":
      return "lower(m.award) LIKE '%bib gourmand%'";
    case "selected":
      return "lower(m.award) LIKE '%selected%'";
    case "green":
      return "lower(m.award) LIKE '%green star%'";
    case "all":
      return "1";
  }
}

function visitPredicate(filter: MichelinMapVisitStatusFilter): string {
  switch (filter) {
    case "visited":
      return "confirmed.id IS NOT NULL";
    case "unvisited":
      return "confirmed.id IS NULL";
    case "all":
      return "1";
  }
}

function longitudePredicate(alias: string, wrapsDateLine: boolean): string {
  return wrapsDateLine
    ? `(${alias}.longitude >= config.minimumLongitude OR ${alias}.longitude <= config.maximumLongitude)`
    : `${alias}.longitude BETWEEN config.minimumLongitude AND config.maximumLongitude`;
}

/**
 * Build one native SQLite query that filters through the persistent R-Tree and
 * returns only the groups that can contribute to the exact top-K result.
 * Name and source-order ties are deliberately finalized in JavaScript with the
 * existing map oracle because SQLite's binary collation is not localeCompare.
 */
export function buildMichelinMapViewportQuery(
  request: MichelinMapViewportRequest,
): MichelinMapViewportQueryPlan | null {
  const maximumResults = validateRequest(request);
  const bounds = getViewportBounds(request);
  if (!bounds) {
    return null;
  }
  const zoom = Math.max(0, request.camera.zoom);
  const scale = mercatorScale(zoom);
  const centerX = longitudeToPixelX(request.camera.longitude, zoom);
  const centerY = latitudeToPixelY(request.camera.latitude, zoom);
  // Keep a small bounded cushion for platform-libm differences between
  // SQLite's distance expression and the JavaScript/Hermes exact oracle.
  const candidateCutoff = maximumResults + NATIVE_RANKING_OVERSCAN_ROWS;
  const parameters = [
    scale,
    centerX,
    centerY,
    bounds.minimumLatitude,
    bounds.maximumLatitude,
    bounds.minimumLongitude,
    bounds.maximumLongitude,
    request.minimumAwardYear,
    candidateCutoff,
  ] as const;
  const filteredSourceSql =
    request.visitStatusFilter === "visited"
      ? `confirmed_restaurants confirmed
      JOIN michelin_restaurants m ON m.id = confirmed.id`
      : `viewport_rowids viewport
      JOIN michelin_restaurants m ON m.rowid = viewport.restaurantRowId
      LEFT JOIN confirmed_restaurants confirmed ON confirmed.id = m.id`;

  const commonSql = `WITH
    config(
      scale,
      centerX,
      centerY,
      minimumLatitude,
      maximumLatitude,
      minimumLongitude,
      maximumLongitude,
      minimumAwardYear,
      candidateCutoff
    ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)),
    confirmed_restaurants AS MATERIALIZED (
      SELECT DISTINCT r.id
      FROM restaurants r
      JOIN visits v ON v.restaurantId = r.id
      WHERE v.status = 'confirmed'
    ),
    viewport_rowids AS MATERIALIZED (
      SELECT spatial.restaurantRowId
      FROM michelin_restaurant_spatial_index spatial, config
      WHERE spatial.maximumLatitude >= config.minimumLatitude
        AND spatial.minimumLatitude <= config.maximumLatitude
        AND ${
          bounds.wrapsDateLine
            ? `(spatial.maximumLongitude >= config.minimumLongitude
              OR spatial.minimumLongitude <= config.maximumLongitude)`
            : `spatial.maximumLongitude >= config.minimumLongitude
              AND spatial.minimumLongitude <= config.maximumLongitude`
        }
      UNION
      SELECT m.rowid
      FROM michelin_restaurants m, config
      WHERE m.latitude = 0.0
        AND m.longitude = 0.0
        AND m.latitude BETWEEN config.minimumLatitude AND config.maximumLatitude
        AND ${longitudePredicate("m", bounds.wrapsDateLine)}
    ),
    filtered AS MATERIALIZED (
      SELECT
        m.rowid AS sourceOrder,
        m.id,
        m.name,
        m.latitude,
        m.longitude,
        m.award,
        CASE WHEN confirmed.id IS NULL THEN 0 ELSE 1 END AS visited
      FROM ${filteredSourceSql}
      CROSS JOIN config
      WHERE m.latitude BETWEEN -90.0 AND 90.0
        AND m.longitude BETWEEN -180.0 AND 180.0
        AND m.latitude BETWEEN config.minimumLatitude AND config.maximumLatitude
        AND ${longitudePredicate("m", bounds.wrapsDateLine)}
        AND m.latestAwardYear >= config.minimumAwardYear
        AND (
          NOT EXISTS (SELECT 1 FROM app_metadata WHERE key = '${ACTIVE_DATASET_KEY}')
          OR m.datasetVersion = (SELECT value FROM app_metadata WHERE key = '${ACTIVE_DATASET_KEY}')
        )
        AND ${visitPredicate(request.visitStatusFilter)}
        AND ${awardPredicate(request.awardFilter)}
    ),
    projected AS (
      SELECT
        filtered.*,
        CASE WHEN filtered.longitude = -180.0
          THEN config.scale
          ELSE ((filtered.longitude + 180.0) / 360.0) * config.scale
        END AS pixelX,
        (0.5 - ln(
          (1.0 + sin(radians(max(-${MAX_MERCATOR_LATITUDE}, min(${MAX_MERCATOR_LATITUDE}, filtered.latitude))))) /
          (1.0 - sin(radians(max(-${MAX_MERCATOR_LATITUDE}, min(${MAX_MERCATOR_LATITUDE}, filtered.latitude)))))
        ) / (4.0 * pi())) * config.scale AS pixelY,
        CASE
          WHEN lower(filtered.award) LIKE '%3 star%' THEN 300
          WHEN lower(filtered.award) LIKE '%2 star%' THEN 200
          WHEN lower(filtered.award) LIKE '%1 star%' THEN 100
          WHEN lower(filtered.award) LIKE '%bib gourmand%' THEN 60
          WHEN lower(filtered.award) LIKE '%selected%' THEN 30
          ELSE 0
        END + CASE WHEN lower(filtered.award) LIKE '%green star%' THEN 10 ELSE 0 END AS awardPriority
      FROM filtered, config
    ),
    scored AS MATERIALIZED (
      SELECT
        projected.*,
        pow(
          min(abs(projected.pixelX - config.centerX), config.scale - abs(projected.pixelX - config.centerX)),
          2
        ) + pow(projected.pixelY - config.centerY, 2) AS centerDistanceScore
      FROM projected, config
    )`;
  const hydratedProjectionSql = (source: string) => `SELECT
    ${source}.sourceOrder,
    hydrated.id,
    hydrated.name,
    hydrated.latitude,
    hydrated.longitude,
    hydrated.address,
    hydrated.location,
    hydrated.cuisine,
    hydrated.latestAwardYear,
    hydrated.award,
    ${source}.visited,
    ${source}.centerDistanceScore,
    ${source}.awardPriority,
    (SELECT COUNT(*) FROM scored) AS totalInView
  FROM ${source}
  JOIN michelin_restaurants hydrated ON hydrated.rowid = ${source}.sourceOrder`;
  const sql = `${commonSql},
    ranked_prefix AS MATERIALIZED (
      SELECT scored.*
      FROM scored
      ORDER BY scored.centerDistanceScore ASC, scored.awardPriority DESC, scored.visited DESC
      LIMIT (SELECT candidateCutoff FROM config)
    )
  ${hydratedProjectionSql("ranked_prefix")}
  ORDER BY ranked_prefix.centerDistanceScore ASC, ranked_prefix.awardPriority DESC, ranked_prefix.visited DESC`;
  const boundaryTieSql = `${commonSql},
    boundary_group AS MATERIALIZED (
      SELECT scored.*
      FROM scored
      WHERE scored.centerDistanceScore = ?
        AND scored.awardPriority = ?
        AND scored.visited = ?
    )
  ${hydratedProjectionSql("boundary_group")}
  ORDER BY boundary_group.sourceOrder ASC`;

  return { sql, boundaryTieSql, parameters, maximumResults, request };
}

function parseRow(row: MichelinMapViewportQueryRow, index: number): RestaurantViewportEntry<MichelinRestaurantRecord> {
  if (!Number.isSafeInteger(row.sourceOrder) || row.sourceOrder <= 0) {
    throw new TypeError(`Map viewport row ${index} has invalid sourceOrder`);
  }
  if (row.visited !== 0 && row.visited !== 1) {
    throw new TypeError(`Map viewport row ${index} has invalid visited flag`);
  }
  return {
    restaurant: {
      id: row.id,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      address: row.address,
      location: row.location,
      cuisine: row.cuisine,
      latestAwardYear: row.latestAwardYear,
      award: row.award,
    },
    visited: row.visited === 1,
  };
}

export function finalizeMichelinMapViewportRows(
  rows: readonly MichelinMapViewportQueryRow[],
  plan: MichelinMapViewportQueryPlan,
): MichelinMapViewportSelection {
  if (rows.length === 0) {
    return { restaurants: [], totalInView: 0, nativeCandidateRows: 0 };
  }
  const sourceOrders = new Set<number>();
  const orderedRows = [...rows].sort((left, right) => left.sourceOrder - right.sourceOrder);
  for (const [index, row] of orderedRows.entries()) {
    if (sourceOrders.has(row.sourceOrder)) {
      throw new Error(`Map viewport query returned duplicate sourceOrder ${row.sourceOrder}`);
    }
    sourceOrders.add(row.sourceOrder);
    if (!Number.isSafeInteger(row.totalInView) || row.totalInView < rows.length) {
      throw new TypeError(`Map viewport row ${index} has invalid totalInView`);
    }
  }
  const totalInView = orderedRows[0]!.totalInView;
  if (orderedRows.some((row) => row.totalInView !== totalInView)) {
    throw new Error("Map viewport query returned inconsistent totalInView values");
  }
  const entries = orderedRows.map(parseRow);
  const exactSelection = new RestaurantViewportIndex(entries, plan.maximumResults).select(plan.request);
  return {
    restaurants: exactSelection.entries.map(({ restaurant, visited }) => ({ ...restaurant, visited })),
    totalInView,
    nativeCandidateRows: rows.length,
  };
}

function hasSameRankingGroup(left: MichelinMapViewportQueryRow, right: MichelinMapViewportQueryRow): boolean {
  return (
    left.centerDistanceScore === right.centerDistanceScore &&
    left.awardPriority === right.awardPriority &&
    left.visited === right.visited
  );
}

export async function selectMichelinMapViewport(
  database: MichelinMapViewportDatabase,
  request: MichelinMapViewportRequest,
): Promise<MichelinMapViewportSelection> {
  const plan = buildMichelinMapViewportQuery(request);
  if (!plan) {
    return { restaurants: [], totalInView: 0, nativeCandidateRows: 0 };
  }
  const rows = await database.getAllAsync<MichelinMapViewportQueryRow>(plan.sql, plan.parameters);
  if (rows.length <= plan.maximumResults) {
    return finalizeMichelinMapViewportRows(rows, plan);
  }
  const boundary = rows[plan.maximumResults - 1]!;
  const firstExcluded = rows[plan.maximumResults]!;
  if (!hasSameRankingGroup(boundary, firstExcluded)) {
    return finalizeMichelinMapViewportRows(rows, plan);
  }

  // A boundary tie is rare. Re-run its prefix through the adapter's deferred
  // read transaction so the native prefix and expanded tie group share one
  // WAL snapshot without adding a connection to the normal one-query path.
  return database.withReadTransaction(async (transaction) => {
    const snapshotRows = await transaction.getAllAsync<MichelinMapViewportQueryRow>(plan.sql, plan.parameters);
    if (snapshotRows.length <= plan.maximumResults) {
      return finalizeMichelinMapViewportRows(snapshotRows, plan);
    }
    const snapshotBoundary = snapshotRows[plan.maximumResults - 1]!;
    const snapshotFirstExcluded = snapshotRows[plan.maximumResults]!;
    if (!hasSameRankingGroup(snapshotBoundary, snapshotFirstExcluded)) {
      return finalizeMichelinMapViewportRows(snapshotRows, plan);
    }
    const boundaryRows = await transaction.getAllAsync<MichelinMapViewportQueryRow>(plan.boundaryTieSql, [
      ...plan.parameters,
      snapshotBoundary.centerDistanceScore,
      snapshotBoundary.awardPriority,
      snapshotBoundary.visited,
    ]);
    const overscanRowsOutsideBoundary = snapshotRows.filter((row) => !hasSameRankingGroup(row, snapshotBoundary));
    return finalizeMichelinMapViewportRows([...overscanRowsOutsideBoundary, ...boundaryRows], plan);
  });
}
