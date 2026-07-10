#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildPhotoIngestionStatement,
  getPhotoIngestionFlushCount,
  PHOTO_INGESTION_FLUSH_SIZE,
  type PhotoIngestionRecord,
} from "../utils/db/photo-ingestion-core.ts";
import {
  getValidatedAssetScanNextOffset,
  getValidatedMediaLibraryPageState,
  type AssetScanPageProgress,
  type MediaLibraryPageProgress,
  type MediaLibraryScanState,
} from "../utils/photo-scan-core.ts";

interface StoredPhotoRow extends PhotoIngestionRecord {
  readonly visitId: string | null;
  readonly foodDetected: number | null;
  readonly foodLabels: string | null;
  readonly foodConfidence: number | null;
  readonly allLabels: string | null;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      visitId TEXT,
      foodDetected INTEGER,
      foodLabels TEXT,
      foodConfidence REAL,
      allLabels TEXT,
      mediaType TEXT DEFAULT 'photo',
      duration REAL
    );
  `);
  return database;
}

function legacyInsert(database: DatabaseSync, photos: readonly PhotoIngestionRecord[]): number {
  let changes = 0;
  for (let offset = 0; offset < photos.length; offset += 1_000) {
    const batch = photos.slice(offset, offset + 1_000);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((photo) => [
      photo.id,
      photo.uri,
      photo.creationTime,
      photo.latitude,
      photo.longitude,
      photo.mediaType,
      photo.duration,
    ]);
    changes += Number(
      database
        .prepare(
          `INSERT OR IGNORE INTO photos (
            id, uri, creationTime, latitude, longitude, mediaType, duration
          ) VALUES ${placeholders}`,
        )
        .run(...values).changes,
    );
  }
  return changes;
}

function candidateInsert(database: DatabaseSync, photos: readonly PhotoIngestionRecord[]): number {
  let changes = 0;
  for (let offset = 0; offset < photos.length; offset += PHOTO_INGESTION_FLUSH_SIZE) {
    const statement = buildPhotoIngestionStatement(photos.slice(offset, offset + PHOTO_INGESTION_FLUSH_SIZE));
    if (statement) {
      changes += Number(database.prepare(statement.sql).run(...statement.parameters).changes);
    }
  }
  return changes;
}

function snapshot(database: DatabaseSync): StoredPhotoRow[] {
  return database
    .prepare(
      `SELECT
        id, uri, creationTime, latitude, longitude, visitId, foodDetected,
        foodLabels, foodConfidence, allLabels, mediaType, duration
       FROM photos
       ORDER BY id ASC`,
    )
    .all()
    .map((row) => ({ ...row })) as unknown as StoredPhotoRow[];
}

function seedExisting(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO photos (
        id, uri, creationTime, latitude, longitude, visitId, foodDetected,
        foodLabels, foodConfidence, allLabels, mediaType, duration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "existing-'雪'",
      "ph://existing/original",
      42,
      1.25,
      -2.5,
      "visit-existing",
      1,
      JSON.stringify([{ label: "ramen", confidence: 0.9 }]),
      0.9,
      JSON.stringify([{ label: "food", confidence: 0.95 }]),
      "video",
      12.5,
    );
}

function makePhoto(index: number): PhotoIngestionRecord {
  return {
    id: `photo-${index.toString().padStart(5, "0")}`,
    uri: index === 1 ? 'ph://雪/"quoted"/line\nbreak' : `ph://asset-${index}/L0/001`,
    creationTime: 1_700_000_000_000 + Math.floor(index / 3),
    latitude: index % 7 === 0 ? null : index % 13 === 0 ? 0 : 34 + (index % 100) / 1_000,
    longitude: index % 7 === 0 ? null : index % 17 === 0 ? 0 : -118 - (index % 100) / 1_000,
    mediaType: index % 11 === 0 ? "video" : "photo",
    duration: index % 11 === 0 ? (index % 22 === 0 ? 0 : 3.75) : null,
  };
}

