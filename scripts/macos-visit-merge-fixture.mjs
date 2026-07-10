#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const FIXTURE_VISIT_COUNT = 185;
const GROUP_COUNT = 37;
const VISITS_PER_GROUP = 5;
const EXPECTED_MERGE_COUNT = GROUP_COUNT * (VISITS_PER_GROUP - 1);
const LEGACY_CALLS_PER_MERGE = 11;
const REFERENCE_UPDATED_AT_MS = 1_700_000_000_000;
const MERGE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const RESTAURANT_PREFIX = "__palate_merge_validation_restaurant_";
const RESERVATION_PREFIX = "__palate_merge_validation_reservation_";
const AFFECTED_TABLES = new Set(["visits", "photos", "visit_suggested_restaurants", "reservation_import_sources"]);

function usage() {
  process.stdout.write(`Usage:
  macos-visit-merge-fixture.mjs prepare --database=PATH --manifest=PATH
  macos-visit-merge-fixture.mjs reference --database=PATH --manifest=PATH --report=PATH [--updated-at-ms=N] [--atomic=true|false]
  macos-visit-merge-fixture.mjs validate --candidate=PATH --reference=PATH --prepared=PATH --manifest=PATH --trigger-ms=N --finish-ms=N --report=PATH

Commands:
  prepare    Derive a deterministic 37x5 merge fixture from the top 185 real visits.
  reference  Apply the independent legacy 11-call-per-merge algorithm to a fixture copy.
  validate   Compare a production result with the legacy reference and prepared sentinels.

This helper never copies or installs the live database. Its caller must supply a disposable copy.
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

function parseFiniteInteger(value, name) {
  if (!/^-?[0-9]+$/u.test(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} must be a safe integer`);
  }
  return parsed;
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

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function openDatabase(path, { readOnly = false } = {}) {
  const database = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  return database;
}

function tableExists(database, tableName) {
  return (
    database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName)
      ?.present === 1
  );
}

