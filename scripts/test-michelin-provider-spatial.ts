#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildMichelinProviderSpatialBounds,
  buildMichelinProviderSpatialCandidateSql,
  buildMichelinProviderSpatialQueryPlans,
  ensureInvalidatedMichelinProviderSpatialIndex,
  ensureMichelinProviderSpatialIndex,
  groupMichelinProviderSpatialCandidates,
  MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL,
  MICHELIN_PROVIDER_SPATIAL_BATCH_SIZE,
  MICHELIN_PROVIDER_SPATIAL_BINDS_PER_INPUT,
  MICHELIN_PROVIDER_SPATIAL_FIXED_BINDS,
  MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL,
  MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL,
  MICHELIN_PROVIDER_SPATIAL_MAX_BINDS,
  MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS,
  MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL,
  MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL,
  invalidateMichelinProviderSpatialIndex,
  rebuildMichelinProviderSpatialIndex,
  repairMichelinProviderSpatialIndexIfNeeded,
  type MichelinProviderSpatialCandidateRow,
  type MichelinProviderSpatialDatabase,
  type MichelinProviderSpatialInput,
} from "../utils/db/michelin-provider-spatial-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";
import {
  buildProviderMichelinRestaurantsByNormalizedName,
  collectProviderMichelinFallbackNormalizedNames,
  findProviderMichelinMatch,
  getUniqueProviderMichelinNameFallback,
  isValidProviderMichelinCoordinate,
  PROVIDER_EXACT_MICHELIN_RADIUS_METERS,
  type ProviderMichelinLocatedReservation,
  type ProviderMichelinMatch,
  type ProviderMichelinNameTools,
} from "../utils/provider-michelin-matching-core.ts";

const EARTH_RADIUS_METERS = 6_371_000;
const SPATIAL_TABLE = "michelin_restaurant_spatial_index";

interface CountRow {
  readonly count: number;
}

interface IssueRow {
  readonly issueCount: number;
}

interface GuideRow {
  readonly rowid: number;
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
}

function createDatabase(path: string = ":memory:", withTextPrimaryKey: boolean = true): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE michelin_restaurants (
      id TEXT ${withTextPrimaryKey ? "PRIMARY KEY" : "NOT NULL"},
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
  return database;
}

function asyncDatabase(database: DatabaseSync): MichelinProviderSpatialDatabase {
  const executor = {
    execAsync: async (source: string): Promise<void> => database.exec(source),
    getFirstAsync: async <T>(source: string): Promise<T | null> =>
      (database.prepare(source).get() as T | undefined) ?? null,
  };
  return {
    ...executor,
    withExclusiveTransactionAsync: async (task): Promise<void> => {
      database.exec("BEGIN");
      try {
        await task(executor);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function insertRestaurant(
  database: DatabaseSync,
  id: string,
  latitude: number,
  longitude: number,
  datasetVersion: string = "v2",
  name: string = id,
): void {
  database
    .prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, datasetVersion)
      VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, latitude, longitude, datasetVersion);
}

function count(database: DatabaseSync, table: string = SPATIAL_TABLE): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count;
}

function issueCount(database: DatabaseSync): number {
  return (database.prepare(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL).get() as unknown as IssueRow).issueCount;
}

function rawCandidates(
  database: DatabaseSync,
  inputs: readonly MichelinProviderSpatialInput[],
): MichelinProviderSpatialCandidateRow[] {
  return buildMichelinProviderSpatialQueryPlans(inputs).flatMap(
    (plan) => database.prepare(plan.sql).all(...plan.parameters) as unknown as MichelinProviderSpatialCandidateRow[],
  );
}

function groupedCandidateIds(database: DatabaseSync, inputs: readonly MichelinProviderSpatialInput[]): string[][] {
  return groupMichelinProviderSpatialCandidates(rawCandidates(database, inputs), inputs.length).map((group) =>
    group.map(({ id }) => id),
  );
}

function spatialContains(database: DatabaseSync, restaurantId: string, latitude: number, longitude: number): boolean {
  const row = database
    .prepare(`SELECT 1 AS present
      FROM michelin_restaurants m
      JOIN ${SPATIAL_TABLE} spatial ON spatial.restaurantRowId = m.rowid
      WHERE m.id = ?
        AND ? BETWEEN spatial.minimumLatitude AND spatial.maximumLatitude
        AND ? BETWEEN spatial.minimumLongitude AND spatial.maximumLongitude`)
    .get(restaurantId, latitude, longitude) as { present?: unknown } | undefined;
  return row?.present === 1;
}

function calculateDistanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (latitude2 - latitude1) * radians;
  const longitudeDelta = (longitude2 - longitude1) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1 * radians) * Math.cos(latitude2 * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}

