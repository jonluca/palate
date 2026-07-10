#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { WrappedStats } from "../utils/db/types.ts";
import {
  buildWrappedStatsMichelinQuery,
  parseWrappedStatsMichelinRows,
  type WrappedStatsMichelinQueryRow,
} from "../utils/db/wrapped-stats-michelin-core.ts";
import { assertBenchmarkOutputDoesNotAliasDatabase } from "./benchmark-wrapped-stats-michelin.ts";
import { countWrappedStatsProductionSqlCalls } from "./wrapped-stats-query-call-counter.ts";

type MichelinStats = WrappedStats["michelinStats"];

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

interface Execution {
  readonly value: MichelinStats;
  readonly sqliteCalls: number;
}

// Independent oracle copied literally from the former production
// implementation. These five statements and their JavaScript hydration stay
// separate from the optimized core so a candidate change cannot silently
// redefine both sides of the parity check.
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

function withLegacyYearFilter(sql: string, year: number | null | undefined): string {
  return sql.replace("__YEAR_FILTER__", year ? "AND strftime('%Y', datetime(v.startTime/1000, 'unixepoch')) = ?" : "");
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

function executeLegacy(database: DatabaseSync, year?: number | null): Execution {
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
  const value = emptyMichelinStats(Number(distinctStarredRestaurants), Number(distinctStars), Number(greenStarVisits));

  for (const row of visitCounts) {
    if (!row.award) {
      continue;
    }
    const award = row.award.toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      value.threeStars += count;
      value.totalAccumulatedStars += count * 3;
    } else if (award.includes("2 star")) {
      value.twoStars += count;
      value.totalAccumulatedStars += count * 2;
    } else if (award.includes("1 star")) {
      value.oneStars += count;
      value.totalAccumulatedStars += count;
    } else if (award.includes("bib")) {
      value.bibGourmand += count;
    } else if (award.includes("selected")) {
      value.selected += count;
    }
    value.totalStarredVisits += count;
  }

  for (const row of restaurantCounts) {
    if (!row.award) {
      continue;
    }
    const award = row.award.toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      value.distinctThreeStars += count;
    } else if (award.includes("2 star")) {
      value.distinctTwoStars += count;
    } else if (award.includes("1 star")) {
      value.distinctOneStars += count;
    } else if (award.includes("bib")) {
      value.distinctBibGourmand += count;
    } else if (award.includes("selected")) {
      value.distinctSelected += count;
    }
  }

  return { value, sqliteCalls: 5 };
}

function executeCandidate(database: DatabaseSync, year?: number | null): Execution {
  const query = buildWrappedStatsMichelinQuery(year);
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as WrappedStatsMichelinQueryRow[];
  return { value: parseWrappedStatsMichelinRows(rows), sqliteCalls: 1 };
}

