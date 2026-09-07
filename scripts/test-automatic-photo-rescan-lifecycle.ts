#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as core from "../utils/automatic-photo-rescan-core.ts";
import { createPreparedPhotoScan, type PreparedPhotoScan } from "../utils/prepared-photo-scan-core.ts";
import type { DeepScanProgress, ScanProgress } from "../hooks/queries.ts";

const compiledHook = ts.transpileModule(
  readFileSync(new URL("../hooks/use-automatic-photo-rescan.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

interface FixtureOptions {
  appState?: string | null;
  enabled?: boolean;
  platform?: string;
  pending?: number;
  queued?: number;
  busy?: boolean;
  mutations?: number;
  permission?: boolean | Promise<boolean>;
  quickGate?: Promise<void>;
  deepGate?: Promise<void>;
  quickFailure?: boolean;
  deepFailure?: boolean;
  retainQueue?: boolean;
  nativeAvailable?: boolean;
  syncFailure?: boolean;
  preparationGate?: Promise<void>;
  quickPipelineIncomplete?: boolean;
}

interface StoreSnapshot {
  hasHydrated: boolean;
  hasCompletedInitialScan: boolean;
  isScanning: boolean;
  isBackgroundPhotoScanRunning: boolean;
  backgroundPhotoScanProgress: { stage: string; detail: string; progress: number | null } | null;
}

interface LibraryEvent {
  hasIncrementalChanges?: boolean;
  insertedAssets?: Array<{ id: string }>;
  deletedAssets?: Array<{ id: string }>;
  updatedAssets?: Array<{ id: string }>;
}

interface HookExports {
  useAutomaticPhotoRescan?: (enabled: boolean) => void;
}

function fixture(options: FixtureOptions = {}) {
  const appListeners = new Set<(state: string) => void>();
  const libraryListeners = new Set<(event: LibraryEvent) => void>();
  const storeListeners = new Set<(state: StoreSnapshot, previous: StoreSnapshot) => void>();
  const mutationListeners = new Set<() => void>();
  const effects: Array<() => (() => void) | void> = [];
  const timers = new Map<number, { delay: number; callback: () => void }>();
  const delays: number[] = [];
  let nextTimer = 0;
  let controller: core.AutomaticPhotoRescanController | undefined;
  let cleanups: Array<() => void> = [];
  let photoNumber = 0;
  let activeMutations = 0;
  const data = {
    pending: options.pending ?? 0,
    queue: Array.from({ length: options.queued ?? 0 }, () => ({ id: `photo-${photoNumber++}` })),
    permission: options.permission ?? true,
    mutations: options.mutations ?? 0,
    quickFailure: options.quickFailure ?? false,
    deepFailure: options.deepFailure ?? false,
    syncRequired: false,
    syncFailure: options.syncFailure ?? false,
  };
  const counts = {
    permission: 0,
    starts: 0,
    finishes: 0,
    quick: 0,
    errors: 0,
    maxConcurrent: 0,
    foodSync: 0,
    prepared: 0,
    released: 0,
    checkpoints: 0,
  };
  const reportedErrors: unknown[] = [];
  const deepBatches: string[][] = [];
  const claimLimits: number[] = [];
  let snapshot: StoreSnapshot = {
    hasHydrated: true,
    hasCompletedInitialScan: true,
    isScanning: options.busy ?? false,
    isBackgroundPhotoScanRunning: false,
    backgroundPhotoScanProgress: null,
  };
  const setState = (update: Partial<StoreSnapshot>) => {
    const previous = snapshot;
    snapshot = { ...snapshot, ...update };
    for (const listener of storeListeners) {
      listener(snapshot, previous);
    }
  };
  const store = {
    getState: () => ({
      ...snapshot,
      startBackgroundPhotoScan: () => {
        if (snapshot.isScanning || snapshot.isBackgroundPhotoScanRunning) {
          return false;
        }
        counts.starts++;
        setState({
          isBackgroundPhotoScanRunning: true,
          backgroundPhotoScanProgress: { stage: "checking", detail: "Checking for photo updates…", progress: null },
        });
        return true;
      },
      updateBackgroundPhotoScanProgress: (progress: StoreSnapshot["backgroundPhotoScanProgress"]) => {
        if (snapshot.isBackgroundPhotoScanRunning) {
          setState({ backgroundPhotoScanProgress: progress });
        }
      },
      finishBackgroundPhotoScan: () => {
        counts.finishes++;
        setState({ isBackgroundPhotoScanRunning: false, backgroundPhotoScanProgress: null });
      },
    }),
    subscribe: (listener: (state: StoreSnapshot, previous: StoreSnapshot) => void) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
  };
  const notifyMutations = () => {
    for (const listener of mutationListeners) {
      listener();
    }
  };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    activeMutations++;
    counts.maxConcurrent = Math.max(counts.maxConcurrent, activeMutations);
    notifyMutations();
    try {
      return await operation();
    } finally {
      activeMutations--;
      notifyMutations();
    }
  };
  const appState = {
    currentState: options.appState === undefined ? "active" : options.appState,
    addEventListener: (event: string, listener: (state: string) => void) => {
      assert.equal(event, "change");
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const queryClient = {
    isMutating: () => data.mutations + activeMutations,
    getMutationCache: () => ({
      subscribe: (listener: () => void) => {
        mutationListeners.add(listener);
        return () => mutationListeners.delete(listener);
      },
    }),
    invalidateQueries: async () => undefined,
    fetchQuery: async ({ queryFn }: { queryFn: () => Promise<number> }) => queryFn(),
    setQueryData: () => undefined,
  };
  const modules = new Map<string, object>([
    [
      "react",
      {
        useEffect: (effect: () => (() => void) | void) => effects.push(effect),
        useRef: <T>(value: T) => ({ current: value }),
      },
    ],
    ["react-native", { AppState: appState, Platform: { OS: options.platform ?? "ios" } }],
    [
      "expo-media-library/legacy",
      {
        addListener: (listener: (event: LibraryEvent) => void) => {
          libraryListeners.add(listener);
          return { remove: () => libraryListeners.delete(listener) };
        },
      },
    ],
    ["@tanstack/react-query", { useQueryClient: () => queryClient }],
    [
      "@/services/scanner",
      {
        prepareAutomaticPhotoScan: async () => {
          counts.prepared++;
          await options.preparationGate;
          return createPreparedPhotoScan({
            pendingPhotoCount: data.pending,
            startedAt: Date.now(),
            scan: null,
            checkpoint: async () => {
              counts.checkpoints++;
            },
            release: async () => {
              counts.released++;
            },
          });
        },
        hasMediaLibraryPermission: async () => {
          counts.permission++;
          return data.permission;
        },
      },
    ],
    ["@/services/analytics", { logScanStarted: () => undefined, logScanCompleted: () => undefined }],
    ["@/store", { useAppStore: store }],
    [
      "@/utils/db",
      {
        claimAutomaticPhotoDeepScanCandidates: async (limit: number, excludedIds: readonly string[] = []) => {
          claimLimits.push(limit);
          return data.queue.filter((photo) => !excludedIds.includes(photo.id)).slice(0, limit);
        },
        clearAutomaticPhotoFoodSyncRequired: async () => {
          data.syncRequired = false;
        },
        getAutomaticPhotoDeepScanQueueCount: async () => data.queue.length,
        isAutomaticPhotoFoodSyncRequired: async () => data.syncRequired,
        isAutomaticPhotoQuickPipelineIncomplete: async () => options.quickPipelineIncomplete ?? false,
        markAutomaticPhotoFoodSyncRequired: async () => {
          data.syncRequired = true;
        },
        pruneAutomaticPhotoDeepScanQueue: async () => undefined,
        syncAllVisitsFoodProbable: async () => {
          counts.foodSync++;
          if (data.syncFailure) {
            throw new Error("food sync failure");
          }
        },
      },
    ],
    [
      "@/modules/batch-asset-info",
      {
        isVisionVisitFoodValidationModeEnabled: () => false,
        isBatchAssetInfoAvailable: () => options.nativeAvailable !== false,
      },
    ],
    [
      "@/utils/automatic-photo-rescan-core",
      {
        ...core,
        createAutomaticPhotoRescanController: (
          dependencies: Parameters<typeof core.createAutomaticPhotoRescanController>[0],
        ) => {
          controller = core.createAutomaticPhotoRescanController(dependencies);
          return controller;
        },
      },
    ],
    [
      "./queries",
      {
        mutationKeys: { photoAnalysis: ["photoAnalysis"] },
        queryKeys: {
          unscannedPhotoCount: ["unscannedPhotoCount"],
          unmatchedVisits: ["unmatchedVisits"],
          photoCount: ["photoCount"],
        },
        invalidateFoodDetectionQueries: async () => undefined,
        useScanPhotos: (
          progress: (value: ScanProgress) => void,
          scanOptions: { enqueueInsertedPhotosForAutomaticDeepScan: boolean },
        ) => ({
          mutateAsync: (prepared: PreparedPhotoScan) =>
            mutate(async () => {
              prepared.claim();
              counts.quick++;
              const imported = data.pending;
              await options.quickGate;
              if (data.quickFailure) {
                throw new Error("quick failure");
              }
              data.pending -= imported;
              await prepared.complete(0);
              if (scanOptions.enqueueInsertedPhotosForAutomaticDeepScan) {
                data.queue.push(...Array.from({ length: imported }, () => ({ id: `photo-${photoNumber++}` })));
              }
              progress({ phase: "scanning", detail: "Imported", progress: 1 });
              return { photosProcessed: imported, visitsCreated: 0 };
            }),
        }),
        useDeepScan: (
          progress: (value: DeepScanProgress) => void,
          scanOptions: { synchronizeVisitFood?: boolean; invalidateQueriesOnSettled?: boolean },
        ) => {
          assert.equal(scanOptions.synchronizeVisitFood, false, "automatic batches must defer full food sync");
          assert.equal(
            scanOptions.invalidateQueriesOnSettled,
            false,
            "automatic batches must defer query invalidation",
          );
          return {
            mutateAsync: (photos: Array<{ id: string }>) =>
              mutate(async () => {
                const ids = Array.from(photos, (photo) => photo.id);
                deepBatches.push(ids);
                await options.deepGate;
                if (data.deepFailure) {
                  throw new Error("deep failure");
                }
                if (!options.retainQueue) {
                  data.queue = data.queue.filter((photo) => !ids.includes(photo.id));
                }
                const result = {
                  totalPhotos: ids.length,
                  processedPhotos: ids.length,
                  foodPhotosFound: 0,
                  retryableFailures: options.retainQueue ? ids.length : 0,
                  isComplete: true,
                  etaMs: 0,
                  elapsedMs: 0,
                  photosPerSecond: 0,
                };
                progress(result);
                return result;
              }),
          };
        },
      },
    ],
  ]);
  const exports: HookExports = {};
  runInNewContext(compiledHook, {
    exports,
    require: (name: string) => {
      assert.ok(modules.has(name), `Unexpected hook dependency: ${name}`);
      return modules.get(name);
    },
    console: {
      warn: (_message: string, cause: unknown) => {
        counts.errors++;
        reportedErrors.push(cause);
      },
    },
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++nextTimer;
      delays.push(delay);
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  assert.ok(exports.useAutomaticPhotoRescan);
  exports.useAutomaticPhotoRescan(options.enabled ?? true);
  cleanups = effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => cleanup !== undefined);

  const flush = async (turns = 60) => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
      for (const [id, timer] of timers) {
        if (timer.delay === 0) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
  return {
    data,
    counts,
    reportedErrors,
    deepBatches,
    claimLimits,
    delays,
    setState,
    state: () => snapshot,
    listeners: () => [appListeners.size, libraryListeners.size, storeListeners.size, mutationListeners.size],
    appState: (next: string) => {
      appState.currentState = next;
      for (const listener of appListeners) {
        listener(next);
      }
    },
    library: (event: LibraryEvent = { hasIncrementalChanges: false }) => {
      for (const listener of libraryListeners) {
        listener(event);
      }
    },
    mutations: (count: number) => {
      data.mutations = count;
      notifyMutations();
    },
    cleanup: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups = [];
    },
    flush,
    settle: async () => {
      let idle = false;
      void controller?.waitForIdle().then(() => {
        idle = true;
      });
      if (!controller) {
        idle = true;
      }
      for (let turn = 0; !idle && turn < 10_000; turn++) {
        await flush(1);
      }
      assert.ok(idle, "automatic scan must settle without delayed timers or a retry loop");
      assert.equal(counts.starts, counts.finishes, "every acquired background scan must release its lock");
      assert.equal(counts.prepared, counts.released, "every prepared native snapshot must be released exactly once");
      assert.ok(counts.maxConcurrent <= 1, "automatic quick and deep scans must not overlap");
    },
  };
}

{
  const scan = fixture({ pending: 2 });
  await scan.flush(2);
  assert.equal(scan.counts.starts, 1, "active launch must start without advancing a foreground timer");
  assert.equal(scan.state().backgroundPhotoScanProgress?.stage, "checking");
  await scan.settle();
  assert.equal(scan.counts.quick, 1);
  assert.equal(scan.deepBatches.flat().length, 2);
  assert.ok(
    scan.delays.every((delay) => delay === 0),
    "foreground work must have no artificial delay",
  );
  scan.cleanup();
}

for (const initialState of [null, "unknown", "background"]) {
  const scan = fixture({ appState: initialState, pending: 1 });
  await scan.settle();
  assert.equal(scan.counts.starts, 0, "an unknown initial state must not be assumed active");
  scan.appState("active");
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "native active notification must start the deferred launch");
  scan.cleanup();
}

for (const blocker of ["store", "mutation"] as const) {
  const scan = fixture({ pending: 1, busy: blocker === "store", mutations: blocker === "mutation" ? 1 : 0 });
  await scan.settle();
  assert.equal(scan.counts.permission, 0);
  if (blocker === "store") {
    scan.setState({ isScanning: false });
  } else {
    scan.mutations(0);
  }
  await scan.settle();
  assert.equal(scan.counts.quick, 1, `${blocker} completion must wake a deferred scan without changing tabs`);
  scan.cleanup();
}

{
  const scan = fixture();
  await scan.settle();
  scan.data.pending = 1;
  scan.library({ hasIncrementalChanges: true, insertedAssets: [{ id: "new-photo" }] });
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "new photos must trigger while the app remains active");
  scan.library({ hasIncrementalChanges: true, updatedAssets: [{ id: "metadata-only" }] });
  await scan.settle();
  assert.equal(scan.counts.starts, 3, "updated assets can make previously skipped metadata importable");
  scan.library({});
  await scan.settle();
  assert.equal(scan.counts.starts, 4, "Android's empty library event must trigger a check");
  scan.cleanup();
}

{
  const quick = gate<void>();
  const scan = fixture({ pending: 1, quickGate: quick.promise });
  await scan.flush();
  assert.equal(scan.counts.quick, 1);
  scan.data.pending += 2;
  for (let event = 0; event < 8; event++) {
    scan.library();
  }
  assert.equal(scan.counts.starts, 1, "library changes during a scan must not start overlapping attempts");
  quick.resolve();
  await scan.settle();
  assert.equal(scan.counts.starts, 2, "library bursts must coalesce into one follow-up attempt");
  assert.equal(scan.counts.quick, 2);
  assert.equal(scan.deepBatches.flat().length, 3);
  scan.cleanup();
}

for (const retainQueue of [false, true]) {
  const scan = fixture({ queued: 59, retainQueue });
  await scan.settle();
  assert.deepEqual(
    scan.deepBatches.map((batch) => batch.length),
    [24, 24, 11],
  );
  assert.equal(new Set(scan.deepBatches.flat()).size, 59, "retryable rows may be attempted only once per run");
  assert.ok(scan.claimLimits.every((limit) => limit === core.AUTOMATIC_PHOTO_DEEP_SCAN_BATCH_SIZE));
  assert.equal(scan.counts.starts, 1);
  assert.equal(scan.counts.quick, 0);
  assert.equal(scan.counts.foodSync, 1, "multiple native batches must reconcile food summaries only once");
  assert.equal(scan.data.queue.length, retainQueue ? 59 : 0);
  scan.cleanup();
}

{
  const scan = fixture({ pending: 1_001 });
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "large incremental imports must not silently skip automatic scanning");
  assert.equal(scan.deepBatches.flat().length, 1_001);
  assert.ok(scan.deepBatches.every((batch) => batch.length <= 24));
  scan.cleanup();
}

for (const failure of ["quick", "deep"] as const) {
  const scan = fixture({ pending: 1, quickFailure: failure === "quick", deepFailure: failure === "deep" });
  await scan.settle();
  assert.equal(scan.counts.errors, 1);
  assert.equal(
    scan.counts.foodSync,
    failure === "deep" ? 1 : 0,
    "a partial deep failure must reconcile completed writes",
  );
  for (let update = 0; update < 5; update++) {
    scan.mutations(0);
  }
  await scan.settle();
  assert.equal(scan.counts.starts, 1, "an error must not spin on availability notifications");
  scan.data.quickFailure = false;
  scan.data.deepFailure = false;
  scan.appState("background");
  scan.appState("active");
  await scan.settle();
  assert.equal(scan.counts.starts, 2, "a later foreground should retry failed work");
  scan.cleanup();
}

{
  const permission = gate<boolean>();
  const scan = fixture({ pending: 1, permission: permission.promise });
  scan.setState({ isScanning: true });
  permission.resolve(true);
  await scan.settle();
  assert.equal(scan.counts.starts, 0, "eligibility must be rechecked after awaiting permission");
  scan.setState({ isScanning: false });
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "permission-time contention must preserve the deferred attempt");
  scan.cleanup();
}

{
  const permission = gate<boolean>();
  const scan = fixture({ pending: 1, permission: permission.promise });
  scan.cleanup();
  assert.deepEqual(scan.listeners(), [0, 0, 0, 0]);
  permission.resolve(true);
  scan.library();
  scan.appState("active");
  scan.mutations(0);
  await scan.settle();
  assert.equal(scan.counts.starts, 0, "unmount must invalidate a pending permission result");
}

for (const stop of ["background", "cleanup"] as const) {
  const deep = gate<void>();
  const scan = fixture({ queued: 49, deepGate: deep.promise });
  await scan.flush();
  assert.equal(scan.deepBatches.length, 1);
  if (stop === "background") {
    scan.appState("background");
  } else {
    scan.cleanup();
  }
  deep.resolve();
  await scan.settle();
  assert.equal(scan.deepBatches.length, 1, `${stop} must stop before claiming another native batch`);
  assert.equal(scan.data.queue.length, 25, "unfinished work must remain queued");
  assert.equal(scan.counts.foodSync, 1, `${stop} must reconcile completed batches before releasing the scan`);
  scan.cleanup();
  assert.deepEqual(scan.listeners(), [0, 0, 0, 0]);
}

{
  const scan = fixture({ queued: 25, syncFailure: true });
  await scan.settle();
  assert.equal(scan.data.syncRequired, true, "a failed final sync must preserve the durable recovery flag");
  assert.equal(scan.counts.foodSync, 1);
  assert.equal(scan.counts.errors, 1);
  scan.data.syncFailure = false;
  scan.appState("background");
  scan.appState("active");
  await scan.settle();
  assert.equal(scan.data.syncRequired, false, "the next foreground must finish the pending food sync");
  assert.equal(scan.counts.foodSync, 2);
  assert.equal(scan.deepBatches.flat().length, 25, "sync recovery must not repeat completed native analysis");
  scan.cleanup();
}

{
  const scan = fixture({ queued: 25, deepFailure: true, syncFailure: true });
  await scan.settle();
  assert.equal(scan.counts.errors, 1);
  const [reportedError] = scan.reportedErrors;
  assert.ok(reportedError instanceof Error);
  assert.equal(reportedError.message, "deep failure", "final synchronization must not replace the scan failure");
  assert.equal(scan.data.syncRequired, true, "a simultaneous sync failure must retain the durable recovery flag");
  assert.equal(scan.data.queue.length, 25, "failed analysis must leave the photos queued");
  assert.equal(scan.deepBatches.length, 1, "a failed batch must stop the drain");
  scan.data.deepFailure = false;
  scan.data.syncFailure = false;
  scan.appState("background");
  scan.appState("active");
  await scan.settle();
  assert.equal(scan.data.syncRequired, false);
  assert.equal(scan.data.queue.length, 0);
  assert.equal(scan.counts.foodSync, 3, "the next run must recover the old sync before reconciling its new results");
  scan.cleanup();
}

{
  const scan = fixture({ pending: 1, queued: 25, nativeAvailable: false });
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "unsupported native analysis must not block importing photos");
  assert.equal(scan.claimLimits.length, 0, "unsupported native analysis must not claim deep-scan work");
  assert.equal(scan.data.queue.length, 25, "unsupported native analysis must preserve existing queued work");
  assert.equal(scan.deepBatches.length, 0);
  scan.cleanup();
}

