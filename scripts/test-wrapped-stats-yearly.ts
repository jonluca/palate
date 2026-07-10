#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertBenchmarkOutputDoesNotAliasDatabase } from "./benchmark-wrapped-stats-yearly.ts";
import {
  parseWrappedStatsYearlyRows,
  WRAPPED_STATS_YEARLY_SQL,
  type WrappedStatsYearlyQueryRow,
  type WrappedStatsYearlyStat,
} from "../utils/db/wrapped-stats-yearly-core.ts";

interface LegacyYearlyRow {
  readonly year: number | string | null;
  readonly totalVisits: number;
  readonly uniqueRestaurants: number;
}

interface LegacyTopRestaurantRow {
  readonly name: string;
  readonly visits: number;
}

interface Execution<T> {
  readonly value: T;
  readonly sqliteCalls: number;
}

interface RankedRestaurantRow {
  readonly year: number | string;
  readonly restaurantId: string;
  readonly name: string;
  readonly visits: number;
}

// Independent oracle copied from the former production implementation. Keep
// this separate from the candidate core so changes to the optimized SQL cannot
// silently change both sides of the parity check.
const LEGACY_YEARLY_SUMMARY_SQL = `SELECT
  strftime('%Y', datetime(startTime/1000, 'unixepoch')) as year,
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
  AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) = ?
GROUP BY v.restaurantId
ORDER BY visits DESC
LIMIT 1`;

function executeLegacy(database: DatabaseSync): Execution<WrappedStatsYearlyStat[]> {
  let sqliteCalls = 1;
  const yearlyRows = database.prepare(LEGACY_YEARLY_SUMMARY_SQL).all() as unknown as LegacyYearlyRow[];
  const topRestaurantStatement = database.prepare(LEGACY_TOP_RESTAURANT_SQL);
  const value = yearlyRows.map((row) => {
    sqliteCalls += 1;
    const topRestaurant = topRestaurantStatement.get(row.year!.toString()) as LegacyTopRestaurantRow | undefined;
    return {
      year: Number(row.year),
      totalVisits: Number(row.totalVisits),
      uniqueRestaurants: Number(row.uniqueRestaurants),
      topRestaurant:
        topRestaurant === undefined
          ? null
          : {
              name: topRestaurant.name,
              visits: Number(topRestaurant.visits),
            },
    };
  });
  return { value, sqliteCalls };
}

function executeCandidate(database: DatabaseSync): Execution<WrappedStatsYearlyStat[]> {
  const rows = database.prepare(WRAPPED_STATS_YEARLY_SQL).all() as unknown as WrappedStatsYearlyQueryRow[];
  return { value: parseWrappedStatsYearlyRows(rows), sqliteCalls: 1 };
}

function executeDeterministicTieOracle(database: DatabaseSync): WrappedStatsYearlyStat[] {
  const yearly = database.prepare(LEGACY_YEARLY_SUMMARY_SQL).all() as unknown as LegacyYearlyRow[];
  const ranked = database
    .prepare(`SELECT
      strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) AS year,
      v.restaurantId AS restaurantId,
      r.name AS name,
      COUNT(*) AS visits
    FROM visits v
    JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.status = 'confirmed'
    GROUP BY year, v.restaurantId
    ORDER BY year DESC, visits DESC, restaurantId ASC`)
    .all() as unknown as RankedRestaurantRow[];
  const topByYear = new Map<string, RankedRestaurantRow>();
  for (const row of ranked) {
    const year = String(row.year);
    if (!topByYear.has(year)) {
      topByYear.set(year, row);
    }
  }
  return yearly.map((row) => {
    const top = topByYear.get(String(row.year));
    return {
      year: Number(row.year),
      totalVisits: Number(row.totalVisits),
      uniqueRestaurants: Number(row.uniqueRestaurants),
      topRestaurant: top === undefined ? null : { name: top.name, visits: Number(top.visits) },
    };
  });
}

