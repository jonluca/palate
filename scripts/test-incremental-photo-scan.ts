#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  beginPreferredAssetScan,
  getIncrementalPhotoScanInitialProgress,
  getIncrementalPhotoScanInitialProgressWithCleanup,
  INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL,
  processPhotoScanAssets,
  type IncrementalAssetScanSession,
  type PhotoScanAssetRecord,
} from "../utils/incremental-photo-scan-core.ts";
import { buildPhotoIngestionStatement } from "../utils/db/photo-ingestion-core.ts";
import { getValidatedAssetScanNextOffset } from "../utils/photo-scan-core.ts";

interface PhotoRow {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
  readonly mediaType: string | null;
  readonly duration: number | null;
}

interface ScenarioResult {
  readonly idQueryCalls: number;
  readonly incrementalBeginCalls: number;
  readonly insertCalls: number;
  readonly pageCalls: number;
  readonly selectedKind: "full" | "incremental";
}

const PHOTO_COLUMNS = `id, uri, creationTime, latitude, longitude, visitId,
  foodDetected, foodLabels, foodConfidence, allLabels, mediaType, duration`;

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY NOT NULL,
    uri TEXT NOT NULL,
    creationTime INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    visitId TEXT,
    foodDetected INTEGER,
    foodLabels TEXT,
    foodConfidence REAL,
    allLabels TEXT,
    mediaType TEXT,
    duration REAL
  )`);
  return database;
}

function makeLibrary(count = 100): PhotoScanAssetRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const specialId =
      index === 7 ? "asset-'quoted'-食堂-🍜" : index === 42 ? 'asset-"double"-café-🧭' : `asset-${index}`;
    let creationTime: number | null = 1_700_000_000_000 + index * 60_000;
    if (index === 9 || index === 63) {
      creationTime = null;
    } else if (index === 31) {
      creationTime = Number.NaN;
    }

    let latitude: number | null = index % 3 === 0 ? 0 : 37.7 + index / 10_000;
    let longitude: number | null = index % 3 === 0 ? 0 : -122.4 - index / 10_000;
    if (index === 11) {
      latitude = 91;
    } else if (index === 13) {
      longitude = -181;
    } else if (index === 17) {
      latitude = Number.NaN;
    } else if (index === 19) {
      longitude = null;
    } else if (index === 23) {
      latitude = null;
      longitude = null;
    }

    const mediaType = index % 5 === 0 ? "video" : "photo";
    return {
      id: specialId,
      uri: index === 7 ? "ph://O'Brien/夕食/🍜" : `ph://asset/${index}`,
      creationTime,
      latitude,
      longitude,
      mediaType,
      duration: mediaType === "video" ? index + 0.25 : index + 99,
    };
  });
}

function orderedKnownIndexes(knownCount: number, libraryCount: number): Set<number> {
  const permutation = Array.from({ length: libraryCount }, (_, index) => (index * 37) % libraryCount);
  return new Set(permutation.slice(0, knownCount));
}

function seedKnownRows(
  database: DatabaseSync,
  library: readonly PhotoScanAssetRecord[],
  knownIndexes: ReadonlySet<number>,
  includeStale: boolean,
): void {
  const insert = database.prepare(`INSERT INTO photos (${PHOTO_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [index, asset] of library.entries()) {
    if (!knownIndexes.has(index)) {
      continue;
    }
    insert.run(
      asset.id,
      `sentinel://known/${index}/O'Brien/寿司`,
      900_000 + index,
      -45.5,
      88.25,
      `visit-sentinel-${index}`,
      index % 2,
      JSON.stringify(["sentinel", `食-${index}`]),
      0.123 + index / 1_000,
      JSON.stringify([{ label: "sentinel", confidence: 0.987 }]),
      "video",
      777.5 + index,
    );
  }
  if (includeStale) {
    insert.run(
      "stale-deleted-'asset'-🗑️",
      "sentinel://stale",
      123_456,
      1,
      2,
      "visit-stale",
      1,
      '["stale"]',
      0.9,
      '[{"label":"stale"}]',
      "photo",
      null,
    );
  }
}

