#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT,
  createAutomaticPhotoRescanController,
  runAutomaticPhotoScanSequence,
  shouldAutomaticallyRescanPhotos,
  shouldRunAutomaticPhotoQuickScan,
} from "../utils/automatic-photo-rescan-core.ts";

const boundaryExpectations = new Map<number, boolean>([
  [-1, false],
  [0, false],
  [1, true],
  [999, true],
  [1_000, false],
  [1_001, false],
  [Number.NaN, false],
]);

for (const [pendingPhotoCount, expected] of boundaryExpectations) {
  assert.equal(
    shouldAutomaticallyRescanPhotos(pendingPhotoCount),
    expected,
    `unexpected automatic-rescan decision for ${String(pendingPhotoCount)} pending photos`,
  );
}
assert.equal(AUTOMATIC_PHOTO_RESCAN_PENDING_LIMIT, 1_000);
assert.equal(shouldRunAutomaticPhotoQuickScan(0, true), true, "an interrupted quick pipeline should resume");
assert.equal(shouldRunAutomaticPhotoQuickScan(999, true), true);
assert.equal(
  shouldRunAutomaticPhotoQuickScan(1_000, true),
  false,
  "recovery must not bypass the 1,000-new-photo safety threshold",
);
assert.equal(shouldRunAutomaticPhotoQuickScan(0, false), false);