function requireTables(database, tableNames) {
  for (const tableName of tableNames) {
    if (!tableExists(database, tableName)) {
      throw new Error(`Required table is missing: ${tableName}`);
    }
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableColumns(database, tableName) {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => String(row.name));
}

function tableRows(database, tableName) {
  const columns = tableColumns(database, tableName);
  if (columns.length === 0) {
    throw new Error(`Unable to inspect columns for table ${tableName}`);
  }
  const order = columns.map(quoteIdentifier).join(", ");
  return database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${order}`).all();
}

function databaseCounts(database) {
  return {
    visits: Number(database.prepare("SELECT COUNT(*) AS count FROM visits").get().count),
    photos: Number(database.prepare("SELECT COUNT(*) AS count FROM photos").get().count),
    suggestions: Number(database.prepare("SELECT COUNT(*) AS count FROM visit_suggested_restaurants").get().count),
    reservationSources: Number(
      database.prepare("SELECT COUNT(*) AS count FROM reservation_import_sources").get().count,
    ),
  };
}

function discoverMergeGroups(database) {
  const visits = database
    .prepare(`
      SELECT id, restaurantId, startTime, endTime
      FROM visits
      WHERE status = 'confirmed' AND restaurantId IS NOT NULL
      ORDER BY restaurantId, startTime, id
    `)
    .all();
  const groups = [];
  let restaurantVisits = [];
  let restaurantId = null;

  const finishRestaurant = () => {
    if (restaurantVisits.length < 2) {
      restaurantVisits = [];
      return;
    }
    let current = [restaurantVisits[0]];
    for (let index = 1; index < restaurantVisits.length; index += 1) {
      const visit = restaurantVisits[index];
      const previous = current[current.length - 1];
      if (Number(visit.startTime) - Number(previous.endTime) <= MERGE_THRESHOLD_MS) {
        current.push(visit);
      } else {
        if (current.length >= 2) {
          groups.push(current);
        }
        current = [visit];
      }
    }
    if (current.length >= 2) {
      groups.push(current);
    }
    restaurantVisits = [];
  };

  for (const visit of visits) {
    if (restaurantId !== null && visit.restaurantId !== restaurantId) {
      finishRestaurant();
    }
    if (visit.restaurantId !== restaurantId) {
      restaurantId = visit.restaurantId;
    }
    restaurantVisits.push(visit);
  }
  finishRestaurant();
  return groups;
}

function checkpointAndClose(database) {
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint && Number(checkpoint.busy ?? 0) !== 0) {
    database.close();
    throw new Error(`WAL checkpoint remained busy: ${JSON.stringify(checkpoint)}`);
  }
  database.close();
}

function prepareFixture(databasePath, manifestPath) {
  const database = openDatabase(databasePath);
  requireTables(database, [
    "visits",
    "photos",
    "restaurants",
    "michelin_restaurants",
    "visit_suggested_restaurants",
    "reservation_import_sources",
  ]);

  const originalCounts = databaseCounts(database);
  if (originalCounts.visits < FIXTURE_VISIT_COUNT) {
    database.close();
    throw new Error(`Fixture requires at least ${FIXTURE_VISIT_COUNT} visits; found ${originalCounts.visits}`);
  }
  const preexistingMergeGroups = discoverMergeGroups(database);
  if (preexistingMergeGroups.length !== 0) {
    database.close();
    throw new Error(
      `The source copy already has ${preexistingMergeGroups.length} mergeable group(s); refusing an ambiguous fixture`,
    );
  }
  const reservedRestaurantCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE id LIKE ?").get(`${RESTAURANT_PREFIX}%`).count,
  );
  const reservedReservationCount = Number(
    database
      .prepare("SELECT COUNT(*) AS count FROM reservation_import_sources WHERE sourceEventId LIKE ?")
      .get(`${RESERVATION_PREFIX}%`).count,
  );
  if (reservedRestaurantCount !== 0 || reservedReservationCount !== 0) {
    database.close();
    throw new Error("The source copy already contains reserved visit-merge validation identifiers");
  }

  const selectedVisits = database
    .prepare(`
      SELECT id, startTime, endTime, photoCount, foodProbable,
             calendarEventId, suggestedRestaurantId
      FROM visits
      ORDER BY photoCount DESC, id
      LIMIT ?
    `)
    .all(FIXTURE_VISIT_COUNT);
  const michelinRows = database
    .prepare(`
      SELECT id, name, latitude, longitude, address, cuisine
      FROM michelin_restaurants
      ORDER BY id
      LIMIT ?
    `)
    .all(GROUP_COUNT * 2);
  if (selectedVisits.length !== FIXTURE_VISIT_COUNT || michelinRows.length < GROUP_COUNT * 2) {
    database.close();
    throw new Error("The source copy cannot supply the deterministic visit/Michelin fixture shape");
  }

  const selectedVisitIds = selectedVisits.map((row) => String(row.id));
  const selectedPlaceholders = selectedVisitIds.map(() => "?").join(", ");
  const selectedStats = database
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM photos WHERE visitId IN (${selectedPlaceholders})) AS photoRows,
        (SELECT COUNT(*) FROM photos WHERE visitId IN (${selectedPlaceholders}) AND foodDetected = 1) AS foodPositivePhotos,
        (SELECT COUNT(*) FROM photos WHERE visitId IN (${selectedPlaceholders}) AND latitude IS NOT NULL AND longitude IS NOT NULL) AS locatedPhotos,
        (SELECT COUNT(*) FROM visit_suggested_restaurants WHERE visitId IN (${selectedPlaceholders})) AS suggestionRows
    `)
    .get(...selectedVisitIds, ...selectedVisitIds, ...selectedVisitIds, ...selectedVisitIds);

  const mappings = [];
  const groups = [];
  const restaurantIds = [];
  const targetVisitIds = [];
  const sourceVisitIds = [];
  const seededReservationSourceEventIds = [];
  const seededSuggestionCases = [];

  database.exec("BEGIN IMMEDIATE");
  try {
    const insertRestaurant = database.prepare(`
      INSERT INTO restaurants (id, name, latitude, longitude, address, cuisine)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateVisit = database.prepare(`
      UPDATE visits
      SET status = 'confirmed', restaurantId = ?, startTime = ?, endTime = ?
      WHERE id = ?
    `);
    const deleteSeedSuggestion = database.prepare(`
      DELETE FROM visit_suggested_restaurants
      WHERE visitId = ? AND restaurantId IN (?, ?)
    `);
    const insertSeedSuggestion = database.prepare(`
      INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
      VALUES (?, ?, ?)
    `);
    const insertReservation = database.prepare(`
      INSERT INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
      VALUES (?, 'macos-visit-merge-validation', ?, ?)
    `);

    for (let groupIndex = 0; groupIndex < GROUP_COUNT; groupIndex += 1) {
      const groupVisits = selectedVisits.slice(groupIndex * VISITS_PER_GROUP, (groupIndex + 1) * VISITS_PER_GROUP);
      const restaurantId = `${RESTAURANT_PREFIX}${String(groupIndex + 1).padStart(3, "0")}__`;
      const michelinRow = michelinRows[groupIndex];
      const targetVisitId = String(groupVisits[0].id);
      const groupBaseTime = Number(groupVisits[0].startTime);
      restaurantIds.push(restaurantId);
      targetVisitIds.push(targetVisitId);
      insertRestaurant.run(
        restaurantId,
        `Merge Validation ${String(groupIndex + 1).padStart(3, "0")} · ${michelinRow.name}`,
        michelinRow.latitude,
        michelinRow.longitude,
        michelinRow.address,
        michelinRow.cuisine,
      );

      for (let ordinal = 0; ordinal < groupVisits.length; ordinal += 1) {
        const visit = groupVisits[ordinal];
        const duration = Math.max(0, Number(visit.endTime) - Number(visit.startTime));
        const startTime = groupBaseTime + ordinal * 60 * 60 * 1000;
        const endTime = startTime + duration;
        if (
          !Number.isFinite(startTime) ||
          !Number.isFinite(endTime) ||
          Math.abs(startTime) > Number.MAX_SAFE_INTEGER ||
          Math.abs(endTime) > Number.MAX_SAFE_INTEGER
        ) {
          throw new Error(`Fixture timestamp overflow in group ${groupIndex + 1}`);
        }
        updateVisit.run(restaurantId, startTime, endTime, visit.id);
        if (ordinal > 0) {
          const sourceVisitId = String(visit.id);
          const sourceEventId = `${RESERVATION_PREFIX}${String(groupIndex + 1).padStart(3, "0")}_${ordinal}__`;
          sourceVisitIds.push(sourceVisitId);
          seededReservationSourceEventIds.push(sourceEventId);
          mappings.push({
            targetVisitId,
            sourceVisitId,
            sourceOrdinal: ordinal - 1,
            groupOrdinal: groupIndex,
          });
          insertReservation.run(sourceEventId, sourceVisitId, REFERENCE_UPDATED_AT_MS + mappings.length);
        }
      }

      const firstSuggestionId = String(michelinRows[groupIndex * 2].id);
      const secondSuggestionId = String(michelinRows[groupIndex * 2 + 1].id);
      for (const visit of groupVisits) {
        deleteSeedSuggestion.run(visit.id, firstSuggestionId, secondSuggestionId);
      }
      insertSeedSuggestion.run(targetVisitId, firstSuggestionId, 10_000 + groupIndex);
      for (let ordinal = 1; ordinal < groupVisits.length; ordinal += 1) {
        insertSeedSuggestion.run(groupVisits[ordinal].id, firstSuggestionId, ordinal);
      }
      insertSeedSuggestion.run(groupVisits[1].id, secondSuggestionId, 200 + groupIndex);
      insertSeedSuggestion.run(groupVisits[2].id, secondSuggestionId, 1 + groupIndex / 1000);
      seededSuggestionCases.push({
        groupOrdinal: groupIndex,
        targetVisitId,
        targetWinsRestaurantId: firstSuggestionId,
        targetWinsDistance: 10_000 + groupIndex,
        earliestSourceWinsRestaurantId: secondSuggestionId,
        earliestSourceWinsDistance: 200 + groupIndex,
      });
      groups.push({
        groupOrdinal: groupIndex,
        restaurantId,
        targetVisitId,
        visitIds: groupVisits.map((visit) => String(visit.id)),
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original fixture error.
    }
    database.close();
    throw error;
  }

  const preparedGroups = discoverMergeGroups(database);
  const preparedMergeCount = preparedGroups.reduce((sum, group) => sum + group.length - 1, 0);
  if (preparedGroups.length !== GROUP_COUNT || preparedMergeCount !== EXPECTED_MERGE_COUNT) {
    database.close();
    throw new Error(`Prepared fixture shape mismatch: ${preparedGroups.length} groups / ${preparedMergeCount} merges`);
  }
  const preparedCounts = databaseCounts(database);
  const preparedForeignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  const preparedQuickCheck = database
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(row.quick_check));
  if (preparedForeignKeyViolations.length !== 0 || preparedQuickCheck.some((value) => value !== "ok")) {
    database.close();
    throw new Error("Prepared fixture failed SQLite integrity validation");
  }
  checkpointAndClose(database);

  const manifest = {
    schemaVersion: 1,
    fixtureKind: "mac-derived-top-photo-count-visits",
    databaseSha256: sha256File(databasePath),
    constants: {
      fixtureVisitCount: FIXTURE_VISIT_COUNT,
      groupCount: GROUP_COUNT,
      visitsPerGroup: VISITS_PER_GROUP,
      expectedMergeCount: EXPECTED_MERGE_COUNT,
      legacyCallsPerMerge: LEGACY_CALLS_PER_MERGE,
      expectedLegacyMergeExecutionCalls: EXPECTED_MERGE_COUNT * LEGACY_CALLS_PER_MERGE,
      expectedLegacyFullPathCalls: EXPECTED_MERGE_COUNT * LEGACY_CALLS_PER_MERGE + 1,
      expectedCandidateStatementCalls: 7,
      expectedCandidateTransactionControlCalls: 2,
      expectedCandidateFullPathCalls: 10,
      referenceUpdatedAtMs: REFERENCE_UPDATED_AT_MS,
      restaurantPrefix: RESTAURANT_PREFIX,
      reservationPrefix: RESERVATION_PREFIX,
    },
    source: {
      originalCounts,
      selectedStats: {
        visits: selectedVisits.length,
        denormalizedPhotoCount: selectedVisits.reduce((sum, visit) => sum + Number(visit.photoCount), 0),
        actualPhotoRows: Number(selectedStats.photoRows),
        locatedPhotoRows: Number(selectedStats.locatedPhotos),
        foodPositivePhotoRows: Number(selectedStats.foodPositivePhotos),
        foodProbableVisits: selectedVisits.filter((visit) => Number(visit.foodProbable) !== 0).length,
        calendarLinkedVisits: selectedVisits.filter((visit) => visit.calendarEventId !== null).length,
        primarySuggestedVisits: selectedVisits.filter((visit) => visit.suggestedRestaurantId !== null).length,
        suggestionRowsBeforeSeeds: Number(selectedStats.suggestionRows),
      },
    },
    prepared: {
      counts: preparedCounts,
      mergeableGroupCount: preparedGroups.length,
      mergeCount: preparedMergeCount,
      quickCheck: preparedQuickCheck,
      foreignKeyViolationCount: preparedForeignKeyViolations.length,
    },
    selectedVisitIds,
    targetVisitIds,
    sourceVisitIds,
    restaurantIds,
    seededReservationSourceEventIds,
    seededSuggestionCases,
    groups,
    mappings,
  };
  atomicWriteJson(manifestPath, manifest);
  process.stdout.write(
    `${JSON.stringify({ status: "ok", command: "prepare", manifest: manifestPath, fixture: manifest.prepared })}\n`,
  );
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.constants?.expectedMergeCount !== EXPECTED_MERGE_COUNT ||
    !Array.isArray(manifest.mappings) ||
    manifest.mappings.length !== EXPECTED_MERGE_COUNT
  ) {
    throw new Error("Unsupported or malformed visit-merge fixture manifest");
  }
  return manifest;
}

function runReference(databasePath, manifestPath, reportPath, updatedAtMs, atomic) {
  const manifest = loadManifest(manifestPath);
  const database = openDatabase(databasePath);
  requireTables(database, [...AFFECTED_TABLES]);
  let executionCalls = 0;
  const getVisit = database.prepare("SELECT * FROM visits WHERE id = ?");
  const movePhotos = database.prepare("UPDATE photos SET visitId = ? WHERE visitId = ?");
  const getLocatedPhotos = database.prepare(`
    SELECT latitude, longitude
    FROM photos
    WHERE visitId = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
  `);
  const getPhotoCount = database.prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId = ?");
  const getFood = database.prepare(`
    SELECT MAX(CASE WHEN foodDetected = 1 THEN 1 ELSE 0 END) AS hasFood
    FROM photos
    WHERE visitId = ?
  `);
  const updateTarget = database.prepare(`
    UPDATE visits
    SET startTime = ?, endTime = ?, centerLat = ?, centerLon = ?,
        photoCount = ?, foodProbable = ?, updatedAt = ?
    WHERE id = ?
  `);
  const copySuggestions = database.prepare(`
    INSERT OR IGNORE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
    SELECT ?, restaurantId, distance
    FROM visit_suggested_restaurants
    WHERE visitId = ?
  `);
  const moveReservations = database.prepare("UPDATE reservation_import_sources SET visitId = ? WHERE visitId = ?");
  const deleteSourceSuggestions = database.prepare("DELETE FROM visit_suggested_restaurants WHERE visitId = ?");
  const deleteSourceVisit = database.prepare("DELETE FROM visits WHERE id = ?");

  const startedNs = process.hrtime.bigint();
  if (atomic) {
    database.exec("BEGIN IMMEDIATE");
  }
  try {
    for (const mapping of manifest.mappings) {
      const targetVisit = getVisit.get(mapping.targetVisitId);
      executionCalls += 1;
      const sourceVisit = getVisit.get(mapping.sourceVisitId);
      executionCalls += 1;
      if (!targetVisit || !sourceVisit) {
        throw new Error("Reference fixture lost a target or source visit");
      }

      movePhotos.run(mapping.targetVisitId, mapping.sourceVisitId);
      executionCalls += 1;
      const locatedPhotos = getLocatedPhotos.all(mapping.targetVisitId);
      executionCalls += 1;
      let centerLat = Number(targetVisit.centerLat);
      let centerLon = Number(targetVisit.centerLon);
      if (locatedPhotos.length > 0) {
        let latitudeSum = 0;
        let longitudeSum = 0;
        for (const photo of locatedPhotos) {
          latitudeSum += Number(photo.latitude);
          longitudeSum += Number(photo.longitude);
        }
        centerLat = latitudeSum / locatedPhotos.length;
        centerLon = longitudeSum / locatedPhotos.length;
      }
      const photoCount = Number(getPhotoCount.get(mapping.targetVisitId).count);
      executionCalls += 1;
      const hasFood = Number(getFood.get(mapping.targetVisitId).hasFood ?? 0) === 1;
      executionCalls += 1;
      const foodProbable =
        hasFood || Number(targetVisit.foodProbable) !== 0 || Number(sourceVisit.foodProbable) !== 0 ? 1 : 0;
      updateTarget.run(
        Math.min(Number(targetVisit.startTime), Number(sourceVisit.startTime)),
        Math.max(Number(targetVisit.endTime), Number(sourceVisit.endTime)),
        centerLat,
        centerLon,
        photoCount,
        foodProbable,
        updatedAtMs,
        mapping.targetVisitId,
      );
      executionCalls += 1;
      copySuggestions.run(mapping.targetVisitId, mapping.sourceVisitId);
      executionCalls += 1;
      moveReservations.run(mapping.targetVisitId, mapping.sourceVisitId);
      executionCalls += 1;
      deleteSourceSuggestions.run(mapping.sourceVisitId);
      executionCalls += 1;
      deleteSourceVisit.run(mapping.sourceVisitId);
      executionCalls += 1;
    }
    if (atomic) {
      database.exec("COMMIT");
    }
  } catch (error) {
    if (atomic) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the merge failure.
      }
    }
    database.close();
    throw error;
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  if (executionCalls !== EXPECTED_MERGE_COUNT * LEGACY_CALLS_PER_MERGE) {
    database.close();
    throw new Error(`Reference call-count mismatch: ${executionCalls}`);
  }
  const counts = databaseCounts(database);
  const remainingSources = Number(
    database
      .prepare(`SELECT COUNT(*) AS count FROM visits WHERE id IN (${manifest.sourceVisitIds.map(() => "?").join(",")})`)
      .get(...manifest.sourceVisitIds).count,
  );
  const quickCheck = database
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(row.quick_check));
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (remainingSources !== 0 || quickCheck.some((value) => value !== "ok") || foreignKeyViolations.length !== 0) {
    database.close();
    throw new Error("Reference result failed its postconditions");
  }
  checkpointAndClose(database);
  const report = {
    schemaVersion: 1,
    status: "ok",
    strategy: "independent-legacy-sequential-reference",
    atomicFixtureSimulation: atomic,
    mergeCount: EXPECTED_MERGE_COUNT,
    executionCalls,
    fullPathCallsIncludingGroupDiscovery: executionCalls + 1,
    elapsedMs,
    updatedAtMs,
    counts,
    remainingSources,
    quickCheck,
    foreignKeyViolationCount: foreignKeyViolations.length,
    databaseSha256: sha256File(databasePath),
  };
  atomicWriteJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function rowsByKey(rows, keyColumns) {
  const map = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keyColumns.map((column) => row[column]));
    if (map.has(key)) {
      throw new Error(`Duplicate comparison key: ${key}`);
    }
    map.set(key, row);
  }
  return map;
}

function exactRowComparison(candidateRows, expectedRows, keyColumns) {
  const candidate = rowsByKey(candidateRows, keyColumns);
  const expected = rowsByKey(expectedRows, keyColumns);
  let mismatchCount = 0;
  const keys = new Set([...candidate.keys(), ...expected.keys()]);
  for (const key of keys) {
    const candidateRow = candidate.get(key);
    const expectedRow = expected.get(key);
    if (!candidateRow || !expectedRow || JSON.stringify(candidateRow) !== JSON.stringify(expectedRow)) {
      mismatchCount += 1;
    }
  }
  return {
    candidateCount: candidateRows.length,
    expectedCount: expectedRows.length,
    mismatchCount,
    candidateDigest: sha256Json(candidateRows),
    expectedDigest: sha256Json(expectedRows),
  };
}

function visitComparison(candidateRows, expectedRows, targetVisitIds, triggerMs, finishMs) {
  const candidate = rowsByKey(candidateRows, ["id"]);
  const expected = rowsByKey(expectedRows, ["id"]);
  const targetIds = new Set(targetVisitIds);
  let mismatchCount = 0;
  let centerToleranceMismatchCount = 0;
  let updatedAtBoundsFailureCount = 0;
  const keys = new Set([...candidate.keys(), ...expected.keys()]);

  for (const key of keys) {
    const candidateRow = candidate.get(key);
    const expectedRow = expected.get(key);
    if (!candidateRow || !expectedRow) {
      mismatchCount += 1;
      continue;
    }
    const target = targetIds.has(String(candidateRow.id));
    let rowMismatch = false;
    const columns = new Set([...Object.keys(candidateRow), ...Object.keys(expectedRow)]);
    for (const column of columns) {
      if (target && column === "updatedAt") {
        const updatedAt = Number(candidateRow.updatedAt);
        if (!Number.isSafeInteger(updatedAt) || updatedAt < triggerMs || updatedAt > finishMs) {
          updatedAtBoundsFailureCount += 1;
          rowMismatch = true;
        }
        continue;
      }
      if (target && (column === "centerLat" || column === "centerLon")) {
        const delta = Math.abs(Number(candidateRow[column]) - Number(expectedRow[column]));
        if (!Number.isFinite(delta) || delta > 1e-12) {
          centerToleranceMismatchCount += 1;
          rowMismatch = true;
        }
        continue;
      }
      if (!Object.is(candidateRow[column], expectedRow[column])) {
        rowMismatch = true;
      }
    }
    if (rowMismatch) {
      mismatchCount += 1;
    }
  }
  return {
    candidateCount: candidateRows.length,
    expectedCount: expectedRows.length,
    mismatchCount,
    centerAbsoluteTolerance: 1e-12,
    centerToleranceMismatchCount,
    updatedAtBounds: { triggerMs, finishMs },
    updatedAtBoundsFailureCount,
    candidateDigest: sha256Json(candidateRows),
    expectedDigest: sha256Json(expectedRows),
  };
}

function subsetRows(rows, predicate) {
  return rows.filter(predicate);
}

function validateResult(candidatePath, referencePath, preparedPath, manifestPath, triggerMs, finishMs, reportPath) {
  const manifest = loadManifest(manifestPath);
  const candidate = openDatabase(candidatePath, { readOnly: true });
  const reference = openDatabase(referencePath, { readOnly: true });
  const prepared = openDatabase(preparedPath, { readOnly: true });
  requireTables(candidate, [...AFFECTED_TABLES]);
  requireTables(reference, [...AFFECTED_TABLES]);
  requireTables(prepared, [...AFFECTED_TABLES]);

  const candidateVisits = tableRows(candidate, "visits");
  const referenceVisits = tableRows(reference, "visits");
  const preparedVisits = tableRows(prepared, "visits");
  const candidatePhotos = tableRows(candidate, "photos");
  const referencePhotos = tableRows(reference, "photos");
  const preparedPhotos = tableRows(prepared, "photos");
  const candidateSuggestions = tableRows(candidate, "visit_suggested_restaurants");
  const referenceSuggestions = tableRows(reference, "visit_suggested_restaurants");
  const candidateReservations = tableRows(candidate, "reservation_import_sources");
  const referenceReservations = tableRows(reference, "reservation_import_sources");
  const selectedIds = new Set(manifest.selectedVisitIds);

  const visits = visitComparison(candidateVisits, referenceVisits, manifest.targetVisitIds, triggerMs, finishMs);
  const photos = exactRowComparison(candidatePhotos, referencePhotos, ["id"]);
  const suggestions = exactRowComparison(candidateSuggestions, referenceSuggestions, ["visitId", "restaurantId"]);
  const reservationSources = exactRowComparison(candidateReservations, referenceReservations, ["sourceEventId"]);

  const untouchedVisits = exactRowComparison(
    subsetRows(candidateVisits, (row) => !selectedIds.has(String(row.id))),
    subsetRows(preparedVisits, (row) => !selectedIds.has(String(row.id))),
    ["id"],
  );
  const preparedPhotoById = rowsByKey(preparedPhotos, ["id"]);
  const untouchedCandidatePhotos = candidatePhotos.filter((row) => {
    const preparedRow = preparedPhotoById.get(JSON.stringify([row.id]));
    return preparedRow && !selectedIds.has(String(preparedRow.visitId));
  });
  const untouchedPreparedPhotos = preparedPhotos.filter((row) => !selectedIds.has(String(row.visitId)));
  const untouchedPhotos = exactRowComparison(untouchedCandidatePhotos, untouchedPreparedPhotos, ["id"]);

  const candidateTableNames = candidate
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const untouchedTables = {};
  for (const tableName of candidateTableNames) {
    if (AFFECTED_TABLES.has(tableName) || !tableExists(prepared, tableName)) {
      continue;
    }
    untouchedTables[tableName] = exactRowComparison(
      tableRows(candidate, tableName),
      tableRows(prepared, tableName),
      tableColumns(candidate, tableName),
    );
  }

  const sourcePlaceholders = manifest.sourceVisitIds.map(() => "?").join(",");
  const targetPlaceholders = manifest.targetVisitIds.map(() => "?").join(",");
  const remainingSources = Number(
    candidate
      .prepare(`SELECT COUNT(*) AS count FROM visits WHERE id IN (${sourcePlaceholders})`)
      .get(...manifest.sourceVisitIds).count,
  );
  const remainingTargets = Number(
    candidate
      .prepare(`SELECT COUNT(*) AS count FROM visits WHERE id IN (${targetPlaceholders})`)
      .get(...manifest.targetVisitIds).count,
  );
  const remainingFixtureRows = Number(
    candidate.prepare("SELECT COUNT(*) AS count FROM visits WHERE restaurantId LIKE ?").get(`${RESTAURANT_PREFIX}%`)
      .count,
  );
  const remainingFixtureDuplicateRestaurants = Number(
    candidate
      .prepare(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT restaurantId
          FROM visits
          WHERE restaurantId LIKE ?
          GROUP BY restaurantId
          HAVING COUNT(*) > 1
        )
      `)
      .get(`${RESTAURANT_PREFIX}%`).count,
  );
  const candidateCounts = databaseCounts(candidate);
  const referenceCounts = databaseCounts(reference);
  const quickCheck = candidate
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(row.quick_check));
  const integrityCheck = candidate
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String(row.integrity_check));
  const foreignKeyViolations = candidate.prepare("PRAGMA foreign_key_check").all();
  const postRunConnectionPragmas = {
    foreignKeys: Number(candidate.prepare("PRAGMA foreign_keys").get().foreign_keys),
    busyTimeoutMs: Number(candidate.prepare("PRAGMA busy_timeout").get().timeout),
  };

  const untouchedTableMismatchCount = Object.values(untouchedTables).reduce(
    (sum, comparison) => sum + comparison.mismatchCount,
    0,
  );
  const failureReasons = [];
  if (visits.mismatchCount !== 0) {
    failureReasons.push(`${visits.mismatchCount} visit row(s) mismatched`);
  }
  if (photos.mismatchCount !== 0) {
    failureReasons.push(`${photos.mismatchCount} photo row(s) mismatched`);
  }
  if (suggestions.mismatchCount !== 0) {
    failureReasons.push(`${suggestions.mismatchCount} suggestion row(s) mismatched`);
  }
  if (reservationSources.mismatchCount !== 0) {
    failureReasons.push(`${reservationSources.mismatchCount} reservation mapping row(s) mismatched`);
  }
  if (untouchedVisits.mismatchCount !== 0 || untouchedPhotos.mismatchCount !== 0 || untouchedTableMismatchCount !== 0) {
    failureReasons.push("One or more untouched sentinels changed");
  }
  if (remainingSources !== 0 || remainingTargets !== GROUP_COUNT || remainingFixtureRows !== GROUP_COUNT) {
    failureReasons.push("Target/source survival counts are incorrect");
  }
  if (remainingFixtureDuplicateRestaurants !== 0) {
    failureReasons.push("Mergeable fixture rows remain");
  }
  if (JSON.stringify(candidateCounts) !== JSON.stringify(referenceCounts)) {
    failureReasons.push("Result table counts differ");
  }
  if (quickCheck.some((value) => value !== "ok") || integrityCheck.some((value) => value !== "ok")) {
    failureReasons.push("SQLite integrity validation failed");
  }
  if (foreignKeyViolations.length !== 0) {
    failureReasons.push("SQLite foreign-key validation failed");
  }

  const report = {
    schemaVersion: 1,
    status: failureReasons.length === 0 ? "ok" : "failed",
    failureReasons,
    fixture: {
      selectedVisits: FIXTURE_VISIT_COUNT,
      groups: GROUP_COUNT,
      expectedMerges: EXPECTED_MERGE_COUNT,
      targetVisitsRemaining: remainingTargets,
      sourceVisitsRemaining: remainingSources,
      fixtureRowsRemaining: remainingFixtureRows,
      mergeableFixtureRestaurantsRemaining: remainingFixtureDuplicateRestaurants,
    },
    counts: { candidate: candidateCounts, reference: referenceCounts },
    parity: {
      visits,
      photos,
      visitSuggestedRestaurants: suggestions,
      reservationImportSources: reservationSources,
      untouchedVisits,
      untouchedPhotos,
      untouchedTables,
      untouchedTableMismatchCount,
    },
    sqlite: {
      quickCheck,
      integrityCheck,
      foreignKeyViolationCount: foreignKeyViolations.length,
      postRunValidationConnectionPragmas: postRunConnectionPragmas,
      executionConnectionPragmasAttested: false,
    },
    files: {
      candidateSha256: sha256File(candidatePath),
      referenceSha256: sha256File(referencePath),
      preparedSha256: sha256File(preparedPath),
      manifestSha256: sha256File(manifestPath),
    },
  };
  candidate.close();
  reference.close();
  prepared.close();
  atomicWriteJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h") {
    usage();
    return;
  }
  const argumentsMap = parseArguments(process.argv.slice(3));
  if (!command || argumentsMap.has("help") || command === "help") {
    usage();
    return;
  }
  if (command === "prepare") {
    prepareFixture(requiredArgument(argumentsMap, "database"), requiredArgument(argumentsMap, "manifest"));
    return;
  }
  if (command === "reference") {
    const updatedAtMs = argumentsMap.has("updated-at-ms")
      ? parseFiniteInteger(argumentsMap.get("updated-at-ms"), "updated-at-ms")
      : REFERENCE_UPDATED_AT_MS;
    runReference(
      requiredArgument(argumentsMap, "database"),
      requiredArgument(argumentsMap, "manifest"),
      requiredArgument(argumentsMap, "report"),
      updatedAtMs,
      argumentsMap.get("atomic") === "true",
    );
    return;
  }
  if (command === "validate") {
    validateResult(
      requiredArgument(argumentsMap, "candidate"),
      requiredArgument(argumentsMap, "reference"),
      requiredArgument(argumentsMap, "prepared"),
      requiredArgument(argumentsMap, "manifest"),
      parseFiniteInteger(requiredArgument(argumentsMap, "trigger-ms"), "trigger-ms"),
      parseFiniteInteger(requiredArgument(argumentsMap, "finish-ms"), "finish-ms"),
      requiredArgument(argumentsMap, "report"),
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
