#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { WrappedStats } from "../utils/db/types.ts";
import {
  buildWrappedStatsMichelinQuery,
  parseWrappedStatsMichelinRows,
  type WrappedStatsMichelinQueryRow,
} from "../utils/db/wrapped-stats-michelin-core.ts";
import { countWrappedStatsProductionSqlCalls } from "./wrapped-stats-query-call-counter.ts";

type MichelinStats = WrappedStats["michelinStats"];
type Strategy = "legacyFiveQueries" | "consolidatedQuery";
type Scope = "allTime" | "selectedYear";

interface Configuration {
  readonly databasePath: string | null;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface RestaurantSeed {
  readonly id: string;
  readonly award: string | null;
}

interface VisitSeed {
  readonly id: string;
  readonly restaurantId: string | null;
  readonly status: string;
  readonly startTime: number;
  readonly awardAtVisit: string | null;
}

interface SourceRestaurantRow {
  readonly id: unknown;
  readonly award: unknown;
}

interface SourceVisitRow {
  readonly restaurantId: unknown;
  readonly suggestedRestaurantId: unknown;
  readonly nearbyRestaurantId: unknown;
  readonly status: unknown;
  readonly startTime: unknown;
  readonly awardAtVisit: unknown;
}

interface DerivationCounts {
  readonly confirmedRestaurantId: number;
  readonly directSuggestion: number;
  readonly nearbySuggestion: number;
  readonly deterministicGuideFallback: number;
}

interface Fixture {
  readonly mode: "deterministic-synthetic" | "mac-database-derived";
  readonly sourceDatabaseSha256: string | null;
  readonly sourceDatabaseBytes: number | null;
  readonly sourceIntegrityCheck: string | null;
  readonly sourceForeignKeyViolationCount: number | null;
  readonly sourceStatusCounts: Readonly<Record<string, number>>;
  readonly sourceVisitCount: number;
  readonly sourceMichelinRestaurantCount: number;
  readonly sourceRowsWithRestaurantId: number;
  readonly sourceRowsWithSuggestedRestaurantId: number;
  readonly sourceRowsWithNearbySuggestion: number;
  readonly sourceRowsWithHistoricalAward: number;
  readonly derivationCounts: DerivationCounts | null;
  readonly restaurants: readonly RestaurantSeed[];
  readonly visits: readonly VisitSeed[];
}

interface AwardCountRow {
  readonly award: string | null;
  readonly count: number;
}

interface CountRow {
  readonly count: number;
}

interface DistinctStarsRow {
  readonly distinctStars: number | null;
}

interface SelectedYearRow {
  readonly year: number | string | null;
}

interface QueryPlanRow {
  readonly detail: string;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly sqliteCalls: number;
  readonly result: MichelinStats;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: readonly number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

// Independent literal copy of the former production strategy. The benchmark
// intentionally does not assemble its oracle from candidate SQL fragments.
const LEGACY_VISIT_COUNTS_SQL = `SELECT COALESCE(v.awardAtVisit, m.award) as award, COUNT(DISTINCT v.id) as count
FROM visits v
JOIN michelin_restaurants m ON v.restaurantId = m.id
WHERE v.status = 'confirmed' __YEAR_FILTER__
GROUP BY COALESCE(v.awardAtVisit, m.award)`;

const LEGACY_RESTAURANT_COUNTS_SQL = `SELECT COALESCE(v.awardAtVisit, m.award) as award, COUNT(DISTINCT m.id) as count
FROM visits v
JOIN michelin_restaurants m ON v.restaurantId = m.id
WHERE v.status = 'confirmed' __YEAR_FILTER__
GROUP BY COALESCE(v.awardAtVisit, m.award)`;

const LEGACY_DISTINCT_STARRED_SQL = `SELECT COUNT(DISTINCT m.id) as count
FROM visits v
JOIN michelin_restaurants m ON v.restaurantId = m.id
WHERE v.status = 'confirmed' __YEAR_FILTER__
  AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')`;

const LEGACY_DISTINCT_STARS_SQL = `SELECT SUM(
  CASE
    WHEN lower(t.award) LIKE '%3 star%' THEN 3
    WHEN lower(t.award) LIKE '%2 star%' THEN 2
    WHEN lower(t.award) LIKE '%1 star%' THEN 1
    ELSE 0
  END
) as distinctStars
FROM (
  SELECT DISTINCT m.id, COALESCE(v.awardAtVisit, m.award) as award
  FROM visits v
  JOIN michelin_restaurants m ON v.restaurantId = m.id
  WHERE v.status = 'confirmed' __YEAR_FILTER__
    AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')
) t`;

const LEGACY_GREEN_STARS_SQL = `SELECT COUNT(DISTINCT v.id) as count
FROM visits v
JOIN michelin_restaurants m ON v.restaurantId = m.id
WHERE v.status = 'confirmed' __YEAR_FILTER__
  AND (COALESCE(v.awardAtVisit, m.award) LIKE '%Green Star%' OR COALESCE(v.awardAtVisit, m.award) LIKE '%green star%')`;

const SYNTHETIC_AWARDS: ReadonlyArray<string | null> = [
  "3 Stars",
  "2 Stars",
  "1 Star",
  "Bib Gourmand",
  "Selected",
  "Green Star",
  "Bib / 1 Star / Green Star",
  "3 Stars / 2 Stars",
  "MICHELIN 2 STARS",
  "Sélection étoilée 雪",
  "Plate",
  "",
  null,
];

const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  samples: 9,
  warmupIterations: 2,
  outputPath: ".build/wrapped-stats-michelin-profile.json",
};

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    let metadata;
    try {
      metadata = lstatSync(existingAncestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        break;
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      if (seenSymlinks.has(existingAncestor)) {
        throw new Error(`Benchmark output path contains a symbolic-link cycle at ${existingAncestor}.`);
      }
      seenSymlinks.add(existingAncestor);
      const target = resolve(dirname(existingAncestor), readlinkSync(existingAncestor));
      return resolve(canonicalizePotentialPath(target, seenSymlinks), ...missingSegments);
    }
    return resolve(realpathSync(existingAncestor), ...missingSegments);
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function sourceDatabasePathVariants(databasePath: string): string[] {
  const resolvedDatabasePath = resolve(databasePath);
  return [...new Set([resolvedDatabasePath, realpathSync(resolvedDatabasePath)])];
}

function protectedSourcePaths(databasePath: string): Array<{ readonly path: string; readonly label: string }> {
  return sourceDatabasePathVariants(databasePath).flatMap((basePath) => [
    { path: basePath, label: "source database" },
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => ({
      path: `${basePath}${suffix}`,
      label: `source database ${suffix} sidecar`,
    })),
  ]);
}

/** Prevent the profiler report writer from targeting its read-only source or SQLite sidecars. */
export function assertBenchmarkOutputDoesNotAliasDatabase(databasePath: string, outputPath: string): void {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedOutputPath = resolve(outputPath);
  if (!existsSync(resolvedDatabasePath) || !statSync(resolvedDatabasePath).isFile()) {
    throw new Error(`Database path is not a file: ${resolvedDatabasePath}`);
  }

  const outputCanonicalPath = canonicalizePotentialPath(resolvedOutputPath);
  const outputIdentity = existsSync(resolvedOutputPath) ? statSync(resolvedOutputPath) : null;
  for (const protectedPath of protectedSourcePaths(resolvedDatabasePath)) {
    if (canonicalizePotentialPath(protectedPath.path) === outputCanonicalPath) {
      throw new Error(`Benchmark output path must not alias the ${protectedPath.label}.`);
    }
    if (outputIdentity !== null && existsSync(protectedPath.path)) {
      const protectedIdentity = statSync(protectedPath.path);
      if (protectedIdentity.dev === outputIdentity.dev && protectedIdentity.ino === outputIdentity.ino) {
        throw new Error(`Benchmark output path must not be a hard link to the ${protectedPath.label}.`);
      }
    }
  }
}

function assertSourceHasNoPendingWal(databasePath: string): void {
  for (const basePath of sourceDatabasePathVariants(databasePath)) {
    const walPath = `${basePath}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      throw new Error(
        `Source database has a non-empty WAL sidecar at ${walPath}; checkpoint and close its writer before profiling an immutable snapshot.`,
      );
    }
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(resolve(databasePath));
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function usage(): string {
  return `Usage: benchmark-wrapped-stats-michelin.ts [options]

  --database=PATH  Open a Palate database read-only and build an anonymized
                   in-memory fixture from its visits and Michelin awards.
                   Source IDs are replaced and no names or IDs are reported.
  --samples=N      Measured counterbalanced pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Counterbalanced warmup pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help

Timed regions include statement preparation/execution, SQLite row decoding,
and Michelin-stat hydration for both all-time and one UTC-year scope. Source
loading/anonymization, fixture seeding, correctness checks, Expo scheduling,
and React Native rendering are excluded.`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0) {
      throw new RangeError(`${option} cannot be empty.`);
    }
    switch (option) {
      case "--database":
        configuration = { ...configuration, databasePath: resolve(value) };
        break;
      case "--samples":
        configuration = { ...configuration, samples: parseInteger(value, option) };
        break;
      case "--warmup":
        configuration = { ...configuration, warmupIterations: parseInteger(value, option, true) };
        break;
      case "--output":
        configuration = { ...configuration, outputPath: value };
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function finiteTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000) {
    throw new TypeError(`${label} must be a finite supported timestamp.`);
  }
  return value;
}

function createSyntheticFixture(): Fixture {
  const restaurants = Array.from(
    { length: 768 },
    (_, index): RestaurantSeed => ({
      id: `restaurant-${index.toString().padStart(4, "0")}`,
      award: SYNTHETIC_AWARDS[index % SYNTHETIC_AWARDS.length]!,
    }),
  );
  const visits: VisitSeed[] = [];
  const sourceStatusCounts: Record<string, number> = {};
  for (let index = 0; index < 18_000; index++) {
    const restaurantIndex = (Math.imul(index, 2_654_435_761) >>> 0) % restaurants.length;
    const year = 2012 + (index % 15);
    const status = index % 17 === 0 ? "pending" : index % 29 === 0 ? "rejected" : "confirmed";
    const historicalAward =
      index % 7 === 0 ? SYNTHETIC_AWARDS[(restaurantIndex + index) % SYNTHETIC_AWARDS.length]! : null;
    sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1;
    visits.push({
      id: `visit-${index.toString().padStart(5, "0")}`,
      restaurantId: index % 101 === 0 ? `orphan-${index % 11}` : restaurants[restaurantIndex]!.id,
      status,
      startTime: Date.UTC(year, index % 12, 1 + (index % 27), index % 24),
      awardAtVisit: historicalAward,
    });
  }
  return {
    mode: "deterministic-synthetic",
    sourceDatabaseSha256: null,
    sourceDatabaseBytes: null,
    sourceIntegrityCheck: null,
    sourceForeignKeyViolationCount: null,
    sourceStatusCounts,
    sourceVisitCount: visits.length,
    sourceMichelinRestaurantCount: restaurants.length,
    sourceRowsWithRestaurantId: visits.length,
    sourceRowsWithSuggestedRestaurantId: 0,
    sourceRowsWithNearbySuggestion: 0,
    sourceRowsWithHistoricalAward: visits.filter(({ awardAtVisit }) => awardAtVisit !== null).length,
    derivationCounts: null,
    restaurants,
    visits,
  };
}

function assertSourceTable(database: DatabaseSync, table: string): void {
  const row = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
    | { name?: unknown }
    | undefined;
  if (row?.name !== table) {
    throw new Error(`Source database does not contain ${table}.`);
  }
}

function assertSourceColumn(database: DatabaseSync, table: string, column: string): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name?: unknown }>;
  if (!rows.some((row) => row.name === column)) {
    throw new Error(`Source table ${table} does not contain ${column}.`);
  }
}

function createMacDerivedFixture(path: string): Fixture {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Database path is not a file: ${path}`);
  }
  assertSourceHasNoPendingWal(path);
  const sourceDatabaseBytes = statSync(path).size;
  const sourceDatabaseSha256 = sha256File(path);
  const source = new DatabaseSync(immutableDatabaseUri(path), { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON; BEGIN");
    assertSourceTable(source, "visits");
    assertSourceTable(source, "michelin_restaurants");
    assertSourceColumn(source, "visits", "awardAtVisit");

    const integrityRow = source.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    const sourceIntegrityCheck = requiredString(integrityRow?.integrity_check, "Source integrity_check");
    const sourceForeignKeyViolationCount = source.prepare("PRAGMA foreign_key_check").all().length;
    const rawRestaurants = source
      .prepare("SELECT id, award FROM michelin_restaurants ORDER BY id ASC")
      .all() as unknown as SourceRestaurantRow[];
    if (rawRestaurants.length === 0) {
      throw new Error("Mac-derived Wrapped Stats profiling requires Michelin guide rows.");
    }
    const hasVisitSuggestions =
      (
        source
          .prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'visit_suggested_restaurants'",
          )
          .get() as { present?: unknown } | undefined
      )?.present === 1;
    const nearbyRestaurantExpression = hasVisitSuggestions
      ? `(SELECT vsr.restaurantId
          FROM visit_suggested_restaurants vsr
          WHERE vsr.visitId = v.id
          ORDER BY vsr.distance ASC, vsr.restaurantId ASC
          LIMIT 1)`
      : "NULL";
    const rawVisits = source
      .prepare(`SELECT
          v.restaurantId AS restaurantId,
          v.suggestedRestaurantId AS suggestedRestaurantId,
          ${nearbyRestaurantExpression} AS nearbyRestaurantId,
          v.status AS status,
          v.startTime AS startTime,
          v.awardAtVisit AS awardAtVisit
        FROM visits v
        ORDER BY v.startTime ASC, v.id ASC`)
      .all() as unknown as SourceVisitRow[];
    if (rawVisits.length === 0) {
      throw new Error("Mac-derived Wrapped Stats profiling requires at least one source visit.");
    }

    const rawToAnonymous = new Map<string, string>();
    const anonymize = (raw: string): string => {
      const existing = rawToAnonymous.get(raw);
      if (existing !== undefined) {
        return existing;
      }
      const id = `restaurant-${rawToAnonymous.size.toString().padStart(5, "0")}`;
      rawToAnonymous.set(raw, id);
      return id;
    };
    const rawGuideIds: string[] = [];
    const restaurants = rawRestaurants.map((row, index): RestaurantSeed => {
      const rawId = requiredString(row.id, `Source Michelin restaurant ${index} id`);
      rawGuideIds.push(rawId);
      return {
        id: anonymize(rawId),
        award: nullableString(row.award, `Source Michelin restaurant ${index} award`),
      };
    });
    const rawGuideIdSet = new Set(rawGuideIds);

    const sourceStatusCounts: Record<string, number> = {};
    let sourceRowsWithRestaurantId = 0;
    let sourceRowsWithSuggestedRestaurantId = 0;
    let sourceRowsWithNearbySuggestion = 0;
    let sourceRowsWithHistoricalAward = 0;
    const mutableDerivationCounts = {
      confirmedRestaurantId: 0,
      directSuggestion: 0,
      nearbySuggestion: 0,
      deterministicGuideFallback: 0,
    };
    const visits = rawVisits.map((row, index): VisitSeed => {
      const restaurantId = nullableString(row.restaurantId, `Source visit ${index} restaurantId`);
      const suggestedRestaurantId = nullableString(
        row.suggestedRestaurantId,
        `Source visit ${index} suggestedRestaurantId`,
      );
      const nearbyRestaurantId = nullableString(row.nearbyRestaurantId, `Source visit ${index} nearbyRestaurantId`);
      const awardAtVisit = nullableString(row.awardAtVisit, `Source visit ${index} awardAtVisit`);
      const status = requiredString(row.status, `Source visit ${index} status`);
      sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1;
      if (restaurantId !== null) {
        sourceRowsWithRestaurantId += 1;
      }
      if (suggestedRestaurantId !== null) {
        sourceRowsWithSuggestedRestaurantId += 1;
      }
      if (nearbyRestaurantId !== null) {
        sourceRowsWithNearbySuggestion += 1;
      }
      if (awardAtVisit !== null) {
        sourceRowsWithHistoricalAward += 1;
      }

      let derivedRestaurantId: string;
      if (restaurantId !== null && rawGuideIdSet.has(restaurantId)) {
        derivedRestaurantId = restaurantId;
        mutableDerivationCounts.confirmedRestaurantId += 1;
      } else if (suggestedRestaurantId !== null && rawGuideIdSet.has(suggestedRestaurantId)) {
        derivedRestaurantId = suggestedRestaurantId;
        mutableDerivationCounts.directSuggestion += 1;
      } else if (nearbyRestaurantId !== null && rawGuideIdSet.has(nearbyRestaurantId)) {
        derivedRestaurantId = nearbyRestaurantId;
        mutableDerivationCounts.nearbySuggestion += 1;
      } else {
        // The deterministic multiplier spreads visits across the real guide's
        // award distribution without exposing any guide ID in the fixture or
        // report. This makes every real timestamp exercise the aggregate.
        derivedRestaurantId = rawGuideIds[(Math.imul(index, 2_654_435_761) >>> 0) % rawGuideIds.length]!;
        mutableDerivationCounts.deterministicGuideFallback += 1;
      }
      return {
        id: `visit-${index.toString().padStart(6, "0")}`,
        restaurantId: anonymize(derivedRestaurantId),
        status: "confirmed",
        startTime: finiteTimestamp(row.startTime, `Source visit ${index} startTime`),
        awardAtVisit,
      };
    });

    const fixture: Fixture = {
      mode: "mac-database-derived",
      sourceDatabaseSha256,
      sourceDatabaseBytes,
      sourceIntegrityCheck,
      sourceForeignKeyViolationCount,
      sourceStatusCounts,
      sourceVisitCount: rawVisits.length,
      sourceMichelinRestaurantCount: rawRestaurants.length,
      sourceRowsWithRestaurantId,
      sourceRowsWithSuggestedRestaurantId,
      sourceRowsWithNearbySuggestion,
      sourceRowsWithHistoricalAward,
      derivationCounts: mutableDerivationCounts,
      restaurants,
      visits,
    };
    source.exec("COMMIT");
    return fixture;
  } catch (error) {
    if (source.isTransaction) {
      source.exec("ROLLBACK");
    }
    throw error;
  } finally {
    source.close();
  }
}

