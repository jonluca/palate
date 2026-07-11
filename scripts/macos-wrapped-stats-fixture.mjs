#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL,
  MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL,
  MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL,
} from "../utils/db/michelin-provider-spatial-core.ts";

const FIXTURE_RESTAURANT_ID = "michelin-1";
const FIRST_YEAR = 2012;
const LAST_YEAR = 2026;
const YEAR_COUNT = LAST_YEAR - FIRST_YEAR + 1;
const LEGACY_ALL_TIME_SQL_CALLS = 24 + YEAR_COUNT;
const CANDIDATE_ALL_TIME_SQL_CALLS = 20;
const SELECTED_YEAR_SQL_CALLS = 19;
const PROVIDER_SPATIAL_TABLE = "michelin_restaurant_spatial_index";
const PROVIDER_SPATIAL_SHADOW_TABLES = [
  `${PROVIDER_SPATIAL_TABLE}_node`,
  `${PROVIDER_SPATIAL_TABLE}_parent`,
  `${PROVIDER_SPATIAL_TABLE}_rowid`,
];
const PROVIDER_SPATIAL_TRIGGERS = [
  "michelin_provider_spatial_delete",
  "michelin_provider_spatial_insert",
  "michelin_provider_spatial_update",
];
const PROVIDER_SPATIAL_SCHEMA_SHAPE = [
  { type: "table", name: PROVIDER_SPATIAL_TABLE, tableName: PROVIDER_SPATIAL_TABLE },
  ...PROVIDER_SPATIAL_SHADOW_TABLES.map((name) => ({ type: "table", name, tableName: name })),
  ...PROVIDER_SPATIAL_TRIGGERS.map((name) => ({ type: "trigger", name, tableName: "michelin_restaurants" })),
].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));

function usage() {
  process.stdout.write(`Usage:
  macos-wrapped-stats-fixture.mjs prepare --database=PATH --manifest=PATH
  macos-wrapped-stats-fixture.mjs verify-spatial --database=PATH
  macos-wrapped-stats-fixture.mjs oracle --database=PATH --report=PATH
  macos-wrapped-stats-fixture.mjs validate --candidate=PATH --prepared=PATH --manifest=PATH --report=PATH

The helper only reads or changes the disposable database path supplied by its caller.
It never discovers, copies, installs, or opens Palate's live database.
`);
}