function createDatabase(withProductionIndexes: boolean): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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
  `);
  if (withProductionIndexes) {
    database.exec(`
      CREATE INDEX idx_visits_status ON visits(status);
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
  const insertRestaurant = database.prepare("INSERT INTO michelin_restaurants (id, award) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime, awardAtVisit) VALUES (?, ?, ?, ?, ?)",
  );
  const restaurants: ReadonlyArray<readonly [string, string | null]> = [
    ["r3", "3 Stars"],
    ["r2", "2 STARS"],
    ["r1", "1 Star"],
    ["rbib", "Bib Gourmand"],
    ["rselected", "Selected Restaurants"],
    ["rgreen", "Green Star"],
    ["rmulti", "Bib Gourmand / 1 Star / Green Star"],
    ["runicode", "Sélection étoilée 三星 雪"],
    ["rempty", ""],
    ["rnull", null],
    ["rhistorical", "3 Stars"],
    ["rmixed", "1 Star"],
    ["rprecedence", "3 Stars / 2 Stars / Bib Gourmand"],
    ["rother", "Plate Award"],
    ["rstatus", "2 Stars"],
  ];

  database.exec("BEGIN");
  try {
    for (const restaurant of restaurants) {
      insertRestaurant.run(...restaurant);
    }

    const visit = (
      id: string,
      restaurantId: string | null,
      status: string,
      time: number,
      awardAtVisit: string | null = null,
    ) => insertVisit.run(id, restaurantId, status, time, awardAtVisit);

    visit("2025-r3-a", "r3", "confirmed", utc(2025, 0, 1, 0));
    visit("2025-r3-b", "r3", "confirmed", utc(2025, 11, 31, 23));
    visit("2025-r2", "r2", "confirmed", utc(2025, 1, 1));
    visit("2025-r1", "r1", "confirmed", utc(2025, 2, 1));
    visit("2025-bib", "rbib", "confirmed", utc(2025, 3, 1));
    visit("2025-selected", "rselected", "confirmed", utc(2025, 4, 1));
    visit("2025-green", "rgreen", "confirmed", utc(2025, 5, 1));
    visit("2025-multi", "rmulti", "confirmed", utc(2025, 6, 1));
    visit("2025-unicode", "runicode", "confirmed", utc(2025, 7, 1));
    visit("2025-empty-current", "rempty", "confirmed", utc(2025, 8, 1));
    visit("2025-null-current", "rnull", "confirmed", utc(2025, 8, 2));
    visit("2025-historical", "rhistorical", "confirmed", utc(2025, 8, 3), "1 Star (historical)");
    visit("2025-mixed-one", "rmixed", "confirmed", utc(2025, 8, 4), "1 Star");
    visit("2025-mixed-two", "rmixed", "confirmed", utc(2025, 8, 5), "2 Stars");
    // An empty historical value is non-null and therefore suppresses fallback
    // to the restaurant's current 3-star award.
    visit("2025-empty-historical", "r3", "confirmed", utc(2025, 8, 6), "");
    visit("2025-precedence", "rprecedence", "confirmed", utc(2025, 8, 7));
    visit("2025-other", "rother", "confirmed", utc(2025, 8, 8));
    visit("2025-pending", "rstatus", "pending", utc(2025, 9, 1));
    visit("2025-rejected", "rstatus", "rejected", utc(2025, 9, 2));
    visit("2025-orphan", "missing", "confirmed", utc(2025, 9, 3), "3 Stars");

    visit("2024-bib-history", "r3", "confirmed", utc(2024, 11, 31, 23), "Bib Gourmand");
    visit("2024-two", "r2", "confirmed", utc(2024, 0, 1));
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

const RANDOM_AWARDS: ReadonlyArray<string | null> = [
  null,
  "",
  "3 Stars",
  "2 Stars",
  "1 Star",
  "Bib Gourmand",
  "Selected",
  "Green Star",
  "Bib / 1 Star / Green Star",
  "3 Stars, 2 Stars",
  "MICHELIN 2 STARS",
  "Sélection étoilée 雪",
  "Plate",
];

function seedRandomFixture(database: DatabaseSync, seed: number): void {
  const random = createRandom(seed);
  const insertRestaurant = database.prepare("INSERT INTO michelin_restaurants (id, award) VALUES (?, ?)");
  const insertVisit = database.prepare(
    "INSERT INTO visits (id, restaurantId, status, startTime, awardAtVisit) VALUES (?, ?, ?, ?, ?)",
  );
  const restaurantIds = Array.from({ length: 23 }, (_, index) => `r-${index.toString().padStart(2, "0")}`);

  database.exec("BEGIN");
  try {
    for (const [index, restaurantId] of restaurantIds.entries()) {
      insertRestaurant.run(restaurantId, RANDOM_AWARDS[index % RANDOM_AWARDS.length]);
    }
    let visitIndex = 0;
    for (let index = 0; index < 320; index++) {
      const usesOrphan = random() < 0.05;
      const restaurantId = usesOrphan
        ? `orphan-${Math.floor(random() * 3)}`
        : restaurantIds[Math.floor(random() * restaurantIds.length)]!;
      const statusRoll = random();
      const status = statusRoll < 0.72 ? "confirmed" : statusRoll < 0.88 ? "pending" : "rejected";
      const year = 2023 + Math.floor(random() * 4);
      const historicalRoll = random();
      const awardAtVisit = historicalRoll < 0.42 ? null : RANDOM_AWARDS[Math.floor(random() * RANDOM_AWARDS.length)]!;
      insertVisit.run(
        `random-${seed}-${visitIndex++}`,
        restaurantId,
        status,
        utc(year, Math.floor(random() * 12), 1 + Math.floor(random() * 27), Math.floor(random() * 24)),
        awardAtVisit,
      );
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
    for (const year of [undefined, null, 0, 2024, 2025, 2026] as const) {
      const legacy = executeLegacy(database, year);
      const candidate = executeCandidate(database, year);
      assert.deepEqual(candidate.value, legacy.value, `focused parity failed for year ${String(year)}`);
      assert.equal(legacy.sqliteCalls, 5);
      assert.equal(candidate.sqliteCalls, 1);
    }

    assert.deepEqual(executeCandidate(database, 2025).value, {
      threeStars: 3,
      twoStars: 2,
      oneStars: 4,
      bibGourmand: 1,
      selected: 1,
      distinctThreeStars: 2,
      distinctTwoStars: 2,
      distinctOneStars: 4,
      distinctBibGourmand: 1,
      distinctSelected: 1,
      totalStarredVisits: 14,
      distinctStarredRestaurants: 8,
      totalAccumulatedStars: 17,
      distinctStars: 14,
      greenStarVisits: 2,
    });
    assert.deepEqual(executeCandidate(database, 2024).value, {
      threeStars: 0,
      twoStars: 1,
      oneStars: 0,
      bibGourmand: 1,
      selected: 0,
      distinctThreeStars: 0,
      distinctTwoStars: 1,
      distinctOneStars: 0,
      distinctBibGourmand: 1,
      distinctSelected: 0,
      totalStarredVisits: 2,
      distinctStarredRestaurants: 1,
      totalAccumulatedStars: 2,
      distinctStars: 2,
      greenStarVisits: 0,
    });
  } finally {
    database.close();
  }
}

function assertRandomizedParity(withProductionIndexes: boolean): void {
  for (let fixture = 0; fixture < 24; fixture++) {
    const database = createDatabase(withProductionIndexes);
    try {
      seedRandomFixture(database, 0x4d49_4300 + fixture);
      for (const year of [undefined, 2024, 2025, 2027] as const) {
        assert.deepEqual(
          executeCandidate(database, year).value,
          executeLegacy(database, year).value,
          `random parity failed for fixture ${fixture}, year ${String(year)}, indexes ${withProductionIndexes}`,
        );
      }
    } finally {
      database.close();
    }
  }
}

for (const withProductionIndexes of [false, true]) {
  assertFocusedParity(withProductionIndexes);
  assertRandomizedParity(withProductionIndexes);
}

const emptyDatabase = createDatabase(true);
try {
  assert.deepEqual(executeLegacy(emptyDatabase).value, emptyMichelinStats(0, 0, 0));
  assert.deepEqual(executeCandidate(emptyDatabase).value, emptyMichelinStats(0, 0, 0));
} finally {
  emptyDatabase.close();
}

assert.deepEqual(
  parseWrappedStatsMichelinRows([
    {
      award: null,
      visitCount: null,
      restaurantCount: null,
      distinctStarredRestaurants: 0,
      distinctStars: null,
      greenStarVisits: 0,
    },
  ]),
  emptyMichelinStats(0, 0, 0),
);

const allTimeQuery = buildWrappedStatsMichelinQuery();
const nullYearQuery = buildWrappedStatsMichelinQuery(null);
const zeroYearQuery = buildWrappedStatsMichelinQuery(0);
const selectedYearQuery = buildWrappedStatsMichelinQuery(2025);
assert.deepEqual(allTimeQuery.parameters, []);
assert.deepEqual(nullYearQuery.parameters, []);
assert.deepEqual(zeroYearQuery.parameters, []);
assert.deepEqual(selectedYearQuery.parameters, ["2025"]);
assert.ok(!allTimeQuery.sql.includes("strftime('%Y'"));
assert.ok(selectedYearQuery.sql.includes("strftime('%Y'"));

const productionPlan = countWrappedStatsProductionSqlCalls();
assert.deepEqual(productionPlan, {
  allTime: 20,
  selectedYear: 19,
  promiseEntries: 20,
  databaseCallSites: 20,
});

const pathFixtureDirectory = mkdtempSync(join(tmpdir(), "palate-wrapped-stats-michelin-paths-"));
try {
  const sourceDirectory = join(pathFixtureDirectory, "source");
  const canonicalDirectoryAlias = join(pathFixtureDirectory, "source-directory-alias");
  mkdirSync(sourceDirectory);
  const databasePath = join(sourceDirectory, "source.sqlite");
  const distinctOutputPath = join(pathFixtureDirectory, "report.json");
  writeFileSync(databasePath, "source-database-sentinel", "utf8");
  const protectedPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  for (const [index, protectedPath] of protectedPaths.entries()) {
    if (index > 0) {
      writeFileSync(protectedPath, `protected-sentinel-${index}`, "utf8");
    }
  }
  symlinkSync(sourceDirectory, canonicalDirectoryAlias, "dir");

  assert.doesNotThrow(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, distinctOutputPath));

  for (const [index, protectedPath] of protectedPaths.entries()) {
    assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, protectedPath), /must not alias/);

    const canonicalAliasPath = join(canonicalDirectoryAlias, protectedPath.slice(sourceDirectory.length + 1));
    assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, canonicalAliasPath), /must not alias/);

    const symlinkOutputPath = join(pathFixtureDirectory, `protected-symlink-${index}.json`);
    symlinkSync(protectedPath, symlinkOutputPath);
    assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, symlinkOutputPath), /must not alias/);

    const hardlinkOutputPath = join(pathFixtureDirectory, `protected-hardlink-${index}.json`);
    linkSync(protectedPath, hardlinkOutputPath);
    assert.throws(() => assertBenchmarkOutputDoesNotAliasDatabase(databasePath, hardlinkOutputPath), /hard link/);
  }
  assert.equal(readFileSync(databasePath, "utf8"), "source-database-sentinel");
} finally {
  rmSync(pathFixtureDirectory, { recursive: true, force: true });
}