function assertLegacyEquivalentModuloUndefinedTies(
  database: DatabaseSync,
  candidate: readonly WrappedStatsYearlyStat[],
  legacy: readonly WrappedStatsYearlyStat[],
): number {
  assert.equal(candidate.length, legacy.length);
  const ranked = database
    .prepare(`SELECT
      strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) AS year,
      r.name AS name,
      COUNT(*) AS visits
    FROM visits v
    JOIN restaurants r ON v.restaurantId = r.id
    WHERE v.status = 'confirmed'
    GROUP BY year, v.restaurantId`)
    .all() as unknown as Array<Omit<RankedRestaurantRow, "restaurantId">>;
  let tieOnlyDifferences = 0;
  for (let index = 0; index < candidate.length; index++) {
    const candidateYear = candidate[index]!;
    const legacyYear = legacy[index]!;
    assert.equal(candidateYear.year, legacyYear.year);
    assert.equal(candidateYear.totalVisits, legacyYear.totalVisits);
    assert.equal(candidateYear.uniqueRestaurants, legacyYear.uniqueRestaurants);
    if (candidateYear.topRestaurant?.name === legacyYear.topRestaurant?.name) {
      assert.deepEqual(candidateYear.topRestaurant, legacyYear.topRestaurant);
      continue;
    }

    assert.notEqual(candidateYear.topRestaurant, null);
    assert.notEqual(legacyYear.topRestaurant, null);
    assert.equal(candidateYear.topRestaurant!.visits, legacyYear.topRestaurant!.visits);
    const tiedTopNames = ranked
      .filter(
        (row) => Number(row.year) === candidateYear.year && Number(row.visits) === candidateYear.topRestaurant!.visits,
      )
      .map((row) => row.name);
    assert.ok(tiedTopNames.includes(candidateYear.topRestaurant!.name));
    assert.ok(tiedTopNames.includes(legacyYear.topRestaurant!.name));
    assert.ok(tiedTopNames.length > 1);
    tieOnlyDifferences += 1;
  }
  return tieOnlyDifferences;
}

