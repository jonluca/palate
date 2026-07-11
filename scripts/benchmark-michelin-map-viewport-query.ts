#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  buildMichelinMapViewportQuery,
  selectMichelinMapViewport,
  type MichelinMapAwardFilter,
  type MichelinMapViewportRequest,
  type MichelinMapViewportSelection,
  type MichelinMapVisitStatusFilter,
} from "../utils/db/michelin-map-viewport-core.ts";
import {
  DEFAULT_MAX_RESTAURANTS_IN_VIEW,
  RestaurantViewportIndex,
  type RestaurantViewportEntry,
} from "../utils/restaurant-viewport-index.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

interface Configuration {
  readonly databasePath: string | null;
  readonly minimumAwardYear: number;
  readonly outputPath: string;
  readonly samples: number;
  readonly syntheticRows: number;
  readonly traceRepetitions: number;
  readonly warmupIterations: number;
}

interface TraceEvent extends MichelinMapViewportRequest {
  readonly label: string;
}

interface SourceMichelinRow extends MichelinRestaurantRecord {
  readonly sourceOrder: number;
  readonly datasetVersion: string | null;
}

interface RawActiveMichelinRow extends MichelinRestaurantRecord {
  readonly datasetVersion?: string | null;
}

interface ConfirmedRestaurantRow {
  readonly id: string;
}

interface BaselineContext {
  readonly activeRows: readonly RawActiveMichelinRow[];
  readonly confirmedRestaurantIds: ReadonlySet<string>;
  readonly confirmedRows: readonly ConfirmedRestaurantRow[];
}

interface StrategyCounters {
  sqliteResultQueries: number;
  transferredJsonBytes: number;
  transferredRows: number;
}

interface BaselineRetention {
  readonly confirmedIdRows: number;
  readonly fullGuideRows: number;
  readonly maximumFilteredEntryRows: number;
  readonly maximumIndexedRows: number;
  readonly maximumPrimaryRetainedRowProxies: number;
  readonly maximumSelectionRows: number;
}

interface CandidateRetention {
  readonly maximumCandidateRows: number;
  readonly maximumPrimaryRetainedRowProxies: number;
  readonly maximumSelectionRows: number;
}

interface CandidateRowBounds {
  readonly candidateRows: readonly number[];
  readonly maximumSelectedRows: number;
  readonly maximumTotalInView: number;
}

interface CapturedExecution {
  readonly candidateRowBounds?: CandidateRowBounds;
  readonly counters: StrategyCounters;
  readonly guard: number;
  readonly retention: BaselineRetention | CandidateRetention;
  readonly selections: readonly MichelinMapViewportSelection[];
}

interface TimedExecution {
  readonly elapsedMilliseconds: number;
  readonly guard: number;
}

interface TimingSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly mode: string | null;
  readonly sha256: string | null;
  readonly size: number | null;
}

interface SourceValidation {
  readonly foreignKeyViolationCount: number;
  readonly integrity: string;
  readonly totalChanges: number;
}

interface ScratchBuildSummary {
  readonly allGuideRows: number;
  readonly buildMilliseconds: number;
  readonly confirmedRestaurantRows: number;
  readonly rtreeCheck: string;
  readonly rtreeRows: number;
  readonly sqliteVersion: string;
  readonly usesRTreeVirtualTable: boolean;
}

interface SyntheticRestaurantSeed extends MichelinRestaurantRecord {
  readonly datasetVersion: string;
}

type Strategy = "fullGuideKDBush" | "nativeSqliteViewport";

const ACTIVE_DATASET_KEY = "michelin_dataset_version";
const CANDIDATE_RANKING_OVERSCAN_ROWS = 32;
const DEFAULT_OUTPUT = ".build/michelin-map-viewport-query-profile.json";
const DEFAULT_SYNTHETIC_ROWS = 28_785;
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

const ALL_GUIDE_ROWS_SQL = `SELECT
  m.rowid AS sourceOrder,
  m.id,
  m.name,
  m.latitude,
  m.longitude,
  m.address,
  m.location,
  m.cuisine,
  m.latestAwardYear,
  m.award,
  m.datasetVersion
FROM michelin_restaurants m
ORDER BY m.rowid ASC`;

// Literal production full-guide query. The benchmark intentionally retains the
// SELECT m.* payload, including datasetVersion, when calculating transfer size.
const ACTIVE_GUIDE_ROWS_SQL = `SELECT m.*
FROM michelin_restaurants m
WHERE NOT EXISTS (
  SELECT 1 FROM app_metadata WHERE key = ?
) OR m.datasetVersion = (
  SELECT value FROM app_metadata WHERE key = ?
)`;

const CONFIRMED_RESTAURANT_IDS_SQL = `SELECT DISTINCT r.id
FROM restaurants r
JOIN visits v ON v.restaurantId = r.id
WHERE v.status = 'confirmed'
ORDER BY r.id ASC`;

const CAMERA_TRACE = [
  { label: "launch-world", camera: { latitude: 20, longitude: 0, zoom: 2.5 }, width: 1180, height: 720 },
  { label: "world-pan", camera: { latitude: 29, longitude: -24, zoom: 3.05 }, width: 1180, height: 720 },
  { label: "north-america", camera: { latitude: 39.3, longitude: -98.4, zoom: 4.1 }, width: 1180, height: 720 },
  { label: "california", camera: { latitude: 37.9, longitude: -121.4, zoom: 5.8 }, width: 1180, height: 720 },
  { label: "san-francisco", camera: { latitude: 37.7749, longitude: -122.4194, zoom: 10.2 }, width: 1180, height: 720 },
  {
    label: "san-francisco-mobile",
    camera: { latitude: 37.784, longitude: -122.4075, zoom: 12.1 },
    width: 390,
    height: 700,
  },
  { label: "new-york-wide", camera: { latitude: 40.7128, longitude: -74.006, zoom: 7.2 }, width: 1180, height: 720 },
  { label: "new-york", camera: { latitude: 40.735, longitude: -73.985, zoom: 11.7 }, width: 1180, height: 720 },
  { label: "western-europe", camera: { latitude: 49.5, longitude: 3.2, zoom: 5.7 }, width: 1180, height: 720 },
  { label: "london", camera: { latitude: 51.5072, longitude: -0.1276, zoom: 10.4 }, width: 1180, height: 720 },
  { label: "paris", camera: { latitude: 48.8566, longitude: 2.3522, zoom: 10.55 }, width: 1180, height: 720 },
  { label: "rome", camera: { latitude: 41.9028, longitude: 12.4964, zoom: 10.3 }, width: 1180, height: 720 },
  { label: "east-asia", camera: { latitude: 35.2, longitude: 124.1, zoom: 4.65 }, width: 1180, height: 720 },
  { label: "tokyo-wide", camera: { latitude: 35.6762, longitude: 139.6503, zoom: 7.4 }, width: 1180, height: 720 },
  { label: "tokyo", camera: { latitude: 35.6895, longitude: 139.6917, zoom: 12.05 }, width: 1180, height: 720 },
  { label: "southeast-asia", camera: { latitude: 13.7, longitude: 100.5, zoom: 5.2 }, width: 1180, height: 720 },
  { label: "singapore", camera: { latitude: 1.3521, longitude: 103.8198, zoom: 10.8 }, width: 1180, height: 720 },
  { label: "australia", camera: { latitude: -27.1, longitude: 134.2, zoom: 4.2 }, width: 1180, height: 720 },
  { label: "sydney", camera: { latitude: -33.8688, longitude: 151.2093, zoom: 10.55 }, width: 1180, height: 720 },
  { label: "dateline-east", camera: { latitude: 20.5, longitude: 179.35, zoom: 4.6 }, width: 1180, height: 720 },
  { label: "dateline-west", camera: { latitude: 20.5, longitude: -179.35, zoom: 4.6 }, width: 1180, height: 720 },
  { label: "return-world", camera: { latitude: 20, longitude: 0, zoom: 2.5 }, width: 1180, height: 720 },
] as const;