function seedBenchmarkSource(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE michelin_restaurants (
        id TEXT PRIMARY KEY,
        award TEXT
      );

      CREATE TABLE visits (
        id TEXT PRIMARY KEY,
        restaurantId TEXT,
        suggestedRestaurantId TEXT,
        status TEXT NOT NULL,
        startTime INTEGER NOT NULL,
        awardAtVisit TEXT
      );

      INSERT INTO michelin_restaurants (id, award) VALUES
        ('guide-star', '1 Star'),
        ('guide-bib', 'Bib Gourmand');

      INSERT INTO visits (id, restaurantId, suggestedRestaurantId, status, startTime, awardAtVisit) VALUES
        ('visit-star', 'guide-star', NULL, 'confirmed', 1735732800000, NULL),
        ('visit-bib', 'guide-bib', NULL, 'confirmed', 1735819200000, NULL);
    `);
  } finally {
    database.close();
  }
}

function runBenchmark(arguments_: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      fileURLToPath(new URL("./benchmark-wrapped-stats-michelin.ts", import.meta.url)),
      ...arguments_,
    ],
    { encoding: "utf8" },
  );
}

const immutableFixtureDirectory = mkdtempSync(join(tmpdir(), "palate-wrapped-stats-michelin-immutable-"));
try {
  const databasePath = join(immutableFixtureDirectory, "source.sqlite");
  const reportPath = join(immutableFixtureDirectory, "report.json");
  const shmPath = `${databasePath}-shm`;
  const walPath = `${databasePath}-wal`;
  seedBenchmarkSource(databasePath);
  const sourceBefore = readFileSync(databasePath);
  const shmSentinel = Buffer.from("preexisting-shm-sentinel\0with-binary-data", "utf8");
  writeFileSync(shmPath, shmSentinel);

  const successfulRun = runBenchmark([
    `--database=${databasePath}`,
    "--samples=1",
    "--warmup=0",
    `--output=${reportPath}`,
  ]);
  assert.equal(successfulRun.status, 0, `${successfulRun.stdout}\n${successfulRun.stderr}`);
  assert.deepEqual(readFileSync(databasePath), sourceBefore);
  assert.deepEqual(readFileSync(shmPath), shmSentinel);

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    scope?: { sourceMutation?: unknown };
    dataset?: { sourceDatabaseSha256?: unknown };
    sqliteCalls?: { productionPlan?: unknown };
  };
  assert.match(String(report.scope?.sourceMutation), /read-only SQLite immutable URI in one read transaction/);
  assert.equal(report.dataset?.sourceDatabaseSha256, createHash("sha256").update(sourceBefore).digest("hex"));
  assert.deepEqual(report.sqliteCalls?.productionPlan, productionPlan);

  const walSentinel = Buffer.from("non-empty-wal-sentinel", "utf8");
  writeFileSync(walPath, walSentinel);
  const rejectedWalRun = runBenchmark([
    `--database=${databasePath}`,
    "--samples=1",
    "--warmup=0",
    `--output=${join(immutableFixtureDirectory, "must-not-be-written.json")}`,
  ]);
  assert.notEqual(rejectedWalRun.status, 0);
  assert.match(`${rejectedWalRun.stdout}\n${rejectedWalRun.stderr}`, /non-empty WAL sidecar/);
  assert.deepEqual(readFileSync(databasePath), sourceBefore);
  assert.deepEqual(readFileSync(shmPath), shmSentinel);
  assert.deepEqual(readFileSync(walPath), walSentinel);
} finally {
  rmSync(immutableFixtureDirectory, { recursive: true, force: true });
}

console.log(
  "wrapped stats Michelin tests passed (independent literal five-query oracle; production call-plan accounting; immutable snapshot/source-sidecar guards; all-time/year/empty/null/Unicode/multi-label/historical/orphan/status cases; output main/sidecar alias guards; 2 index modes; 48 randomized fixtures)",
);