function createDatabase(withProductionIndexes: boolean): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = OFF;

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
  `);
  if (withProductionIndexes) {
    database.exec(`
      CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
      CREATE INDEX idx_visits_restaurant_status_time
        ON visits(restaurantId, status, startTime DESC);
    `);
  }
  return database;
}

function utc(year: number, month = 0, day = 1, hour = 12): number {
  return Date.UTC(year, month, day, hour, 0, 0, 0);
}

function seedFocusedFixture(database: DatabaseSync): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status, startTime) VALUES (?, ?, ?, ?)");

  database.exec("BEGIN");
  try {
    insertRestaurant.run("a-tie", "Alpha");
    insertRestaurant.run("z-tie", "Zulu");
    insertRestaurant.run("unicode", "寿司 O'Brien 🍣");
    insertRestaurant.run("quoted", 'JSON "Table" \\ Snow 雪');

    // Equal 2026 counts lock the candidate's explicit restaurant-ID tie order.
    // Insert the lexically later ID first to ensure insertion order is not
    // accidentally used; the legacy winner may vary with its query plan.
    insertVisit.run("2026-z-1", "z-tie", "confirmed", utc(2026, 0, 1, 0));
    insertVisit.run("2026-a-1", "a-tie", "confirmed", utc(2026, 0, 1, 0));
    insertVisit.run("2026-z-2", "z-tie", "confirmed", utc(2026, 5, 1));
    insertVisit.run("2026-a-2", "a-tie", "confirmed", utc(2026, 11, 31, 23));

    insertVisit.run("2025-unicode-1", "unicode", "confirmed", utc(2025, 0, 1, 0));
    insertVisit.run("2025-unicode-2", "unicode", "confirmed", utc(2025, 6, 1));
    insertVisit.run("2025-unicode-3", "unicode", "confirmed", utc(2025, 11, 31, 23));
    insertVisit.run("2025-alpha", "a-tie", "confirmed", utc(2025, 3, 1));
    insertVisit.run("2025-pending", "a-tie", "pending", utc(2025, 3, 2));

    // Yearly totals include non-null restaurant IDs even if the restaurant row
    // is missing, while the legacy top-restaurant join returns null.
    insertVisit.run("2024-orphan-1", "missing-a", "confirmed", utc(2024, 0, 1));
    insertVisit.run("2024-orphan-2", "missing-a", "confirmed", utc(2024, 1, 1));
    insertVisit.run("2024-orphan-3", "missing-b", "confirmed", utc(2024, 2, 1));

    insertVisit.run("2023-null", null, "confirmed", utc(2023));
    insertVisit.run("2023-rejected", "quoted", "rejected", utc(2023, 5, 1));
    insertVisit.run("2022-quoted", "quoted", "confirmed", utc(2022, 11, 31, 23));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function seedRandomFixture(database: DatabaseSync, seed: number): void {
  const random = createRandom(seed);
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status, startTime) VALUES (?, ?, ?, ?)");
  const restaurantIds = Array.from({ length: 17 }, (_, index) => `r-${index.toString().padStart(2, "0")}`);

  database.exec("BEGIN");
  try {
    for (const [index, id] of restaurantIds.entries()) {
      insertRestaurant.run(id, index === 3 ? "Café 雪" : `Restaurant ${index}`);
    }

    let visitIndex = 0;
    for (let year = 2012; year <= 2026; year++) {
      for (const restaurantId of restaurantIds) {
        const confirmedCount = Math.floor(random() * 6);
        for (let count = 0; count < confirmedCount; count++) {
          insertVisit.run(
            `random-${seed}-${visitIndex++}`,
            restaurantId,
            "confirmed",
            utc(year, Math.floor(random() * 12), 1 + Math.floor(random() * 27), Math.floor(random() * 24)),
          );
        }
        if (random() < 0.2) {
          insertVisit.run(
            `random-${seed}-${visitIndex++}`,
            restaurantId,
            random() < 0.5 ? "pending" : "rejected",
            utc(year, Math.floor(random() * 12), 1 + Math.floor(random() * 27)),
          );
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function assertFocusedParity(withProductionIndexes: boolean): void {
  const database = createDatabase(withProductionIndexes);
  try {
    seedFocusedFixture(database);
    const legacy = executeLegacy(database);
    const candidate = executeCandidate(database);
    assert.deepEqual(candidate.value, executeDeterministicTieOracle(database));
    assert.deepEqual(
      candidate.value.filter(({ year }) => year !== 2026),
      legacy.value.filter(({ year }) => year !== 2026),
    );
    assert.equal(assertLegacyEquivalentModuloUndefinedTies(database, candidate.value, legacy.value), 1);
    assert.equal(legacy.sqliteCalls, 1 + legacy.value.length);
    assert.equal(candidate.sqliteCalls, 1);
    assert.deepEqual(candidate.value, [
      {
        year: 2026,
        totalVisits: 4,
        uniqueRestaurants: 2,
        topRestaurant: { name: "Alpha", visits: 2 },
      },
      {
        year: 2025,
        totalVisits: 4,
        uniqueRestaurants: 2,
        topRestaurant: { name: "寿司 O'Brien 🍣", visits: 3 },
      },
      {
        year: 2024,
        totalVisits: 3,
        uniqueRestaurants: 2,
        topRestaurant: null,
      },
      {
        year: 2022,
        totalVisits: 1,
        uniqueRestaurants: 1,
        topRestaurant: { name: 'JSON "Table" \\ Snow 雪', visits: 1 },
      },
    ]);
  } finally {
    database.close();
  }
}

function assertRandomizedParity(withProductionIndexes: boolean): number {
  let tieOnlyDifferences = 0;
  for (let fixture = 0; fixture < 24; fixture++) {
    const database = createDatabase(withProductionIndexes);
    try {
      seedRandomFixture(database, 0x57a7_0000 + fixture);
      const candidate = executeCandidate(database).value;
      const legacy = executeLegacy(database).value;
      assert.deepEqual(candidate, executeDeterministicTieOracle(database));
      tieOnlyDifferences += assertLegacyEquivalentModuloUndefinedTies(database, candidate, legacy);
    } finally {
      database.close();
    }
  }
  return tieOnlyDifferences;
}

let randomizedTieOnlyDifferences = 0;
for (const withProductionIndexes of [false, true]) {
  assertFocusedParity(withProductionIndexes);
  randomizedTieOnlyDifferences += assertRandomizedParity(withProductionIndexes);
}

const emptyDatabase = createDatabase(true);
try {
  assert.deepEqual(executeLegacy(emptyDatabase).value, []);
  assert.deepEqual(executeCandidate(emptyDatabase).value, []);
} finally {
  emptyDatabase.close();
}

const invalidTimestampDatabase = createDatabase(true);
try {
  invalidTimestampDatabase.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run("invalid", "Invalid");
  invalidTimestampDatabase
    .prepare("INSERT INTO visits (id, restaurantId, status, startTime) VALUES (?, ?, ?, ?)")
    .run("invalid-time", "invalid", "confirmed", 8_640_000_000_000_000);
  const invalidYear = invalidTimestampDatabase
    .prepare("SELECT strftime('%Y', datetime(startTime/1000, 'unixepoch')) AS year FROM visits")
    .get() as { year: unknown };
  assert.equal(invalidYear.year, null);
  assert.throws(() => executeLegacy(invalidTimestampDatabase), TypeError);
  assert.throws(() => executeCandidate(invalidTimestampDatabase), /returned a null year/);
} finally {
  invalidTimestampDatabase.close();
}

assert.deepEqual(
  parseWrappedStatsYearlyRows([
    {
      year: "2026",
      totalVisits: 3,
      uniqueRestaurants: 2,
      topRestaurantName: null,
      topRestaurantVisits: null,
    },
  ]),
  [{ year: 2026, totalVisits: 3, uniqueRestaurants: 2, topRestaurant: null }],
);
assert.throws(
  () =>
    parseWrappedStatsYearlyRows([
      {
        year: null,
        totalVisits: 1,
        uniqueRestaurants: 1,
        topRestaurantName: null,
        topRestaurantVisits: null,
      },
    ]),
  /returned a null year/,
);
assert.throws(
  () =>
    parseWrappedStatsYearlyRows([
      {
        year: "2026.5",
        totalVisits: 1,
        uniqueRestaurants: 1,
        topRestaurantName: null,
        topRestaurantVisits: null,
      },
    ]),
  /returned an invalid year/,
);

const pathFixtureDirectory = mkdtempSync(join(tmpdir(), "palate-wrapped-stats-paths-"));
try {
  const databasePath = join(pathFixtureDirectory, "source.sqlite");
  const distinctOutputPath = join(pathFixtureDirectory, "report.json");
  const symlinkOutputPath = join(pathFixtureDirectory, "source-symlink.json");
  const hardlinkOutputPath = join(pathFixtureDirectory, "source-hardlink.json");
  writeFileSync(databasePath, "source-database-sentinel", "utf8");
  assert.doesNotThrow(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, distinctOutputPath));
  assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, databasePath), /must not alias/);
  symlinkSync(databasePath, symlinkOutputPath);
  assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, symlinkOutputPath), /must not alias/);
  linkSync(databasePath, hardlinkOutputPath);
  assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, hardlinkOutputPath), /hard link/);
  assert.equal(readFileSync(databasePath, "utf8"), "source-database-sentinel");
} finally {
  rmSync(pathFixtureDirectory, { recursive: true, force: true });
}

console.log(
  `wrapped stats yearly tests passed (independent legacy oracle; invalid-year rejection; output alias guards; 2 index modes; 48 randomized fixtures; ${randomizedTieOnlyDifferences} randomized tie-only legacy differences)`,
);