const FILTER_TRACE: readonly {
  readonly awardFilter: MichelinMapAwardFilter;
  readonly visitStatusFilter: MichelinMapVisitStatusFilter;
}[] = [
  { visitStatusFilter: "all", awardFilter: "all" },
  { visitStatusFilter: "visited", awardFilter: "all" },
  { visitStatusFilter: "unvisited", awardFilter: "all" },
  { visitStatusFilter: "all", awardFilter: "1star" },
  { visitStatusFilter: "all", awardFilter: "2star" },
  { visitStatusFilter: "all", awardFilter: "3star" },
  { visitStatusFilter: "all", awardFilter: "bib" },
  { visitStatusFilter: "all", awardFilter: "selected" },
  { visitStatusFilter: "all", awardFilter: "green" },
];

function usage(): string {
  return `Usage: benchmark-michelin-map-viewport-query.ts [options]

  --database=PATH          Immutable real Palate database (default: deterministic synthetic source)
  --output=PATH            Aggregate-only JSON report (default: ${DEFAULT_OUTPUT})
  --samples=N              Counterbalanced measured pairs (default: 7)
  --warmup=N               Counterbalanced warmup pairs (default: 1)
  --trace-repetitions=N    Camera/filter trace repetitions per sample (default: 1)
  --synthetic-rows=N       Active guide rows without --database (default: ${DEFAULT_SYNTHETIC_ROWS})
  --minimum-award-year=N   Minimum current guide year (default: current UTC year minus one)
  --help, -h               Print this help

The real source is opened mode=ro, immutable=1, and query_only. Its main,
WAL, SHM, and journal files are never changed. The persistent R-Tree candidate
is built only in a disposable scratch database, which is deleted on every exit.
Reports contain aggregate counts, timings, byte sizes, and digests only.`;
}

function parseInteger(option: string, value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be an integer; received ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${option} must be between ${minimum} and ${maximum}; received ${value}`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let databasePath: string | null = null;
  let minimumAwardYear = new Date().getUTCFullYear() - 1;
  let outputPath = resolve(DEFAULT_OUTPUT);
  let samples = 7;
  let syntheticRows = DEFAULT_SYNTHETIC_ROWS;
  let traceRepetitions = 1;
  let warmupIterations = 1;
  const seen = new Set<string>();

  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator <= 2 || separator === argument.length - 1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (seen.has(option)) {
      throw new Error(`Duplicate option: ${option}`);
    }
    seen.add(option);

    switch (option) {
      case "--database":
        databasePath = resolve(value);
        break;
      case "--output":
        outputPath = resolve(value);
        break;
      case "--samples":
        samples = parseInteger(option, value, 1, 101);
        break;
      case "--warmup":
        warmupIterations = parseInteger(option, value, 0, 100);
        break;
      case "--trace-repetitions":
        traceRepetitions = parseInteger(option, value, 1, 100);
        break;
      case "--synthetic-rows":
        syntheticRows = parseInteger(option, value, 500, 250_000);
        break;
      case "--minimum-award-year":
        minimumAwardYear = parseInteger(option, value, 1900, 3000);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return {
    databasePath,
    minimumAwardYear,
    outputPath,
    samples,
    syntheticRows,
    traceRepetitions,
    warmupIterations,
  };
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, mode: null, sha256: null, size: null };
  }
  const metadata = statSync(path);
  return {
    exists: true,
    mode: fileMode(metadata.mode),
    sha256: sha256File(path),
    size: metadata.size,
  };
}

function snapshotSource(databasePath: string): Record<string, FileSnapshot> {
  return Object.fromEntries([
    ["main", snapshotFile(databasePath)],
    ...SIDECAR_SUFFIXES.map((suffix) => [suffix.slice(1), snapshotFile(`${databasePath}${suffix}`)] as const),
  ]);
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Path contains a symbolic-link cycle at ${ancestor}`);
        }
        seenSymlinks.add(ancestor);
        return resolve(
          canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), seenSymlinks),
          ...missing,
        );
      }
      return resolve(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function sourcePathVariants(databasePath: string): string[] {
  return [...new Set([resolve(databasePath), realpathSync(databasePath)])];
}

function protectedSourcePaths(databasePath: string): string[] {
  return sourcePathVariants(databasePath).flatMap((base) => [
    base,
    ...SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const outputCanonical = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    if (outputIdentity && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not hard-link the source database or a SQLite sidecar");
      }
    }
  }
}

function assertSourceCanBeOpenedImmutable(databasePath: string): void {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${databasePath}`);
  }
  for (const base of sourcePathVariants(databasePath)) {
    for (const suffix of ["-wal", "-journal"] as const) {
      const sidecar = `${base}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw new Error(`Immutable source has a non-empty ${suffix.slice(1)} sidecar: ${sidecar}`);
      }
    }
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(realpathSync(databasePath));
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number") {
    throw new TypeError("SQLite total_changes() did not return a number");
  }
  return row.count;
}