for (const options of [{ enabled: false }, { platform: "web" }]) {
  const scan = fixture(options);
  await scan.settle();
  assert.deepEqual(scan.listeners(), [0, 0, 0, 0]);
  assert.equal(scan.counts.starts, 0);
  scan.cleanup();
}

for (const stop of ["background", "cleanup"] as const) {
  const preparation = gate<void>();
  const scan = fixture({ pending: 2, preparationGate: preparation.promise });
  await scan.flush();
  assert.equal(scan.counts.prepared, 1);
  if (stop === "background") {
    scan.appState("background");
  } else {
    scan.cleanup();
  }
  preparation.resolve();
  await scan.settle();
  assert.equal(scan.counts.quick, 0, `${stop} during preparation must not start import`);
  assert.equal(scan.counts.checkpoints, 0, "abandoned checks must not advance history");
  assert.equal(scan.counts.released, 1);
  scan.cleanup();
}

{
  const scan = fixture();
  await scan.settle();
  assert.equal(scan.counts.quick, 0);
  assert.equal(scan.deepBatches.length, 0);
  assert.equal(scan.counts.checkpoints, 1, "an explicitly completed empty delta may advance history");
  assert.equal(scan.counts.foodSync, 0);
  scan.cleanup();
}

{
  const scan = fixture({ quickPipelineIncomplete: true });
  await scan.settle();
  assert.equal(scan.counts.quick, 1, "a completed metadata checkpoint must not hide interrupted visit work");
  assert.equal(scan.counts.checkpoints, 1);
  scan.cleanup();
}

console.log("Automatic photo rescan hook lifecycle tests passed.");