function edgeFixture(): PhotoIngestionRecord[] {
  const photos = Array.from({ length: PHOTO_INGESTION_FLUSH_SIZE + 5 }, (_, index) => makePhoto(index));
  photos.splice(2, 0, {
    id: "existing-'雪'",
    uri: "ph://must-not-overwrite",
    creationTime: 999,
    latitude: 0,
    longitude: 0,
    mediaType: "photo",
    duration: null,
  });
  photos.splice(1_500, 0, { ...makePhoto(12), uri: "ph://duplicate-must-not-win" });
  // The original photo-03990 remains in the first 4,000-row production chunk
  // after both insertions above; this duplicate lands in the second chunk.
  photos.push({ ...makePhoto(3_990), uri: "ph://cross-flush-duplicate-must-not-win" });
  return photos;
}

assert.equal(buildPhotoIngestionStatement([]), null);
assert.equal(getPhotoIngestionFlushCount(0, false), 0);
assert.equal(getPhotoIngestionFlushCount(3_999, false), 0);
assert.equal(getPhotoIngestionFlushCount(3_999, true), 3_999);
assert.equal(getPhotoIngestionFlushCount(4_000, false), 4_000);
assert.equal(getPhotoIngestionFlushCount(9_000, false), 4_000);
assert.throws(() => getPhotoIngestionFlushCount(-1, false), /non-negative safe integer/);
assert.throws(() => getPhotoIngestionFlushCount(1.5, false), /non-negative safe integer/);

const maximumDirectFixture = Array.from({ length: PHOTO_INGESTION_FLUSH_SIZE }, (_, index) => makePhoto(index));
const maximumDirectStatement = buildPhotoIngestionStatement(maximumDirectFixture);
assert.ok(maximumDirectStatement);
assert.equal(maximumDirectStatement.requestedCount, PHOTO_INGESTION_FLUSH_SIZE);
assert.equal(maximumDirectStatement.parameters.length, PHOTO_INGESTION_FLUSH_SIZE * 7);
assert.ok(maximumDirectStatement.parameters.length < 32_766);
assert.throws(() => buildPhotoIngestionStatement([...maximumDirectFixture, makePhoto(PHOTO_INGESTION_FLUSH_SIZE)]), {
  name: "RangeError",
  message: `Photo ingestion statements support at most ${PHOTO_INGESTION_FLUSH_SIZE} records; received ${PHOTO_INGESTION_FLUSH_SIZE + 1}.`,
});

const fixture = edgeFixture();
const crossFlushDuplicateIndexes = fixture.flatMap((photo, index) => (photo.id === makePhoto(3_990).id ? [index] : []));
assert.equal(crossFlushDuplicateIndexes.length, 2);
assert.ok(crossFlushDuplicateIndexes[0]! < PHOTO_INGESTION_FLUSH_SIZE);
assert.ok(crossFlushDuplicateIndexes[1]! >= PHOTO_INGESTION_FLUSH_SIZE);
const statement = buildPhotoIngestionStatement(fixture.slice(0, PHOTO_INGESTION_FLUSH_SIZE));
assert.ok(statement);
assert.equal(statement.parameters.length, PHOTO_INGESTION_FLUSH_SIZE * 7);
assert.equal(statement.requestedCount, PHOTO_INGESTION_FLUSH_SIZE);
assert.doesNotMatch(statement.sql, /json_each/);

const reference = createDatabase();
const candidate = createDatabase();
try {
  seedExisting(reference);
  seedExisting(candidate);
  const referenceChanges = legacyInsert(reference, fixture);
  const candidateChanges = candidateInsert(candidate, fixture);
  assert.equal(candidateChanges, referenceChanges);
  assert.deepEqual(snapshot(candidate), snapshot(reference));

  const rowsById = new Map(snapshot(candidate).map((row) => [row.id, row]));
  assert.equal(rowsById.get("existing-'雪'")?.uri, "ph://existing/original");
  assert.equal(rowsById.get(makePhoto(12).id)?.uri, makePhoto(12).uri);
  assert.equal(rowsById.get(makePhoto(3_990).id)?.uri, makePhoto(3_990).uri);
  assert.equal(rowsById.get(makePhoto(13).id)?.latitude, 0);
  assert.equal(rowsById.get(makePhoto(17).id)?.longitude, 0);
  assert.equal(rowsById.get(makePhoto(22).id)?.duration, 0);
} finally {
  reference.close();
  candidate.close();
}