function validateSource(database: DatabaseSync): SourceValidation {
  const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
  const foreignKeys = database.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get() as
    | { count?: unknown }
    | undefined;
  if (typeof integrity?.integrity_check !== "string") {
    throw new TypeError("PRAGMA integrity_check returned an invalid value");
  }
  if (typeof foreignKeys?.count !== "number") {
    throw new TypeError("PRAGMA foreign_key_check returned an invalid count");
  }
  return {
    foreignKeyViolationCount: foreignKeys.count,
    integrity: integrity.integrity_check,
    totalChanges: totalChanges(database),
  };
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SYNTHETIC_CENTERS = [
  [37.7749, -122.4194],
  [40.7128, -74.006],
  [51.5072, -0.1276],
  [48.8566, 2.3522],
  [41.9028, 12.4964],
  [35.6762, 139.6503],
  [1.3521, 103.8198],
  [-33.8688, 151.2093],
  [20.5, 179.35],
  [20.5, -179.35],
] as const;

const SYNTHETIC_AWARDS = [
  "3 Stars",
  "2 Stars",
  "1 Star",
  "Bib Gourmand",
  "Selected Restaurants",
  "1 Star, Green Star",
  "Green Star",
] as const;

function syntheticRestaurant(index: number, random: () => number): SyntheticRestaurantSeed {
  let latitude: number;
  let longitude: number;
  if (index % 4 === 0) {
    latitude = -70 + random() * 140;
    longitude = -180 + random() * 360;
  } else {
    const center = SYNTHETIC_CENTERS[index % SYNTHETIC_CENTERS.length]!;
    latitude = center[0] + (random() - 0.5) * 5;
    longitude = center[1] + (random() - 0.5) * 5;
    if (longitude > 180) {
      longitude -= 360;
    } else if (longitude < -180) {
      longitude += 360;
    }
  }
  if (index % 997 === 0) {
    latitude = 0;
    longitude = 0;
  }
  const latestAwardYear = index % 11 === 0 ? 2024 : index % 5 === 0 ? 2025 : 2026;
  const suffix = index % 401 === 0 ? " Café 東京 🍣" : "";
  return {
    id: `synthetic-guide-${index.toString().padStart(6, "0")}`,
    name: `Restaurant ${index}${suffix}`,
    latitude,
    longitude,
    address: `${index} Benchmark Street`,
    location: `Region ${index % 257}`,
    cuisine: `Cuisine ${index % 43}`,
    latestAwardYear,
    award: SYNTHETIC_AWARDS[index % SYNTHETIC_AWARDS.length]!,
    datasetVersion: "synthetic-2026-v1",
  };
}

function createSyntheticSource(databasePath: string, rowCount: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      CREATE TABLE michelin_restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        address TEXT NOT NULL,
        location TEXT NOT NULL,
        cuisine TEXT NOT NULL,
        latestAwardYear INTEGER,
        award TEXT NOT NULL,
        datasetVersion TEXT
      );
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE restaurants (id TEXT PRIMARY KEY);
      CREATE TABLE visits (id TEXT PRIMARY KEY, restaurantId TEXT, status TEXT NOT NULL);
      INSERT INTO app_metadata (key, value) VALUES ('${ACTIVE_DATASET_KEY}', 'synthetic-2026-v1');
      BEGIN IMMEDIATE;
    `);
    const insertGuide = database.prepare(`INSERT INTO michelin_restaurants (
      id, name, latitude, longitude, address, location, cuisine,
      latestAwardYear, award, datasetVersion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertRestaurant = database.prepare("INSERT OR IGNORE INTO restaurants (id) VALUES (?)");
    const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, ?)");
    const random = createRandom(0x5041_4c41);
    for (let index = 0; index < rowCount; index++) {
      const restaurant = syntheticRestaurant(index, random);
      insertGuide.run(
        restaurant.id,
        restaurant.name,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.address,
        restaurant.location,
        restaurant.cuisine,
        restaurant.latestAwardYear,
        restaurant.award,
        restaurant.datasetVersion,
      );
      if (index % 19 === 0 || index % 29 === 0) {
        insertRestaurant.run(restaurant.id);
        insertVisit.run(
          `synthetic-visit-${index.toString().padStart(6, "0")}`,
          restaurant.id,
          index % 19 === 0 ? "confirmed" : "pending",
        );
      }
    }
    database.exec("COMMIT; ANALYZE;");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have committed or failed before BEGIN.
    }
    throw error;
  } finally {
    database.close();
  }
}

function buildTrace(minimumAwardYear: number): TraceEvent[] {
  return CAMERA_TRACE.map((snapshot, index) => {
    const filter = FILTER_TRACE[Math.floor(index / 2) % FILTER_TRACE.length]!;
    return {
      ...snapshot,
      ...filter,
      minimumAwardYear,
    };
  });
}

function buildInitialOpenTrace(minimumAwardYear: number): readonly [TraceEvent] {
  return [
    {
      label: "initial-open-visited-world",
      camera: { latitude: 20, longitude: 0, zoom: 2.5 },
      width: 1180,
      height: 720,
      minimumAwardYear,
      visitStatusFilter: "visited",
      awardFilter: "all",
    },
  ];
}

function expandTrace(trace: readonly TraceEvent[], repetitions: number): TraceEvent[] {
  const expanded: TraceEvent[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    expanded.push(...trace);
  }
  return expanded;
}

function loadAllSourceRows(database: DatabaseSync): SourceMichelinRow[] {
  return database.prepare(ALL_GUIDE_ROWS_SQL).all() as unknown as SourceMichelinRow[];
}