function parseArguments(rawArguments) {
  const parsed = new Map();
  for (const rawArgument of rawArguments) {
    if (rawArgument === "--help" || rawArgument === "-h") {
      parsed.set("help", "true");
      continue;
    }
    const match = /^--([a-z0-9-]+)=(.*)$/u.exec(rawArgument);
    if (!match) {
      throw new Error(`Invalid argument: ${rawArgument}`);
    }
    if (parsed.has(match[1])) {
      throw new Error(`Duplicate argument: --${match[1]}`);
    }
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

function requiredArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (!value) {
    throw new Error(`Missing required argument: --${name}=...`);
  }
  return value;
}

function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function fileSize(path) {
  try {
    return Number(statSync(path).size);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function openDatabase(path, { readOnly = false } = {}) {
  const database = new DatabaseSync(path, { readOnly });
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return database;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requireTables(database, tableNames) {
  const statement = database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?");
  for (const tableName of tableNames) {
    if (statement.get(tableName)?.present !== 1) {
      throw new Error(`Required table is missing: ${tableName}`);
    }
  }
}

function checkpointAndClose(database) {
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint && Number(checkpoint.busy ?? 0) !== 0) {
    database.close();
    throw new Error(`WAL checkpoint remained busy: ${JSON.stringify(checkpoint)}`);
  }
  database.close();
}

function integrity(database) {
  const quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check ?? "missing");
  const integrityCheck = String(database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "missing");
  const foreignKeyViolationCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get().count,
  );
  return { quickCheck, integrityCheck, foreignKeyViolationCount };
}

function providerSpatialSummary(database) {
  const expectedNames = PROVIDER_SPATIAL_SCHEMA_SHAPE.map(({ name }) => name);
  const placeholders = expectedNames.map(() => "?").join(", ");
  const schemaShape = database
    .prepare(`
      SELECT type, name, tbl_name AS tableName
      FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY type, name
    `)
    .all(...expectedNames)
    .map((row) => ({ type: String(row.type), name: String(row.name), tableName: String(row.tableName) }));
  if (JSON.stringify(schemaShape) !== JSON.stringify(PROVIDER_SPATIAL_SCHEMA_SHAPE)) {
    throw new Error(`Provider spatial schema shape mismatch: ${JSON.stringify(schemaShape)}`);
  }

  const spatialColumns = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(PROVIDER_SPATIAL_TABLE)})`)
    .all()
    .map((row) => String(row.name));
  const expectedSpatialColumns = [
    "restaurantRowId",
    "minimumLatitude",
    "maximumLatitude",
    "minimumLongitude",
    "maximumLongitude",
  ];
  if (JSON.stringify(spatialColumns) !== JSON.stringify(expectedSpatialColumns)) {
    throw new Error(`Provider spatial columns mismatch: ${JSON.stringify(spatialColumns)}`);
  }

  const validGuideRestaurantCount = Number(
    database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM michelin_restaurants
        WHERE latitude BETWEEN -90.0 AND 90.0
          AND longitude BETWEEN -180.0 AND 180.0
          AND NOT (latitude = 0.0 AND longitude = 0.0)
      `)
      .get().count,
  );
  const indexedRestaurantCount = Number(
    database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(PROVIDER_SPATIAL_TABLE)}`).get().count,
  );
  const healthIssueCount = Number(database.prepare(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL).get()?.issueCount ?? -1);
  const rtreeCheck = String(
    database.prepare("SELECT rtreecheck(?) AS result").get(PROVIDER_SPATIAL_TABLE)?.result ?? "missing",
  );
  const rtreeCompileOptionEnabled =
    Number(database.prepare("SELECT sqlite_compileoption_used('ENABLE_RTREE') AS enabled").get()?.enabled ?? 0) === 1;
  if (
    !rtreeCompileOptionEnabled ||
    indexedRestaurantCount !== validGuideRestaurantCount ||
    healthIssueCount !== 0 ||
    rtreeCheck !== "ok"
  ) {
    throw new Error(
      `Provider spatial prewarm failed: ${JSON.stringify({
        rtreeCompileOptionEnabled,
        validGuideRestaurantCount,
        indexedRestaurantCount,
        healthIssueCount,
        rtreeCheck,
      })}`,
    );
  }

  return {
    tableName: PROVIDER_SPATIAL_TABLE,
    schemaObjectCount: schemaShape.length,
    virtualTableCount: schemaShape.filter(({ name }) => name === PROVIDER_SPATIAL_TABLE).length,
    shadowTableCount: schemaShape.filter(({ name }) => PROVIDER_SPATIAL_SHADOW_TABLES.includes(name)).length,
    triggerCount: schemaShape.filter(({ type }) => type === "trigger").length,
    rtreeCompileOptionEnabled,
    validGuideRestaurantCount,
    indexedRestaurantCount,
    healthIssueCount,
    rtreeCheck,
  };
}

function prewarmProviderSpatialIndex(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS michelin_provider_spatial_delete;
      DROP TRIGGER IF EXISTS michelin_provider_spatial_insert;
      DROP TRIGGER IF EXISTS michelin_provider_spatial_update;
      DROP TABLE IF EXISTS ${PROVIDER_SPATIAL_TABLE};
    `);
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    database.exec(MICHELIN_PROVIDER_SPATIAL_BACKFILL_SQL);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return providerSpatialSummary(database);
}