// One bounded ingestion statement is atomic even when a later row aborts.
const atomicDatabase = createDatabase();
try {
  const before = snapshot(atomicDatabase);
  atomicDatabase.exec(`
    CREATE TRIGGER reject_failure_photo
    BEFORE INSERT ON photos
    WHEN NEW.id = 'failure'
    BEGIN
      SELECT RAISE(ABORT, 'injected ingestion failure');
    END;
  `);
  const atomicFixture: PhotoIngestionRecord[] = [
    { ...makePhoto(90_000), id: "before-failure" },
    { ...makePhoto(90_001), id: "failure" },
    { ...makePhoto(90_002), id: "after-failure" },
  ];
  assert.throws(() => candidateInsert(atomicDatabase, atomicFixture), /injected ingestion failure/);
  assert.deepEqual(snapshot(atomicDatabase), before);
} finally {
  atomicDatabase.close();
}

// Successful production chunks remain durable when a later bounded chunk aborts.
const lateChunkFailureDatabase = createDatabase();
try {
  lateChunkFailureDatabase.exec(`
    CREATE TRIGGER reject_late_failure_photo
    BEFORE INSERT ON photos
    WHEN NEW.id = 'late-failure'
    BEGIN
      SELECT RAISE(ABORT, 'injected late-chunk ingestion failure');
    END;
  `);
  const durableFirstChunk = Array.from({ length: PHOTO_INGESTION_FLUSH_SIZE }, (_, index) =>
    makePhoto(100_000 + index),
  );
  const lateFailureFixture: PhotoIngestionRecord[] = [
    ...durableFirstChunk,
    { ...makePhoto(200_000), id: "before-late-failure" },
    { ...makePhoto(200_001), id: "late-failure" },
    { ...makePhoto(200_002), id: "after-late-failure" },
  ];

  assert.throws(
    () => candidateInsert(lateChunkFailureDatabase, lateFailureFixture),
    /injected late-chunk ingestion failure/,
  );
  const durableRows = snapshot(lateChunkFailureDatabase);
  assert.equal(durableRows.length, PHOTO_INGESTION_FLUSH_SIZE);
  assert.deepEqual(
    durableRows.map(({ id }) => id),
    durableFirstChunk.map(({ id }) => id).sort(),
  );
  assert.equal(
    durableRows.some(({ id }) => id === "before-late-failure"),
    false,
  );
  assert.equal(
    durableRows.some(({ id }) => id === "late-failure"),
    false,
  );
  assert.equal(
    durableRows.some(({ id }) => id === "after-late-failure"),
    false,
  );
} finally {
  lateChunkFailureDatabase.close();
}

function validateAssetScanSequence(totalCount: number, pages: readonly AssetScanPageProgress[]): number {
  let expectedOffset = 0;
  for (const page of pages) {
    expectedOffset = getValidatedAssetScanNextOffset(expectedOffset, totalCount, page);
  }
  return expectedOffset;
}

assert.equal(validateAssetScanSequence(0, []), 0);
assert.equal(
  validateAssetScanSequence(5, [
    { offset: 0, assetCount: 2, nextOffset: 2, totalCount: 5, hasNextPage: true },
    { offset: 2, assetCount: 2, nextOffset: 4, totalCount: 5, hasNextPage: true },
    { offset: 4, assetCount: 1, nextOffset: null, totalCount: 5, hasNextPage: false },
  ]),
  5,
);
assert.equal(
  validateAssetScanSequence(3, [{ offset: 0, assetCount: 3, nextOffset: null, totalCount: 3, hasNextPage: false }]),
  3,
);