function loadBaselineContext(database: DatabaseSync): BaselineContext {
  const activeRows = database
    .prepare(ACTIVE_GUIDE_ROWS_SQL)
    .all(ACTIVE_DATASET_KEY, ACTIVE_DATASET_KEY) as unknown as RawActiveMichelinRow[];
  const confirmedRows = database.prepare(CONFIRMED_RESTAURANT_IDS_SQL).all() as unknown as ConfirmedRestaurantRow[];
  return {
    activeRows,
    confirmedRestaurantIds: new Set(confirmedRows.map(({ id }) => id)),
    confirmedRows,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function getAwardStarCount(award: string): number {
  const normalized = award.toLowerCase();
  if (normalized.includes("3 stars") || normalized.includes("3 star")) {
    return 3;
  }
  if (normalized.includes("2 stars") || normalized.includes("2 star")) {
    return 2;
  }
  return normalized.includes("1 star") ? 1 : 0;
}

function awardMatches(award: string, filter: MichelinMapAwardFilter): boolean {
  const normalized = award.toLowerCase();
  switch (filter) {
    case "all":
      return true;
    case "1star":
      return getAwardStarCount(award) === 1;
    case "2star":
      return getAwardStarCount(award) === 2;
    case "3star":
      return getAwardStarCount(award) === 3;
    case "bib":
      return normalized.includes("bib gourmand");
    case "selected":
      return normalized.includes("selected");
    case "green":
      return normalized.includes("green star");
  }
}

function restaurantRecord(row: RawActiveMichelinRow): MichelinRestaurantRecord {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    location: row.location,
    cuisine: row.cuisine,
    latestAwardYear: row.latestAwardYear,
    award: row.award,
  };
}

function baselineFilterKey(request: MichelinMapViewportRequest): string {
  return `${request.minimumAwardYear}\0${request.visitStatusFilter}\0${request.awardFilter}`;
}

function buildBaselineIndex(
  context: BaselineContext,
  request: MichelinMapViewportRequest,
): {
  readonly filteredEntryRows: number;
  readonly index: RestaurantViewportIndex<MichelinRestaurantRecord>;
} {
  const entries: RestaurantViewportEntry<MichelinRestaurantRecord>[] = [];
  for (const row of context.activeRows) {
    const visited = context.confirmedRestaurantIds.has(row.id);
    if (request.visitStatusFilter === "visited" && !visited) {
      continue;
    }
    if (request.visitStatusFilter === "unvisited" && visited) {
      continue;
    }
    if (typeof row.latestAwardYear !== "number" || row.latestAwardYear < request.minimumAwardYear) {
      continue;
    }
    if (!awardMatches(row.award, request.awardFilter)) {
      continue;
    }
    entries.push({ restaurant: restaurantRecord(row), visited });
  }
  return {
    filteredEntryRows: entries.length,
    index: new RestaurantViewportIndex(entries, request.maximumResults ?? DEFAULT_MAX_RESTAURANTS_IN_VIEW),
  };
}

function normalizeBaselineSelection(
  selection: ReturnType<RestaurantViewportIndex<MichelinRestaurantRecord>["select"]>,
): MichelinMapViewportSelection {
  return {
    restaurants: selection.entries.map(({ restaurant, visited }) => ({ ...restaurant, visited })),
    totalInView: selection.totalInView,
    nativeCandidateRows: 0,
  };
}

function updateGuard(guard: number, selection: MichelinMapViewportSelection): number {
  let updated = Math.imul(guard ^ selection.totalInView, 16_777_619) >>> 0;
  updated = Math.imul(updated ^ selection.restaurants.length, 16_777_619) >>> 0;
  if (selection.restaurants.length > 0) {
    updated = updateGuardString(updated, selection.restaurants[0]!.id);
    updated = updateGuardString(updated, selection.restaurants.at(-1)!.id);
  }
  return updated;
}

function updateGuardString(guard: number, value: string): number {
  let updated = guard;
  for (let index = 0; index < value.length; index++) {
    updated ^= value.charCodeAt(index);
    updated = Math.imul(updated, 16_777_619) >>> 0;
  }
  return updated;
}

function executeBaseline(
  source: DatabaseSync,
  trace: readonly TraceEvent[],
  capture: boolean,
): CapturedExecution | TimedExecution {
  const startedAt = performance.now();
  const context = loadBaselineContext(source);
  const indexes = new Map<
    string,
    { filteredEntryRows: number; index: RestaurantViewportIndex<MichelinRestaurantRecord> }
  >();
  const selections: MichelinMapViewportSelection[] = [];
  let guard = 2_166_136_261;
  let maximumFilteredEntryRows = 0;
  let maximumIndexedRows = 0;
  let maximumSelectionRows = 0;

  for (const request of trace) {
    const key = baselineFilterKey(request);
    let cached = indexes.get(key);
    if (!cached) {
      cached = buildBaselineIndex(context, request);
      indexes.set(key, cached);
      maximumFilteredEntryRows = Math.max(maximumFilteredEntryRows, cached.filteredEntryRows);
      maximumIndexedRows = Math.max(maximumIndexedRows, cached.index.size);
    }
    const selection = normalizeBaselineSelection(cached.index.select(request));
    maximumSelectionRows = Math.max(maximumSelectionRows, selection.restaurants.length);
    guard = updateGuard(guard, selection);
    if (capture) {
      selections.push(selection);
    }
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  if (!capture) {
    return { elapsedMilliseconds, guard };
  }

  const transferredJsonBytes = serializedBytes(context.activeRows) + serializedBytes(context.confirmedRows);
  return {
    counters: {
      sqliteResultQueries: 2,
      transferredJsonBytes,
      transferredRows: context.activeRows.length + context.confirmedRows.length,
    },
    guard,
    retention: {
      confirmedIdRows: context.confirmedRows.length,
      fullGuideRows: context.activeRows.length,
      maximumFilteredEntryRows,
      maximumIndexedRows,
      maximumPrimaryRetainedRowProxies:
        context.activeRows.length + context.confirmedRows.length + maximumFilteredEntryRows + maximumSelectionRows,
      maximumSelectionRows,
    },
    selections,
  };
}

async function executeCandidate(
  scratch: DatabaseSync,
  trace: readonly TraceEvent[],
  capture: boolean,
): Promise<CapturedExecution | TimedExecution> {
  const startedAt = performance.now();
  const selections: MichelinMapViewportSelection[] = [];
  const candidateRows: number[] = [];
  let guard = 2_166_136_261;
  let maximumCandidateRows = 0;
  let maximumSelectionRows = 0;
  let maximumTotalInView = 0;
  let sqliteResultQueries = 0;
  let transferredJsonBytes = 0;
  let transferredRows = 0;

  for (const request of trace) {
    let requestTransferredRows = 0;
    const getAllAsync = async <T>(source: string, parameters: readonly (number | string)[]): Promise<T[]> => {
      const rows = scratch.prepare(source).all(...parameters) as T[];
      sqliteResultQueries++;
      requestTransferredRows += rows.length;
      if (capture) {
        transferredRows += rows.length;
        transferredJsonBytes += serializedBytes(rows);
      }
      return rows;
    };
    const selection = await selectMichelinMapViewport(
      {
        getAllAsync,
        withReadTransaction: async (task) => {
          scratch.exec("BEGIN");
          try {
            const result = await task({ getAllAsync });
            scratch.exec("COMMIT");
            return result;
          } catch (error) {
            scratch.exec("ROLLBACK");
            throw error;
          }
        },
      },
      request,
    );
    guard = updateGuard(guard, selection);
    maximumCandidateRows = Math.max(maximumCandidateRows, selection.nativeCandidateRows);
    maximumSelectionRows = Math.max(maximumSelectionRows, selection.restaurants.length);
    maximumTotalInView = Math.max(maximumTotalInView, selection.totalInView);
    if (capture) {
      selections.push(selection);
      candidateRows.push(selection.nativeCandidateRows);
    }
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  if (!capture) {
    return { elapsedMilliseconds, guard };
  }

  return {
    candidateRowBounds: {
      candidateRows,
      maximumSelectedRows: maximumSelectionRows,
      maximumTotalInView,
    },
    counters: { sqliteResultQueries, transferredJsonBytes, transferredRows },
    guard,
    retention: {
      maximumCandidateRows,
      maximumPrimaryRetainedRowProxies: maximumCandidateRows + maximumSelectionRows,
      maximumSelectionRows,
    },
    selections,
  };
}

function stripCandidateCounter(
  selection: MichelinMapViewportSelection,
): Omit<MichelinMapViewportSelection, "nativeCandidateRows"> {
  return { restaurants: selection.restaurants, totalInView: selection.totalInView };
}

function assertExactParity(
  baseline: CapturedExecution,
  candidate: CapturedExecution,
  trace: readonly TraceEvent[],
  phase: string,
): string {
  assert.equal(baseline.selections.length, trace.length);
  assert.equal(candidate.selections.length, trace.length);
  for (let index = 0; index < trace.length; index++) {
    assert.deepEqual(
      stripCandidateCounter(candidate.selections[index]!),
      stripCandidateCounter(baseline.selections[index]!),
      `${phase} ${trace[index]!.label}: native SQLite selection diverged from full-guide/KDBush`,
    );
  }
  assert.equal(candidate.guard, baseline.guard, `${phase}: result guards differ`);
  return sha256Bytes(JSON.stringify(baseline.selections.map(stripCandidateCounter)));
}

function createScratchDatabase(
  scratchPath: string,
  allRows: readonly SourceMichelinRow[],
  activeDatasetVersion: string | null,
  confirmedRestaurantIds: readonly string[],
): { readonly database: DatabaseSync; readonly summary: ScratchBuildSummary } {
  const startedAt = performance.now();
  const database = new DatabaseSync(scratchPath);
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE michelin_restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        address TEXT NOT NULL,
        location TEXT NOT NULL,
        cuisine TEXT NOT NULL,
        latestAwardYear INTEGER,
        award TEXT NOT NULL,
        datasetVersion TEXT
      );
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE restaurants (id TEXT PRIMARY KEY);
      CREATE TABLE visits (id TEXT PRIMARY KEY, restaurantId TEXT, status TEXT NOT NULL);
      CREATE VIRTUAL TABLE michelin_restaurant_spatial_index USING rtree(
        restaurantRowId,
        minimumLatitude,
        maximumLatitude,
        minimumLongitude,
        maximumLongitude
      );
      BEGIN IMMEDIATE;
    `);
    const insertGuide = database.prepare(`INSERT INTO michelin_restaurants (
      rowid, id, name, latitude, longitude, address, location, cuisine,
      latestAwardYear, award, datasetVersion
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of allRows) {
      insertGuide.run(
        row.sourceOrder,
        row.id,
        row.name,
        row.latitude,
        row.longitude,
        row.address,
        row.location,
        row.cuisine,
        row.latestAwardYear,
        row.award,
        row.datasetVersion,
      );
    }
    if (activeDatasetVersion !== null) {
      database
        .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
        .run(ACTIVE_DATASET_KEY, activeDatasetVersion);
    }
    const insertRestaurant = database.prepare("INSERT INTO restaurants (id) VALUES (?)");
    const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, 'confirmed')");
    confirmedRestaurantIds.forEach((id, index) => {
      insertRestaurant.run(id);
      insertVisit.run(`scratch-confirmed-${index}`, id);
    });
    database.exec(`
      INSERT INTO michelin_restaurant_spatial_index (
        restaurantRowId,
        minimumLatitude,
        maximumLatitude,
        minimumLongitude,
        maximumLongitude
      )
      SELECT rowid, latitude, latitude, longitude, longitude
      FROM michelin_restaurants
      WHERE latitude BETWEEN -90.0 AND 90.0
        AND longitude BETWEEN -180.0 AND 180.0
        AND NOT (latitude = 0.0 AND longitude = 0.0);
      COMMIT;
      ANALYZE;
      PRAGMA query_only = ON;
    `);
    const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    const rtreeCheck = database.prepare("SELECT rtreecheck('michelin_restaurant_spatial_index') AS result").get() as
      | { result?: unknown }
      | undefined;
    const rtreeRows = database.prepare("SELECT COUNT(*) AS count FROM michelin_restaurant_spatial_index").get() as
      | { count?: unknown }
      | undefined;
    const sqliteVersionValue = sqliteVersion?.version;
    const rtreeCheckValue = rtreeCheck?.result;
    const rtreeRowCount = rtreeRows?.count;
    if (typeof sqliteVersionValue !== "string") {
      throw new TypeError("Scratch SQLite version is not a string");
    }
    if (typeof rtreeCheckValue !== "string") {
      throw new TypeError("Scratch rtreecheck result is not a string");
    }
    if (typeof rtreeRowCount !== "number") {
      throw new TypeError("Scratch R-Tree row count is not a number");
    }
    assert.equal(rtreeCheckValue, "ok", "scratch R-Tree integrity failed");

    const representativePlan = buildMichelinMapViewportQuery(buildTrace(2025)[0]!);
    assert.ok(representativePlan);
    const queryPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${representativePlan.sql}`)
      .all(...representativePlan.parameters) as unknown as Array<{ detail?: unknown }>;
    const usesRTreeVirtualTable = queryPlan.some(
      ({ detail }) => typeof detail === "string" && detail.includes("VIRTUAL TABLE INDEX"),
    );
    assert.equal(usesRTreeVirtualTable, true, "candidate query plan did not use the scratch R-Tree");
    return {
      database,
      summary: {
        allGuideRows: allRows.length,
        buildMilliseconds: performance.now() - startedAt,
        confirmedRestaurantRows: confirmedRestaurantIds.length,
        rtreeCheck: rtreeCheckValue,
        rtreeRows: rtreeRowCount,
        sqliteVersion: sqliteVersionValue,
        usesRTreeVirtualTable,
      },
    };
  } catch (error) {
    try {
      database.exec("PRAGMA query_only = OFF; ROLLBACK");
    } catch {
      // The scratch transaction may not have started or may already be committed.
    }
    database.close();
    throw error;
  }
}

function activeDatasetVersion(database: DatabaseSync): string | null {
  const row = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(ACTIVE_DATASET_KEY) as
    | { value?: unknown }
    | undefined;
  if (!row) {
    return null;
  }
  if (typeof row.value !== "string") {
    throw new TypeError("Active Michelin dataset version is not a string");
  }
  return row.value;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function summarize(values: readonly number[]): TimingSummary {
  assert.ok(values.length > 0);
  return {
    samplesMilliseconds: values.map(rounded),
    minimumMilliseconds: rounded(Math.min(...values)),
    medianMilliseconds: rounded(median(values)),
    p95Milliseconds: rounded(percentile(values, 0.95)),
    maximumMilliseconds: rounded(Math.max(...values)),
  };
}

function summarizeCounts(values: readonly number[]): Record<string, number> {
  assert.ok(values.length > 0);
  return {
    minimum: Math.min(...values),
    median: median(values),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

async function benchmark(
  source: DatabaseSync,
  scratch: DatabaseSync,
  trace: readonly TraceEvent[],
  configuration: Configuration,
  expectedGuard: number,
): Promise<{
  readonly baseline: TimingSummary;
  readonly candidate: TimingSummary;
  readonly measurementOrder: readonly string[];
}> {
  for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
    const strategies: Strategy[] =
      warmup % 2 === 0 ? ["fullGuideKDBush", "nativeSqliteViewport"] : ["nativeSqliteViewport", "fullGuideKDBush"];
    for (const strategy of strategies) {
      const execution =
        strategy === "fullGuideKDBush"
          ? (executeBaseline(source, trace, false) as TimedExecution)
          : ((await executeCandidate(scratch, trace, false)) as TimedExecution);
      assert.equal(execution.guard, expectedGuard, `warmup ${strategy} guard changed`);
    }
  }

  const samples: Record<Strategy, number[]> = { fullGuideKDBush: [], nativeSqliteViewport: [] };
  const measurementOrder: string[] = [];
  for (let sample = 0; sample < configuration.samples; sample++) {
    const strategies: Strategy[] =
      sample % 2 === 0 ? ["fullGuideKDBush", "nativeSqliteViewport"] : ["nativeSqliteViewport", "fullGuideKDBush"];
    measurementOrder.push(strategies.join("-then-"));
    for (const strategy of strategies) {
      const execution =
        strategy === "fullGuideKDBush"
          ? (executeBaseline(source, trace, false) as TimedExecution)
          : ((await executeCandidate(scratch, trace, false)) as TimedExecution);
      assert.equal(execution.guard, expectedGuard, `measured ${strategy} guard changed`);
      samples[strategy].push(execution.elapsedMilliseconds);
    }
  }
  return {
    baseline: summarize(samples.fullGuideKDBush),
    candidate: summarize(samples.nativeSqliteViewport),
    measurementOrder,
  };
}

function assertSelectionFields(selection: MichelinMapViewportSelection): void {
  for (const restaurant of selection.restaurants) {
    for (const field of ["id", "name", "address", "location", "cuisine", "award"] as const) {
      assert.equal(typeof restaurant[field], "string", `selection field ${field} must be a string`);
    }
    assert.equal(typeof restaurant.latitude, "number");
    assert.equal(typeof restaurant.longitude, "number");
    assert.ok(restaurant.latestAwardYear === null || typeof restaurant.latestAwardYear === "number");
    assert.equal(typeof restaurant.visited, "boolean");
  }
}

function candidateBoundsReport(bounds: CandidateRowBounds): Record<string, unknown> {
  const softCandidateCutoff = DEFAULT_MAX_RESTAURANTS_IN_VIEW + CANDIDATE_RANKING_OVERSCAN_ROWS;
  return {
    softCandidateCutoff,
    tieSafeRowsCanExceedSoftCutoff: true,
    observed: summarizeCounts(bounds.candidateRows),
    queriesAboveSoftCutoff: bounds.candidateRows.filter((count) => count > softCandidateCutoff).length,
    maximumRowsAboveSoftCutoff: Math.max(0, Math.max(...bounds.candidateRows) - softCandidateCutoff),
    maximumSelectedRows: bounds.maximumSelectedRows,
    maximumTotalInView: bounds.maximumTotalInView,
    everyCandidatePageNoLargerThanItsTotalInView: true,
    everySelectionWithinResultLimit: bounds.maximumSelectedRows <= DEFAULT_MAX_RESTAURANTS_IN_VIEW,
  };
}

async function main(): Promise<void> {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-michelin-map-viewport-"));
  const syntheticSourcePath = join(temporaryDirectory, "synthetic-source.db");
  const scratchPath = join(temporaryDirectory, "candidate-scratch.db");
  let source: DatabaseSync | null = null;
  let scratch: DatabaseSync | null = null;

  try {
    const sourcePath = configuration.databasePath ?? syntheticSourcePath;
    if (configuration.databasePath === null) {
      createSyntheticSource(sourcePath, configuration.syntheticRows);
    }
    assertSourceCanBeOpenedImmutable(sourcePath);
    assertOutputDoesNotAliasSource(sourcePath, configuration.outputPath);
    const sourceBeforeFiles = snapshotSource(sourcePath);
    source = new DatabaseSync(immutableDatabaseUri(sourcePath), { readOnly: true });
    source.exec("PRAGMA query_only = ON");
    const sourceBeforeValidation = validateSource(source);
    assert.equal(sourceBeforeValidation.integrity, "ok", "source integrity_check must pass");
    assert.equal(sourceBeforeValidation.foreignKeyViolationCount, 0, "source foreign_key_check must pass");

    const allRows = loadAllSourceRows(source);
    const setupBaseline = loadBaselineContext(source);
    const datasetVersion = activeDatasetVersion(source);
    const confirmedIds = [...setupBaseline.confirmedRestaurantIds];
    const scratchResult = createScratchDatabase(scratchPath, allRows, datasetVersion, confirmedIds);
    scratch = scratchResult.database;
    const trace = expandTrace(buildTrace(configuration.minimumAwardYear), configuration.traceRepetitions);
    const initialOpenTrace = buildInitialOpenTrace(configuration.minimumAwardYear);

    const preBaseline = executeBaseline(source, trace, true) as CapturedExecution;
    const preCandidate = (await executeCandidate(scratch, trace, true)) as CapturedExecution;
    preBaseline.selections.forEach(assertSelectionFields);
    preCandidate.selections.forEach(assertSelectionFields);
    const preMeasurementDigest = assertExactParity(preBaseline, preCandidate, trace, "pre-measurement");
    const preCandidateBounds = preCandidate.candidateRowBounds;
    assert.ok(preCandidateBounds);
    for (let index = 0; index < trace.length; index++) {
      const candidateRowCount: number = preCandidateBounds.candidateRows[index]!;
      const selection = preCandidate.selections[index]!;
      assert.equal(selection.nativeCandidateRows, candidateRowCount);
      assert.ok(candidateRowCount <= selection.totalInView);
      assert.ok(selection.restaurants.length <= DEFAULT_MAX_RESTAURANTS_IN_VIEW);
    }

    const preInitialOpenBaseline = executeBaseline(source, initialOpenTrace, true) as CapturedExecution;
    const preInitialOpenCandidate = (await executeCandidate(scratch, initialOpenTrace, true)) as CapturedExecution;
    preInitialOpenBaseline.selections.forEach(assertSelectionFields);
    preInitialOpenCandidate.selections.forEach(assertSelectionFields);
    const preInitialOpenDigest = assertExactParity(
      preInitialOpenBaseline,
      preInitialOpenCandidate,
      initialOpenTrace,
      "initial-open pre-measurement",
    );
    const preInitialOpenCandidateBounds = preInitialOpenCandidate.candidateRowBounds;
    assert.ok(preInitialOpenCandidateBounds);
    const initialOpenCandidateRowCount = preInitialOpenCandidateBounds.candidateRows[0]!;
    const initialOpenSelection = preInitialOpenCandidate.selections[0]!;
    assert.equal(initialOpenSelection.nativeCandidateRows, initialOpenCandidateRowCount);
    assert.ok(initialOpenCandidateRowCount <= initialOpenSelection.totalInView);
    assert.ok(initialOpenSelection.restaurants.length <= DEFAULT_MAX_RESTAURANTS_IN_VIEW);

    const timing = await benchmark(source, scratch, trace, configuration, preBaseline.guard);
    const initialOpenTiming = await benchmark(
      source,
      scratch,
      initialOpenTrace,
      configuration,
      preInitialOpenBaseline.guard,
    );

    const postBaseline = executeBaseline(source, trace, true) as CapturedExecution;
    const postCandidate = (await executeCandidate(scratch, trace, true)) as CapturedExecution;
    const postMeasurementDigest = assertExactParity(postBaseline, postCandidate, trace, "post-measurement");
    assert.equal(postMeasurementDigest, preMeasurementDigest, "semantic result changed during measurement");
    assert.deepEqual(postBaseline.counters, preBaseline.counters);
    assert.deepEqual(postCandidate.counters, preCandidate.counters);
    assert.deepEqual(postCandidate.candidateRowBounds, preCandidate.candidateRowBounds);

    const postInitialOpenBaseline = executeBaseline(source, initialOpenTrace, true) as CapturedExecution;
    const postInitialOpenCandidate = (await executeCandidate(scratch, initialOpenTrace, true)) as CapturedExecution;
    const postInitialOpenDigest = assertExactParity(
      postInitialOpenBaseline,
      postInitialOpenCandidate,
      initialOpenTrace,
      "initial-open post-measurement",
    );
    assert.equal(
      postInitialOpenDigest,
      preInitialOpenDigest,
      "initial-open semantic result changed during measurement",
    );
    assert.deepEqual(postInitialOpenBaseline.counters, preInitialOpenBaseline.counters);
    assert.deepEqual(postInitialOpenCandidate.counters, preInitialOpenCandidate.counters);
    assert.deepEqual(postInitialOpenCandidate.candidateRowBounds, preInitialOpenCandidate.candidateRowBounds);

    const scratchIntegrity = scratch.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    const scratchForeignKeys = scratch.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get() as
      | { count?: unknown }
      | undefined;
    assert.equal(scratchIntegrity?.integrity_check, "ok");
    assert.equal(scratchForeignKeys?.count, 0);

    const sourceAfterValidation = validateSource(source);
    assert.deepEqual(sourceAfterValidation, sourceBeforeValidation, "source validation state changed");
    const sourceAfterFiles = snapshotSource(sourcePath);
    assert.deepEqual(sourceAfterFiles, sourceBeforeFiles, "source main or sidecar files changed");

    const baselineMedian = timing.baseline.medianMilliseconds;
    const candidateMedian = timing.candidate.medianMilliseconds;
    const baselineRetention = preBaseline.retention as BaselineRetention;
    const candidateRetention = preCandidate.retention as CandidateRetention;
    const initialOpenBaselineMedian = initialOpenTiming.baseline.medianMilliseconds;
    const initialOpenCandidateMedian = initialOpenTiming.candidate.medianMilliseconds;
    const initialOpenBaselineRetention = preInitialOpenBaseline.retention as BaselineRetention;
    const initialOpenCandidateRetention = preInitialOpenCandidate.retention as CandidateRetention;
    const report = {
      schemaVersion: 1,
      status: "ok",
      generatedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        sqlite: scratchResult.summary.sqliteVersion,
        baselineSpatialIndex: "kdbush",
        candidateSpatialIndex: "sqlite-rtree",
      },
      configuration: {
        input: configuration.databasePath === null ? "synthetic" : "immutable-real-database",
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
        traceRepetitions: configuration.traceRepetitions,
        uniqueTraceEvents: CAMERA_TRACE.length,
        timedViewportQueriesPerSample: trace.length,
        viewportInitialRequestQueriesPerSample: initialOpenTrace.length,
        distinctFilterStates: new Set(trace.map(baselineFilterKey)).size,
        minimumAwardYear: configuration.minimumAwardYear,
        resultLimit: DEFAULT_MAX_RESTAURANTS_IN_VIEW,
        syntheticRows: configuration.databasePath === null ? configuration.syntheticRows : null,
      },
      source: {
        description: configuration.databasePath === null ? "generated-disposable-source" : "immutable-real-source",
        basename: configuration.databasePath === null ? null : basename(configuration.databasePath),
        databaseBytes: sourceBeforeFiles.main?.size ?? null,
        allGuideRows: allRows.length,
        activeGuideRows: setupBaseline.activeRows.length,
        confirmedRestaurantRows: setupBaseline.confirmedRows.length,
        activeDatasetVersionPresent: datasetVersion !== null,
      },
      scratch: {
        disposable: true,
        rawRecordsRetained: false,
        rtreeBuiltOnlyInScratch: true,
        ...scratchResult.summary,
        integrity: scratchIntegrity.integrity_check,
        foreignKeyViolationCount: scratchForeignKeys.count,
      },
      correctness: {
        exactOrderedIdAndFullFieldParityBeforeMeasurement: true,
        exactOrderedIdAndFullFieldParityAfterMeasurement: true,
        comparedRestaurantFields: [
          "id",
          "name",
          "latitude",
          "longitude",
          "address",
          "location",
          "cuisine",
          "latestAwardYear",
          "award",
          "visited",
        ],
        comparedSelectionFields: ["ordered restaurants", "totalInView"],
        semanticSha256: preMeasurementDigest,
        lightweightTimedResultGuard: preBaseline.guard.toString(16).padStart(8, "0"),
        measuredSamplesValidated: configuration.samples,
      },
      measurementModel: {
        baseline:
          "literal active SELECT m.* plus confirmed-ID query, JavaScript status/year/award filtering, cached per-filter KDBush construction, and viewport selection",
        candidate:
          "the production selector: normally one SQLite result query using the R-Tree or confirmed-ID fast path, a bounded ranking overscan, and exact JavaScript finalization; a boundary tie reruns the prefix and tie expansion on one read snapshot",
        includes: [
          "SQLite statement preparation, execution, and row decoding",
          "baseline full-guide and confirmed-ID reads",
          "baseline JavaScript filtering and KDBush builds",
          "candidate SQL filtering, ranking-prefix selection, and bounded KDBush finalization",
          "representative camera and filter changes",
        ],
        excludes: [
          "Expo asynchronous scheduling and native bridge transport",
          "React rendering, marker construction, and map drawing",
          "disposable scratch database and R-Tree construction",
          "JSON payload proxy calculation and correctness validation",
          "the screen's common confirmed-restaurant query and React rendering lifecycle",
        ],
        baselineTraceCaching:
          "The trace keeps one KDBush index per distinct filter for the whole sample. The prior screen retained only its current useMemo index, so this deliberately favors the baseline when filters are revisited.",
        candidateScratchRelationalShape:
          "The scratch database copies every real guide row but models each distinct confirmed Michelin ID with one restaurant and one confirmed visit rather than copying the source visit distribution or indexes. Timing can understate confirmed-status CTE work; parity and transfer counts remain exact for the modeled confirmed-ID set.",
        transferBytesDefinition:
          "UTF-8 bytes of JSON.stringify over raw SQLite result rows; a stable payload proxy, not measured Expo bridge bytes",
      },
      structuralWork: {
        fullGuideKDBush: {
          sqliteResultQueries: preBaseline.counters.sqliteResultQueries,
          transferredRows: preBaseline.counters.transferredRows,
          transferredJsonBytes: preBaseline.counters.transferredJsonBytes,
          retainedRows: baselineRetention,
        },
        nativeSqliteViewport: {
          sqliteResultQueries: preCandidate.counters.sqliteResultQueries,
          transferredRows: preCandidate.counters.transferredRows,
          transferredJsonBytes: preCandidate.counters.transferredJsonBytes,
          retainedRows: candidateRetention,
          candidateRowBounds: candidateBoundsReport(preCandidateBounds),
        },
        comparison: {
          sqliteResultQueryDelta: preCandidate.counters.sqliteResultQueries - preBaseline.counters.sqliteResultQueries,
          transferredRowsSaved: preBaseline.counters.transferredRows - preCandidate.counters.transferredRows,
          transferredRowReductionPercent:
            preBaseline.counters.transferredRows === 0
              ? 0
              : ((preBaseline.counters.transferredRows - preCandidate.counters.transferredRows) /
                  preBaseline.counters.transferredRows) *
                100,
          transferredJsonBytesSaved:
            preBaseline.counters.transferredJsonBytes - preCandidate.counters.transferredJsonBytes,
          transferredJsonByteReductionPercent:
            preBaseline.counters.transferredJsonBytes === 0
              ? 0
              : ((preBaseline.counters.transferredJsonBytes - preCandidate.counters.transferredJsonBytes) /
                  preBaseline.counters.transferredJsonBytes) *
                100,
          maximumPrimaryRetainedRowProxiesSaved:
            baselineRetention.maximumPrimaryRetainedRowProxies - candidateRetention.maximumPrimaryRetainedRowProxies,
        },
      },
      timing: {
        scope: "representative-camera-filter-trace",
        measurementOrder: timing.measurementOrder,
        fullGuideKDBush: timing.baseline,
        nativeSqliteViewport: timing.candidate,
        candidateMedianSpeedup: baselineMedian / candidateMedian,
        candidateMedianMillisecondsSaved: baselineMedian - candidateMedian,
        candidateMedianPercentReduction: ((baselineMedian - candidateMedian) / baselineMedian) * 100,
        interpretation:
          "The native candidate can be slower on this repeated trace because its normal path executes one SQLite result query per camera event while the deliberately favorable baseline reuses cached per-filter KDBush indexes; rare boundary ties use three result queries. Interpret elapsed time independently from payload and retained-row reductions.",
      },
      viewportInitialRequest: {
        scope: "single-production-viewport-subsystem-initial-request",
        traceRepetitionsApplied: false,
        excludesCommonScreenWork:
          "Both old and new screens also load getConfirmedRestaurantsWithVisits before this request; that shared query, React Query scheduling, bridge transport, and rendering are excluded, so this is not end-to-end map startup.",
        request: {
          camera: { latitude: 20, longitude: 0, zoom: 2.5 },
          width: 1180,
          height: 720,
          minimumAwardYear: configuration.minimumAwardYear,
          visitStatusFilter: "visited",
          awardFilter: "all",
          resultLimit: DEFAULT_MAX_RESTAURANTS_IN_VIEW,
        },
        correctness: {
          exactOrderedIdAndFullFieldParityBeforeMeasurement: true,
          exactOrderedIdAndFullFieldParityAfterMeasurement: true,
          semanticSha256: preInitialOpenDigest,
          lightweightTimedResultGuard: preInitialOpenBaseline.guard.toString(16).padStart(8, "0"),
          measuredSamplesValidated: configuration.samples,
        },
        structuralWork: {
          fullGuideKDBush: {
            sqliteResultQueries: preInitialOpenBaseline.counters.sqliteResultQueries,
            transferredRows: preInitialOpenBaseline.counters.transferredRows,
            transferredJsonBytes: preInitialOpenBaseline.counters.transferredJsonBytes,
            retainedRows: initialOpenBaselineRetention,
          },
          nativeSqliteViewport: {
            sqliteResultQueries: preInitialOpenCandidate.counters.sqliteResultQueries,
            transferredRows: preInitialOpenCandidate.counters.transferredRows,
            transferredJsonBytes: preInitialOpenCandidate.counters.transferredJsonBytes,
            retainedRows: initialOpenCandidateRetention,
            candidateRowBounds: candidateBoundsReport(preInitialOpenCandidateBounds),
          },
          comparison: {
            sqliteResultQueryDelta:
              preInitialOpenCandidate.counters.sqliteResultQueries -
              preInitialOpenBaseline.counters.sqliteResultQueries,
            transferredRowsSaved:
              preInitialOpenBaseline.counters.transferredRows - preInitialOpenCandidate.counters.transferredRows,
            transferredRowReductionPercent:
              preInitialOpenBaseline.counters.transferredRows === 0
                ? 0
                : ((preInitialOpenBaseline.counters.transferredRows -
                    preInitialOpenCandidate.counters.transferredRows) /
                    preInitialOpenBaseline.counters.transferredRows) *
                  100,
            transferredJsonBytesSaved:
              preInitialOpenBaseline.counters.transferredJsonBytes -
              preInitialOpenCandidate.counters.transferredJsonBytes,
            transferredJsonByteReductionPercent:
              preInitialOpenBaseline.counters.transferredJsonBytes === 0
                ? 0
                : ((preInitialOpenBaseline.counters.transferredJsonBytes -
                    preInitialOpenCandidate.counters.transferredJsonBytes) /
                    preInitialOpenBaseline.counters.transferredJsonBytes) *
                  100,
            maximumPrimaryRetainedRowProxiesSaved:
              initialOpenBaselineRetention.maximumPrimaryRetainedRowProxies -
              initialOpenCandidateRetention.maximumPrimaryRetainedRowProxies,
          },
        },
        timing: {
          measurementOrder: initialOpenTiming.measurementOrder,
          fullGuideKDBush: initialOpenTiming.baseline,
          nativeSqliteViewport: initialOpenTiming.candidate,
          candidateMedianSpeedup: initialOpenBaselineMedian / initialOpenCandidateMedian,
          candidateMedianMillisecondsSaved: initialOpenBaselineMedian - initialOpenCandidateMedian,
          candidateMedianPercentReduction:
            ((initialOpenBaselineMedian - initialOpenCandidateMedian) / initialOpenBaselineMedian) * 100,
        },
      },
      sourceAttestation: {
        openMode: "mode=ro, immutable=1, PRAGMA query_only=ON",
        before: sourceBeforeFiles,
        after: sourceAfterFiles,
        mainAndSidecarsByteAndModeIdentical: true,
        beforeValidation: sourceBeforeValidation,
        afterValidation: sourceAfterValidation,
        integrityUnchangedAndOk: true,
        foreignKeysUnchangedAndClean: true,
        totalChangesUnchanged: true,
      },
      privacy: {
        aggregateOnly: true,
        rawGuideRowsInReport: false,
        rawVisitRowsInReport: false,
        rawSourceOrScratchCopiesRetained: false,
      },
    };

    mkdirSync(dirname(configuration.outputPath), { recursive: true });
    writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configuration.outputPath, 0o600);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    scratch?.close();
    source?.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