function verifyProviderSpatialStartupIsReadOnly(databasePath) {
  const databaseSha256Before = sha256File(databasePath);
  const walPath = `${databasePath}-wal`;
  const walBytesBefore = fileSize(walPath);
  if (walBytesBefore !== 0) {
    throw new Error(`Provider spatial startup verification requires an empty WAL; found ${walBytesBefore} bytes`);
  }

  const database = openDatabase(databasePath);
  let summary;
  try {
    // This is the exact healthy-startup sequence: idempotent schema guards,
    // followed by the read-only health query inside providerSpatialSummary.
    database.exec(MICHELIN_PROVIDER_SPATIAL_SCHEMA_SQL);
    summary = providerSpatialSummary(database);
  } finally {
    database.close();
  }

  const databaseSha256After = sha256File(databasePath);
  const walBytesAfter = fileSize(walPath);
  if (databaseSha256After !== databaseSha256Before || walBytesAfter !== 0) {
    throw new Error(
      `Healthy provider spatial startup wrote to its fixture: ${JSON.stringify({
        databaseBytesChanged: databaseSha256After !== databaseSha256Before,
        walBytesAfter,
      })}`,
    );
  }
  process.stdout.write(
    `Verified zero-write provider spatial startup (${summary.indexedRestaurantCount} indexed rows)\n`,
  );
}

function selectedFixtureRows(database) {
  return database
    .prepare(`
      WITH ranked AS (
        SELECT
          v.id,
          CAST(strftime('%Y', datetime(v.startTime / 1000, 'unixepoch')) AS INTEGER) AS year,
          v.startTime,
          v.photoCount,
          v.foodProbable,
          v.calendarEventId,
          v.suggestedRestaurantId,
          ROW_NUMBER() OVER (
            PARTITION BY strftime('%Y', datetime(v.startTime / 1000, 'unixepoch'))
            ORDER BY (v.calendarEventId IS NOT NULL) DESC, v.photoCount DESC, v.id
          ) AS rank
        FROM visits v
      )
      SELECT
        r.id,
        r.year,
        r.startTime,
        r.photoCount,
        r.foodProbable,
        r.calendarEventId,
        r.suggestedRestaurantId,
        (SELECT COUNT(*) FROM photos p WHERE p.visitId = r.id) AS attachedPhotoCount
      FROM ranked r
      WHERE r.rank = 1 AND r.year BETWEEN ? AND ?
      ORDER BY r.year
    `)
    .all(FIRST_YEAR, LAST_YEAR);
}

function verifyFixtureRows(rows) {
  if (rows.length !== YEAR_COUNT) {
    throw new Error(`Fixture requires ${YEAR_COUNT} represented UTC years; found ${rows.length}`);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expectedYear = FIRST_YEAR + index;
    const row = rows[index];
    if (Number(row.year) !== expectedYear) {
      throw new Error(`Fixture year ${expectedYear} is missing`);
    }
    if (Number(row.photoCount) !== Number(row.attachedPhotoCount)) {
      throw new Error(
        `Visit ${row.id} has photoCount=${row.photoCount} but ${row.attachedPhotoCount} attached photo rows`,
      );
    }
  }
}