function destination(
  latitude: number,
  longitude: number,
  distanceMeters: number,
  bearingDegrees: number,
): MichelinProviderSpatialInput {
  const radians = Math.PI / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitude1 = latitude * radians;
  const longitude1 = longitude * radians;
  const bearing = bearingDegrees * radians;
  const latitude2 = Math.asin(
    Math.sin(latitude1) * Math.cos(angularDistance) +
      Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const longitude2 =
    longitude1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude1),
      Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2),
    );
  return { latitude: latitude2 / radians, longitude: normalizeLongitude(longitude2 / radians) };
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function testBoundsAndInputValidation(): void {
  assert.equal(PROVIDER_EXACT_MICHELIN_RADIUS_METERS, MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS);
  const ordinary = buildMichelinProviderSpatialBounds(37.8, -122.4);
  assert.equal(ordinary.longitudeIntervals.length, 1);
  const antimeridian = buildMichelinProviderSpatialBounds(0, 179.9999);
  assert.equal(antimeridian.longitudeIntervals.length, 2);
  assert.equal(antimeridian.longitudeIntervals[0].maximum, 180);
  assert.ok(antimeridian.longitudeIntervals[0].minimum > 179);
  assert.equal(antimeridian.longitudeIntervals[1]?.minimum, -180);
  assert.ok((antimeridian.longitudeIntervals[1]?.maximum ?? 0) < -179);
  assert.deepEqual(buildMichelinProviderSpatialBounds(90, 17).longitudeIntervals, [{ minimum: -180, maximum: 180 }]);
  assert.deepEqual(buildMichelinProviderSpatialBounds(-90, -17).longitudeIntervals, [{ minimum: -180, maximum: 180 }]);

  for (const [latitude, longitude] of [
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
  ]) {
    assert.throws(() => buildMichelinProviderSpatialBounds(latitude, longitude), /must be finite and between/);
  }
}

async function testInvalidationSurvivesFailedRepair(): Promise<void> {
  const database = createDatabase();
  try {
    insertRestaurant(database, "invalidation", 10, 20);
    const adapter = asyncDatabase(database);
    await ensureMichelinProviderSpatialIndex(adapter);

    invalidateMichelinProviderSpatialIndex();
    assert.equal(await ensureInvalidatedMichelinProviderSpatialIndex(adapter), false);
    assert.equal(await ensureInvalidatedMichelinProviderSpatialIndex(adapter), false);

    const row = database.prepare("SELECT rowid FROM michelin_restaurants WHERE id = 'invalidation'").get() as {
      rowid: number;
    };
    database.prepare(`DELETE FROM ${SPATIAL_TABLE} WHERE restaurantRowId = ?`).run(row.rowid);
    invalidateMichelinProviderSpatialIndex();
    const failingAdapter: MichelinProviderSpatialDatabase = {
      ...adapter,
      withExclusiveTransactionAsync: async (): Promise<void> => {
        throw new Error("injected rebuild failure");
      },
    };
    await assert.rejects(ensureInvalidatedMichelinProviderSpatialIndex(failingAdapter), /injected rebuild failure/);
    assert.equal(issueCount(database), 1);
    assert.equal(
      await ensureInvalidatedMichelinProviderSpatialIndex(adapter),
      true,
      "failed repair must keep same-session validation armed",
    );
    assert.equal(issueCount(database), 0);
  } finally {
    database.close();
  }
}