const validFirstPage: AssetScanPageProgress = {
  offset: 0,
  assetCount: 2,
  nextOffset: 2,
  totalCount: 5,
  hasNextPage: true,
};
for (const page of [
  { ...validFirstPage, offset: 1 },
  { ...validFirstPage, totalCount: 6 },
] satisfies AssetScanPageProgress[]) {
  assert.throws(() => validateAssetScanSequence(5, [page]), /snapshot changed unexpectedly/);
}
assert.throws(
  () =>
    validateAssetScanSequence(5, [
      validFirstPage,
      { offset: 3, assetCount: 2, nextOffset: 5, totalCount: 5, hasNextPage: false },
    ]),
  /snapshot changed unexpectedly/,
);
for (const assetCount of [0, -1, 1.5, Number.NaN]) {
  assert.throws(() => validateAssetScanSequence(5, [{ ...validFirstPage, assetCount }]), /empty or invalid page/);
}
assert.throws(
  () =>
    validateAssetScanSequence(5, [{ offset: 0, assetCount: 6, nextOffset: null, totalCount: 5, hasNextPage: false }]),
  /exceeds its snapshot/,
);
for (const nextOffset of [null, 1, 3]) {
  assert.throws(
    () => validateAssetScanSequence(5, [{ ...validFirstPage, nextOffset }]),
    /did not advance contiguously/,
  );
}
assert.throws(
  () => validateAssetScanSequence(2, [{ offset: 0, assetCount: 2, nextOffset: 2, totalCount: 2, hasNextPage: true }]),
  /did not advance contiguously/,
);
assert.throws(
  () => validateAssetScanSequence(5, [{ offset: 0, assetCount: 2, nextOffset: 2, totalCount: 5, hasNextPage: false }]),
  /ended before consuming its snapshot/,
);
assert.throws(
  () => validateAssetScanSequence(2, [{ offset: 0, assetCount: 2, nextOffset: 2, totalCount: 2, hasNextPage: false }]),
  /ended before consuming its snapshot/,
);

function validateMediaLibrarySequence(
  initialTotalAssets: number,
  pages: readonly MediaLibraryPageProgress[],
): readonly MediaLibraryScanState[] {
  const states: MediaLibraryScanState[] = [];
  let state: MediaLibraryScanState = {
    processedAssets: 0,
    totalAssets: initialTotalAssets,
    nextCursor: undefined,
  };

  for (const page of pages) {
    state = getValidatedMediaLibraryPageState(state.nextCursor, state.processedAssets, state.totalAssets, page);
    states.push(state);
  }

  return states;
}

assert.deepEqual(
  validateMediaLibrarySequence(5, [
    { assetCount: 2, endCursor: "cursor-2", totalCount: 5, hasNextPage: true },
    { assetCount: 2, endCursor: "cursor-4", totalCount: 5, hasNextPage: true },
    { assetCount: 1, endCursor: "cursor-5", totalCount: 5, hasNextPage: false },
  ]),
  [
    { processedAssets: 2, totalAssets: 5, nextCursor: "cursor-2" },
    { processedAssets: 4, totalAssets: 5, nextCursor: "cursor-4" },
    { processedAssets: 5, totalAssets: 5, nextCursor: undefined },
  ],
);
assert.deepEqual(
  validateMediaLibrarySequence(0, [{ assetCount: 0, endCursor: null, totalCount: 0, hasNextPage: false }]),
  [{ processedAssets: 0, totalAssets: 0, nextCursor: undefined }],
);
assert.deepEqual(
  validateMediaLibrarySequence(7, [
    { assetCount: 2, endCursor: "cursor-2", totalCount: 7, hasNextPage: true },
    { assetCount: 0, endCursor: null, totalCount: 2, hasNextPage: false },
  ]),
  [
    { processedAssets: 2, totalAssets: 7, nextCursor: "cursor-2" },
    { processedAssets: 2, totalAssets: 2, nextCursor: undefined },
  ],
);

