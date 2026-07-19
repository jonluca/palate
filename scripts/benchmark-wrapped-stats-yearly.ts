#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  parseWrappedStatsYearlyRows,
  WRAPPED_STATS_YEARLY_SQL,
  type WrappedStatsYearlyQueryRow,
  type WrappedStatsYearlyStat,
} from "../utils/db/wrapped-stats-yearly-core.ts";

interface Configuration {
  readonly databasePath: string | null;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface RestaurantSeed {
  readonly id: string;
  readonly name: string;
}

interface VisitSeed {
  readonly id: string;
  readonly restaurantId: string;
  readonly startTime: number;
}

interface SourceVisitRow {
  readonly startTime: unknown;
  readonly status: unknown;
  readonly restaurantId: unknown;
  readonly suggestedRestaurantId: unknown;
}

interface Fixture {
  readonly mode: "deterministic-synthetic" | "mac-database-derived";
  readonly sourceDatabaseSha256: string | null;
  readonly sourceDatabaseBytes: number | null;
  readonly sourceVisitCount: number;
  readonly sourceStatusCounts: Readonly<Record<string, number>>;
  readonly sourceRowsWithRestaurantId: number;
  readonly sourceRowsWithSuggestedRestaurantId: number;
  readonly restaurants: readonly RestaurantSeed[];
  readonly visits: readonly VisitSeed[];
}

interface LegacyYearlyRow {
  readonly year: number | string | null;
  readonly totalVisits: number;
  readonly uniqueRestaurants: number;
}

interface LegacyTopRestaurantRow {
  readonly name: string;
  readonly visits: number;
}

interface RankedRestaurantRow {
  readonly year: number | string;
  readonly name: string;
  readonly visits: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly sqliteCalls: number;
  readonly result: readonly WrappedStatsYearlyStat[];
}

interface MeasurementSummary {
  readonly samplesMilliseconds: readonly number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "legacyNPlusOne" | "batchedWindow";

const LEGACY_YEARLY_SUMMARY_SQL = `SELECT
  strftime('%Y', datetime(startTime/1000, 'unixepoch', 'localtime')) as year,
  COUNT(*) as totalVisits,
  COUNT(DISTINCT restaurantId) as uniqueRestaurants
FROM visits
WHERE status = 'confirmed' AND restaurantId IS NOT NULL
GROUP BY year
ORDER BY year DESC`;

const LEGACY_TOP_RESTAURANT_SQL = `SELECT r.name, COUNT(*) as visits
FROM visits v
JOIN restaurants r ON v.restaurantId = r.id
WHERE v.status = 'confirmed'
  AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) = ?
GROUP BY v.restaurantId
ORDER BY visits DESC
LIMIT 1`;

const RANKED_RESTAURANTS_SQL = `SELECT
  strftime('%Y', datetime(v.startTime/1000, 'unixepoch', 'localtime')) AS year,
  r.name AS name,
  COUNT(*) AS visits
FROM visits v
JOIN restaurants r ON v.restaurantId = r.id
WHERE v.status = 'confirmed'
GROUP BY year, v.restaurantId`;

const SYNTHETIC_YEAR_COUNTS = [
  [2012, 42],
  [2013, 99],
  [2014, 255],
  [2015, 175],
  [2016, 126],
  [2017, 210],
  [2018, 231],
  [2019, 532],
  [2020, 485],
  [2021, 526],
  [2022, 617],
  [2023, 930],
  [2024, 671],
  [2025, 1_025],
  [2026, 587],
] as const;
const SYNTHETIC_RESTAURANT_COUNT = 512;
const ALL_TIME_BASE_QUERY_CALLS = 24;
const SELECTED_YEAR_QUERY_CALLS = 23;
const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/wrapped-stats-yearly-profile.json",
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalizePotentialPath(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

/** Prevent the profiler's report writer from ever targeting its read-only source. */
export function assertBenchmarkOutputDoesNotAliasDatabase(databasePath: string, outputPath: string): void {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedOutputPath = resolve(outputPath);
  if (!existsSync(resolvedDatabasePath) || !statSync(resolvedDatabasePath).isFile()) {
    throw new Error(`Database path is not a file: ${resolvedDatabasePath}`);
  }

  if (canonicalizePotentialPath(resolvedDatabasePath) === canonicalizePotentialPath(resolvedOutputPath)) {
    throw new Error("Benchmark output path must not alias the source database.");
  }

  if (existsSync(resolvedOutputPath)) {
    const sourceIdentity = statSync(resolvedDatabasePath);
    const outputIdentity = statSync(resolvedOutputPath);
    if (sourceIdentity.dev === outputIdentity.dev && sourceIdentity.ino === outputIdentity.ino) {
      throw new Error("Benchmark output path must not be a hard link to the source database.");
    }
  }
}

function usage(): string {
  return `Usage: benchmark-wrapped-stats-yearly.ts [options]

  --database=PATH  Open an existing Palate SQLite database read-only and derive
                   an anonymized in-memory fixture from every visit timestamp.
                   Source rows are never updated; IDs and names are not reported.
  --samples=N      Measured counterbalanced pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Counterbalanced warmup pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help

Timed regions include statement preparation/execution, SQLite row decoding,
and yearly-result hydration. Fixture loading/seeding, correctness validation,
Expo's asynchronous SQLite layer, and app rendering are excluded.`;
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
  const restaurants = Array.from({ length: SYNTHETIC_RESTAURANT_COUNT }, (_, index) => ({
    id: `restaurant-${index.toString().padStart(4, "0")}`,
    name: index === 0 ? "Profile Café 雪" : `Profile Restaurant ${index.toString().padStart(4, "0")}`,
  }));
  const visits: VisitSeed[] = [];
  let globalIndex = 0;
  for (const [year, count] of SYNTHETIC_YEAR_COUNTS) {
    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);
    for (let index = 0; index < count; index++) {
      const restaurantIndex = (Math.imul(globalIndex, 2_654_435_761) >>> 0) % restaurants.length;
      visits.push({
        id: `visit-${globalIndex.toString().padStart(5, "0")}`,
        restaurantId: restaurants[restaurantIndex]!.id,
        startTime: Math.floor(yearStart + ((yearEnd - yearStart - 1) * (index + 0.5)) / count),
      });
      globalIndex += 1;
    }
  }
  return {
    mode: "deterministic-synthetic",
    sourceDatabaseSha256: null,
    sourceDatabaseBytes: null,
    sourceVisitCount: visits.length,
    sourceStatusCounts: { synthetic: visits.length },
    sourceRowsWithRestaurantId: visits.length,
    sourceRowsWithSuggestedRestaurantId: 0,
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

function createMacDerivedFixture(path: string): Fixture {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Database path is not a file: ${path}`);
  }
  const sourceDatabaseBytes = statSync(path).size;
  const sourceDatabaseSha256 = sha256File(path);
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON");
    assertSourceTable(source, "visits");
    const rows = source
      .prepare(`SELECT startTime, status, restaurantId, suggestedRestaurantId
        FROM visits
        ORDER BY startTime ASC, id ASC`)
      .all() as unknown as SourceVisitRow[];
    if (rows.length === 0) {
      throw new Error("Mac-derived Wrapped Stats profiling requires at least one source visit.");
    }

    const rawRestaurantToAnonymous = new Map<string, string>();
    const restaurants: RestaurantSeed[] = [];
    const anonymizeRestaurant = (rawKey: string): string => {
      const existing = rawRestaurantToAnonymous.get(rawKey);
      if (existing !== undefined) {
        return existing;
      }
      const index = rawRestaurantToAnonymous.size;
      const id = `restaurant-${index.toString().padStart(4, "0")}`;
      rawRestaurantToAnonymous.set(rawKey, id);
      restaurants.push({ id, name: `Anonymized Restaurant ${index.toString().padStart(4, "0")}` });
      return id;
    };

    const sourceStatusCounts: Record<string, number> = {};
    let sourceRowsWithRestaurantId = 0;
    let sourceRowsWithSuggestedRestaurantId = 0;
    const visits = rows.map((row, index): VisitSeed => {
      const status = requiredString(row.status, `Source visit ${index} status`);
      sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1;
      const restaurantId = nullableString(row.restaurantId, `Source visit ${index} restaurantId`);
      const suggestedRestaurantId = nullableString(
        row.suggestedRestaurantId,
        `Source visit ${index} suggestedRestaurantId`,
      );
      if (restaurantId !== null) {
        sourceRowsWithRestaurantId += 1;
      }
      if (suggestedRestaurantId !== null) {
        sourceRowsWithSuggestedRestaurantId += 1;
      }
      // Preserve real visit timestamps and known restaurant grouping, but make
      // currently unassigned visits useful for confirmed-stats profiling via a
      // bounded anonymous fallback pool. The source database remains untouched.
      const rawRestaurantKey =
        restaurantId !== null
          ? `restaurant:${restaurantId}`
          : suggestedRestaurantId !== null
            ? `suggested:${suggestedRestaurantId}`
            : `fallback:${index % 257}`;
      return {
        id: `visit-${index.toString().padStart(5, "0")}`,
        restaurantId: anonymizeRestaurant(rawRestaurantKey),
        startTime: finiteTimestamp(row.startTime, `Source visit ${index} startTime`),
      };
    });

    return {
      mode: "mac-database-derived",
      sourceDatabaseSha256,
      sourceDatabaseBytes,
      sourceVisitCount: rows.length,
      sourceStatusCounts,
      sourceRowsWithRestaurantId,
      sourceRowsWithSuggestedRestaurantId,
      restaurants,
      visits,
    };
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

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL
    );

    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_restaurant_status_time
      ON visits(restaurantId, status, startTime DESC);
    CREATE INDEX idx_visits_time ON visits(startTime);
  `);
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime) VALUES (?, ?, 'confirmed', ?)",
  );
  database.exec("BEGIN");
  try {
    for (const restaurant of fixture.restaurants) {
      insertRestaurant.run(restaurant.id, restaurant.name);
    }
    for (const visit of fixture.visits) {
      insertVisit.run(visit.id, visit.restaurantId, visit.startTime);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return database;
}

function executeLegacy(database: DatabaseSync): Measurement {
  const startedAt = performance.now();
  let sqliteCalls = 1;
  const yearlyRows = database.prepare(LEGACY_YEARLY_SUMMARY_SQL).all() as unknown as LegacyYearlyRow[];
  const topStatement = database.prepare(LEGACY_TOP_RESTAURANT_SQL);
  const result = yearlyRows.map((row): WrappedStatsYearlyStat => {
    sqliteCalls += 1;
    const top = topStatement.get(row.year!.toString()) as LegacyTopRestaurantRow | undefined;
    return {
      year: Number(row.year),
      totalVisits: Number(row.totalVisits),
      uniqueRestaurants: Number(row.uniqueRestaurants),
      topRestaurant: top === undefined ? null : { name: top.name, visits: Number(top.visits) },
    };
  });
  return { elapsedMilliseconds: performance.now() - startedAt, sqliteCalls, result };
}

function executeCandidate(database: DatabaseSync): Measurement {
  const startedAt = performance.now();
  const rows = database.prepare(WRAPPED_STATS_YEARLY_SQL).all() as unknown as WrappedStatsYearlyQueryRow[];
  const result = parseWrappedStatsYearlyRows(rows);
  return { elapsedMilliseconds: performance.now() - startedAt, sqliteCalls: 1, result };
}

function topCandidateNamesByYear(database: DatabaseSync): Map<number, Set<string>> {
  const rows = database.prepare(RANKED_RESTAURANTS_SQL).all() as unknown as RankedRestaurantRow[];
  const maximumByYear = new Map<number, number>();
  for (const row of rows) {
    const year = Number(row.year);
    maximumByYear.set(year, Math.max(maximumByYear.get(year) ?? 0, Number(row.visits)));
  }
  const names = new Map<number, Set<string>>();
  for (const row of rows) {
    const year = Number(row.year);
    if (Number(row.visits) !== maximumByYear.get(year)) {
      continue;
    }
    const set = names.get(year) ?? new Set<string>();
    set.add(row.name);
    names.set(year, set);
  }
  return names;
}

function compareResults(
  legacy: readonly WrappedStatsYearlyStat[],
  candidate: readonly WrappedStatsYearlyStat[],
  topCandidates: ReadonlyMap<number, ReadonlySet<string>>,
): { readonly exact: boolean; readonly tieOnlyNameDifferences: number } {
  assert.equal(candidate.length, legacy.length);
  let exact = true;
  let tieOnlyNameDifferences = 0;
  for (let index = 0; index < legacy.length; index++) {
    const before = legacy[index]!;
    const after = candidate[index]!;
    assert.equal(after.year, before.year);
    assert.equal(after.totalVisits, before.totalVisits);
    assert.equal(after.uniqueRestaurants, before.uniqueRestaurants);
    if (after.topRestaurant?.name === before.topRestaurant?.name) {
      assert.deepEqual(after.topRestaurant, before.topRestaurant);
      continue;
    }
    exact = false;
    assert.notEqual(after.topRestaurant, null);
    assert.notEqual(before.topRestaurant, null);
    assert.equal(after.topRestaurant!.visits, before.topRestaurant!.visits);
    const tied = topCandidates.get(after.year);
    assert.ok(tied !== undefined && tied.size > 1);
    assert.ok(tied.has(after.topRestaurant!.name));
    assert.ok(tied.has(before.topRestaurant!.name));
    tieOnlyNameDifferences += 1;
  }
  return { exact, tieOnlyNameDifferences };
}

function exactDigest(result: readonly WrappedStatsYearlyStat[]): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function definedSemanticsDigest(result: readonly WrappedStatsYearlyStat[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        result.map((row) => ({
          year: row.year,
          totalVisits: row.totalVisits,
          uniqueRestaurants: row.uniqueRestaurants,
          topRestaurantVisits: row.topRestaurant?.visits ?? null,
        })),
      ),
    )
    .digest("hex");
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
  return iteration % 2 === 0 ? ["legacyNPlusOne", "batchedWindow"] : ["batchedWindow", "legacyNPlusOne"];
}

function explain(database: DatabaseSync, sql: string, ...parameters: (string | number)[]): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as unknown as QueryPlanRow[]).map(
    ({ detail }) => detail,
  );
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
    const topCandidates = topCandidateNamesByYear(database);
    const oracle = executeLegacy(database);
    const validation = executeCandidate(database);
    const parity = compareResults(oracle.result, validation.result, topCandidates);
    assert.equal(definedSemanticsDigest(oracle.result), definedSemanticsDigest(validation.result));
    const yearCount = validation.result.length;
    assert.equal(oracle.sqliteCalls, 1 + yearCount);
    assert.equal(validation.sqliteCalls, 1);

