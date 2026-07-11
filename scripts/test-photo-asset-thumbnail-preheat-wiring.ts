#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, root), "utf8");

const photosSection = read("components/visit/photos-section.tsx");
assert.match(photosSection, /planPhotoAssetThumbnailPreheat/);
assert.match(photosSection, /updatePhotoAssetThumbnailPreheat/);
assert.match(photosSection, /endPhotoAssetThumbnailPreheat/);
assert.match(photosSection, /transitionPhotoAssetThumbnailPreheatProducer/);
assert.match(photosSection, /configuredPhotoRowsRef\.current !== photoRows/);
assert.match(photosSection, /type: dataChanged \? "data-change" : "refresh"/);
assert.match(photosSection, /type: "viewability"/);
assert.match(photosSection, /visibleRowIndicesToPlan === null/);
assert.match(photosSection, /if \(!plan\) \{\s*endPhotoAssetThumbnailPreheat\(preheatScopeID\);\s*return;/);
assert.match(photosSection, /currentProducerState, event, photoRows\.length/);
assert.match(photosSection, /const \{ width: screenWidth, scale \} = useWindowDimensions\(\)/);
assert.match(photosSection, /scale,/);
assert.doesNotMatch(photosSection, /PixelRatio/);
assert.match(photosSection, /onViewableItemsChanged=\{onViewableItemsChanged\}/);
assert.match(photosSection, /viewabilityConfig=\{PHOTO_VIEWABILITY_CONFIG\}/);

const protectedPreview = read("components/visit-card/photo-preview.tsx");
assert.doesNotMatch(protectedPreview, /PhotoAssetThumbnailPreheat|thumbnail-preheat/i);

const nativeModule = read("modules/batch-asset-info/ios/BatchAssetInfoModule.swift");
assert.match(nativeModule, /Constant\("supportsPhotoAssetThumbnailPreheat"\)/);
assert.match(nativeModule, /Function\("updatePhotoAssetThumbnailPreheat"\)/);
assert.match(nativeModule, /Function\("endPhotoAssetThumbnailPreheat"\)/);
assert.match(nativeModule, /PhotoAssetThumbnailPreheatStrategy\.resolve\(\) == \.windowedV1/);

const nativeStore = read("modules/batch-asset-info/ios/Core/PhotoAssetThumbnailStore.swift");
assert.match(nativeStore, /PhotoAssetThumbnailPreheatRuntime/);
assert.match(nativeStore, /enqueueVisibleAssetFetchDemand\(identifiersToFetch\)/);
assert.match(nativeStore, /assetFetchScheduler\.replacePreheatDemand/);
assert.match(nativeStore, /preheatRuntime\.resolveAssetFetch/);

console.log("Photo asset thumbnail preheat production wiring tests passed.");
