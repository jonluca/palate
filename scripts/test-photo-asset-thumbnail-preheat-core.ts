#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  DEFAULT_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE,
  INITIAL_PHOTO_ASSET_THUMBNAIL_PREHEAT_ROW_COUNT,
  MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE,
  WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  createPhotoAssetThumbnailPreheatProducerState,
  planPhotoAssetThumbnailPreheat,
  preparePhotoAssetThumbnailPreheatBridgeRequest,
  resolvePhotoAssetThumbnailPixelTarget,
  resolvePhotoAssetThumbnailPreheatStrategy,
  transitionPhotoAssetThumbnailPreheatProducer,
} from "../utils/photo-asset-thumbnail-preheat-core.ts";

const pointTarget = {
  pointWidth: 100.1,
  pointHeight: 55.5,
  scale: 2,
} as const;

assert.deepEqual(resolvePhotoAssetThumbnailPixelTarget(pointTarget), {
  pixelWidth: 201,
  pixelHeight: 111,
});
for (const invalidTarget of [
  { pointWidth: 0, pointHeight: 10, scale: 2 },
  { pointWidth: 10, pointHeight: Number.NaN, scale: 2 },
  { pointWidth: 10, pointHeight: 10, scale: Number.POSITIVE_INFINITY },
  { pointWidth: 8_193, pointHeight: 1, scale: 1 },
  { pointWidth: 4_096, pointHeight: 4_096, scale: 1 },
]) {
  assert.equal(resolvePhotoAssetThumbnailPixelTarget(invalidTarget), null);
}

assert.equal(
  resolvePhotoAssetThumbnailPreheatStrategy({
    nativeValue: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    nativeMethodAvailable: true,
  }),
  WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
);

const bridgeRequest = preparePhotoAssetThumbnailPreheatBridgeRequest(
  "scope",
  ["ph://first", "ph://first", "file:///invalid", ...Array.from({ length: 80 }, (_, i) => `ph://asset-${i}`)],
  { pixelWidth: 320, pixelHeight: 240 },
);
assert.ok(bridgeRequest);
assert.equal(bridgeRequest.uris[0], "ph://first");
assert.equal(bridgeRequest.uris.length, MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE - 2);
assert.equal(bridgeRequest.uris.at(-1), "ph://asset-60");
const invalidBridgeInputs: readonly (readonly [unknown, unknown, unknown])[] = [
  ["", ["ph://asset"], { pixelWidth: 320, pixelHeight: 240 }],
  ["scope", null, { pixelWidth: 320, pixelHeight: 240 }],
  ["scope", ["ph://asset"], { pixelWidth: Number.NaN, pixelHeight: 240 }],
  ["scope", ["ph://asset"], { pixelWidth: Number.POSITIVE_INFINITY, pixelHeight: 240 }],
  ["scope", ["ph://asset"], { pixelWidth: 320.5, pixelHeight: 240 }],
  ["scope", ["ph://asset"], { pixelWidth: 8_193, pixelHeight: 1 }],
  ["scope", ["ph://asset"], { pixelWidth: 4_096, pixelHeight: 4_096 }],
];
for (const [scopeID, uris, target] of invalidBridgeInputs) {
  assert.equal(preparePhotoAssetThumbnailPreheatBridgeRequest(scopeID, uris, target), null);
}
for (const disabledOptions of [
  undefined,
  null,
  {},
  { nativeValue: undefined, nativeMethodAvailable: true },
  { nativeValue: "window-v2", nativeMethodAvailable: true },
  { nativeValue: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY, nativeMethodAvailable: false },
  {
    nativeValue: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    nativeMethodAvailable: true,
    enabled: false,
  },
  { nativeValue: DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY, nativeMethodAvailable: true },
] as const) {
  assert.equal(
    resolvePhotoAssetThumbnailPreheatStrategy(disabledOptions),
    DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    "disabled flags and older or unknown binaries must remain no-ops",
  );
}

const initialRows = Array.from({ length: 30 }, (_, index): readonly unknown[] => [`ph://initial-${index}`]);
initialRows[2] = ["file:///tmp/not-a-photo", "ph://", null, 17];
initialRows[4] = ["ph://initial-1", "ph://unicode-雪/'quote'/🍣"];
initialRows[5] = ["ph://initial-5", "ph://initial-5-extra"];