    for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
      for (const strategy of strategyOrder(iteration)) {
        const measurement = strategy === "legacyNPlusOne" ? executeLegacy(database) : executeCandidate(database);
        compareResults(oracle.result, measurement.result, topCandidates);
      }
    }

    const samples: Record<Strategy, number[]> = { legacyNPlusOne: [], batchedWindow: [] };
    for (let iteration = 0; iteration < configuration.samples; iteration++) {
      for (const strategy of strategyOrder(iteration)) {
        const measurement = strategy === "legacyNPlusOne" ? executeLegacy(database) : executeCandidate(database);
        compareResults(oracle.result, measurement.result, topCandidates);
        samples[strategy].push(measurement.elapsedMilliseconds);
      }
    }

    const legacySummary = summarize(samples.legacyNPlusOne);
    const candidateSummary = summarize(samples.batchedWindow);
    const representativeYear = validation.result[0]?.year ?? new Date().getUTCFullYear();
    const report = {
      schemaVersion: 1,
      benchmark: "wrapped-stats-yearly",
      scope: {
        timed: "Node SQLite statement preparation/execution, row decoding, and yearly result hydration",
        excluded: [
          "source loading and anonymization",
          "in-memory fixture seeding",
          "correctness checks and hashing",
          "Expo asynchronous SQLite scheduling",
          "React Native rendering",
        ],
        sourceMutation: false,
      },
      configuration: {
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
        counterbalanced: true,
      },
      dataset: {
        mode: fixture.mode,
        sourceDatabaseSha256: fixture.sourceDatabaseSha256,
        sourceDatabaseBytes: fixture.sourceDatabaseBytes,
        sourceVisitCount: fixture.sourceVisitCount,
        sourceStatusCounts: fixture.sourceStatusCounts,
        sourceRowsWithRestaurantId: fixture.sourceRowsWithRestaurantId,
        sourceRowsWithSuggestedRestaurantId: fixture.sourceRowsWithSuggestedRestaurantId,
        derivedFixturePolicy:
          fixture.mode === "mac-database-derived"
            ? "All source timestamps are retained; IDs/names are replaced and visits are confirmed only in the in-memory fixture."
            : "Deterministic anonymized fixture shaped like the 6,511-visit Mac dataset.",
        derivedVisitCount: fixture.visits.length,
        derivedRestaurantCount: fixture.restaurants.length,
        utcYearCount: yearCount,
      },
      correctness: {
        independentLegacyOracle: true,
        definedSemanticsParity: true,
        exactResultParity: parity.exact,
        tieOnlyTopRestaurantNameDifferences: parity.tieOnlyNameDifferences,
        legacyExactDigest: exactDigest(oracle.result),
        candidateExactDigest: exactDigest(validation.result),
        definedSemanticsDigest: definedSemanticsDigest(validation.result),
        candidateTieRule: "highest visit count, then restaurantId ascending",
        legacyTieRule: "unspecified and SQLite-query-plan-dependent",
      },
      sqliteCalls: {
        yearlyPhase: { legacy: oracle.sqliteCalls, candidate: validation.sqliteCalls },
        wrappedStatsAllTime: {
          legacy: ALL_TIME_BASE_QUERY_CALLS + yearCount,
          candidate: ALL_TIME_BASE_QUERY_CALLS,
        },
        wrappedStatsSelectedYear: {
          legacy: SELECTED_YEAR_QUERY_CALLS,
          candidate: SELECTED_YEAR_QUERY_CALLS,
        },
      },
      timing: {
        legacyNPlusOne: legacySummary,
        batchedWindow: candidateSummary,
        medianSpeedup: legacySummary.medianMilliseconds / candidateSummary.medianMilliseconds,
        medianMillisecondsSaved: legacySummary.medianMilliseconds - candidateSummary.medianMilliseconds,
      },
      queryPlans: {
        legacyYearlySummary: explain(database, LEGACY_YEARLY_SUMMARY_SQL),
        legacyPerYearTopRestaurant: explain(database, LEGACY_TOP_RESTAURANT_SQL, String(representativeYear)),
        batchedWindow: explain(database, WRAPPED_STATS_YEARLY_SQL),
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
      `Wrapped Stats yearly profile (${fixture.mode}): ${fixture.visits.length.toLocaleString("en-US")} visits, ${yearCount} UTC years`,
    );
    console.log(
      `SQLite calls: yearly ${oracle.sqliteCalls} -> ${validation.sqliteCalls}; all-time Wrapped Stats ${ALL_TIME_BASE_QUERY_CALLS + yearCount} -> ${ALL_TIME_BASE_QUERY_CALLS}`,
    );
    console.log(
      `Defined-semantics parity: yes; exact parity: ${parity.exact ? "yes" : `no (${parity.tieOnlyNameDifferences} equal-count tie-only winner changes)`}`,
    );
    console.log(
      `Median: ${legacySummary.medianMilliseconds.toFixed(3)} ms -> ${candidateSummary.medianMilliseconds.toFixed(3)} ms (${report.timing.medianSpeedup.toFixed(2)}x)`,
    );
    console.log(`Saved anonymized profile to ${outputPath}`);
  } finally {
    database.close();
  }
}

const invokedScriptPath = process.argv[1];
if (invokedScriptPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedScriptPath)).href) {
  main();
}