{
  const events: string[] = [];
  let finishQuickScan!: () => void;
  const quickScanGate = new Promise<void>((resolve) => {
    finishQuickScan = resolve;
  });
  const sequence = runAutomaticPhotoScanSequence({
    shouldRunQuickScan: true,
    scanPhotos: async () => {
      events.push("quick:start");
      await quickScanGate;
      events.push("quick:end");
      return { photosProcessed: 2 };
    },
    getDeepScanCandidates: async () => {
      events.push("deep:candidates");
      return [{ id: "new-photo-1" }, { id: "new-photo-2" }];
    },
    deepScanPhotos: async (photos) => {
      events.push(`deep:start:${photos.length}`);
      events.push("deep:end");
    },
    finalizeDeepScanQueue: async () => {
      events.push("deep:finalize");
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, ["quick:start"], "deep scan must wait for the quick scan to finish");
  finishQuickScan();
  const result = await sequence;
  assert.deepEqual(result, { photosProcessed: 2 });
  assert.deepEqual(events, [
    "quick:start",
    "quick:end",
    "deep:candidates",
    "deep:start:2",
    "deep:end",
    "deep:finalize",
  ]);
}

{
  let deepScanCalls = 0;
  await runAutomaticPhotoScanSequence({
    shouldRunQuickScan: true,
    scanPhotos: async () => "quick-result",
    getDeepScanCandidates: async () => [],
    deepScanPhotos: async () => {
      deepScanCalls++;
    },
    finalizeDeepScanQueue: async () => undefined,
  });
  assert.equal(deepScanCalls, 0, "an empty new-photo batch should not start Vision work");

  await assert.rejects(
    runAutomaticPhotoScanSequence({
      shouldRunQuickScan: true,
      scanPhotos: async () => {
        throw new Error("quick failed");
      },
      getDeepScanCandidates: async () => [{ id: "must-not-run" }],
      deepScanPhotos: async () => {
        deepScanCalls++;
      },
      finalizeDeepScanQueue: async () => undefined,
    }),
    /quick failed/,
  );
  assert.equal(deepScanCalls, 0, "a failed quick scan must not start deep scanning");

  let finalizeCalls = 0;
  await assert.rejects(
    runAutomaticPhotoScanSequence({
      shouldRunQuickScan: true,
      scanPhotos: async () => "quick-finished",
      getDeepScanCandidates: async () => [{ id: "new-photo" }],
      deepScanPhotos: async () => {
        throw new Error("deep failed");
      },
      finalizeDeepScanQueue: async () => {
        finalizeCalls++;
      },
    }),
    /deep failed/,
  );
  assert.equal(finalizeCalls, 1, "deep failures must still prune completed queue rows");
}

{
  let quickScanCalls = 0;
  let deepScanCalls = 0;
  let shouldFailDeepScan = true;
  const queuedPhotos = [{ id: "durable-retry" }];

  await assert.rejects(
    runAutomaticPhotoScanSequence({
      shouldRunQuickScan: true,
      scanPhotos: async () => {
        quickScanCalls++;
        return "quick-finished";
      },
      getDeepScanCandidates: async () => queuedPhotos,
      deepScanPhotos: async () => {
        deepScanCalls++;
        if (shouldFailDeepScan) {
          throw new Error("temporary Vision failure");
        }
      },
      finalizeDeepScanQueue: async () => undefined,
    }),
    /temporary Vision failure/,
  );

  shouldFailDeepScan = false;
  const retryResult = await runAutomaticPhotoScanSequence({
    shouldRunQuickScan: false,
    scanPhotos: async () => {
      quickScanCalls++;
      return "must-not-run";
    },
    getDeepScanCandidates: async () => queuedPhotos,
    deepScanPhotos: async () => {
      deepScanCalls++;
    },
    finalizeDeepScanQueue: async () => undefined,
  });

  assert.equal(retryResult, null, "a queue-only retry must not manufacture a quick-scan result");
  assert.equal(quickScanCalls, 1, "a later queue-only retry must not rerun the quick import");
  assert.equal(deepScanCalls, 2, "durable deep work should retry on the next app-open attempt");
}

{
  const calls = { permission: 0, attempt: 0 };
  const controller = createAutomaticPhotoRescanController({
    canRun: () => true,
    hasPhotoLibraryPermission: async () => {
      calls.permission++;
      return true;
    },
    runAttempt: async () => {
      calls.attempt++;
    },
  });

  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.deepEqual(calls, { permission: 1, attempt: 1 }, "cold active launch should check once");

  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.deepEqual(calls, { permission: 1, attempt: 1 }, "repeated active events must be ignored");

  controller.handleAppStateChange("background");
  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.deepEqual(calls, { permission: 2, attempt: 2 }, "a later app open should get one new attempt");
}

{
  const calls = { permission: 0, attempt: 0 };
  const controller = createAutomaticPhotoRescanController({
    canRun: () => true,
    hasPhotoLibraryPermission: async () => {
      calls.permission++;
      return true;
    },
    runAttempt: async () => {
      calls.attempt++;
    },
  });

  controller.handleAppStateChange("background");
  await controller.waitForIdle();
  assert.deepEqual(calls, { permission: 0, attempt: 0 });

  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.deepEqual(calls, { permission: 1, attempt: 1 });
}

{
  const unavailableCalls = { permission: 0, attempt: 0 };
  const unavailableController = createAutomaticPhotoRescanController({
    canRun: () => false,
    hasPhotoLibraryPermission: async () => {
      unavailableCalls.permission++;
      return true;
    },
    runAttempt: async () => {
      unavailableCalls.attempt++;
    },
  });
  unavailableController.handleAppStateChange("active");
  await unavailableController.waitForIdle();
  assert.deepEqual(unavailableCalls, { permission: 0, attempt: 0 });

  const deniedCalls = { permission: 0, attempt: 0 };
  const deniedController = createAutomaticPhotoRescanController({
    canRun: () => true,
    hasPhotoLibraryPermission: async () => {
      deniedCalls.permission++;
      return false;
    },
    runAttempt: async () => {
      deniedCalls.attempt++;
    },
  });
  deniedController.handleAppStateChange("active");
  await deniedController.waitForIdle();
  assert.deepEqual(deniedCalls, { permission: 1, attempt: 0 });
}

{
  let resolveFirstPermission!: (granted: boolean) => void;
  const firstPermission = new Promise<boolean>((resolve) => {
    resolveFirstPermission = resolve;
  });
  let permissionCalls = 0;
  let attemptCalls = 0;
  const controller = createAutomaticPhotoRescanController({
    canRun: () => true,
    hasPhotoLibraryPermission: async () => {
      permissionCalls++;
      return permissionCalls === 1 ? firstPermission : true;
    },
    runAttempt: async () => {
      attemptCalls++;
    },
  });

  controller.handleAppStateChange("active");
  await Promise.resolve();
  controller.handleAppStateChange("inactive");
  controller.handleAppStateChange("active");
  resolveFirstPermission(true);
  await controller.waitForIdle();

  assert.equal(permissionCalls, 2, "a newer foreground cycle should run after an older check settles");
  assert.equal(attemptCalls, 1, "foreground cycles must never overlap attempts");
}

{
  let attemptCalls = 0;
  let reportedErrors = 0;
  const controller = createAutomaticPhotoRescanController({
    canRun: () => true,
    hasPhotoLibraryPermission: async () => true,
    runAttempt: async () => {
      attemptCalls++;
      if (attemptCalls === 1) {
        throw new Error("test attempt failure");
      }
    },
    onError: () => {
      reportedErrors++;
    },
  });

  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.equal(attemptCalls, 1, "an error must remain latched for the current open cycle");

  controller.handleAppStateChange("background");
  controller.handleAppStateChange("active");
  await controller.waitForIdle();
  assert.equal(reportedErrors, 1);
  assert.equal(attemptCalls, 2, "a later app open should retry after a contained error");
}

const root = new URL("../", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, root), "utf8");
const appLayout = read("app/(app)/_layout.tsx");
const rescanScreen = read("app/(app)/rescan.tsx");
const reviewScreen = read("app/(app)/(tabs)/review.tsx");
const automaticHook = read("hooks/use-automatic-photo-rescan.ts");
const newPhotosCard = read("components/home/new-photos-card.tsx");
const scannerService = read("services/scanner.ts");
const visitService = read("services/visit.ts");
const deepScanCard = read("components/settings/deep-scan-card.tsx");
const photoDatabase = read("utils/db/photos.ts");
const queueCore = read("utils/db/automatic-photo-deep-scan-queue-core.ts");
const advancedSettings = read("app/(app)/settings-advanced.tsx");
const visitsScreen = read("app/(app)/visits.tsx");
const scanHook = read("hooks/use-scan.ts");
const scanCard = read("components/scan/scan-card.tsx");

assert.match(appLayout, /useAutomaticPhotoRescan\(hasHydrated && hasCompletedInitialScan\)/);
assert.match(rescanScreen, /if \(!useAppStore\.getState\(\)\.isScanning\)/);
assert.match(automaticHook, /handleAppStateChange\(AppState\.currentState\)/);
assert.match(automaticHook, /AppState\.addEventListener\("change"/);
assert.match(automaticHook, /subscription\.remove\(\)/);
assert.match(automaticHook, /getUnscannedPhotoCount/);
assert.match(automaticHook, /getAutomaticPhotoDeepScanQueueCount/);
assert.match(automaticHook, /claimAutomaticPhotoDeepScanCandidates/);
assert.match(automaticHook, /pruneAutomaticPhotoDeepScanQueue/);
assert.match(automaticHook, /isAutomaticPhotoQuickPipelineIncomplete/);
assert.match(automaticHook, /shouldRunAutomaticPhotoQuickScan/);
assert.match(automaticHook, /markAutomaticPhotoFoodSyncRequired/);
assert.match(automaticHook, /syncAllVisitsFoodProbable/);
assert.match(automaticHook, /runAutomaticPhotoScanSequence/);
assert.match(automaticHook, /useDeepScan\(\)/);
assert.match(automaticHook, /startBackgroundPhotoScan/);
assert.doesNotMatch(automaticHook, /expo-router|router\.(?:push|replace)|Redirect|Alert\.alert|showToast|Haptics/);
assert.doesNotMatch(automaticHook, /requestMediaLibraryPermission|useRequestPermission/);
assert.doesNotMatch(automaticHook, /\.startScan\(\)|\.resetScan\(\)/);
assert.match(automaticHook, /requestCalendarPermissionIfNeeded: false/);
assert.match(automaticHook, /enqueueInsertedPhotosForAutomaticDeepScan: !validationModeEnabled/);
assert.doesNotMatch(automaticHook, /pendingAssetIds|getPhotosByAssetIds/);
assert.match(newPhotosCard, /queryKeys\.unscannedPhotoCount/);
assert.match(newPhotosCard, /!isScanning/);
assert.match(scannerService, /enqueueInsertedPhotosForAutomaticDeepScan/);
assert.match(scannerService, /insertPhotosForAutomaticDeepScan\(photos\)/);
assert.match(photoDatabase, /withExclusiveTransactionAsync/);
assert.match(photoDatabase, /RETURNING id/);
assert.match(photoDatabase, /ENQUEUE_AUTOMATIC_PHOTO_DEEP_SCAN_IDS_SQL/);
assert.match(photoDatabase, /MARK_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL/);
assert.match(queueCore, /automatic_photo_deep_scan_queue/);
assert.match(queueCore, /photo\.foodDetected IS NULL/);
assert.match(visitService, /!hasPermission && requestPermissionIfNeeded/);
assert.match(visitService, /clearAutomaticPhotoQuickPipelineIncomplete\(\)/);
assert.doesNotMatch(reviewScreen, /DeepScanCard|autoStart=\{true\}/);
assert.match(reviewScreen, /isBackgroundPhotoScanRunning/);
assert.match(advancedSettings, /disabled=\{isPhotoScanBusy\}/);
assert.match(visitsScreen, /isPhotoScanBusy\s*\? undefined/);
assert.match(deepScanCard, /disabled=\{isPhotoScanBusy\}/);
assert.match(deepScanCard, /if \(state\.isScanning \|\| state\.isBackgroundPhotoScanRunning\)[\s\S]*Alert\.alert/);
assert.match(scanHook, /isBackgroundScanRunning: isBackgroundPhotoScanRunning/);
assert.match(rescanScreen, /interactionState=\{isBackgroundScanRunning \? "background-scan-running" : "available"\}/);
assert.match(scanCard, /disabled=\{controlsDisabled\}/);
assert.doesNotMatch(appLayout, /["']\/rescan["']/);

console.log("Automatic photo rescan policy and app-open wiring tests passed.");