assert.throws(
  () => validateMediaLibrarySequence(2, [{ assetCount: 0, endCursor: "cursor-0", totalCount: 2, hasNextPage: true }]),
  /nonterminal empty page/,
);
for (const endCursor of [undefined, null, ""]) {
  assert.throws(
    () => validateMediaLibrarySequence(2, [{ assetCount: 1, endCursor, totalCount: 2, hasNextPage: true }]),
    /without a pagination cursor/,
  );
}
assert.throws(
  () =>
    validateMediaLibrarySequence(3, [
      { assetCount: 1, endCursor: "cursor-1", totalCount: 3, hasNextPage: true },
      { assetCount: 1, endCursor: "cursor-1", totalCount: 3, hasNextPage: true },
    ]),
  /cursor did not advance/,
);

const changingEstimateStates = validateMediaLibrarySequence(1, [
  { assetCount: 2, endCursor: "cursor-2", totalCount: 1, hasNextPage: true },
  { assetCount: 2, endCursor: "cursor-4", totalCount: 9, hasNextPage: true },
  { assetCount: 1, endCursor: "cursor-5", totalCount: 3, hasNextPage: true },
  { assetCount: 1, endCursor: "cursor-6", totalCount: 4, hasNextPage: false },
]);
assert.deepEqual(changingEstimateStates, [
  { processedAssets: 2, totalAssets: 3, nextCursor: "cursor-2" },
  { processedAssets: 4, totalAssets: 9, nextCursor: "cursor-4" },
  { processedAssets: 5, totalAssets: 9, nextCursor: "cursor-5" },
  { processedAssets: 6, totalAssets: 6, nextCursor: undefined },
]);
for (const state of changingEstimateStates.slice(0, -1)) {
  assert.ok(state.processedAssets < state.totalAssets);
}
const finalChangingEstimateState = changingEstimateStates.at(-1);
assert.ok(finalChangingEstimateState);
assert.equal(finalChangingEstimateState.processedAssets, finalChangingEstimateState.totalAssets);

function flushPlan(totalPhotos: number, pageSize: number): number[] {
  const flushes: number[] = [];
  let pending = 0;
  let processed = 0;
  while (processed < totalPhotos) {
    const pageCount = Math.min(pageSize, totalPhotos - processed);
    pending += pageCount;
    processed += pageCount;
    let flushCount = getPhotoIngestionFlushCount(pending, false);
    while (flushCount > 0) {
      flushes.push(flushCount);
      pending -= flushCount;
      flushCount = getPhotoIngestionFlushCount(pending, false);
    }
  }
  const finalFlush = getPhotoIngestionFlushCount(pending, true);
  if (finalFlush > 0) {
    flushes.push(finalFlush);
    pending -= finalFlush;
  }
  assert.equal(processed, totalPhotos);
  assert.equal(pending, 0);
  return flushes;
}

function legacyStatementCount(totalPhotos: number, pageSize: number): number {
  let statements = 0;
  for (let processed = 0; processed < totalPhotos; processed += pageSize) {
    const pageCount = Math.min(pageSize, totalPhotos - processed);
    statements += Math.ceil(pageCount / 1_000);
  }
  return statements;
}

for (const pageSize of [25, 100, 250, 500, 2_000, 5_000]) {
  const plan = flushPlan(68_030, pageSize);
  assert.equal(plan.length, 18);
  assert.equal(
    plan.reduce((sum, count) => sum + count, 0),
    68_030,
  );
  assert.ok(plan.every((count) => count > 0 && count <= PHOTO_INGESTION_FLUSH_SIZE));
  assert.equal(plan.at(-1), 30);
}
assert.equal(legacyStatementCount(68_030, 2_000), 69);
assert.equal(legacyStatementCount(68_030, 100), 681);
assert.equal(legacyStatementCount(68_030, 25), 2_722);

console.log("Photo ingestion tests passed.");