const initialPlan = planPhotoAssetThumbnailPreheat({
  strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  photoRows: initialRows,
  ...pointTarget,
});
assert.ok(initialPlan);
assert.equal(initialPlan.selection, "initial");
assert.deepEqual(
  initialPlan.rowIndices,
  Array.from({ length: INITIAL_PHOTO_ASSET_THUMBNAIL_PREHEAT_ROW_COUNT }, (_, index) => index),
);
assert.deepEqual(initialPlan.target, { pixelWidth: 201, pixelHeight: 111 });
assert.equal(initialPlan.uris.length, DEFAULT_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE);
assert.deepEqual(initialPlan.uris.slice(0, 5), [
  "ph://initial-0",
  "ph://initial-1",
  "ph://initial-3",
  "ph://unicode-雪/'quote'/🍣",
  "ph://initial-5",
]);
assert.equal(initialPlan.uris.includes("ph://initial-24"), false, "initial planning must not scan beyond row 23");
assert.equal(
  initialPlan.uris.filter((uri) => uri === "ph://initial-1").length,
  1,
  "exact ph:// duplicates must retain only their first occurrence",
);

const windowRows = Array.from({ length: 12 }, (_, index): readonly unknown[] => [
  `ph://row-${index}-a`,
  `ph://row-${index}-b`,
]);
windowRows[5] = ["ph://shared", "https://example.invalid/image.jpg", "ph://"];
windowRows[6] = ["ph://row-6-a", "ph://shared"];
const windowPlan = planPhotoAssetThumbnailPreheat({
  strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  photoRows: windowRows,
  visibleRowIndices: [4, 3, 4, -1, null, 99],
  maximumPayloadSize: 64,
  ...pointTarget,
});
assert.ok(windowPlan);
assert.equal(windowPlan.selection, "window");
assert.deepEqual(windowPlan.rowIndices, [3, 4, 5, 6, 7, 2]);
assert.deepEqual(windowPlan.uris, [
  "ph://row-3-a",
  "ph://row-3-b",
  "ph://row-4-a",
  "ph://row-4-b",
  "ph://shared",
  "ph://row-6-a",
  "ph://row-7-a",
  "ph://row-7-b",
  "ph://row-2-a",
  "ph://row-2-b",
]);

const callerCapped = planPhotoAssetThumbnailPreheat({
  strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  photoRows: windowRows,
  visibleRowIndices: [3, 4],
  maximumPayloadSize: 3,
  ...pointTarget,
});
assert.deepEqual(callerCapped?.uris, ["ph://row-3-a", "ph://row-3-b", "ph://row-4-a"]);

const hardCapRows = Array.from({ length: INITIAL_PHOTO_ASSET_THUMBNAIL_PREHEAT_ROW_COUNT }, (_, row) =>
  Array.from({ length: 3 }, (_, photo) => `ph://hard-cap-${row}-${photo}`),
);
const hardCapped = planPhotoAssetThumbnailPreheat({
  strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  photoRows: hardCapRows,
  maximumPayloadSize: Number.MAX_SAFE_INTEGER,
  ...pointTarget,
});
assert.equal(hardCapped?.uris.length, MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE);

assert.equal(
  planPhotoAssetThumbnailPreheat({
    strategy: DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    photoRows: [["ph://must-not-cross-the-bridge"]],
    ...pointTarget,
  }),
  null,
);
assert.equal(
  planPhotoAssetThumbnailPreheat({
    strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    photoRows: [["ph://invalid-target-must-not-cross-the-bridge"]],
    pointWidth: 0,
    pointHeight: 160,
    scale: 2,
  }),
  null,
);

const lifecycleRows = Array.from({ length: 16 }, (_, row) => [`ph://lifecycle-${row}`]);
let lifecycleState = createPhotoAssetThumbnailPreheatProducerState();

const bootstrap = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  { type: "refresh" },
  lifecycleRows.length,
);
lifecycleState = bootstrap.state;
assert.deepEqual(bootstrap.visibleRowIndicesToPlan, []);
assert.equal(
  planPhotoAssetThumbnailPreheat({
    strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    photoRows: lifecycleRows,
    visibleRowIndices: bootstrap.visibleRowIndicesToPlan,
    ...pointTarget,
  })?.selection,
  "initial",
  "bootstrap is allowed to request the row-zero initial plan",
);