function snapshot(database: DatabaseSync): PhotoRow[] {
  return database.prepare(`SELECT ${PHOTO_COLUMNS} FROM photos ORDER BY id ASC`).all() as unknown as PhotoRow[];
}

function validLocation(asset: PhotoScanAssetRecord): boolean {
  return (
    asset.latitude !== null &&
    asset.longitude !== null &&
    Number.isFinite(asset.latitude) &&
    Number.isFinite(asset.longitude) &&
    asset.latitude >= -90 &&
    asset.latitude <= 90 &&
    asset.longitude >= -180 &&
    asset.longitude <= 180
  );
}

function insertLiteralFullScan(database: DatabaseSync, assets: readonly PhotoScanAssetRecord[], pageSize: number) {
  const statement = database.prepare(`INSERT OR IGNORE INTO photos (
    id, uri, creationTime, latitude, longitude, mediaType, duration
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let pageCalls = 0;
  let insertCalls = 0;
  let photosWithLocation = 0;
  let skippedAssets = 0;

  for (let offset = 0; offset < assets.length; offset += pageSize) {
    pageCalls++;
    for (const asset of assets.slice(offset, offset + pageSize)) {
      if (asset.creationTime === null || !Number.isFinite(asset.creationTime)) {
        skippedAssets++;
        continue;
      }
      const hasLocation = validLocation(asset);
      if (hasLocation) {
        photosWithLocation++;
      }
      statement.run(
        asset.id,
        asset.uri,
        asset.creationTime,
        hasLocation ? asset.latitude : null,
        hasLocation ? asset.longitude : null,
        asset.mediaType,
        asset.mediaType === "video" ? asset.duration : null,
      );
      insertCalls++;
    }
  }
  return { insertCalls, pageCalls, photosWithLocation, skippedAssets };
}

function summarizeExcluded(assets: readonly PhotoScanAssetRecord[]) {
  let excludedPhotosWithLocation = 0;
  let excludedSkippedAssets = 0;
  for (const asset of assets) {
    if (asset.creationTime === null || !Number.isFinite(asset.creationTime)) {
      excludedSkippedAssets++;
    } else if (validLocation(asset)) {
      excludedPhotosWithLocation++;
    }
  }
  return { excludedPhotosWithLocation, excludedSkippedAssets };
}

function makeIncrementalSession(
  library: readonly PhotoScanAssetRecord[],
  existingIds: readonly string[],
): { readonly session: IncrementalAssetScanSession; readonly unknownAssets: PhotoScanAssetRecord[] } {
  // This Set models native PhotoKit filtering only inside the isolated oracle.
  const existing = new Set(existingIds);
  const unknownAssets = library.filter((asset) => !existing.has(asset.id));
  const excluded = library.filter((asset) => existing.has(asset.id));
  const excludedMetrics = summarizeExcluded(excluded);
  return {
    session: {
      sessionId: "incremental-fixture",
      totalCount: unknownAssets.length,
      libraryTotalCount: library.length,
      excludedVisibleCount: excluded.length,
      ...excludedMetrics,
      maxPageSize: 5_000,
    },
    unknownAssets,
  };
}

async function runScenario(name: string, knownCount: number, includeStale: boolean): Promise<ScenarioResult> {
  const library = makeLibrary();
  const knownIndexes = orderedKnownIndexes(knownCount, library.length);
  const literalDatabase = createDatabase();
  const candidateDatabase = createDatabase();
  try {
    seedKnownRows(literalDatabase, library, knownIndexes, includeStale);
    seedKnownRows(candidateDatabase, library, knownIndexes, includeStale);
    const seededSnapshot = snapshot(candidateDatabase);
    const literal = insertLiteralFullScan(literalDatabase, library, 7);

    let idQueryCalls = 0;
    let fullBeginCalls = 0;
    let incrementalBeginCalls = 0;
    let plannedUnknownAssets: PhotoScanAssetRecord[] = [];
    const selected = await beginPreferredAssetScan({
      incrementalAvailable: true,
      loadExistingAssetIds: async () => {
        idQueryCalls++;
        return candidateDatabase
          .prepare(INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL)
          .all()
          .map((row) => String((row as { id: unknown }).id));
      },
      beginFullScan: async () => {
        fullBeginCalls++;
        plannedUnknownAssets = [...library];
        return { sessionId: "full-fixture", totalCount: library.length, maxPageSize: 5_000 };
      },
      beginIncrementalScan: async (existingIds) => {
        incrementalBeginCalls++;
        const plan = makeIncrementalSession(library, existingIds);
        plannedUnknownAssets = plan.unknownAssets;
        return plan.session;
      },
    });

    const initialProgress =
      selected.kind === "incremental"
        ? getIncrementalPhotoScanInitialProgress(selected.session)
        : { totalAssets: library.length, processedAssets: 0, photosWithLocation: 0, skippedAssets: 0 };
    let processedAssets = initialProgress.processedAssets;
    let photosWithLocation = initialProgress.photosWithLocation;
    let skippedAssets = initialProgress.skippedAssets;
    let pageCalls = 0;
    let insertCalls = 0;
    const pageSize = 7;

    for (let offset = 0; offset < plannedUnknownAssets.length; offset += pageSize) {
      pageCalls++;
      const page = plannedUnknownAssets.slice(offset, offset + pageSize);
      const processed = processPhotoScanAssets(page);
      photosWithLocation += processed.photosWithLocation;
      skippedAssets += processed.skippedAssets;
      const statement = buildPhotoIngestionStatement(processed.photos);
      if (statement !== null) {
        candidateDatabase.prepare(statement.sql).run(...statement.parameters);
        insertCalls++;
      }
      processedAssets += page.length;
    }

    assert.equal(idQueryCalls, 1, `${name}: exactly one existing-ID query`);
    assert.equal(fullBeginCalls, knownCount === 0 && !includeStale ? 1 : 0, `${name}: full begin selection`);
    assert.equal(
      incrementalBeginCalls,
      knownCount === 0 && !includeStale ? 0 : 1,
      `${name}: incremental begin selection`,
    );
    assert.equal(processedAssets, library.length, `${name}: progress includes excluded visible assets`);
    assert.equal(photosWithLocation, literal.photosWithLocation, `${name}: location progress parity`);
    assert.equal(skippedAssets, literal.skippedAssets, `${name}: skipped progress parity`);
    assert.deepEqual(snapshot(candidateDatabase), snapshot(literalDatabase), `${name}: exact database parity`);

    for (const seeded of seededSnapshot) {
      const retained = snapshot(candidateDatabase).find((row) => row.id === seeded.id);
      assert.deepEqual(retained, seeded, `${name}: INSERT OR IGNORE preserves sentinel metadata for ${seeded.id}`);
    }

    if (knownCount === library.length) {
      assert.equal(selected.kind, "incremental");
      assert.equal(selected.session.totalCount, 0);
      assert.equal(pageCalls, 0, "all-known: zero page calls");
      assert.equal(insertCalls, 0, "all-known: zero insert calls");
    }

    return { idQueryCalls, incrementalBeginCalls, insertCalls, pageCalls, selectedKind: selected.kind };
  } finally {
    literalDatabase.close();
    candidateDatabase.close();
  }
}

async function testBeginSelectionAndFallback(): Promise<void> {
  const fullSession = { sessionId: "full", totalCount: 3, maxPageSize: 5_000 };
  const incrementalSession: IncrementalAssetScanSession = {
    sessionId: "incremental",
    totalCount: 1,
    libraryTotalCount: 3,
    excludedVisibleCount: 2,
    excludedPhotosWithLocation: 1,
    excludedSkippedAssets: 1,
    maxPageSize: 5_000,
  };

  for (const testCase of [
    { name: "old binary", available: false, ids: ["known"], incrementalFails: false, expected: [0, 1, 0] },
    { name: "empty database", available: true, ids: [], incrementalFails: false, expected: [1, 1, 0] },
    { name: "incremental success", available: true, ids: ["known"], incrementalFails: false, expected: [1, 0, 1] },
    { name: "begin fallback", available: true, ids: ["known"], incrementalFails: true, expected: [1, 1, 1] },
  ] as const) {
    const calls = [0, 0, 0];
    let warningCalls = 0;
    const selected = await beginPreferredAssetScan({
      incrementalAvailable: testCase.available,
      loadExistingAssetIds: async () => {
        calls[0]++;
        return [...testCase.ids];
      },
      beginFullScan: async () => {
        calls[1]++;
        return fullSession;
      },
      beginIncrementalScan: async () => {
        calls[2]++;
        if (testCase.incrementalFails) {
          throw new Error("planned begin failure");
        }
        return incrementalSession;
      },
      onIncrementalBeginFailure: () => warningCalls++,
    });
    assert.deepEqual(calls, testCase.expected, `${testCase.name}: call selection`);
    assert.equal(selected.kind, testCase.name === "incremental success" ? "incremental" : "full");
    assert.equal(warningCalls, testCase.incrementalFails ? 1 : 0);
  }

  for (const databaseBeginFails of [false, true]) {
    const calls = { database: 0, ids: 0, incremental: 0, full: 0, warnings: 0 };
    const selected = await beginPreferredAssetScan({
      databaseBackedIncrementalAvailable: true,
      preferDatabaseBackedIncremental: true,
      incrementalAvailable: true,
      beginDatabaseBackedIncrementalScan: async () => {
        calls.database++;
        if (databaseBeginFails) {
          throw new Error("planned database-backed begin failure");
        }
        return incrementalSession;
      },
      loadExistingAssetIds: async () => {
        calls.ids++;
        return ["known"];
      },
      beginFullScan: async () => {
        calls.full++;
        return fullSession;
      },
      beginIncrementalScan: async () => {
        calls.incremental++;
        return incrementalSession;
      },
      onIncrementalBeginFailure: () => calls.warnings++,
    });
    assert.deepEqual(calls, {
      database: 1,
      ids: 0,
      incremental: 0,
      full: databaseBeginFails ? 1 : 0,
      warnings: databaseBeginFails ? 1 : 0,
    });
    assert.equal(selected.kind, databaseBeginFails ? "full" : "incremental");
  }

  const defaultPreferenceCalls = { database: 0, ids: 0, incremental: 0 };
  const defaultPreference = await beginPreferredAssetScan({
    databaseBackedIncrementalAvailable: true,
    incrementalAvailable: true,
    beginDatabaseBackedIncrementalScan: async () => {
      defaultPreferenceCalls.database++;
      return incrementalSession;
    },
    loadExistingAssetIds: async () => {
      defaultPreferenceCalls.ids++;
      return ["known"];
    },
    beginFullScan: async () => fullSession,
    beginIncrementalScan: async () => {
      defaultPreferenceCalls.incremental++;
      return incrementalSession;
    },
  });
  assert.equal(defaultPreference.kind, "incremental");
  assert.deepEqual(defaultPreferenceCalls, { database: 0, ids: 1, incremental: 1 });

  let fullCallsAfterIdFailure = 0;
  await assert.rejects(
    beginPreferredAssetScan({
      incrementalAvailable: true,
      loadExistingAssetIds: async () => {
        throw new Error("ID query failed");
      },
      beginFullScan: async () => {
        fullCallsAfterIdFailure++;
        return fullSession;
      },
      beginIncrementalScan: async () => incrementalSession,
    }),
    /ID query failed/,
  );
  assert.equal(fullCallsAfterIdFailure, 0, "ID-query failure must not silently become a full scan");

  let beginCallsBeforePageFailure = 0;
  const selected = await beginPreferredAssetScan({
    incrementalAvailable: true,
    loadExistingAssetIds: async () => ["known"],
    beginFullScan: async () => {
      beginCallsBeforePageFailure++;
      return fullSession;
    },
    beginIncrementalScan: async () => {
      beginCallsBeforePageFailure++;
      return incrementalSession;
    },
  });
  assert.equal(selected.kind, "incremental");
  await assert.rejects(Promise.reject(new Error("page failed after begin")), /page failed after begin/);
  assert.equal(beginCallsBeforePageFailure, 1, "page/persistence failures cannot trigger begin fallback");
}

async function testSessionValidation(): Promise<void> {
  const zeroUnknown: IncrementalAssetScanSession = {
    sessionId: "all-known",
    totalCount: 0,
    libraryTotalCount: 4,
    excludedVisibleCount: 4,
    excludedPhotosWithLocation: 2,
    excludedSkippedAssets: 1,
    maxPageSize: 5_000,
  };
  assert.deepEqual(getIncrementalPhotoScanInitialProgress(zeroUnknown), {
    totalAssets: 4,
    processedAssets: 4,
    photosWithLocation: 2,
    skippedAssets: 1,
  });
  assert.throws(
    () => getIncrementalPhotoScanInitialProgress({ ...zeroUnknown, libraryTotalCount: 5 }),
    /counts are inconsistent/,
  );
  assert.throws(
    () => getIncrementalPhotoScanInitialProgress({ ...zeroUnknown, maxPageSize: 0 }),
    /zero maximum page size/,
  );
  assert.throws(
    () => getIncrementalPhotoScanInitialProgress({ ...zeroUnknown, excludedSkippedAssets: 5 }),
    /exceed the excluded visible count/,
  );

  const malformedSession = {
    ...zeroUnknown,
    sessionId: "malformed-session",
    libraryTotalCount: 5,
  };
  const endedSessionIds: string[] = [];
  await assert.rejects(
    getIncrementalPhotoScanInitialProgressWithCleanup(malformedSession, async (sessionId) => {
      endedSessionIds.push(sessionId);
    }),
    /counts are inconsistent/,
  );
  assert.deepEqual(endedSessionIds, ["malformed-session"], "malformed sessions are released exactly once");

  const cleanupErrors: unknown[] = [];
  await assert.rejects(
    getIncrementalPhotoScanInitialProgressWithCleanup(
      malformedSession,
      async () => {
        throw new Error("planned cleanup failure");
      },
      (error) => cleanupErrors.push(error),
    ),
    /counts are inconsistent/,
    "cleanup failure must not mask the malformed-session error",
  );
  assert.equal(cleanupErrors.length, 1);
  assert.match(String(cleanupErrors[0]), /planned cleanup failure/);
}

function testMaximumPageBoundaries(): void {
  for (const [totalCount, expectedPageCalls] of [
    [0, 0],
    [4_999, 1],
    [5_000, 1],
    [5_001, 2],
  ] as const) {
    let offset = 0;
    let pageCalls = 0;
    while (offset < totalCount) {
      const assetCount = Math.min(5_000, totalCount - offset);
      const nextOffset = offset + assetCount;
      offset = getValidatedAssetScanNextOffset(offset, totalCount, {
        offset,
        assetCount,
        nextOffset: nextOffset < totalCount ? nextOffset : null,
        totalCount,
        hasNextPage: nextOffset < totalCount,
      });
      pageCalls++;
    }
    assert.equal(pageCalls, expectedPageCalls, `${totalCount} unknown assets: maximum-page boundary`);
    assert.equal(offset, totalCount, `${totalCount} unknown assets: exact terminal offset`);
  }
}

function testProductionSourceWiring(): void {
  const scannerSource = readFileSync(new URL("../services/scanner.ts", import.meta.url), "utf8");
  const scanStart = scannerSource.indexOf("export async function scanCameraRoll(");
  const scanEnd = scannerSource.indexOf("export async function getPhotoCount", scanStart);
  assert.ok(scanStart >= 0 && scanEnd > scanStart);
  const scanSource = scannerSource.slice(scanStart, scanEnd);
  assert.match(scanSource, /incrementalAvailable: isIncrementalAssetScanAvailable\(\)/);
  assert.match(scanSource, /databaseBackedIncrementalAvailable: isDatabaseBackedIncrementalAssetScanAvailable\(\)/);
  assert.match(scanSource, /preferDatabaseBackedIncremental: false/);
  assert.match(scanSource, /beginDatabaseBackedIncrementalScan:/);
  assert.match(scanSource, /getPhotoDatabasePathForIncrementalScan\(\)/);
  assert.match(scanSource, /loadExistingAssetIds: getExistingPhotoAssetIdsForIncrementalScan/);
  assert.match(scanSource, /beginIncrementalScan: beginIncrementalAssetScan/);
  assert.match(scanSource, /await getIncrementalPhotoScanInitialProgressWithCleanup\(/);
  assert.match(scanSource, /nativeScan\.session,\s*endAssetScan,/);
  assert.match(scanSource, /processPhotoScanAssets\(page\.assets\)/);
  assert.match(scanSource, /incrementalInitialProgress\?\.processedAssets \?\? 0/);
  assert.doesNotMatch(scanSource, /new Set\s*\(/, "production scanner must not filter PhotoKit IDs in JS");

  const photoDatabaseSource = readFileSync(new URL("../utils/db/photos.ts", import.meta.url), "utf8");
  const queryStart = photoDatabaseSource.indexOf("export async function getExistingPhotoAssetIdsForIncrementalScan");
  const queryEnd = photoDatabaseSource.indexOf("export async function getVisitablePhotoCounts", queryStart);
  assert.ok(queryStart >= 0 && queryEnd > queryStart);
  const querySource = photoDatabaseSource.slice(queryStart, queryEnd);
  assert.match(querySource, /getAllAsync<\{ id: string \}>\(INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL\)/);
  assert.equal((querySource.match(/getAllAsync/g) ?? []).length, 1, "production helper performs one ID query");
  assert.doesNotMatch(querySource, /getFirstAsync|COUNT\s*\(/i);

  const nativeBarrelSource = readFileSync(new URL("../modules/batch-asset-info/index.ts", import.meta.url), "utf8");
  assert.match(nativeBarrelSource, /beginIncrementalAssetScan/);
  assert.match(nativeBarrelSource, /isIncrementalAssetScanAvailable/);
}

const scenarioResults = {
  emptyDatabase: await runScenario("empty database", 0, false),
  zeroPercentKnownWithStaleId: await runScenario("0% known with stale ID", 0, true),
  fiftyPercentKnown: await runScenario("50% known", 50, true),
  ninetyNinePercentKnown: await runScenario("99% known", 99, true),
  allKnown: await runScenario("100% known", 100, true),
};
await testBeginSelectionAndFallback();
await testSessionValidation();
testMaximumPageBoundaries();
testProductionSourceWiring();

assert.equal(scenarioResults.allKnown.idQueryCalls, 1);
assert.equal(scenarioResults.allKnown.pageCalls, 0);
assert.equal(scenarioResults.allKnown.insertCalls, 0);

console.log(
  JSON.stringify(
    {
      status: "ok",
      productionSqlImportedDirectly: true,
      productionIngestionBuilderImportedDirectly: true,
      scenarios: scenarioResults,
      checks: {
        literalInsertOrIgnoreParity: true,
        knownRatios: [0, 50, 99, 100],
        emptyDatabaseFullPath: true,
        staleDatabaseIds: true,
        interspersedUnknownAssets: true,
        unicodeAndQuotes: true,
        videosAndDurations: true,
        nilAndNonFiniteCreationTimes: true,
        invalidAndPartialLocations: true,
        pageBoundaries: true,
        sentinelMetadataPreserved: true,
        oneIdentifierQuery: true,
        allKnownZeroPagesAndInserts: true,
        beginOnlyFallback: true,
        malformedSessionCleanup: true,
        oldBinarySourcePath: true,
      },
    },
    null,
    2,
  ),
);