function testBackfillTriggersRepairAndRollback(): void {
  const database = createDatabase();
  try {
    insertRestaurant(database, "preexisting-active", 10, 20);
    insertRestaurant(database, "preexisting-old", 11, 21, "v1");
    insertRestaurant(database, "preexisting-invalid", 91, 22);
    insertRestaurant(database, "preexisting-zero", 0, 0);
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    assert.equal(count(database), 0);
    assert.equal(issueCount(database), 2);

    database.exec("BEGIN");
    database.exec(MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL);
    assert.equal(count(database), 2);
    database.exec("ROLLBACK");
    assert.equal(count(database), 0, "backfill must participate in the caller transaction");
    database.exec(MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL);
    assert.equal(count(database), 2);
    assert.equal(issueCount(database), 0);

    insertRestaurant(database, "triggered", 12, 22);
    assert.ok(spatialContains(database, "triggered", 12, 22));
    database
      .prepare("UPDATE michelin_restaurants SET latitude = ?, longitude = ? WHERE id = ?")
      .run(13, 23, "triggered");
    assert.ok(spatialContains(database, "triggered", 13, 23));
    assert.ok(!spatialContains(database, "triggered", 12, 22));
    database.prepare("UPDATE michelin_restaurants SET latitude = ? WHERE id = ?").run(92, "triggered");
    assert.ok(!spatialContains(database, "triggered", 92, 23));
    database.prepare("UPDATE michelin_restaurants SET latitude = ? WHERE id = ?").run(13, "triggered");
    assert.ok(spatialContains(database, "triggered", 13, 23));

    database.exec("BEGIN");
    database
      .prepare("UPDATE michelin_restaurants SET latitude = ?, longitude = ? WHERE id = ?")
      .run(14, 24, "triggered");
    assert.ok(spatialContains(database, "triggered", 14, 24));
    database.exec("ROLLBACK");
    assert.ok(spatialContains(database, "triggered", 13, 23));

    database.prepare("DELETE FROM michelin_restaurants WHERE id = ?").run("triggered");
    assert.equal(count(database), 2);

    const activeRow = database
      .prepare("SELECT rowid FROM michelin_restaurants WHERE id = ?")
      .get("preexisting-active") as { rowid: number };
    const oldRow = database.prepare("SELECT rowid FROM michelin_restaurants WHERE id = ?").get("preexisting-old") as {
      rowid: number;
    };
    database.prepare(`DELETE FROM ${SPATIAL_TABLE} WHERE restaurantRowId = ?`).run(activeRow.rowid);
    database
      .prepare(`UPDATE ${SPATIAL_TABLE}
        SET minimumLatitude = 50, maximumLatitude = 50,
            minimumLongitude = 50, maximumLongitude = 50
        WHERE restaurantRowId = ?`)
      .run(oldRow.rowid);
    database.prepare(`INSERT INTO ${SPATIAL_TABLE} VALUES (?, ?, ?, ?, ?)`).run(999_999, 1, 1, 1, 1);
    assert.equal(issueCount(database), 3);

    database.exec("BEGIN");
    database.exec(MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL);
    assert.equal(issueCount(database), 0);
    database.exec("ROLLBACK");
    assert.equal(issueCount(database), 3, "repair must participate in the caller transaction");
    database.exec(MICHELIN_PROVIDER_SPATIAL_REPAIR_SQL);
    assert.equal(issueCount(database), 0);
    assert.equal(count(database), 2);
  } finally {
    database.close();
  }
}