const firstWindow = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  {
    type: "viewability",
    visibleRowIndices: [9, 8, 9, -1, Number.NaN, 99],
  },
  lifecycleRows.length,
);
lifecycleState = firstWindow.state;
assert.deepEqual(firstWindow.visibleRowIndicesToPlan, [8, 9]);
const firstWindowPlan = planPhotoAssetThumbnailPreheat({
  strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  photoRows: lifecycleRows,
  visibleRowIndices: firstWindow.visibleRowIndicesToPlan,
  ...pointTarget,
});
assert.equal(firstWindowPlan?.selection, "window");
assert.deepEqual(firstWindowPlan?.rowIndices, [8, 9, 10, 11, 12, 7]);

const transientEmpty = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  {
    type: "viewability",
    visibleRowIndices: [],
  },
  lifecycleRows.length,
);
assert.strictEqual(transientEmpty.state, lifecycleState);
assert.equal(
  transientEmpty.visibleRowIndicesToPlan,
  null,
  "nonempty -> empty viewability must retain the native window without resetting to row zero",
);

const invalidWindow = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  { type: "viewability", visibleRowIndices: [-1, lifecycleRows.length, Number.NaN] },
  lifecycleRows.length,
);
assert.strictEqual(invalidWindow.state, lifecycleState);
assert.equal(
  invalidWindow.visibleRowIndicesToPlan,
  null,
  "an invalid-only callback must not leak through the planner and select the initial rows",
);

const repeatedWindow = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  {
    type: "viewability",
    visibleRowIndices: [9, 8],
  },
  lifecycleRows.length,
);
assert.strictEqual(repeatedWindow.state, lifecycleState);
assert.equal(repeatedWindow.visibleRowIndicesToPlan, null, "an unchanged nonempty window is also a bridge no-op");

const refreshedWindow = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  { type: "refresh" },
  lifecycleRows.length,
);
assert.deepEqual(
  refreshedWindow.visibleRowIndicesToPlan,
  [8, 9],
  "target/configuration refreshes must reuse the retained nonempty window",
);

const nextWindow = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  {
    type: "viewability",
    visibleRowIndices: [11, 12],
  },
  lifecycleRows.length,
);
lifecycleState = nextWindow.state;
assert.deepEqual(nextWindow.visibleRowIndicesToPlan, [11, 12]);
assert.equal(lifecycleState.selection, "window");

const unchangedDataChange = transitionPhotoAssetThumbnailPreheatProducer(
  lifecycleState,
  { type: "data-change" },
  lifecycleRows.length,
);
assert.strictEqual(unchangedDataChange.state, lifecycleState);
assert.deepEqual(
  unchangedDataChange.visibleRowIndicesToPlan,
  [11, 12],
  "a data identity change must retain a still-valid nonempty visible window",
);

const clampedDataChange = transitionPhotoAssetThumbnailPreheatProducer(lifecycleState, { type: "data-change" }, 12);
lifecycleState = clampedDataChange.state;
assert.equal(lifecycleState.selection, "window");
assert.deepEqual(lifecycleState.visibleRowIndices, [11]);
assert.deepEqual(
  clampedDataChange.visibleRowIndicesToPlan,
  [11],
  "a shrinking data set must clamp away only the visible rows that no longer exist",
);

const exhaustedDataChange = transitionPhotoAssetThumbnailPreheatProducer(lifecycleState, { type: "data-change" }, 8);
lifecycleState = exhaustedDataChange.state;
assert.equal(lifecycleState.selection, "initial");
assert.deepEqual(exhaustedDataChange.visibleRowIndicesToPlan, []);
assert.equal(
  planPhotoAssetThumbnailPreheat({
    strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    photoRows: lifecycleRows.slice(0, 8),
    visibleRowIndices: exhaustedDataChange.visibleRowIndicesToPlan,
    ...pointTarget,
  })?.selection,
  "initial",
  "a data change may request row zero only when no retained visible row still exists",
);

console.log("Photo asset thumbnail preheat core tests passed.");
