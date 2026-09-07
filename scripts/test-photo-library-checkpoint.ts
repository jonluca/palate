#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { PhotoLibraryChangeCheckpoint } from "../utils/db/photo-library-checkpoint.ts";
import { buildPhotoIngestionStatement, type PhotoIngestionRecord } from "../utils/db/photo-ingestion-core.ts";
import {
  CREATE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL,
  ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL,
  MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
} from "../utils/db/automatic-photo-deep-scan-queue-core.ts";
import { dropApplicationDatabaseTables } from "../utils/db/reset-core.ts";
import * as runtimeJson from "../utils/runtime-json.ts";

interface CheckpointApi {
  getPhotoLibraryChangeCheckpoint(): Promise<PhotoLibraryChangeCheckpoint>;
  commitPhotoLibraryChangeToken(token: string | null, expectedRevision: string): Promise<boolean>;
  invalidatePhotoLibraryChangeToken(): Promise<void>;
}

const compiledApi = ts.transpileModule(
  readFileSync(new URL("../utils/db/photo-library-checkpoint.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loadApi(database: DatabaseSync) {
  let writes = 0;
  const adapter = {
    async getFirstAsync(sql: string, parameters: SQLInputValue[]) {
      return database.prepare(sql).get(...parameters) ?? null;
    },
    async runAsync(sql: string, parameters: SQLInputValue[]) {
      const result = database.prepare(sql).run(...parameters);
      writes += Number(result.changes);
      return { changes: Number(result.changes) };
    },
  };
  const exports: Partial<CheckpointApi> = {};
  runInNewContext(compiledApi, {
    exports,
    require: (name: string) => {
      if (name === "./core") {
        return { getDatabase: async () => adapter };
      }
      if (name === "../runtime-json.ts") {
        return runtimeJson;
      }
      throw new Error(`Unexpected checkpoint dependency: ${name}`);
    },
  });
  const { getPhotoLibraryChangeCheckpoint, commitPhotoLibraryChangeToken, invalidatePhotoLibraryChangeToken } = exports;
  assert.ok(getPhotoLibraryChangeCheckpoint && commitPhotoLibraryChangeToken && invalidatePhotoLibraryChangeToken);
  return {
    getPhotoLibraryChangeCheckpoint,
    commitPhotoLibraryChangeToken,
    invalidatePhotoLibraryChangeToken,
    writes: () => writes,
  };
}

function initializeFixture(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY NOT NULL, uri TEXT NOT NULL, creationTime REAL NOT NULL,
      latitude REAL, longitude REAL, mediaType TEXT, duration REAL,
      visitId TEXT, foodDetected INTEGER
    );
    ${CREATE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL}
  `);
}

function persistPhotos(database: DatabaseSync, photos: readonly PhotoIngestionRecord[]): number {
  const statement = buildPhotoIngestionStatement(photos);
  assert.ok(statement);
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare(`${statement.sql} RETURNING id`).all(...statement.parameters);
    if (rows.length > 0) {
      database.prepare(ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL).run(JSON.stringify(rows.map((row) => row.id)));
      database.prepare(MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL).run();
    }
    database.exec("COMMIT");
    return rows.length;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const directory = mkdtempSync(join(tmpdir(), "palate-photo-checkpoint-"));
let database = new DatabaseSync(join(directory, "checkpoint.db"));
try {
  initializeFixture(database);
  let api = loadApi(database);

  const initialReads = await Promise.all([
    api.getPhotoLibraryChangeCheckpoint(),
    api.getPhotoLibraryChangeCheckpoint(),
  ]);
  const initial = initialReads[0];
  assert.equal(initial.token, null);
  assert.match(initial.revision, /^[a-f0-9]{32}$/);
  assert.equal(initialReads[1].revision, initial.revision, "concurrent first readers must share a generation");
  assert.equal(api.writes(), 1);
  assert.equal((await api.getPhotoLibraryChangeCheckpoint()).revision, initial.revision);
  assert.equal(api.writes(), 1, "reading an existing checkpoint must not write it again");

  const token = "opaque-'雪'-\"quoted\"-\\token\nline";
  assert.equal(await api.commitPhotoLibraryChangeToken(token, initial.revision), true);
  const committed = await api.getPhotoLibraryChangeCheckpoint();
  assert.equal(committed.token, token, "checkpoint storage must preserve the opaque token exactly");
  assert.notEqual(committed.revision, initial.revision);
  assert.equal(await api.commitPhotoLibraryChangeToken("stale-token", initial.revision), false);
  assert.equal(await api.commitPhotoLibraryChangeToken(null, initial.revision), false);
  assert.equal((await api.getPhotoLibraryChangeCheckpoint()).token, token);
  await assert.rejects(api.commitPhotoLibraryChangeToken("   ", committed.revision), /non-empty/);
  await assert.rejects(api.commitPhotoLibraryChangeToken("next", ""), /revision must be non-empty/);

  database.close();
  database = new DatabaseSync(join(directory, "checkpoint.db"));
  api = loadApi(database);
  assert.equal((await api.getPhotoLibraryChangeCheckpoint()).token, token, "checkpoint must survive database reopen");
  assert.equal((await api.getPhotoLibraryChangeCheckpoint()).revision, committed.revision);

  const photo: PhotoIngestionRecord = {
    id: "replayed-photo",
    uri: "ph://replayed",
    creationTime: 100,
    latitude: 0,
    longitude: 0,
    mediaType: "photo",
    duration: null,
  };
  assert.equal(persistPhotos(database, [photo]), 1);
  database.prepare("UPDATE photos SET visitId = ?, foodDetected = 1 WHERE id = ?").run("kept-visit", photo.id);
  // A failed later page leaves the prior token intact, even with a durable prefix.
  assert.equal((await api.getPhotoLibraryChangeCheckpoint()).token, token);
  assert.equal(persistPhotos(database, [{ ...photo, uri: "ph://must-not-replace" }]), 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM photos").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automatic_photo_deep_scan_queue").get()?.count, 1);
  const replayed = database.prepare("SELECT uri, visitId, foodDetected FROM photos WHERE id = ?").get(photo.id);
  assert.equal(replayed?.uri, photo.uri);
  assert.equal(replayed?.visitId, "kept-visit");
  assert.equal(replayed?.foodDetected, 1);
  assert.equal(await api.commitPhotoLibraryChangeToken("after-replay", committed.revision), true);

  const beforeInvalidation = await api.getPhotoLibraryChangeCheckpoint();
  await api.invalidatePhotoLibraryChangeToken();
  database.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  const invalidated = await api.getPhotoLibraryChangeCheckpoint();
  assert.equal(invalidated.token, null, "local photo removal must force the next scan to establish a new baseline");
  assert.notEqual(invalidated.revision, beforeInvalidation.revision);
  assert.equal(await api.commitPhotoLibraryChangeToken("before-local-removal", beforeInvalidation.revision), false);

  assert.equal(await api.commitPhotoLibraryChangeToken("before-reset", invalidated.revision), true);
  const beforeReset = await api.getPhotoLibraryChangeCheckpoint();
  await dropApplicationDatabaseTables({ execAsync: async (sql) => database.exec(sql) });
  initializeFixture(database);
  assert.equal(await api.commitPhotoLibraryChangeToken("stale-after-reset", beforeReset.revision), false);
  const afterReset = await api.getPhotoLibraryChangeCheckpoint();
  assert.equal(afterReset.token, null);
  assert.notEqual(afterReset.revision, beforeReset.revision);
  assert.equal(await api.commitPhotoLibraryChangeToken("before-partial-reset", afterReset.revision), true);
  const beforePartialReset = await api.getPhotoLibraryChangeCheckpoint();

  await assert.rejects(
    dropApplicationDatabaseTables({
      execAsync: async (source) => {
        for (const statement of source.split(";").filter((part) => part.trim().length > 0)) {
          database.exec(statement);
          if (statement.includes("DROP TABLE IF EXISTS photos")) {
            throw new Error("reset interrupted after removing photos");
          }
        }
      },
    }),
    /reset interrupted/,
  );
  assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  initializeFixture(database);
  assert.equal(
    await api.commitPhotoLibraryChangeToken("stale-after-partial-reset", beforePartialReset.revision),
    false,
  );
  const afterPartialReset = await api.getPhotoLibraryChangeCheckpoint();
  assert.equal(afterPartialReset.token, null, "partial reset must not retain a token after photo rows disappear");
  assert.notEqual(afterPartialReset.revision, beforePartialReset.revision);
  assert.equal(await api.commitPhotoLibraryChangeToken(null, afterPartialReset.revision), true);
  assert.notEqual((await api.getPhotoLibraryChangeCheckpoint()).revision, afterPartialReset.revision);
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log("Photo-library checkpoint, concurrent ownership, replay, and reset tests passed.");