function createRuntimeDatabase(fixture: Fixture): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;
    PRAGMA foreign_keys = OFF;

    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      award TEXT
    );

    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      awardAtVisit TEXT
    );

    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_restaurant_status_time
      ON visits(restaurantId, status, startTime DESC);
  `);
  const insertRestaurant = database.prepare("INSERT INTO michelin_restaurants (id, award) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime, awardAtVisit) VALUES (?, ?, ?, ?, ?)",
  );
  database.exec("BEGIN");
  try {
    for (const restaurant of fixture.restaurants) {
      insertRestaurant.run(restaurant.id, restaurant.award);
    }
    for (const visit of fixture.visits) {
      insertVisit.run(visit.id, visit.restaurantId, visit.status, visit.startTime, visit.awardAtVisit);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return database;
}

function withLegacyYearFilter(sql: string, year: number | null): string {
  return sql.replace(
    "__YEAR_FILTER__",
    year ? "AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) = ?" : "",
  );
}

function emptyMichelinStats(
  distinctStarredRestaurants: number,
  distinctStars: number,
  greenStarVisits: number,
): MichelinStats {
  return {
    threeStars: 0,
    twoStars: 0,
    oneStars: 0,
    bibGourmand: 0,
    selected: 0,
    distinctThreeStars: 0,
    distinctTwoStars: 0,
    distinctOneStars: 0,
    distinctBibGourmand: 0,
    distinctSelected: 0,
    totalStarredVisits: 0,
    distinctStarredRestaurants,
    totalAccumulatedStars: 0,
    distinctStars,
    greenStarVisits,
  };
}

function executeLegacy(database: DatabaseSync, year: number | null): Measurement {
  const startedAt = performance.now();
  const parameters = year ? [String(year)] : [];
  const all = <T>(sql: string): T[] =>
    database.prepare(withLegacyYearFilter(sql, year)).all(...parameters) as unknown as T[];
  const get = <T>(sql: string): T | undefined =>
    database.prepare(withLegacyYearFilter(sql, year)).get(...parameters) as unknown as T | undefined;
  const visitCounts = all<AwardCountRow>(LEGACY_VISIT_COUNTS_SQL);
  const restaurantCounts = all<AwardCountRow>(LEGACY_RESTAURANT_COUNTS_SQL);
  const distinctStarredRestaurants = get<CountRow>(LEGACY_DISTINCT_STARRED_SQL)?.count ?? 0;
  const distinctStars = get<DistinctStarsRow>(LEGACY_DISTINCT_STARS_SQL)?.distinctStars ?? 0;
  const greenStarVisits = get<CountRow>(LEGACY_GREEN_STARS_SQL)?.count ?? 0;
  const result = emptyMichelinStats(Number(distinctStarredRestaurants), Number(distinctStars), Number(greenStarVisits));

  for (const row of visitCounts) {
    if (!row.award) {
      continue;
    }
    const award = row.award.toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      result.threeStars += count;
      result.totalAccumulatedStars += count * 3;
    } else if (award.includes("2 star")) {
      result.twoStars += count;
      result.totalAccumulatedStars += count * 2;
    } else if (award.includes("1 star")) {
      result.oneStars += count;
      result.totalAccumulatedStars += count;
    } else if (award.includes("bib")) {
      result.bibGourmand += count;
    } else if (award.includes("selected")) {
      result.selected += count;
    }
    result.totalStarredVisits += count;
  }
  for (const row of restaurantCounts) {
    if (!row.award) {
      continue;
    }
    const award = row.award.toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      result.distinctThreeStars += count;
    } else if (award.includes("2 star")) {
      result.distinctTwoStars += count;
    } else if (award.includes("1 star")) {
      result.distinctOneStars += count;
    } else if (award.includes("bib")) {
      result.distinctBibGourmand += count;
    } else if (award.includes("selected")) {
      result.distinctSelected += count;
    }
  }
  return { elapsedMilliseconds: performance.now() - startedAt, sqliteCalls: 5, result };
}

function executeCandidate(database: DatabaseSync, year: number | null): Measurement {
  const startedAt = performance.now();
  const query = buildWrappedStatsMichelinQuery(year);
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as WrappedStatsMichelinQueryRow[];
  const result = parseWrappedStatsMichelinRows(rows);
  return { elapsedMilliseconds: performance.now() - startedAt, sqliteCalls: 1, result };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarize(samples: readonly number[]): MeasurementSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  return iteration % 2 === 0 ? ["legacyFiveQueries", "consolidatedQuery"] : ["consolidatedQuery", "legacyFiveQueries"];
}

function explain(database: DatabaseSync, sql: string, parameters: readonly string[]): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as unknown as QueryPlanRow[]).map(
    ({ detail }) => detail,
  );
}

function selectRepresentativeYear(database: DatabaseSync): number {
  const row = database
    .prepare(`SELECT strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) AS year
      FROM visits v
      JOIN michelin_restaurants m ON v.restaurantId = m.id
      WHERE v.status = 'confirmed'
      GROUP BY year
      ORDER BY COUNT(*) DESC, year DESC
      LIMIT 1`)
    .get() as SelectedYearRow | undefined;
  const year = Number(row?.year);
  return Number.isSafeInteger(year) ? year : new Date().getUTCFullYear();
}

function workloadCoverage(database: DatabaseSync): {
  readonly confirmedVisits: number;
  readonly joinedVisits: number;
  readonly distinctAssignedRestaurants: number;
  readonly nonEmptyAwardVisits: number;
  readonly exactAwardGroups: number;
} {
  const row = database
    .prepare(`SELECT
      (SELECT COUNT(*) FROM visits WHERE status = 'confirmed') AS confirmedVisits,
      COUNT(*) AS joinedVisits,
      COUNT(DISTINCT m.id) AS distinctAssignedRestaurants,
      SUM(CASE WHEN COALESCE(v.awardAtVisit, m.award) != '' THEN 1 ELSE 0 END) AS nonEmptyAwardVisits,
      COUNT(DISTINCT CASE
        WHEN COALESCE(v.awardAtVisit, m.award) != '' THEN COALESCE(v.awardAtVisit, m.award)
      END) AS exactAwardGroups
    FROM visits v
    JOIN michelin_restaurants m ON v.restaurantId = m.id
    WHERE v.status = 'confirmed'`)
    .get() as
    | {
        confirmedVisits?: unknown;
        joinedVisits?: unknown;
        distinctAssignedRestaurants?: unknown;
        nonEmptyAwardVisits?: unknown;
        exactAwardGroups?: unknown;
      }
    | undefined;
  return {
    confirmedVisits: Number(row?.confirmedVisits ?? 0),
    joinedVisits: Number(row?.joinedVisits ?? 0),
    distinctAssignedRestaurants: Number(row?.distinctAssignedRestaurants ?? 0),
    nonEmptyAwardVisits: Number(row?.nonEmptyAwardVisits ?? 0),
    exactAwardGroups: Number(row?.exactAwardGroups ?? 0),
  };
}

function measureScope(
  database: DatabaseSync,
  scope: Scope,
  year: number | null,
  configuration: Configuration,
): {
  readonly oracle: Measurement;
  readonly candidate: Measurement;
  readonly legacy: MeasurementSummary;
  readonly consolidated: MeasurementSummary;
} {
  const oracle = executeLegacy(database, year);
  const candidate = executeCandidate(database, year);
  assert.deepEqual(candidate.result, oracle.result, `${scope} candidate differs from the independent legacy oracle`);
  assert.equal(oracle.sqliteCalls, 5);
  assert.equal(candidate.sqliteCalls, 1);

  for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
    for (const strategy of strategyOrder(iteration)) {
      const measurement =
        strategy === "legacyFiveQueries" ? executeLegacy(database, year) : executeCandidate(database, year);
      assert.deepEqual(measurement.result, oracle.result);
    }
  }

  const samples: Record<Strategy, number[]> = { legacyFiveQueries: [], consolidatedQuery: [] };
  for (let iteration = 0; iteration < configuration.samples; iteration++) {
    for (const strategy of strategyOrder(iteration)) {
      const measurement =
        strategy === "legacyFiveQueries" ? executeLegacy(database, year) : executeCandidate(database, year);
      assert.deepEqual(measurement.result, oracle.result);
      samples[strategy].push(measurement.elapsedMilliseconds);
    }
  }
  return {
    oracle,
    candidate,
    legacy: summarize(samples.legacyFiveQueries),
    consolidated: summarize(samples.consolidatedQuery),
  };
}

function timingReport(measurement: ReturnType<typeof measureScope>): {
  readonly legacyFiveQueries: MeasurementSummary;
  readonly consolidatedQuery: MeasurementSummary;
  readonly medianSpeedup: number;
  readonly medianMillisecondsSaved: number;
} {
  return {
    legacyFiveQueries: measurement.legacy,
    consolidatedQuery: measurement.consolidated,
    medianSpeedup: measurement.legacy.medianMilliseconds / measurement.consolidated.medianMilliseconds,
    medianMillisecondsSaved: measurement.legacy.medianMilliseconds - measurement.consolidated.medianMilliseconds,
  };
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
    return;
  }
  const outputPath = resolve(configuration.outputPath);
  if (configuration.databasePath !== null) {
    assertBenchmarkOutputDoesNotAliasDatabase(configuration.databasePath, outputPath);
  }
  const fixture =
    configuration.databasePath === null
      ? createSyntheticFixture()
      : createMacDerivedFixture(configuration.databasePath);
  const database = createRuntimeDatabase(fixture);
  try {
    const productionPlan = countWrappedStatsProductionSqlCalls();
    const representativeYear = selectRepresentativeYear(database);
    const workload = workloadCoverage(database);
    const allTime = measureScope(database, "allTime", null, configuration);
    const selectedYear = measureScope(database, "selectedYear", representativeYear, configuration);
    assert.ok(workload.joinedVisits > 0, "benchmark fixture must contain confirmed guide-linked visits");
    assert.ok(workload.nonEmptyAwardVisits > 0, "benchmark fixture must exercise non-empty Michelin awards");
    assert.ok(workload.exactAwardGroups > 1, "benchmark fixture must exercise multiple exact Michelin awards");
    assert.ok(allTime.candidate.result.totalStarredVisits > 0, "benchmark fixture must produce Michelin stats");
    const allTimeCandidateQuery = buildWrappedStatsMichelinQuery(null);
    const selectedYearCandidateQuery = buildWrappedStatsMichelinQuery(representativeYear);
    const report = {
      schemaVersion: 1,
      benchmark: "wrapped-stats-michelin",
      scope: {
        timed:
          "Node SQLite statement preparation/execution, row decoding, and Michelin-stat hydration for all-time and one UTC year",
        excluded: [
          "source loading and anonymization",
          "in-memory fixture seeding",
          "correctness checks and hashing",
          "Expo asynchronous SQLite scheduling",
          "React Native rendering",
        ],
        sourceMutation:
          fixture.mode === "mac-database-derived"
            ? "None: the source is opened through a read-only SQLite immutable URI in one read transaction after rejecting a non-empty WAL; its main-file SHA-256 is verified after report writing."
            : "None: deterministic synthetic mode does not open a source database.",
      },
      configuration: {
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
        counterbalanced: true,
        representativeUtcYear: representativeYear,
      },
      dataset: {
        mode: fixture.mode,
        sourceDatabaseSha256: fixture.sourceDatabaseSha256,
        sourceDatabaseBytes: fixture.sourceDatabaseBytes,
        sourceIntegrityCheck: fixture.sourceIntegrityCheck,
        sourceForeignKeyViolationCount: fixture.sourceForeignKeyViolationCount,
        sourceVisitCount: fixture.sourceVisitCount,
        sourceMichelinRestaurantCount: fixture.sourceMichelinRestaurantCount,
        sourceStatusCounts: fixture.sourceStatusCounts,
        sourceRowsWithRestaurantId: fixture.sourceRowsWithRestaurantId,
        sourceRowsWithSuggestedRestaurantId: fixture.sourceRowsWithSuggestedRestaurantId,
        sourceRowsWithNearbySuggestion: fixture.sourceRowsWithNearbySuggestion,
        sourceRowsWithHistoricalAward: fixture.sourceRowsWithHistoricalAward,
        derivationCounts: fixture.derivationCounts,
        derivedFixturePolicy:
          fixture.mode === "mac-database-derived"
            ? "All real visit timestamps are retained. Profiling copies are confirmed and assigned to an existing guide row by confirmed restaurantId, direct suggestion, nearest visit suggestion, then deterministic guide fallback. Historical awards are retained; IDs are replaced; names and source IDs are never reported."
            : "Deterministic anonymized stress fixture with historical, empty, null, Unicode, multi-label, orphan, and status variants.",
        derivedVisitCount: fixture.visits.length,
        derivedMichelinRestaurantCount: fixture.restaurants.length,
        workloadCoverage: workload,
      },
      correctness: {
        independentLiteralFiveQueryOracle: true,
        allTimeExactParity: true,
        selectedYearExactParity: true,
        allTimeResultDigest: digest(allTime.candidate.result),
        selectedYearResultDigest: digest(selectedYear.candidate.result),
        nonZeroAllTimeMetricCount: Object.values(allTime.candidate.result).filter((value) => value !== 0).length,
        allTimeMetricCount: Object.keys(allTime.candidate.result).length,
      },
      sqliteCalls: {
        allTime: { legacy: allTime.oracle.sqliteCalls, candidate: allTime.candidate.sqliteCalls },
        selectedYear: { legacy: selectedYear.oracle.sqliteCalls, candidate: selectedYear.candidate.sqliteCalls },
        productionPlan,
        wrappedStatsAllTime: {
          legacy: productionPlan.allTime + allTime.oracle.sqliteCalls - allTime.candidate.sqliteCalls,
          candidate: productionPlan.allTime,
        },
        wrappedStatsSelectedYear: {
          legacy: productionPlan.selectedYear + selectedYear.oracle.sqliteCalls - selectedYear.candidate.sqliteCalls,
          candidate: productionPlan.selectedYear,
        },
      },
      timing: {
        allTime: timingReport(allTime),
        selectedYear: timingReport(selectedYear),
      },
      queryPlans: {
        legacyAllTime: [
          explain(database, withLegacyYearFilter(LEGACY_VISIT_COUNTS_SQL, null), []),
          explain(database, withLegacyYearFilter(LEGACY_RESTAURANT_COUNTS_SQL, null), []),
          explain(database, withLegacyYearFilter(LEGACY_DISTINCT_STARRED_SQL, null), []),
          explain(database, withLegacyYearFilter(LEGACY_DISTINCT_STARS_SQL, null), []),
          explain(database, withLegacyYearFilter(LEGACY_GREEN_STARS_SQL, null), []),
        ],
        consolidatedAllTime: explain(database, allTimeCandidateQuery.sql, allTimeCandidateQuery.parameters),
        consolidatedSelectedYear: explain(
          database,
          selectedYearCandidateQuery.sql,
          selectedYearCandidateQuery.parameters,
        ),
      },
    } as const;

    mkdirSync(dirname(outputPath), { recursive: true });
    if (configuration.databasePath !== null) {
      assertBenchmarkOutputDoesNotAliasDatabase(configuration.databasePath, outputPath);
    }
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (
      configuration.databasePath !== null &&
      fixture.sourceDatabaseSha256 !== null &&
      sha256File(configuration.databasePath) !== fixture.sourceDatabaseSha256
    ) {
      throw new Error("Source database SHA-256 changed while writing the benchmark report.");
    }

    console.log(
      `Wrapped Stats Michelin profile (${fixture.mode}): ${fixture.visits.length.toLocaleString("en-US")} visits, ${fixture.restaurants.length.toLocaleString("en-US")} Michelin rows, UTC year ${representativeYear}`,
    );
    console.log(
      `SQLite calls: Michelin phase ${allTime.oracle.sqliteCalls} -> ${allTime.candidate.sqliteCalls}; all-time Wrapped Stats ${report.sqliteCalls.wrappedStatsAllTime.legacy} -> ${report.sqliteCalls.wrappedStatsAllTime.candidate}; selected year ${report.sqliteCalls.wrappedStatsSelectedYear.legacy} -> ${report.sqliteCalls.wrappedStatsSelectedYear.candidate}`,
    );
    console.log(
      `All-time median: ${allTime.legacy.medianMilliseconds.toFixed(3)} ms -> ${allTime.consolidated.medianMilliseconds.toFixed(3)} ms (${(allTime.legacy.medianMilliseconds / allTime.consolidated.medianMilliseconds).toFixed(2)}x)`,
    );
    console.log(
      `Selected-year median: ${selectedYear.legacy.medianMilliseconds.toFixed(3)} ms -> ${selectedYear.consolidated.medianMilliseconds.toFixed(3)} ms (${(selectedYear.legacy.medianMilliseconds / selectedYear.consolidated.medianMilliseconds).toFixed(2)}x)`,
    );
    console.log(`Exact parity: yes; saved anonymized profile to ${outputPath}`);
  } finally {
    database.close();
  }
}

const invokedScriptPath = process.argv[1];
if (invokedScriptPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedScriptPath)).href) {
  main();
}