function prepareFixture(databasePath, manifestPath) {
  const database = openDatabase(databasePath);
  requireTables(database, ["visits", "photos", "restaurants", "michelin_restaurants"]);
  const sourceIntegrity = integrity(database);
  if (
    sourceIntegrity.quickCheck !== "ok" ||
    sourceIntegrity.integrityCheck !== "ok" ||
    sourceIntegrity.foreignKeyViolationCount !== 0
  ) {
    database.close();
    throw new Error(`Source copy failed integrity validation: ${JSON.stringify(sourceIntegrity)}`);
  }
  const confirmedCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM visits WHERE status = 'confirmed'").get().count,
  );
  if (confirmedCount !== 0) {
    database.close();
    throw new Error(`Source copy already contains ${confirmedCount} confirmed visit(s)`);
  }
  if (
    Number(
      database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE id = ?").get(FIXTURE_RESTAURANT_ID).count,
    ) !== 0
  ) {
    database.close();
    throw new Error(`Source copy already contains reserved restaurant ${FIXTURE_RESTAURANT_ID}`);
  }
  const michelinRestaurant = database
    .prepare(`
      SELECT id, name, latitude, longitude, address, location, cuisine, award
      FROM michelin_restaurants
      WHERE id = ?
    `)
    .get(FIXTURE_RESTAURANT_ID);
  if (!michelinRestaurant) {
    database.close();
    throw new Error(`Required Michelin row is missing: ${FIXTURE_RESTAURANT_ID}`);
  }
  const rows = selectedFixtureRows(database);
  verifyFixtureRows(rows);
  const selectedVisitIds = rows.map((row) => String(row.id));
  const placeholders = selectedVisitIds.map(() => "?").join(", ");

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`
        INSERT INTO restaurants (id, name, latitude, longitude, address, cuisine)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(michelinRestaurant.id),
        String(michelinRestaurant.name),
        Number(michelinRestaurant.latitude),
        Number(michelinRestaurant.longitude),
        String(michelinRestaurant.address),
        String(michelinRestaurant.cuisine),
      );
    const updateResult = database
      .prepare(`
        UPDATE visits
        SET status = 'confirmed', restaurantId = ?
        WHERE id IN (${placeholders})
      `)
      .run(FIXTURE_RESTAURANT_ID, ...selectedVisitIds);
    if (Number(updateResult.changes) !== YEAR_COUNT) {
      throw new Error(`Expected to confirm ${YEAR_COUNT} visits; updated ${updateResult.changes}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  let providerSpatial;
  try {
    providerSpatial = prewarmProviderSpatialIndex(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const preparedIntegrity = integrity(database);
  if (
    preparedIntegrity.quickCheck !== "ok" ||
    preparedIntegrity.integrityCheck !== "ok" ||
    preparedIntegrity.foreignKeyViolationCount !== 0
  ) {
    database.close();
    throw new Error(`Prepared copy failed integrity validation: ${JSON.stringify(preparedIntegrity)}`);
  }
  const selectedSummary = database
    .prepare(`
      SELECT
        COUNT(*) AS confirmedVisits,
        COUNT(DISTINCT restaurantId) AS uniqueRestaurants,
        SUM(photoCount) AS totalPhotos,
        ROUND(AVG(photoCount), 1) AS averagePhotos,
        SUM(calendarEventId IS NOT NULL) AS calendarLinkedVisits,
        SUM(foodProbable = 1) AS foodProbableVisits,
        SUM(suggestedRestaurantId IS NOT NULL) AS primarySuggestedVisits
      FROM visits
      WHERE status = 'confirmed'
    `)
    .get();
  checkpointAndClose(database);

  atomicWriteJson(manifestPath, {
    schemaVersion: 2,
    fixtureKind: "one-real-visit-per-utc-year",
    databaseSha256: sha256File(databasePath),
    constants: {
      fixtureRestaurantId: FIXTURE_RESTAURANT_ID,
      firstYear: FIRST_YEAR,
      lastYear: LAST_YEAR,
      yearCount: YEAR_COUNT,
      legacyAllTimeSqlCalls: LEGACY_ALL_TIME_SQL_CALLS,
      candidateAllTimeSqlCalls: CANDIDATE_ALL_TIME_SQL_CALLS,
      selectedYearSqlCalls: SELECTED_YEAR_SQL_CALLS,
    },
    restaurant: michelinRestaurant,
    selectedVisitIds,
    selectedYears: rows.map((row) => Number(row.year)),
    selectedRows: rows,
    prepared: {
      confirmedVisits: Number(selectedSummary.confirmedVisits),
      uniqueRestaurants: Number(selectedSummary.uniqueRestaurants),
      totalPhotos: Number(selectedSummary.totalPhotos),
      averagePhotos: Number(selectedSummary.averagePhotos),
      calendarLinkedVisits: Number(selectedSummary.calendarLinkedVisits),
      foodProbableVisits: Number(selectedSummary.foodProbableVisits),
      primarySuggestedVisits: Number(selectedSummary.primarySuggestedVisits),
      threeStarVisits: YEAR_COUNT,
      accumulatedStars: YEAR_COUNT * 3,
      mapPointCount: 1,
      providerSpatial,
    },
    integrity: preparedIntegrity,
  });
  process.stdout.write(`Prepared ${YEAR_COUNT}-year Wrapped Stats fixture in ${databasePath}\n`);
}

function statsFor(database, year = null) {
  const yearClause =
    year === null ? "" : "AND CAST(strftime('%Y', datetime(v.startTime / 1000, 'unixepoch')) AS INTEGER) = ?";
  const parameters = year === null ? [] : [year];
  const headline = database
    .prepare(`
      SELECT
        COUNT(*) AS confirmedVisits,
        COUNT(DISTINCT v.restaurantId) AS uniqueRestaurants,
        COALESCE(SUM(v.photoCount), 0) AS totalPhotos,
        ROUND(COALESCE(AVG(v.photoCount), 0), 1) AS averagePhotos,
        COALESCE(SUM(v.calendarEventId IS NOT NULL), 0) AS calendarLinkedVisits,
        COALESCE(SUM(v.foodProbable = 1), 0) AS foodProbableVisits,
        MIN(v.startTime) AS firstVisitDate
      FROM visits v
      WHERE v.status = 'confirmed' ${yearClause}
    `)
    .get(...parameters);
  const awardRows = database
    .prepare(`
      SELECT COALESCE(v.awardAtVisit, m.award) AS award, COUNT(DISTINCT v.id) AS count
      FROM visits v
      JOIN michelin_restaurants m ON m.id = v.restaurantId
      WHERE v.status = 'confirmed' ${yearClause}
      GROUP BY COALESCE(v.awardAtVisit, m.award)
      ORDER BY award
    `)
    .all(...parameters);
  const distinctAwardRows = database
    .prepare(`
      SELECT COALESCE(v.awardAtVisit, m.award) AS award, COUNT(DISTINCT m.id) AS count
      FROM visits v
      JOIN michelin_restaurants m ON m.id = v.restaurantId
      WHERE v.status = 'confirmed' ${yearClause}
      GROUP BY COALESCE(v.awardAtVisit, m.award)
      ORDER BY award
    `)
    .all(...parameters);
  const distinctStarredRestaurants = Number(
    database
      .prepare(`
        SELECT COUNT(DISTINCT m.id) AS count
        FROM visits v
        JOIN michelin_restaurants m ON m.id = v.restaurantId
        WHERE v.status = 'confirmed' ${yearClause}
          AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%'
            OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')
      `)
      .get(...parameters).count,
  );
  const distinctStars = Number(
    database
      .prepare(`
        SELECT SUM(
          CASE
            WHEN lower(t.award) LIKE '%3 star%' THEN 3
            WHEN lower(t.award) LIKE '%2 star%' THEN 2
            WHEN lower(t.award) LIKE '%1 star%' THEN 1
            ELSE 0
          END
        ) AS distinctStars
        FROM (
          SELECT DISTINCT m.id, COALESCE(v.awardAtVisit, m.award) AS award
          FROM visits v
          JOIN michelin_restaurants m ON m.id = v.restaurantId
          WHERE v.status = 'confirmed' ${yearClause}
            AND (COALESCE(v.awardAtVisit, m.award) LIKE '%star%'
              OR COALESCE(v.awardAtVisit, m.award) LIKE '%Star%')
        ) t
      `)
      .get(...parameters).distinctStars ?? 0,
  );
  const greenStarVisits = Number(
    database
      .prepare(`
        SELECT COUNT(DISTINCT v.id) AS count
        FROM visits v
        JOIN michelin_restaurants m ON m.id = v.restaurantId
        WHERE v.status = 'confirmed' ${yearClause}
          AND (COALESCE(v.awardAtVisit, m.award) LIKE '%Green Star%'
            OR COALESCE(v.awardAtVisit, m.award) LIKE '%green star%')
      `)
      .get(...parameters).count,
  );
  const michelinStats = {
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
  for (const row of awardRows) {
    if (!row.award) {
      continue;
    }
    const award = String(row.award).toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      michelinStats.threeStars += count;
      michelinStats.totalAccumulatedStars += count * 3;
    } else if (award.includes("2 star")) {
      michelinStats.twoStars += count;
      michelinStats.totalAccumulatedStars += count * 2;
    } else if (award.includes("1 star")) {
      michelinStats.oneStars += count;
      michelinStats.totalAccumulatedStars += count;
    } else if (award.includes("bib")) {
      michelinStats.bibGourmand += count;
    } else if (award.includes("selected")) {
      michelinStats.selected += count;
    }
    michelinStats.totalStarredVisits += count;
  }
  for (const row of distinctAwardRows) {
    if (!row.award) {
      continue;
    }
    const award = String(row.award).toLowerCase();
    const count = Number(row.count);
    if (award.includes("3 star")) {
      michelinStats.distinctThreeStars += count;
    } else if (award.includes("2 star")) {
      michelinStats.distinctTwoStars += count;
    } else if (award.includes("1 star")) {
      michelinStats.distinctOneStars += count;
    } else if (award.includes("bib")) {
      michelinStats.distinctBibGourmand += count;
    } else if (award.includes("selected")) {
      michelinStats.distinctSelected += count;
    }
  }
  const monthlyVisits = database
    .prepare(`
      SELECT
        CAST(strftime('%Y', datetime(v.startTime / 1000, 'unixepoch')) AS INTEGER) AS year,
        CAST(strftime('%m', datetime(v.startTime / 1000, 'unixepoch')) AS INTEGER) AS month,
        COUNT(*) AS visits
      FROM visits v
      WHERE v.status = 'confirmed' ${yearClause}
      GROUP BY year, month
      ORDER BY year, month
    `)
    .all(...parameters)
    .map((row) => ({ year: Number(row.year), month: Number(row.month), visits: Number(row.visits) }));
  const mapPoints = database
    .prepare(`
      SELECT r.id, r.name, r.latitude, r.longitude, COUNT(DISTINCT v.id) AS visits
      FROM visits v
      JOIN restaurants r ON r.id = v.restaurantId
      WHERE v.status = 'confirmed' ${yearClause}
      GROUP BY r.id, r.name, r.latitude, r.longitude
      ORDER BY visits DESC, r.name
    `)
    .all(...parameters)
    .map((row) => ({ ...row, visits: Number(row.visits) }));
  return {
    year,
    confirmedVisits: Number(headline.confirmedVisits),
    uniqueRestaurants: Number(headline.uniqueRestaurants),
    totalPhotos: Number(headline.totalPhotos),
    averagePhotos: Number(headline.averagePhotos),
    calendarLinkedVisits: Number(headline.calendarLinkedVisits),
    foodProbableVisits: Number(headline.foodProbableVisits),
    firstVisitDate: headline.firstVisitDate === null ? null : Number(headline.firstVisitDate),
    threeStarVisits: michelinStats.threeStars,
    accumulatedStars: michelinStats.totalAccumulatedStars,
    michelinStats,
    monthlyVisits,
    mapPoints,
  };
}

function writeOracle(databasePath, reportPath) {
  const database = openDatabase(databasePath, { readOnly: true });
  requireTables(database, ["visits", "photos", "restaurants", "michelin_restaurants"]);
  const databaseIntegrity = integrity(database);
  const years = database
    .prepare(`
      SELECT DISTINCT CAST(strftime('%Y', datetime(startTime / 1000, 'unixepoch')) AS INTEGER) AS year
      FROM visits WHERE status = 'confirmed' ORDER BY year
    `)
    .all()
    .map((row) => Number(row.year));
  const report = {
    schemaVersion: 1,
    status:
      databaseIntegrity.quickCheck === "ok" &&
      databaseIntegrity.integrityCheck === "ok" &&
      databaseIntegrity.foreignKeyViolationCount === 0
        ? "ok"
        : "failed",
    databaseSha256: sha256File(databasePath),
    availableYears: [...years].sort((left, right) => right - left),
    allTime: statsFor(database),
    selected2025: statsFor(database, 2025),
    perYear: years.map((year) => statsFor(database, year)),
    structuralCalls: {
      legacyAllTimeSqlCalls: 24 + years.length,
      candidateAllTimeSqlCalls: CANDIDATE_ALL_TIME_SQL_CALLS,
      selectedYearSqlCalls: SELECTED_YEAR_SQL_CALLS,
    },
    integrity: databaseIntegrity,
  };
  database.close();
  atomicWriteJson(reportPath, report);
  if (report.status !== "ok") {
    throw new Error("Oracle database failed integrity validation");
  }
  process.stdout.write(`Wrote Wrapped Stats oracle to ${reportPath}\n`);
}

function tableNames(database, schema = "main") {
  return database
    .prepare(`
      SELECT name FROM ${quoteIdentifier(schema)}.sqlite_schema
      WHERE type = 'table'
        AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
      ORDER BY name
    `)
    .all()
    .map((row) => String(row.name));
}

function schemaObjects(database, schema = "main") {
  return database
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM ${quoteIdentifier(schema)}.sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence'
      ORDER BY type, name
    `)
    .all();
}

function tableColumns(database, schema, tableName) {
  return database
    .prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => String(row.name));
}

const PERSISTED_PRAGMA_NAMES = ["user_version", "application_id", "auto_vacuum", "page_size", "encoding"];

function persistedPragmas(database, schema) {
  return Object.fromEntries(
    PERSISTED_PRAGMA_NAMES.map((pragmaName) => {
      const row = database.prepare(`PRAGMA ${quoteIdentifier(schema)}.${pragmaName}`).get();
      return [pragmaName, row?.[pragmaName] ?? null];
    }),
  );
}

function compareDatabases(candidatePath, preparedPath) {
  const candidate = openDatabase(candidatePath, { readOnly: true });
  candidate.prepare("ATTACH DATABASE ? AS prepared").run(preparedPath);
  const candidateTables = tableNames(candidate, "main");
  const preparedTables = tableNames(candidate, "prepared");
  const candidateSchema = schemaObjects(candidate, "main");
  const preparedSchema = schemaObjects(candidate, "prepared");
  const schemaMatches = JSON.stringify(candidateSchema) === JSON.stringify(preparedSchema);
  const candidatePersistedPragmas = persistedPragmas(candidate, "main");
  const preparedPersistedPragmas = persistedPragmas(candidate, "prepared");
  const persistedPragmasMatch = JSON.stringify(candidatePersistedPragmas) === JSON.stringify(preparedPersistedPragmas);
  const byteIdentical = sha256File(candidatePath) === sha256File(preparedPath);
  const tableResults = [];
  if (schemaMatches) {
    for (const tableName of candidateTables) {
      const candidateColumns = tableColumns(candidate, "main", tableName);
      const preparedColumns = tableColumns(candidate, "prepared", tableName);
      const columnsMatch = JSON.stringify(candidateColumns) === JSON.stringify(preparedColumns);
      let candidateCount = -1;
      let preparedCount = -1;
      let candidateOnlyCount = -1;
      let preparedOnlyCount = -1;
      if (columnsMatch) {
        const columnList = candidateColumns.map(quoteIdentifier).join(", ");
        candidateCount = Number(
          candidate.prepare(`SELECT COUNT(*) AS count FROM main.${quoteIdentifier(tableName)}`).get().count,
        );
        preparedCount = Number(
          candidate.prepare(`SELECT COUNT(*) AS count FROM prepared.${quoteIdentifier(tableName)}`).get().count,
        );
        candidateOnlyCount = Number(
          candidate
            .prepare(`
              SELECT COUNT(*) AS count FROM (
                SELECT ${columnList}, COUNT(*) AS __row_count
                FROM main.${quoteIdentifier(tableName)}
                GROUP BY ${columnList}
                EXCEPT
                SELECT ${columnList}, COUNT(*) AS __row_count
                FROM prepared.${quoteIdentifier(tableName)}
                GROUP BY ${columnList}
              )
            `)
            .get().count,
        );
        preparedOnlyCount = Number(
          candidate
            .prepare(`
              SELECT COUNT(*) AS count FROM (
                SELECT ${columnList}, COUNT(*) AS __row_count
                FROM prepared.${quoteIdentifier(tableName)}
                GROUP BY ${columnList}
                EXCEPT
                SELECT ${columnList}, COUNT(*) AS __row_count
                FROM main.${quoteIdentifier(tableName)}
                GROUP BY ${columnList}
              )
            `)
            .get().count,
        );
      }
      tableResults.push({
        table: tableName,
        columnsMatch,
        candidateCount,
        preparedCount,
        candidateOnlyCount,
        preparedOnlyCount,
        matches:
          columnsMatch && candidateCount === preparedCount && candidateOnlyCount === 0 && preparedOnlyCount === 0,
      });
    }
  }
  const candidateIntegrity = integrity(candidate);
  candidate.close();
  return {
    schemaMatches,
    candidateSchemaObjectCount: candidateSchema.length,
    preparedSchemaObjectCount: preparedSchema.length,
    candidateTables,
    preparedTables,
    candidatePersistedPragmas,
    preparedPersistedPragmas,
    persistedPragmasMatch,
    byteIdentical,
    tables: tableResults,
    candidateIntegrity,
    matches:
      schemaMatches &&
      persistedPragmasMatch &&
      byteIdentical &&
      tableResults.every((table) => table.matches) &&
      candidateIntegrity.quickCheck === "ok" &&
      candidateIntegrity.integrityCheck === "ok" &&
      candidateIntegrity.foreignKeyViolationCount === 0,
  };
}

function validateResult(candidatePath, preparedPath, manifestPath, reportPath) {
  let report;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const comparison = compareDatabases(candidatePath, preparedPath);
    report = {
      schemaVersion: 1,
      status: comparison.matches ? "ok" : "failed",
      files: {
        candidateSha256: sha256File(candidatePath),
        preparedSha256: sha256File(preparedPath),
        manifestPreparedSha256: String(manifest.databaseSha256 ?? ""),
      },
      fixture: {
        kind: manifest.fixtureKind,
        selectedYearCount: manifest.selectedYears?.length ?? 0,
        expectedLegacyAllTimeSqlCalls: manifest.constants?.legacyAllTimeSqlCalls,
      },
      readOnlyParity: comparison,
      failureReasons: comparison.matches ? [] : ["Candidate database differs semantically from the prepared fixture"],
    };
  } catch (error) {
    report = {
      schemaVersion: 1,
      status: "failed",
      files: {
        candidateSha256: sha256File(candidatePath),
        preparedSha256: sha256File(preparedPath),
      },
      failureReasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  atomicWriteJson(reportPath, report);
  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

const [command, ...rawArguments] = process.argv.slice(2);
const argumentsMap = parseArguments(rawArguments);
if (!command || argumentsMap.has("help")) {
  usage();
  process.exit(command ? 0 : 2);
}

if (command === "prepare") {
  prepareFixture(requiredArgument(argumentsMap, "database"), requiredArgument(argumentsMap, "manifest"));
} else if (command === "verify-spatial") {
  verifyProviderSpatialStartupIsReadOnly(requiredArgument(argumentsMap, "database"));
} else if (command === "oracle") {
  writeOracle(requiredArgument(argumentsMap, "database"), requiredArgument(argumentsMap, "report"));
} else if (command === "validate") {
  validateResult(
    requiredArgument(argumentsMap, "candidate"),
    requiredArgument(argumentsMap, "prepared"),
    requiredArgument(argumentsMap, "manifest"),
    requiredArgument(argumentsMap, "report"),
  );
} else {
  throw new Error(`Unknown command: ${command}`);
}