async function testEnsureUpsertsAndZeroWriteHealthyStartup(): Promise<void> {
  const database = createDatabase();
  try {
    insertRestaurant(database, "ensure-a", 10, 20);
    insertRestaurant(database, "ensure-b", 11, 21);
    const adapter = asyncDatabase(database);
    assert.equal(await ensureMichelinProviderSpatialIndex(adapter), true);
    assert.equal(issueCount(database), 0);

    const firstRow = database.prepare("SELECT rowid FROM michelin_restaurants WHERE id = 'ensure-a'").get() as {
      rowid: number;
    };
    database.prepare(`DELETE FROM ${SPATIAL_TABLE} WHERE restaurantRowId = ?`).run(firstRow.rowid);
    database.prepare(`INSERT INTO ${SPATIAL_TABLE} VALUES (?, ?, ?, ?, ?)`).run(999_999, 1, 1, 1, 1);
    assert.equal(count(database), 2, "equal-count corruption fixture must evade a count-only preflight");
    assert.ok(issueCount(database) > 0);
    assert.equal(await ensureMichelinProviderSpatialIndex(adapter), true);
    assert.equal(issueCount(database), 0);

    database
      .prepare(`UPDATE ${SPATIAL_TABLE}
        SET minimumLatitude = 50, maximumLatitude = 50,
            minimumLongitude = 50, maximumLongitude = 50
        WHERE restaurantRowId = ?`)
      .run(firstRow.rowid);
    assert.equal(count(database), 2);
    assert.equal(await repairMichelinProviderSpatialIndexIfNeeded(adapter), true);
    assert.equal(issueCount(database), 0);

    const upsert = database.prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, datasetVersion)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        datasetVersion = excluded.datasetVersion`);
    const beforeUnchanged = (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count;
    upsert.run("ensure-a", "ensure-a", 10, 20, "v2");
    const unchangedDelta =
      (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count - beforeUnchanged;
    assert.equal(unchangedDelta, 1, "unchanged coordinates must not rewrite R-Tree shadow rows");
    const beforeChanged = (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count;
    upsert.run("ensure-a", "ensure-a", 12, 22, "v2");
    const changedDelta =
      (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count - beforeChanged;
    assert.ok(changedDelta > 1, "changed coordinates must update the R-Tree");
    assert.ok(spatialContains(database, "ensure-a", 12, 22));

    const beforeHealthy = (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count;
    assert.equal(await ensureMichelinProviderSpatialIndex(adapter), false);
    assert.equal(
      (database.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count,
      beforeHealthy,
    );
  } finally {
    database.close();
  }

  const directory = mkdtempSync(join(tmpdir(), "palate-provider-spatial-healthy-"));
  const path = join(directory, "healthy.db");
  const walPath = `${path}-wal`;
  const fileDatabase = createDatabase(path);
  try {
    fileDatabase.exec("PRAGMA journal_mode = WAL; CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    fileDatabase.prepare("INSERT INTO sequence_probe DEFAULT VALUES").run();
    for (let index = 0; index < 256; index++) {
      insertRestaurant(fileDatabase, `healthy-${index}`, 20 + index / 1000, 30 + index / 1000);
    }
    const adapter = asyncDatabase(fileDatabase);
    assert.equal(await ensureMichelinProviderSpatialIndex(adapter), true);
    fileDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(existsSync(walPath) ? statSync(walPath).size : 0, 0);
    const sequenceBefore = fileDatabase
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sequence_probe'")
      .get() as { seq: number };
    const changesBefore = (fileDatabase.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count;
    assert.equal(await ensureMichelinProviderSpatialIndex(adapter), false);
    assert.equal(
      (fileDatabase.prepare("SELECT total_changes() AS count").get() as unknown as CountRow).count,
      changesBefore,
    );
    assert.deepEqual(
      fileDatabase.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sequence_probe'").get(),
      sequenceBefore,
    );
    assert.equal(existsSync(walPath) ? statSync(walPath).size : 0, 0);
  } finally {
    fileDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function testVacuumRowidRemapRequiresRebuild(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "palate-provider-spatial-vacuum-"));
  const path = join(directory, "vacuum.db");
  // SQLite currently preserves rowids when a TEXT PRIMARY KEY index exists,
  // but does not guarantee that behavior. This permitted schema variant forces
  // the remap that production must remain safe against after any VACUUM.
  const database = createDatabase(path, false);
  try {
    insertRestaurant(database, "vacuum-a", 30, 40);
    insertRestaurant(database, "vacuum-b", 31, 41);
    insertRestaurant(database, "vacuum-c", 32, 42);
    const adapter = asyncDatabase(database);
    await ensureMichelinProviderSpatialIndex(adapter);
    database.prepare("DELETE FROM michelin_restaurants WHERE id = 'vacuum-b'").run();
    const before = database.prepare("SELECT rowid FROM michelin_restaurants WHERE id = 'vacuum-c'").get() as {
      rowid: number;
    };
    assert.equal(before.rowid, 3);
    database.exec("VACUUM");
    const after = database.prepare("SELECT rowid FROM michelin_restaurants WHERE id = 'vacuum-c'").get() as {
      rowid: number;
    };
    assert.equal(after.rowid, 2, "fixture must prove VACUUM renumbered the TEXT-primary-key table");
    assert.ok(issueCount(database) > 0, "rowid-keyed R-Tree must be considered stale after remap");
    await rebuildMichelinProviderSpatialIndex(adapter);
    assert.equal(issueCount(database), 0);
    assert.deepEqual(groupedCandidateIds(database, [{ latitude: 32, longitude: 42 }]), [["vacuum-c"]]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function testConcurrentDatasetSnapshot(): void {
  const directory = mkdtempSync(join(tmpdir(), "palate-provider-spatial-snapshot-"));
  const path = join(directory, "snapshot.db");
  const writer = createDatabase(path);
  let reader: DatabaseSync | null = null;
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    writer.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    writer.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("michelin_dataset_version", "v1");
    insertRestaurant(writer, "snapshot-old", 45, -73, "v1");
    insertRestaurant(writer, "snapshot-new", 45, -73, "v2");
    reader = new DatabaseSync(path);
    reader.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const input = [{ latitude: 45, longitude: -73 }];
    const plan = buildMichelinProviderSpatialQueryPlans(input)[0]!;
    const oldRows = reader
      .prepare(plan.sql)
      .all(...plan.parameters) as unknown as MichelinProviderSpatialCandidateRow[];
    assert.deepEqual(
      groupMichelinProviderSpatialCandidates(oldRows, 1)[0]?.map(({ id }) => id),
      ["snapshot-old"],
    );

    writer.prepare("UPDATE app_metadata SET value = ? WHERE key = ?").run("v2", "michelin_dataset_version");
    const hydratedOld = reader
      .prepare(MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL)
      .all(
        JSON.stringify(["snapshot-old"]),
        "michelin_dataset_version",
        "michelin_dataset_version",
      ) as unknown as MichelinRestaurantRecord[];
    assert.deepEqual(
      hydratedOld.map(({ id }) => id),
      ["snapshot-old"],
    );
    reader.exec("COMMIT");

    assert.deepEqual(groupedCandidateIds(reader, input), [["snapshot-new"]]);
  } finally {
    try {
      reader?.close();
    } finally {
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function testActiveDatasetSourceOrderAndQueryPlan(): void {
  const database = createDatabase();
  try {
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("michelin_dataset_version", "v2");
    insertRestaurant(database, "z-active-first", 35, -120, "v2", "Same Name");
    insertRestaurant(database, "a-old", 35, -120, "v1", "Same Name");
    insertRestaurant(database, "m-active-second", 35, -120, "v2", "Same Name");
    insertRestaurant(database, "far-active", 40, -120, "v2");

    const input = [{ latitude: 35, longitude: -120 }];
    assert.deepEqual(groupedCandidateIds(database, input), [["z-active-first", "m-active-second"]]);
    database.prepare("UPDATE app_metadata SET value = ? WHERE key = ?").run("v1", "michelin_dataset_version");
    assert.deepEqual(groupedCandidateIds(database, input), [["a-old"]]);
    database.prepare("DELETE FROM app_metadata WHERE key = ?").run("michelin_dataset_version");
    assert.deepEqual(groupedCandidateIds(database, input), [["z-active-first", "a-old", "m-active-second"]]);

    const plan = buildMichelinProviderSpatialQueryPlans(input)[0]!;
    const details = (
      database.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.parameters) as unknown as Array<{ detail: string }>
    ).map(({ detail }) => detail);
    assert.ok(details.some((detail) => detail.includes("VIRTUAL TABLE INDEX")));
    assert.ok(details.some((detail) => detail.includes("INTEGER PRIMARY KEY")));
  } finally {
    database.close();
  }
}

function testCandidateSupersetAtBoundaries(): void {
  const database = createDatabase();
  try {
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    const queries: MichelinProviderSpatialInput[] = [
      { latitude: 37.77, longitude: -122.42 },
      { latitude: 0.1, longitude: 179.9995 },
      { latitude: 89.9999, longitude: 35 },
      { latitude: -89.9999, longitude: -145 },
    ];
    const exactBoundaryIdsByQuery: string[][] = queries.map(() => []);
    let restaurantOrdinal = 0;
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex]!;
      for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
        for (const distance of [0, 250, 999.99, 1000, 1000.01]) {
          const point = destination(query.latitude, query.longitude, distance, bearing);
          const id = `boundary-${restaurantOrdinal++}`;
          insertRestaurant(database, id, point.latitude, point.longitude, "v2");
          if (distance === 1000) {
            assert.ok(
              Math.abs(
                calculateDistanceMeters(query.latitude, query.longitude, point.latitude, point.longitude) - 1000,
              ) < 0.01,
            );
            exactBoundaryIdsByQuery[queryIndex]!.push(id);
          }
        }
      }
    }
    const random = createRandom(0x517a7);
    for (let index = 0; index < 256; index++) {
      insertRestaurant(database, `global-${index}`, random() * 179.8 - 89.9, random() * 360 - 180);
    }

    const sourceRows = database
      .prepare("SELECT rowid, id, latitude, longitude FROM michelin_restaurants ORDER BY rowid")
      .all() as unknown as GuideRow[];
    const grouped = groupMichelinProviderSpatialCandidates(rawCandidates(database, queries), queries.length);
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex]!;
      const candidateIds = new Set(grouped[queryIndex]!.map(({ id }) => id));
      const exactIds = sourceRows
        .filter(
          (row) =>
            calculateDistanceMeters(query.latitude, query.longitude, row.latitude, row.longitude) <=
            MICHELIN_PROVIDER_SPATIAL_RADIUS_METERS,
        )
        .map(({ id }) => id);
      assert.ok(exactIds.length >= 24, "each edge query must exercise many exact-radius points");
      for (const id of exactIds) {
        assert.ok(candidateIds.has(id), `candidate bounds omitted exact-radius row ${id}`);
      }
      for (const id of exactBoundaryIdsByQuery[queryIndex]!) {
        assert.ok(candidateIds.has(id), `candidate bounds omitted theoretical 1000 m boundary row ${id}`);
      }
      assert.deepEqual(
        grouped[queryIndex]!.map(({ sourceOrder }) => sourceOrder),
        [...grouped[queryIndex]!.map(({ sourceOrder }) => sourceOrder)].sort((left, right) => left - right),
      );
    }
  } finally {
    database.close();
  }
}

function testChunkingAndRowValidation(): void {
  const inputs = Array.from({ length: 130 }, (_, index) => ({
    latitude: 10 + index / 1000,
    longitude: 20 + index / 1000,
  }));
  const plans = buildMichelinProviderSpatialQueryPlans(inputs);
  assert.equal(MICHELIN_PROVIDER_SPATIAL_BATCH_SIZE, 64);
  assert.deepEqual(
    plans.map(({ startIndex, inputCount }) => [startIndex, inputCount]),
    [
      [0, 64],
      [64, 64],
      [128, 2],
    ],
  );
  assert.deepEqual(
    plans.map(({ parameters }) => parameters.length),
    [64, 64, 2].map(
      (inputCount) => inputCount * MICHELIN_PROVIDER_SPATIAL_BINDS_PER_INPUT + MICHELIN_PROVIDER_SPATIAL_FIXED_BINDS,
    ),
  );
  assert.ok(plans.every(({ parameters }) => parameters.length <= MICHELIN_PROVIDER_SPATIAL_MAX_BINDS));
  assert.deepEqual(buildMichelinProviderSpatialQueryPlans([]), []);
  assert.throws(() => buildMichelinProviderSpatialQueryPlans(inputs, 125), /between 1 and 124/);
  assert.throws(() => buildMichelinProviderSpatialCandidateSql(125), /must not exceed 124/);

  const row: MichelinProviderSpatialCandidateRow = {
    reservationOrdinal: 0,
    sourceOrder: 2,
    id: "two",
    name: "Two",
    latitude: 1,
    longitude: 2,
  };
  assert.deepEqual(
    groupMichelinProviderSpatialCandidates([{ ...row }, { ...row }], 1)[0]?.map(({ id }) => id),
    ["two"],
  );
  assert.throws(
    () => groupMichelinProviderSpatialCandidates([{ ...row, reservationOrdinal: 1 }], 1),
    /outside the input range/,
  );
  assert.throws(
    () => groupMichelinProviderSpatialCandidates([{ ...row, sourceOrder: 1.5 }], 1),
    /must be a safe integer/,
  );
  assert.throws(() => groupMichelinProviderSpatialCandidates([{ ...row, latitude: 91 }], 1), /latitude must be finite/);
  assert.throws(
    () => groupMichelinProviderSpatialCandidates([{ ...row, latitude: 0, longitude: 0 }], 1),
    /excluded 0,0/,
  );
  assert.throws(
    () => groupMichelinProviderSpatialCandidates([{ ...row }, { ...row, id: "conflict" }], 1),
    /conflicts with an earlier sourceOrder/,
  );
}

const TEST_NAME_TOOLS: ProviderMichelinNameTools = {
  stripComparisonAffixes: (value) => value.replace(/^reservation\s+at\s+/i, "").trim(),
  normalizeForComparison: (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  compareRestaurantAndCalendarTitle: (title, name) =>
    TEST_NAME_TOOLS.normalizeForComparison(TEST_NAME_TOOLS.stripComparisonAffixes(title)) ===
    TEST_NAME_TOOLS.normalizeForComparison(TEST_NAME_TOOLS.stripComparisonAffixes(name)),
  isFuzzyRestaurantMatch: (left, right) => {
    const normalizedLeft = TEST_NAME_TOOLS.normalizeForComparison(left);
    const normalizedRight = TEST_NAME_TOOLS.normalizeForComparison(right);
    return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
  },
};

function literalFullGuideMatch(
  reservation: ProviderMichelinLocatedReservation,
  restaurants: readonly MichelinRestaurantRecord[],
): ProviderMichelinMatch | null {
  const normalize = (value: string): string =>
    TEST_NAME_TOOLS.normalizeForComparison(TEST_NAME_TOOLS.stripComparisonAffixes(value));
  const byName = new Map<string, MichelinRestaurantRecord[]>();
  for (const restaurant of restaurants) {
    const existing = byName.get(normalize(restaurant.name));
    if (existing) {
      existing.push(restaurant);
    } else {
      byName.set(normalize(restaurant.name), [restaurant]);
    }
  }
  const exact = (byName.get(normalize(reservation.restaurantName)) ?? [])
    .map((restaurant) => ({
      restaurant,
      distance: calculateDistanceMeters(
        reservation.latitude,
        reservation.longitude,
        restaurant.latitude,
        restaurant.longitude,
      ),
    }))
    .filter(({ distance }) => distance <= 1000)
    .sort((left, right) => left.distance - right.distance);
  if (exact[0]) {
    return { ...exact[0], kind: "exact" };
  }
  let fuzzy: ProviderMichelinMatch | null = null;
  for (const restaurant of restaurants) {
    const distance = calculateDistanceMeters(
      reservation.latitude,
      reservation.longitude,
      restaurant.latitude,
      restaurant.longitude,
    );
    if (distance > 250) {
      continue;
    }
    if (
      !TEST_NAME_TOOLS.compareRestaurantAndCalendarTitle(reservation.restaurantName, restaurant.name) &&
      !TEST_NAME_TOOLS.isFuzzyRestaurantMatch(reservation.restaurantName, restaurant.name)
    ) {
      continue;
    }
    if (!fuzzy || distance < fuzzy.distance) {
      fuzzy = { restaurant, distance, kind: "fuzzy" };
    }
  }
  return fuzzy;
}

function activeFullGuide(database: DatabaseSync): MichelinRestaurantRecord[] {
  return database
    .prepare(`SELECT
      m.id, m.name, m.latitude, m.longitude, m.address, m.location,
      m.cuisine, m.latestAwardYear, m.award
    FROM michelin_restaurants m
    WHERE NOT EXISTS (
      SELECT 1 FROM app_metadata WHERE key = 'michelin_dataset_version'
    ) OR m.datasetVersion = (
      SELECT value FROM app_metadata WHERE key = 'michelin_dataset_version'
    )
    ORDER BY m.rowid`)
    .all() as unknown as MichelinRestaurantRecord[];
}

function candidateModelMatches(
  database: DatabaseSync,
  reservations: readonly ProviderMichelinLocatedReservation[],
): {
  readonly matches: readonly (ProviderMichelinMatch | null)[];
  readonly candidateRowCount: number;
  readonly hydrationRowCount: number;
} {
  const valid: ProviderMichelinLocatedReservation[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < reservations.length; index++) {
    const reservation = reservations[index]!;
    if (!isValidProviderMichelinCoordinate(reservation.latitude, reservation.longitude)) {
      continue;
    }
    valid.push(reservation);
    originalIndices.push(index);
  }
  const raw = rawCandidates(database, valid);
  const groups = groupMichelinProviderSpatialCandidates(raw, valid.length);
  const lightweightMatches = groups.map((group, index) =>
    findProviderMichelinMatch(valid[index]!, group, TEST_NAME_TOOLS),
  );
  const selectedIds = [...new Set(lightweightMatches.flatMap((match) => (match ? [match.restaurant.id] : [])))];
  const hydrated =
    selectedIds.length === 0
      ? []
      : (database
          .prepare(MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL)
          .all(
            JSON.stringify(selectedIds),
            "michelin_dataset_version",
            "michelin_dataset_version",
          ) as unknown as MichelinRestaurantRecord[]);
  const hydratedById = new Map(hydrated.map((restaurant) => [restaurant.id, restaurant]));
  const matches: Array<ProviderMichelinMatch | null> = reservations.map(() => null);
  for (let validIndex = 0; validIndex < lightweightMatches.length; validIndex++) {
    const match = lightweightMatches[validIndex];
    if (match) {
      matches[originalIndices[validIndex]!] = {
        restaurant: hydratedById.get(match.restaurant.id)!,
        distance: match.distance,
        kind: match.kind,
      };
    }
  }
  return { matches, candidateRowCount: raw.length, hydrationRowCount: hydrated.length };
}

function testLiteralFullGuideOracleAndFallbacks(): void {
  const database = createDatabase();
  try {
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("michelin_dataset_version", "v2");
    insertRestaurant(database, "tie-first", 10, 20, "v2", "Exact Place");
    insertRestaurant(database, "tie-second", 10, 20, "v2", "Exact Place");
    insertRestaurant(database, "historical", 10, 20, "v1", "Exact Place");
    insertRestaurant(database, "fuzzy", 11, 21, "v2", "Fuzzy Bistro");
    const exactBoundary = destination(12, 22, 999.99, 0);
    insertRestaurant(database, "exact-boundary", exactBoundary.latitude, exactBoundary.longitude, "v2", "Boundary");
    const exactOutside = destination(13, 23, 1000.01, 0);
    insertRestaurant(database, "exact-outside", exactOutside.latitude, exactOutside.longitude, "v2", "Outside");
    const fuzzyBoundary = destination(14, 24, 249.99, 90);
    insertRestaurant(database, "fuzzy-boundary", fuzzyBoundary.latitude, fuzzyBoundary.longitude, "v2", "Needle House");
    const fuzzyOutside = destination(15, 25, 250.01, 90);
    insertRestaurant(database, "fuzzy-outside", fuzzyOutside.latitude, fuzzyOutside.longitude, "v2", "Far Needle");

    const reservations: ProviderMichelinLocatedReservation[] = [
      { restaurantName: "Reservation at Exact Place", latitude: 10, longitude: 20 },
      { restaurantName: "Fuzzy", latitude: 11, longitude: 21 },
      { restaurantName: "Boundary", latitude: 12, longitude: 22 },
      { restaurantName: "Outside", latitude: 13, longitude: 23 },
      { restaurantName: "Needle", latitude: 14, longitude: 24 },
      { restaurantName: "Needle", latitude: 15, longitude: 25 },
      { restaurantName: "Reservation at Exact Place", latitude: 10, longitude: 20 },
      { restaurantName: "Invalid", latitude: Number.NaN, longitude: 0 },
      { restaurantName: "Invalid", latitude: 91, longitude: 0 },
    ];
    const assertOracleParity = (): void => {
      const fullGuide = activeFullGuide(database);
      const expected = reservations.map((reservation) =>
        isValidProviderMichelinCoordinate(reservation.latitude, reservation.longitude)
          ? literalFullGuideMatch(reservation, fullGuide)
          : null,
      );
      const candidate = candidateModelMatches(database, reservations);
      assert.deepEqual(
        candidate.matches.map((match) => match?.restaurant.id ?? null),
        expected.map((match) => match?.restaurant.id ?? null),
      );
      for (let index = 0; index < expected.length; index++) {
        if (expected[index] && candidate.matches[index]) {
          assert.ok(Math.abs(expected[index]!.distance - candidate.matches[index]!.distance) < 1e-7);
        }
      }
      assert.equal(
        candidate.hydrationRowCount,
        new Set(candidate.matches.flatMap((match) => (match ? [match.restaurant.id] : []))).size,
      );
      assert.ok(candidate.hydrationRowCount < candidate.candidateRowCount);
    };
    assertOracleParity();
    database.prepare("DELETE FROM app_metadata WHERE key = 'michelin_dataset_version'").run();
    assertOracleParity();

    assert.deepEqual(candidateModelMatches(database, []).matches, []);
    assert.deepEqual(
      candidateModelMatches(database, [
        { restaurantName: "Invalid", latitude: Number.NaN, longitude: 0 },
        { restaurantName: "Invalid", latitude: 0, longitude: Number.POSITIVE_INFINITY },
      ]).matches,
      [null, null],
    );

    const fallbackRestaurants = activeFullGuide(database);
    const fallbackMap = buildProviderMichelinRestaurantsByNormalizedName(fallbackRestaurants, TEST_NAME_TOOLS);
    const requestedFallbacks = collectProviderMichelinFallbackNormalizedNames(
      [
        { restaurantName: "Exact Place", latitude: 10, longitude: 20 },
        { restaurantName: "Fuzzy Bistro", latitude: null, longitude: null },
        { restaurantName: "Exact Place", latitude: null, longitude: 20 },
      ],
      TEST_NAME_TOOLS,
    );
    assert.deepEqual([...requestedFallbacks].sort(), ["exact place", "fuzzy bistro"]);
    assert.equal(getUniqueProviderMichelinNameFallback("Fuzzy Bistro", fallbackMap, TEST_NAME_TOOLS)?.id, "fuzzy");
    assert.equal(getUniqueProviderMichelinNameFallback("Exact Place", fallbackMap, TEST_NAME_TOOLS), null);
  } finally {
    database.close();
  }
}

function testProductionIntegrationSourceContract(): void {
  const reservationSource = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
  const databaseSource = readFileSync(new URL("../utils/db/michelin.ts", import.meta.url), "utf8");
  const coreSource = readFileSync(new URL("../utils/db/core.ts", import.meta.url), "utf8");
  assert.doesNotMatch(reservationSource, /getAllMichelinRestaurants/);
  assert.match(reservationSource, /getMichelinRestaurantsForCalendarNormalizedNames/);
  assert.match(reservationSource, /selectMichelinProviderSpatialCandidates/);
  assert.equal(reservationSource.match(/await matchLocatedReservationsToMichelin\(/g)?.length, 2);
  const resolveStart = reservationSource.indexOf("async function resolveReservationLocation");
  const resolveEnd = reservationSource.indexOf("async function loadProviderMichelinFallbackRestaurantsByName");
  const resolveSource = reservationSource.slice(resolveStart, resolveEnd);
  assert.ok(
    resolveSource.indexOf("searchPlaceByText") < resolveSource.indexOf("getUniqueProviderMichelinNameFallback"),
  );
  assert.match(databaseSource, /withExclusiveTransactionAsync/);
  assert.match(databaseSource, /selectedIds/);
  assert.match(databaseSource, /outside its candidate group/);
  assert.match(databaseSource, /JSON\.stringify\(selectedIds\)/);
  assert.ok(coreSource.indexOf("VACUUM;") < coreSource.indexOf("rebuildMichelinProviderSpatialIndex(database)"));
  assert.ok(
    coreSource.indexOf("DROP TABLE IF EXISTS michelin_restaurant_spatial_index") <
      coreSource.indexOf("DROP TABLE IF EXISTS michelin_restaurants"),
  );
}

testBoundsAndInputValidation();
testBackfillTriggersRepairAndRollback();
await testEnsureUpsertsAndZeroWriteHealthyStartup();
await testInvalidationSurvivesFailedRepair();
await testVacuumRowidRemapRequiresRebuild();
testConcurrentDatasetSnapshot();
testActiveDatasetSourceOrderAndQueryPlan();
testCandidateSupersetAtBoundaries();
testChunkingAndRowValidation();
testLiteralFullGuideOracleAndFallbacks();
testProductionIntegrationSourceContract();

console.log(
  "Michelin provider spatial tests passed: full-guide parity, winner hydration, R-Tree lifecycle/VACUUM, snapshots, zero-write startup, and fallbacks.",
);
