#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import pMap from "p-map";
import ts from "typescript";
import * as incremental from "../utils/incremental-photo-scan-core.ts";
import * as paging from "../utils/photo-scan-core.ts";
import * as ingestion from "../utils/db/photo-ingestion-core.ts";
import * as preparedCore from "../utils/prepared-photo-scan-core.ts";
import type { ScanOptions, ScanProgress } from "../services/scanner.ts";

interface ScannerApi {
  prepareAutomaticPhotoScan(options?: {
    onProgress?: (detail: string) => void;
  }): Promise<preparedCore.PreparedPhotoScan>;
  scanCameraRoll(options?: ScanOptions): Promise<ScanProgress>;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

const compiledScanner = ts.transpileModule(readFileSync(new URL("../services/scanner.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledReadGate = ts.transpileModule(
  readFileSync(new URL("../utils/photo-library-read-gate.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
}

function makePhoto(index: number): incremental.PhotoScanAssetRecord {
  return {
    id: `photo-${index}`,
    uri: `ph://photo-${index}`,
    creationTime: 1_700_000_000_000 + index,
    latitude: index % 2 ? null : 0,
    longitude: index % 2 ? null : 0,
    mediaType: "photo",
    duration: null,
  };
}

interface FixtureOptions {
  readonly count?: number;
  readonly mode?: "change" | "database" | "identifiers" | "full" | "legacy";
  readonly beforeInsert?: (call: number) => Promise<void>;
  readonly malformedSession?: boolean;
  readonly changeToken?: string | null;
  readonly platform?: "ios" | "android";
}

interface FixtureState {
  pageFailureAt: number;
  insertFailureAt: number;
  checkpointFails: boolean;
  changeBeginFails: boolean;
  token: string;
  revision: string;
  nativeBeginGate?: Promise<void>;
  nativeReleaseGate?: Promise<void>;
  mediaPageGate?: Promise<void>;
}

function fixture(options: FixtureOptions = {}) {
  const library = Array.from({ length: options.count ?? 3 }, (_, index) => makePhoto(index));
  const stored = new Map<string, incremental.PhotoScanInsertRecord>();
  const queued = new Set<string>();
  const sessions = new Map<string, incremental.PhotoScanAssetRecord[]>();
  const mode = options.mode ?? "change";
  const counts = {
    begin: 0,
    ids: 0,
    page: 0,
    insert: 0,
    end: 0,
    checkpoint: 0,
    marker: 0,
    mediaPage: 0,
    mediaInfo: 0,
    nativeBatch: 0,
  };
  const state: FixtureState = {
    pageFailureAt: 0,
    insertFailureAt: 0,
    checkpointFails: false,
    changeBeginFails: false,
    token: "old-token",
    revision: "r1",
  };
  const events: string[] = [];
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  let timerId = 0;
  const gateExports = {};
  runInNewContext(compiledReadGate, {
    exports: gateExports,
    setTimeout: (callback: () => void, milliseconds: number) => {
      timers.set(++timerId, { callback, milliseconds });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });

  const begin = async () => {
    counts.begin++;
    events.push("begin");
    await state.nativeBeginGate;
    const pending = mode === "full" ? library.slice() : library.filter((photo) => !stored.has(photo.id));
    const sessionId = `session-${counts.begin}`;
    sessions.set(sessionId, pending);
    return {
      sessionId,
      totalCount: pending.length,
      maxPageSize: 5_000,
      libraryTotalCount: options.malformedSession ? -1 : library.length,
      excludedVisibleCount: library.length - pending.length,
      excludedPhotosWithLocation: library.filter((photo) => stored.has(photo.id) && photo.latitude !== null).length,
      excludedSkippedAssets: 0,
      mode: "delta",
      changeToken: options.changeToken === undefined ? "next-token" : options.changeToken,
    };
  };

  const insert = async (photos: incremental.PhotoScanInsertRecord[], enqueue: boolean) => {
    counts.insert++;
    events.push(`insert-start:${photos.length}`);
    await options.beforeInsert?.(counts.insert);
    if (counts.insert === state.insertFailureAt) {
      throw new Error("injected insert failure");
    }
    let inserted = 0;
    for (const photo of photos) {
      if (!stored.has(photo.id)) {
        stored.set(photo.id, photo);
        if (enqueue) {
          queued.add(photo.id);
        }
        inserted++;
      }
    }
    events.push(`insert-end:${photos.length}`);
    return inserted;
  };

  const modules = new Map<string, object>([
    ["expo-device", { totalMemory: 8 * 1024 ** 3, deviceYearClass: 2026 }],
    ["react-native", { Platform: { OS: options.platform ?? "ios" } }],
    ["p-map", pMap],
    ["./album-assets-core", {}],
    ["@/utils/db/photo-ingestion-core", ingestion],
    ["@/utils/incremental-photo-scan-core", incremental],
    ["@/utils/photo-scan-core", paging],
    ["@/utils/prepared-photo-scan-core", preparedCore],
    ["@/utils/photo-library-read-gate", gateExports],
    [
      "@/utils/db/automatic-photo-deep-scan-queue",
      {
        markAutomaticPhotoQuickPipelineIncomplete: async () => {
          counts.marker++;
          events.push("marker");
        },
      },
    ],
    [
      "@/utils/db/photo-library-checkpoint",
      {
        getPhotoLibraryChangeCheckpoint: async () => ({ token: state.token, revision: state.revision }),
        commitPhotoLibraryChangeToken: async (token: string | null, revision: string) => {
          counts.checkpoint++;
          events.push("checkpoint");
          if (state.checkpointFails) {
            throw new Error("injected checkpoint failure");
          }
          if (revision !== state.revision) {
            return false;
          }
          state.token = token ?? "";
          state.revision = `${state.revision}-next`;
          return true;
        },
      },
    ],
    [
      "@/utils/db",
      {
        getExistingPhotoAssetIdsForIncrementalScan: async () => {
          counts.ids++;
          return [...stored.keys()];
        },
        getPhotoDatabasePathForIncrementalScan: async () => "/fixture/photos.db",
        insertPhotos: (photos: incremental.PhotoScanInsertRecord[]) => insert(photos, false),
        insertPhotosForAutomaticDeepScan: (photos: incremental.PhotoScanInsertRecord[]) => insert(photos, true),
      },
    ],
    [
      "@/modules/batch-asset-info",
      {
        isPhotoLibraryChangeScanAvailable: () => mode === "change",
        isDatabaseBackedIncrementalAssetScanAvailable: () => mode === "database",
        isIncrementalAssetScanAvailable: () => mode === "identifiers",
        isBatchAssetInfoAvailable: () => mode !== "legacy",
        isAssetScanAvailable: () => mode !== "legacy",
        beginPhotoLibraryChangeScan: async () => {
          if (state.changeBeginFails) {
            throw new Error("native comparison database is locked");
          }
          return begin();
        },
        beginDatabaseBackedIncrementalAssetScan: begin,
        beginIncrementalAssetScan: begin,
        beginAssetScan: begin,
        getAssetScanPage: async (sessionId: string, page: { offset: number; limit: number }) => {
          counts.page++;
          events.push(`page:${page.offset}`);
          if (counts.page === state.pageFailureAt) {
            throw new Error("injected page failure");
          }
          const pending = sessions.get(sessionId);
          assert.ok(pending, "page must use a retained session");
          const assets = pending.slice(page.offset, page.offset + page.limit);
          const end = page.offset + assets.length;
          return {
            assets,
            offset: page.offset,
            totalCount: pending.length,
            nextOffset: end < pending.length ? end : null,
            hasNextPage: end < pending.length,
          };
        },
        endAssetScan: async (sessionId: string) => {
          counts.end++;
          await state.nativeReleaseGate;
          assert.equal(sessions.delete(sessionId), true, "native session must be released exactly once");
          events.push("end");
        },
        getAssetInfoBatch: async () => {
          counts.nativeBatch++;
          throw new Error("Fallback must not re-enter native batch metadata");
        },
      },
    ],
    [
      "expo-media-library/legacy",
      {
        MediaType: { photo: "photo", video: "video" },
        SortBy: { creationTime: "creationTime" },
        getAssetsAsync: async (request: { first: number; after?: string }) => {
          counts.mediaPage++;
          await state.mediaPageGate;
          const offset = Number(request.after ?? 0);
          const assets = library.slice(offset, offset + request.first).map((asset) => ({
            ...asset,
            location:
              asset.latitude === null || asset.longitude === null
                ? undefined
                : {
                    latitude: asset.latitude,
                    longitude: asset.longitude,
                  },
          }));
          const end = offset + assets.length;
          return { assets, totalCount: library.length, endCursor: String(end), hasNextPage: end < library.length };
        },
        getAssetInfoAsync: async (asset: incremental.PhotoScanAssetRecord) => {
          counts.mediaInfo++;
          return {
            ...asset,
            location:
              asset.latitude === null || asset.longitude === null
                ? undefined
                : {
                    latitude: asset.latitude,
                    longitude: asset.longitude,
                  },
          };
        },
      },
    ],
  ]);
  const exports: Partial<ScannerApi> = {};
  runInNewContext(compiledScanner, {
    exports,
    require: (name: string) => {
      const module = modules.get(name);
      assert.ok(module, `Unexpected scanner dependency: ${name}`);
      return module;
    },
    console: { warn: () => undefined, error: () => undefined },
  });
  assert.ok(exports.prepareAutomaticPhotoScan && exports.scanCameraRoll);
  return {
    prepare: exports.prepareAutomaticPhotoScan,
    scan: exports.scanCameraRoll,
    library,
    stored,
    queued,
    sessions,
    counts,
    state,
    events,
    expireReads() {
      const active = [...timers.entries()];
      assert.ok(active.length > 0, "a pending read must own a deadline");
      for (const [id, timer] of active) {
        assert.equal(timer.milliseconds, 15_000);
        timers.delete(id);
        timer.callback();
      }
    },
    timers,
  };
}

{
  const tailStarted = deferred();
  const releaseTail = deferred();
  const scan = fixture({
    count: 4_001,
    beforeInsert: async (call) => {
      if (call === 2) {
        tailStarted.resolve();
        await releaseTail.promise;
      }
    },
  });
  const prepared = await scan.prepare();
  assert.equal(prepared.pendingPhotoCount, 4_001);
  assert.equal(scan.counts.begin, 1);
  assert.equal(scan.counts.checkpoint, 0, "inspection cannot checkpoint pending assets");
  const running = scan.scan({ preparedScan: prepared, enqueueInsertedPhotosForAutomaticDeepScan: true });
  await tailStarted.promise;
  assert.equal(scan.stored.size, 4_000);
  assert.equal(scan.counts.checkpoint, 0, "final buffer must be durable before checkpoint");
  releaseTail.resolve();
  const result = await running;
  await prepared.dispose();
  assert.equal(result.newPhotosAdded, 4_001);
  assert.equal(scan.queued.size, 4_001);
  assert.equal(scan.counts.begin, 1, "count and import must share the native snapshot");
  assert.equal(scan.counts.ids, 0, "persistent native changes must not read all IDs into JavaScript");
  assert.equal(scan.counts.end, 1);
  assert.equal(scan.sessions.size, 0);
  assert.ok(scan.events.indexOf("checkpoint") > scan.events.indexOf("insert-end:1"));
  assert.throws(() => prepared.claim(), /Cannot claim/);
  await assert.rejects(prepared.complete(0), /Cannot complete/);
}

for (const complete of [false, true]) {
  const scan = fixture({ count: 0 });
  const prepared = await scan.prepare();
  assert.equal(prepared.pendingPhotoCount, 0);
  assert.equal(scan.counts.checkpoint, 0, "zero-work inspection is not completion");
  if (complete) {
    await prepared.complete(0);
  }
  await Promise.all([prepared.dispose(), prepared.dispose()]);
  assert.equal(scan.counts.checkpoint, complete ? 1 : 0);
  assert.equal(scan.counts.page, 0);
  assert.equal(scan.counts.insert, 0);
  assert.equal(scan.counts.end, 1);
}

{
  const scan = fixture();
  const prepared = await scan.prepare();
  await assert.rejects(prepared.complete(0), /Cannot complete a prepared/);
  await prepared.dispose();
  assert.equal(scan.counts.checkpoint, 0);
  assert.throws(() => prepared.claim(), /Cannot claim a disposed/);
}

{
  const scan = fixture({ count: 5 });
  scan.state.pageFailureAt = 2;
  const prepared = await scan.prepare();
  await assert.rejects(scan.scan({ preparedScan: prepared, batchSize: 2 }), /injected page failure/);
  await prepared.dispose();
  assert.equal(scan.stored.size, 2, "successful buffered prefix must survive a later page failure");
  assert.equal(scan.counts.checkpoint, 0);
  assert.equal(scan.state.token, "old-token");
  assert.equal(scan.counts.end, 1);
  scan.state.pageFailureAt = 0;
  const retry = await scan.prepare();
  assert.equal(retry.pendingPhotoCount, 3);
  const result = await scan.scan({ preparedScan: retry, batchSize: 2 });
  assert.equal(result.newPhotosAdded, 3);
  assert.equal(scan.stored.size, 5);
  assert.equal(scan.state.token, "next-token");
  assert.equal(scan.counts.end, 2);
}

{
  const scan = fixture();
  scan.state.insertFailureAt = 1;
  const prepared = await scan.prepare();
  await assert.rejects(scan.scan({ preparedScan: prepared }), /injected insert failure/);
  await prepared.dispose();
  assert.equal(scan.counts.insert, 1, "failed insert cannot retry the buffered rows implicitly");
  assert.equal(scan.stored.size, 0);
  assert.equal(scan.counts.checkpoint, 0);
  assert.equal(scan.counts.end, 1);
}

{
  const scan = fixture({ count: 2 });
  scan.library[0] = { ...scan.library[0], creationTime: null };
  const prepared = await scan.prepare();
  const result = await scan.scan({ preparedScan: prepared });
  assert.equal(result.newPhotosAdded, 1);
  assert.equal(result.skippedAssets, 1);
  assert.equal(scan.counts.checkpoint, 0, "inaccessible creation date cannot advance history");
  assert.equal(scan.counts.marker, 1, "downstream recovery must be marked even with automatic Vision disabled");
  assert.equal(scan.queued.size, 0);
  assert.equal(scan.counts.end, 1);
}

{
  const scan = fixture();
  scan.state.checkpointFails = true;
  const prepared = await scan.prepare();
  await assert.rejects(scan.scan({ preparedScan: prepared }), /injected checkpoint failure/);
  assert.equal(scan.stored.size, 3);
  assert.equal(scan.state.token, "old-token");
  assert.equal(scan.counts.end, 1, "checkpoint failure must release the snapshot");
}

{
  const scan = fixture({ malformedSession: true });
  await assert.rejects(scan.prepare(), /invalid library total count/);
  assert.equal(scan.counts.end, 1, "malformed preparation must release its retained native snapshot");
  assert.equal(scan.counts.checkpoint, 0);
}

for (const mode of ["database", "identifiers", "full", "legacy"] as const) {
  const scan = fixture({ mode });
  const prepared = await scan.prepare();
  assert.equal(prepared.pendingPhotoCount, 3);
  const result = await scan.scan({ preparedScan: prepared });
  await prepared.dispose();
  assert.equal(result.newPhotosAdded, 3, `${mode}: older binaries must retain imports`);
  assert.equal(scan.counts.checkpoint, 0, `${mode}: no unsupported token API calls`);
  assert.equal(scan.counts.begin, mode === "legacy" || mode === "full" ? 0 : 1);
  assert.equal(scan.sessions.size, 0);
}

{
  const scan = fixture();
  scan.state.changeBeginFails = true;
  const prepared = await scan.prepare();
  assert.equal(prepared.pendingPhotoCount, 3, "native database failure must retain the paged comparison fallback");
  assert.equal(scan.counts.ids, 1, "fallback reads identifiers through the application's working database connection");
  const result = await scan.scan({ preparedScan: prepared });
  await prepared.dispose();
  assert.equal(result.newPhotosAdded, 3, "a failed history comparison must not prevent an otherwise usable import");
  assert.equal(scan.counts.checkpoint, 0, "fallback cannot advance the failed history snapshot's checkpoint");
  assert.equal(scan.state.token, "old-token");
  assert.equal(scan.sessions.size, 0);
  scan.state.changeBeginFails = false;
  const retry = await scan.prepare();
  assert.equal(retry.pendingPhotoCount, 0);
  await retry.complete(0);
  await retry.dispose();
  assert.equal(scan.state.token, "next-token", "history checkpoints resume after the native connection recovers");
}

{
  const native = deferred();
  const write = deferred();
  const scan = fixture({ count: 4, beforeInsert: () => write.promise });
  scan.state.nativeBeginGate = native.promise;
  scan.stored.set(scan.library[0].id, { ...scan.library[0], creationTime: 1 });
  scan.library[1] = {
    ...scan.library[1],
    mediaType: "video",
    duration: 12.5,
    creationTime: -5,
    latitude: 90,
    longitude: -180,
  };
  scan.library[2] = { ...scan.library[2], latitude: Number.NaN, longitude: 0 };
  scan.library[3] = { ...scan.library[3], creationTime: null };
  const details: string[] = [];
  const preparing = scan.prepare({ onProgress: (detail) => details.push(detail) });
  await flushAsyncWork();
  assert.equal(scan.counts.begin, 1);
  scan.expireReads();
  const prepared = await preparing;
  assert.equal(prepared.pendingPhotoCount, 3, "fallback must retain only photos absent from SQLite");
  assert.equal(prepared.mediaLibraryAssets?.length, 3);
  assert.equal(Object.isFrozen(prepared.mediaLibraryAssets), true);
  assert.ok(details.includes("Reading photos directly…"));
  let finished = false;
  const importing = scan
    .scan({ preparedScan: prepared, enqueueInsertedPhotosForAutomaticDeepScan: true })
    .then((value) => {
      finished = true;
      return value;
    });
  await flushAsyncWork();
  assert.equal(scan.counts.insert, 1);
  assert.equal(finished, false, "fallback must await durable insertion before settling");
  write.resolve();
  const result = await importing;
  await prepared.dispose();
  assert.equal(result.newPhotosAdded, 2);
  assert.equal(result.skippedAssets, 1);
  assert.equal(result.usingNativeBatch, false);
  assert.equal(scan.stored.get("photo-1")?.creationTime, -5, "pre-1970 timestamps remain valid");
  assert.equal(scan.stored.get("photo-1")?.latitude, 90);
  assert.equal(scan.stored.get("photo-1")?.duration, 12.5);
  assert.equal(scan.stored.get("photo-2")?.latitude, null);
  assert.equal(scan.queued.size, 2);
  assert.equal(scan.counts.checkpoint, 0, "timed-out native history must never be checkpointed");
  assert.equal(scan.counts.nativeBatch, 0);
  assert.equal(scan.counts.mediaInfo, 0, "page metadata must not trigger content-editing/image reads");
  assert.equal(scan.counts.begin, 1, "prepared null-native fallback must not re-enter native preparation");

  const retry = await scan.prepare();
  assert.equal(retry.pendingPhotoCount, 1, "a skipped photo remains eligible on the next attempt");
  await retry.dispose();
  scan.library[3] = { ...scan.library[3], creationTime: 3 };
  const manual = await scan.scan();
  assert.equal(manual.newPhotosAdded, 1, "manual import also bypasses an outstanding native preparation");
  assert.equal(scan.counts.begin, 1, "repeated attempts cannot queue more native reads behind a stuck operation");

  const cleanup = deferred();
  scan.state.nativeReleaseGate = cleanup.promise;
  native.resolve();
  await flushAsyncWork();
  assert.equal(scan.counts.end, 1, "late native snapshot is disposed exactly once");
  assert.equal(scan.counts.checkpoint, 0);
  const whileCleaning = await scan.prepare();
  assert.equal(scan.counts.begin, 1, "native admission remains occupied until late cleanup really finishes");
  await whileCleaning.dispose();
  cleanup.resolve();
  await flushAsyncWork();
  assert.equal(scan.sessions.size, 0);
  const recovered = await scan.prepare();
  assert.equal(scan.counts.begin, 2, "native reads resume only after the previous result and cleanup settle");
  await recovered.complete(0);
  await recovered.dispose();
  assert.equal(scan.counts.checkpoint, 1);
  assert.equal(scan.timers.size, 0);
}

{
  const scan = fixture();
  scan.state.nativeBeginGate = new Promise(() => undefined);
  scan.state.mediaPageGate = new Promise(() => undefined);
  const preparing = scan.prepare();
  const rejected = assert.rejects(preparing, /Photo library read did not finish/);
  await flushAsyncWork();
  scan.expireReads();
  await flushAsyncWork();
  assert.equal(scan.counts.mediaPage, 1);
  scan.expireReads();
  await rejected;
  await assert.rejects(scan.prepare(), /Photo library reads are still pending/);
  assert.equal(scan.counts.begin, 1);
  assert.equal(scan.counts.mediaPage, 1, "unavailable PhotoKit cannot accumulate native or Expo page workers");
  assert.equal(scan.counts.checkpoint, 0);
  assert.equal(scan.timers.size, 0);
}

{
  const release = deferred();
  const scan = fixture({ count: 0 });
  const prepared = await scan.prepare();
  await prepared.complete(0);
  scan.state.nativeReleaseGate = release.promise;
  const disposing = prepared.dispose();
  const rejected = assert.rejects(disposing, /Photo library read did not finish/);
  await flushAsyncWork();
  scan.expireReads();
  await rejected;
  scan.library.push(makePhoto(1));
  const fallback = await scan.prepare();
  await scan.scan({ preparedScan: fallback });
  await fallback.dispose();
  assert.equal(scan.counts.begin, 1, "pending snapshot release must keep the native path unavailable");
  assert.equal(scan.counts.end, 1);
  assert.equal(scan.stored.size, 1);
  assert.equal(scan.counts.checkpoint, 1, "only the original completed native snapshot advances history");
  release.resolve();
  await flushAsyncWork();
  assert.equal(scan.sessions.size, 0);
  assert.equal(scan.timers.size, 0);
}

{
  const scan = fixture({ mode: "full" });
  const result = await scan.scan();
  assert.equal(result.newPhotosAdded, 3);
  assert.equal(scan.counts.begin, 1, "a manual scan with available native metadata keeps its existing path");
  assert.equal(scan.counts.mediaPage, 0);
}

{
  const scan = fixture({ mode: "legacy", platform: "android", count: 2 });
  scan.library[0] = { ...scan.library[0], mediaType: "video", duration: 4.5 };
  const prepared = await scan.prepare();
  assert.equal(prepared.mediaLibraryAssets, undefined, "Android retains its existing metadata path");
  await scan.scan({ preparedScan: prepared });
  await prepared.dispose();
  assert.equal(scan.counts.mediaInfo, 2);
  assert.equal(scan.stored.get("photo-0")?.latitude, 0);
  assert.equal(scan.stored.get("photo-0")?.duration, 4.5);
  assert.equal(scan.counts.begin, 0);
}

{
  const scan = fixture({ mode: "legacy", count: 1_001 });
  scan.library[1_000] = { ...scan.library[999] };
  scan.stored.set(scan.library[0].id, { ...scan.library[0], creationTime: 1 });
  const details: string[] = [];
  const prepared = await scan.prepare({ onProgress: (detail) => details.push(detail) });
  assert.equal(scan.counts.mediaPage, 2);
  assert.equal(prepared.pendingPhotoCount, 999, "paged metadata excludes known IDs and deduplicates moving pages");
  assert.deepEqual(details, [
    "Reading photos directly…",
    "Checked 1,000 of 1,001 photos…",
    "Checked 1,001 of 1,001 photos…",
  ]);
  const result = await scan.scan({ preparedScan: prepared });
  await prepared.dispose();
  assert.equal(result.newPhotosAdded, 999);
  assert.equal(scan.counts.mediaPage, 2, "import consumes the retained records without fetching the library again");
  assert.equal(scan.counts.mediaInfo, 0);
}

console.log(
  "Prepared scanner snapshot reuse, durable checkpoints, bounded fallback, late cleanup, and recovery tests passed.",
);
