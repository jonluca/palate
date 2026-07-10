#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL,
  ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL,
  parseMichelinCalendarHydrationRows,
  selectMichelinCalendarHydrationIds,
  type MichelinCalendarHydrationRow,
  type MichelinCalendarNameRow,
} from "../utils/db/michelin-calendar-match-core.ts";
import {
  buildCalendarGuideRestaurantsByNormalizedName,
  getCalendarGuideMatchesForEvent,
  loadCalendarGuideMatchingContext,
  type CalendarGuideNameTools,
} from "../utils/calendar-guide-matching-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

const DATASET_KEY = "michelin_dataset_version";
const DECLARED_COLUMNS = [
  "id",
  "name",
  "latitude",
  "longitude",
  "address",
  "location",
  "cuisine",
  "latestAwardYear",
  "award",
] as const;

interface SeedRow extends MichelinRestaurantRecord {
  readonly datasetVersion: string | null;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
  `);
}

function insertRows(database: DatabaseSync, rows: readonly SeedRow[]): void {
  const statement = database.prepare(`INSERT INTO michelin_restaurants (
    id, name, latitude, longitude, address, location, cuisine,
    latestAwardYear, award, datasetVersion
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  database.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(
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
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function setDatasetVersion(database: DatabaseSync, version: string | null): void {
  database.prepare("DELETE FROM app_metadata WHERE key = ?").run(DATASET_KEY);
  if (version !== null) {
    database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run(DATASET_KEY, version);
  }
}

// Independent test normalizer with the production-relevant behaviors needed by
// these fixtures: Unicode deburring, emoji/punctuation removal, ampersands, and
// comparison affixes. Production integration is asserted separately below.
function normalizeFixtureName(value: string): string {
  return value
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+(restaurant|café|cafe)$/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/[’'`´ʼʻ]/g, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^a-z0-9_\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickDeclaredColumns(row: SeedRow): MichelinRestaurantRecord {
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

/** Independent literal copy of the former full-guide selection. */
function executeLiteralOracle(
  database: DatabaseSync,
  requestedNormalizedNames: ReadonlySet<string>,
): MichelinRestaurantRecord[] {
  const rows = database
    .prepare(
      `SELECT m.*
       FROM michelin_restaurants m
       WHERE NOT EXISTS (
         SELECT 1 FROM app_metadata WHERE key = ?
       ) OR m.datasetVersion = (
         SELECT value FROM app_metadata WHERE key = ?
       )
       ORDER BY m.rowid`,
    )
    .all(DATASET_KEY, DATASET_KEY) as unknown as SeedRow[];
  return rows.filter((row) => requestedNormalizedNames.has(normalizeFixtureName(row.name))).map(pickDeclaredColumns);
}

function executeCandidate(
  database: DatabaseSync,
  requestedNormalizedNames: ReadonlySet<string>,
  afterNameRead?: () => void,
): MichelinRestaurantRecord[] {
  if (requestedNormalizedNames.size === 0) {
    return [];
  }

  database.exec("BEGIN");
  try {
    const nameRows = database
      .prepare(ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL)
      .all(DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarNameRow[];
    const ids = selectMichelinCalendarHydrationIds(nameRows, requestedNormalizedNames, normalizeFixtureName);
    afterNameRead?.();
    if (ids.length === 0) {
      database.exec("COMMIT");
      return [];
    }
    const rows = database
      .prepare(ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL)
      .all(JSON.stringify(ids), DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarHydrationRow[];
    assert.equal(rows.length, ids.length, "snapshot hydration must return every selected name row");
    database.exec("COMMIT");
    return parseMichelinCalendarHydrationRows(rows);
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function assertDeclaredShape(rows: readonly MichelinRestaurantRecord[]): void {
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), DECLARED_COLUMNS, "hydration must expose exactly MichelinRestaurantRecord");
    assert.ok(!("datasetVersion" in row), "datasetVersion must never cross the native-to-JS boundary");
    assert.ok(!("requestedOrdinal" in row), "the private hydration ordinal must be removed");
  }
}

function fileSnapshot(path: string): { readonly exists: boolean; readonly bytes: number; readonly sha256: string } {
  if (!existsSync(path)) {
    return { exists: false, bytes: 0, sha256: createHash("sha256").update("").digest("hex") };
  }
  return {
    exists: true,
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function sourceFilesSnapshot(databasePath: string): Record<string, ReturnType<typeof fileSnapshot>> {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => [suffix || "main", fileSnapshot(`${databasePath}${suffix}`)]),
  );
}

function runBenchmarkProcess(
  repositoryRoot: string,
  databasePath: string,
  outputPath: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      join(repositoryRoot, "scripts/benchmark-michelin-calendar-guide-projection.ts"),
      `--database=${databasePath}`,
      "--matched-rows=1",
      "--samples=1",
      "--warmup=0",
      `--output=${outputPath}`,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function assertBenchmarkRejected(
  repositoryRoot: string,
  databasePath: string,
  outputPath: string,
  expectedMessage: RegExp,
): void {
  const result = runBenchmarkProcess(repositoryRoot, databasePath, outputPath);
  assert.notEqual(result.status, 0, `benchmark unexpectedly accepted ${outputPath}`);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, expectedMessage);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function calendarRestaurant(id: string, overrides: Partial<MichelinRestaurantRecord> = {}): MichelinRestaurantRecord {
  return {
    id,
    name: "Cafe",
    latitude: 1,
    longitude: 2,
    address: "",
    location: "",
    cuisine: "Test",
    latestAwardYear: 2025,
    award: "Selected",
    ...overrides,
  };
}

const fixtureRows: SeedRow[] = [
  {
    id: "active-z",
    name: "The Café 🍣 Restaurant",
    latitude: 48.1,
    longitude: 11.5,
    address: "",
    location: "",
    cuisine: "Creative",
    latestAwardYear: 2025,
    award: "2 Stars",
    datasetVersion: "active",
  },
  {
    id: "active-quote-'雪'",
    name: "Cafe",
    latitude: 48.1,
    longitude: 11.5,
    address: "",
    location: "",
    cuisine: "Japanese",
    latestAwardYear: null,
    award: "Selected",
    datasetVersion: "active",
  },
  {
    id: "stale-between",
    name: "Café Restaurant",
    latitude: 48.3,
    longitude: 11.7,
    address: "Stale",
    location: "Stale",
    cuisine: "Stale",
    latestAwardYear: 2020,
    award: "1 Star",
    datasetVersion: "stale",
  },
  {
    id: "active-and",
    name: "Salt & Stone",
    latitude: 0,
    longitude: 0,
    address: "Zero coordinates",
    location: "Null Island",
    cuisine: "Modern",
    latestAwardYear: 2024,
    award: "Bib Gourmand",
    datasetVersion: "active",
  },
  {
    id: "active-other",
    name: "Unrequested Dining Room",
    latitude: -33.8,
    longitude: 151.2,
    address: "Other",
    location: "Sydney",
    cuisine: "Other",
    latestAwardYear: 2025,
    award: "",
    datasetVersion: "active",
  },
];

{
  const calls: string[] = [];
  const tools: CalendarGuideNameTools = {
    cleanCalendarEventTitle: (title) => {
      calls.push(`clean:${title}`);
      return title.replace(/^Dinner at\s+/i, "");
    },
    stripComparisonAffixes: (value) => {
      calls.push(`strip:${value}`);
      return value.replace(/^The\s+/i, "").replace(/\s+Restaurant$/i, "");
    },
    normalizeForComparison: (value) => {
      calls.push(`normalize:${value}`);
      return normalizeFixtureName(value);
    },
  };
  let loaderCalls = 0;
  const noEvents = await loadCalendarGuideMatchingContext([], tools, async () => {
    loaderCalls += 1;
    return [];
  });
  assert.equal(loaderCalls, 0, "no events must not enter the database seam");
  assert.equal(noEvents.requestedNormalizedNames.size, 0);
  assert.equal(noEvents.restaurantsByName.size, 0);

  const invalidEvents = await loadCalendarGuideMatchingContext([{ title: "--" }, { title: "" }], tools, async () => {
    loaderCalls += 1;
    return [];
  });
  assert.equal(loaderCalls, 0, "filtered/too-short event names must not enter the database seam");
  assert.equal(invalidEvents.requestedNormalizedNames.size, 0);

  calls.length = 0;
  const duplicateA = calendarRestaurant("duplicate-a", { name: "The Café Restaurant" });
  const duplicateB = calendarRestaurant("duplicate-b", { name: "Cafe" });
  const context = await loadCalendarGuideMatchingContext(
    [{ title: "Dinner at The Café Restaurant" }, { title: "Dinner at Cafe" }, { title: "No Match" }],
    tools,
    async (requestedNames, normalizeRestaurantName) => {
      loaderCalls += 1;
      assert.deepEqual([...requestedNames], ["cafe", "no match"]);
      assert.equal(normalizeRestaurantName("The Café Restaurant"), "cafe");
      return [duplicateA, duplicateB];
    },
  );
  assert.equal(loaderCalls, 1);
  assert.deepEqual(calls.slice(0, 3), [
    "clean:Dinner at The Café Restaurant",
    "strip:The Café Restaurant",
    "normalize:Café",
  ]);
  assert.deepEqual(
    getCalendarGuideMatchesForEvent("Dinner at Cafe", "Anywhere", context.restaurantsByName, tools).map(({ id }) => id),
    ["duplicate-a", "duplicate-b"],
    "equal location scores must retain database encounter order",
  );
  assert.deepEqual(getCalendarGuideMatchesForEvent("Unknown", null, context.restaurantsByName, tools), []);

  const rankedRestaurants = buildCalendarGuideRestaurantsByNormalizedName(
    [
      calendarRestaurant("unrelated", { address: "Elsewhere", location: "Elsewhere" }),
      calendarRestaurant("paris", { address: "Paris", location: "France" }),
    ],
    tools,
  );
  assert.deepEqual(
    getCalendarGuideMatchesForEvent("Cafe", "Paris", rankedRestaurants, tools).map(({ id }) => id),
    ["paris", "unrelated"],
  );
  const emptyFieldRestaurants = buildCalendarGuideRestaurantsByNormalizedName(
    [calendarRestaurant("empty-fields"), calendarRestaurant("nonempty", { address: "Other", location: "Other" })],
    tools,
  );
  assert.deepEqual(
    getCalendarGuideMatchesForEvent("Cafe", "Unrelated", emptyFieldRestaurants, tools).map(({ id }) => id),
    ["empty-fields", "nonempty"],
    "legacy empty-string substring scoring must remain intact",
  );
}

{
  const database = new DatabaseSync(":memory:");
  createSchema(database);
  insertRows(database, fixtureRows);
  setDatasetVersion(database, "active");
  const requested = new Set(["cafe", "salt and stone"]);
  const oracle = executeLiteralOracle(database, requested);
  const candidate = executeCandidate(database, requested);
  assert.deepEqual(candidate, oracle, "active-dataset projection must match the literal full-guide oracle");
  assert.deepEqual(
    candidate.map(({ id }) => id),
    ["active-z", "active-quote-'雪'", "active-and"],
    "duplicate normalized names must retain legacy encounter/group order",
  );
  assert.equal(candidate[0]?.address, "", "empty address must survive unchanged");
  assert.equal(candidate[0]?.location, "", "empty location must survive unchanged");
  assertDeclaredShape(candidate);

  database.exec(`
    CREATE INDEX idx_calendar_covering
      ON michelin_restaurants(datasetVersion, id, name);
    ANALYZE;
    PRAGMA reverse_unordered_selects = ON;
  `);
  const forcedCoveringSql = ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL.replace(
    "FROM michelin_restaurants m",
    "FROM michelin_restaurants m INDEXED BY idx_calendar_covering",
  );
  const forcedPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${forcedCoveringSql}`)
    .all(DATASET_KEY, DATASET_KEY) as unknown as Array<{ detail: string }>;
  assert.ok(
    forcedPlan.some(({ detail }) => detail.includes("USING COVERING INDEX idx_calendar_covering")),
    "adversarial fixture must actually traverse the covering index",
  );
  assert.ok(
    forcedPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE FOR ORDER BY")),
    "rowid order must be restored after an indexed traversal",
  );
  const indexedNameRows = database
    .prepare(forcedCoveringSql)
    .all(DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarNameRow[];
  assert.deepEqual(
    selectMichelinCalendarHydrationIds(indexedNameRows, new Set(["cafe"]), normalizeFixtureName),
    ["active-z", "active-quote-'雪'"],
    "covering-index order must not reorder equal-location duplicate-name matches",
  );

  setDatasetVersion(database, null);
  const noMetadataOracle = executeLiteralOracle(database, requested);
  const noMetadataCandidate = executeCandidate(database, requested);
  assert.deepEqual(noMetadataCandidate, noMetadataOracle, "metadata-absent fallback must include every dataset");
  assert.deepEqual(
    noMetadataCandidate.map(({ id }) => id),
    ["active-z", "active-quote-'雪'", "stale-between", "active-and"],
  );

  let normalizeCalls = 0;
  assert.deepEqual(
    selectMichelinCalendarHydrationIds([{ id: "unused", name: "Unused" }], new Set(), (name) => {
      normalizeCalls += 1;
      return normalizeFixtureName(name);
    }),
    [],
  );
  assert.equal(normalizeCalls, 0, "an empty requested-name set must avoid normalization work");
  database.close();
}

{
  const database = new DatabaseSync(":memory:");
  createSchema(database);
  setDatasetVersion(database, "active");
  const largeRows = Array.from(
    { length: 1_205 },
    (_, index): SeedRow => ({
      id: `large-${index.toString().padStart(4, "0")}-'雪'`,
      name: index % 2 === 0 ? "Café Restaurant" : "The Cafe",
      latitude: 10 + index / 100_000,
      longitude: 20 + index / 100_000,
      address: index % 7 === 0 ? "" : `Address ${index}`,
      location: index % 11 === 0 ? "" : `Location ${index}`,
      cuisine: `Cuisine ${index % 5}`,
      latestAwardYear: index % 3 === 0 ? null : 2025,
      award: index % 2 === 0 ? "1 Star" : "Selected",
      datasetVersion: "active",
    }),
  );
  insertRows(database, largeRows);
  const requested = new Set(["cafe"]);
  const candidate = executeCandidate(database, requested);
  assert.deepEqual(candidate, executeLiteralOracle(database, requested));
  assert.equal(candidate.length, largeRows.length, "JSON hydration must not inherit SQLite bind-variable limits");
  assertDeclaredShape(candidate);
  database.close();
}

{
  const directory = mkdtempSync(join(tmpdir(), "palate-calendar-guide-snapshot-"));
  const databasePath = join(directory, "snapshot.db");
  const reader = new DatabaseSync(databasePath);
  try {
    reader.exec("PRAGMA journal_mode = WAL");
    createSchema(reader);
    insertRows(reader, [
      {
        id: "snapshot-original",
        name: "Café Restaurant",
        latitude: 1,
        longitude: 2,
        address: "before",
        location: "before",
        cuisine: "before",
        latestAwardYear: 2024,
        award: "1 Star",
        datasetVersion: "v1",
      },
    ]);
    setDatasetVersion(reader, "v1");
    const writer = new DatabaseSync(databasePath);
    try {
      const candidate = executeCandidate(reader, new Set(["cafe"]), () => {
        writer.exec("BEGIN");
        writer
          .prepare(
            `UPDATE michelin_restaurants
             SET address = 'after', location = 'after', cuisine = 'after', datasetVersion = 'v2'
             WHERE id = 'snapshot-original'`,
          )
          .run();
        writer
          .prepare(
            `INSERT INTO michelin_restaurants (
               id, name, latitude, longitude, address, location, cuisine,
               latestAwardYear, award, datasetVersion
             ) VALUES ('snapshot-new', 'Cafe', 3, 4, 'new', 'new', 'new', 2025, '2 Stars', 'v2')`,
          )
          .run();
        writer.prepare("UPDATE app_metadata SET value = 'v2' WHERE key = ?").run(DATASET_KEY);
        writer.exec("COMMIT");
      });
      assert.equal(candidate.length, 1);
      assert.equal(candidate[0]?.address, "before", "hydration must remain on the name scan's read snapshot");
      const fresh = executeCandidate(reader, new Set(["cafe"]));
      assert.deepEqual(
        fresh.map(({ id }) => id),
        ["snapshot-original", "snapshot-new"],
        "a subsequent transaction must observe the refreshed guide",
      );
      assert.equal(fresh[0]?.address, "after");
    } finally {
      writer.close();
    }
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const directory = mkdtempSync(join(tmpdir(), "palate-calendar-guide-read-only-"));
  const databasePath = join(directory, "read-only.db");
  const walPath = `${databasePath}-wal`;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    createSchema(database);
    database.exec("CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)");
    database.prepare("INSERT INTO sequence_probe (value) VALUES ('sentinel')").run();
    insertRows(database, fixtureRows);
    setDatasetVersion(database, "active");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const totalChangesBefore = (database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    const sequenceBefore = database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
    const mainBefore = fileSnapshot(databasePath);
    const walBefore = fileSnapshot(walPath);

    const candidate = executeCandidate(database, new Set(["cafe", "salt and stone"]));
    assert.ok(candidate.length > 0);

    const totalChangesAfter = (database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    const sequenceAfter = database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
    assert.equal(totalChangesAfter, totalChangesBefore, "the read snapshot must not increment total_changes()");
    assert.deepEqual(sequenceAfter, sequenceBefore, "the read snapshot must not advance sqlite_sequence");
    assert.deepEqual(
      fileSnapshot(databasePath),
      mainBefore,
      "the read snapshot must leave main database bytes unchanged",
    );
    assert.deepEqual(fileSnapshot(walPath), walBefore, "the read snapshot must leave WAL bytes and hash unchanged");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), "palate-calendar-guide-benchmark-contract-"));
  const databasePath = join(directory, "source.db");
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  const journalPath = `${databasePath}-journal`;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    createSchema(database);
    database.exec("CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)");
    database.prepare("INSERT INTO sequence_probe (value) VALUES ('benchmark-sequence-sentinel')").run();
    insertRows(database, fixtureRows);
    setDatasetVersion(database, "active");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }

  try {
    // Make every protected sidecar path concrete so direct, symbolic-link, and
    // hard-link aliases are all exercised rather than inferred.
    writeFileSync(walPath, "");
    writeFileSync(shmPath, "calendar-guide-shm-sentinel");
    writeFileSync(journalPath, "");
    const sourceBefore = sourceFilesSnapshot(databasePath);
    const protectedPaths = [databasePath, walPath, shmPath, journalPath];

    for (const [index, protectedPath] of protectedPaths.entries()) {
      assertBenchmarkRejected(repositoryRoot, databasePath, protectedPath, /must not alias/i);

      const symlinkPath = join(directory, `output-symlink-${index}.json`);
      symlinkSync(protectedPath, symlinkPath);
      assertBenchmarkRejected(repositoryRoot, databasePath, symlinkPath, /must not alias/i);

      const hardlinkPath = join(directory, `output-hardlink-${index}.json`);
      linkSync(protectedPath, hardlinkPath);
      assertBenchmarkRejected(repositoryRoot, databasePath, hardlinkPath, /hard link|must not alias/i);
    }

    writeFileSync(walPath, "nonempty-wal-sentinel");
    assertBenchmarkRejected(
      repositoryRoot,
      databasePath,
      join(directory, "nonempty-wal-output.json"),
      /non-empty wal sidecar/i,
    );
    writeFileSync(walPath, "");
    writeFileSync(journalPath, "nonempty-journal-sentinel");
    assertBenchmarkRejected(
      repositoryRoot,
      databasePath,
      join(directory, "nonempty-journal-output.json"),
      /non-empty journal sidecar/i,
    );
    writeFileSync(journalPath, "");

    const outputPath = join(directory, "aggregate-report.json");
    const result = runBenchmarkProcess(repositoryRoot, databasePath, outputPath);
    assert.equal(result.status, 0, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const serialized = readFileSync(outputPath, "utf8");
    const report = requiredRecord(JSON.parse(serialized), "report");
    const privacy = requiredRecord(report.privacy, "privacy");
    const measurementModel = requiredRecord(report.measurementModel, "measurementModel");
    const strategies = requiredRecord(report.strategies, "strategies");
    const legacyStrategy = requiredRecord(strategies.legacyFullGuide, "legacy strategy");
    const candidateStrategy = requiredRecord(strategies.twoStageProjection, "candidate strategy");
    const writeInvariants = requiredRecord(report.writeInvariants, "writeInvariants");
    const sourceAttestation = requiredRecord(report.sourceAttestation, "sourceAttestation");
    const expoAttestation = requiredRecord(
      measurementModel.installedExpoTransactionAttestation,
      "installedExpoTransactionAttestation",
    );
    assert.equal(report.status, "ok");
    assert.equal(privacy.aggregateOnly, true);
    assert.equal(privacy.calendarDataAccessed, false);
    assert.equal(privacy.rawRestaurantFieldsRetainedInReport, false);
    assert.equal(measurementModel.runtime, "Node.js node:sqlite plus benchmark-local JavaScript");
    assert.match(String(measurementModel.scope ?? ""), /not end-to-end Expo helper timing/);
    assert.ok(legacyStrategy.nodeModelTiming);
    assert.ok(candidateStrategy.nodeModelTiming);
    assert.equal(legacyStrategy.timing, undefined);
    assert.equal(candidateStrategy.timing, undefined);
    assert.equal(writeInvariants.totalChangesUnchanged, true);
    assert.equal(writeInvariants.sqliteSequenceUnchanged, true);
    assert.equal(writeInvariants.mainAndSidecarsByteIdentical, true);
    assert.equal(sourceAttestation.byteIdentical, true);
    assert.equal(expoAttestation.executesLiteralDeferredBegin, true);
    assert.equal(expoAttestation.closesDedicatedTransactionConnection, true);
    assert.ok(!serialized.includes(databasePath), "aggregate report must not retain the source path");
    assert.ok(!serialized.includes(outputPath), "aggregate report must not retain the output path");
    for (const row of fixtureRows) {
      for (const value of [row.id, row.name, row.address, row.location, row.cuisine]) {
        if (value.length >= 8) {
          assert.ok(!serialized.includes(value), `aggregate report leaked fixture value: ${value}`);
        }
      }
    }
    assert.deepEqual(
      sourceFilesSnapshot(databasePath),
      sourceBefore,
      "contract cases and successful benchmark must leave source main/sidecars byte-identical",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const visitSource = readFileSync(join(repositoryRoot, "services/visit.ts"), "utf8");
  const databaseSource = readFileSync(join(repositoryRoot, "utils/db/michelin.ts"), "utf8");
  const expoDatabaseSource = readFileSync(
    join(repositoryRoot, "node_modules/expo-sqlite/src/SQLiteDatabase.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    visitSource,
    /getAllMichelinRestaurants/,
    "Calendar service must not call the full-guide transfer API",
  );
  assert.match(visitSource, /getMichelinRestaurantsForCalendarNormalizedNames/);
  assert.match(visitSource, /loadCalendarGuideMatchingContext\(/);
  assert.match(visitSource, /getCalendarGuideMatchesForEvent\(/);
  assert.match(visitSource, /cleanCalendarEventTitle,/);
  assert.match(visitSource, /normalizeForComparison,/);
  assert.match(visitSource, /stripComparisonAffixes,/);
  assert.match(databaseSource, /withExclusiveTransactionAsync\(async \(transaction\) =>/);
  assert.match(databaseSource, /ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL/);
  assert.match(databaseSource, /ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL/);
  const exclusiveTransactionStart = expoDatabaseSource.indexOf("public async withExclusiveTransactionAsync(");
  const exclusiveTransactionEnd = expoDatabaseSource.indexOf("public isInTransactionSync()", exclusiveTransactionStart);
  assert.ok(exclusiveTransactionStart >= 0 && exclusiveTransactionEnd > exclusiveTransactionStart);
  const exclusiveTransactionImplementation = expoDatabaseSource.slice(
    exclusiveTransactionStart,
    exclusiveTransactionEnd,
  );
  assert.match(exclusiveTransactionImplementation, /Transaction\.createAsync\(this\)/);
  assert.match(exclusiveTransactionImplementation, /transaction\.execAsync\('BEGIN'\)/);
  assert.match(exclusiveTransactionImplementation, /transaction\.closeAsync\(\)/);
  assert.doesNotMatch(exclusiveTransactionImplementation, /BEGIN (?:IMMEDIATE|EXCLUSIVE)/);
}

console.log(
  "Michelin Calendar guide projection tests passed: literal-oracle parity, active/missing metadata, indexed encounter order, executable matching orchestration, Unicode and quoted IDs, duplicate/location ties, full declared shape, large JSON hydration, snapshot isolation, zero-write proof, benchmark alias/sidecar/privacy contract, and production/Expo lifecycle integration.",
);
