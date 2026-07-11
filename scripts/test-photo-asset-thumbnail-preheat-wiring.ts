#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, root), "utf8");

const photosSection = read("components/visit/photos-section.tsx");
assert.match(photosSection, /PhotoAssetThumbnail/);
assert.doesNotMatch(photosSection, /PhotoAssetThumbnailPreheat/);
assert.doesNotMatch(photosSection, /planPhotoAssetThumbnailPreheat/);
assert.doesNotMatch(photosSection, /updatePhotoAssetThumbnailPreheat/);
assert.doesNotMatch(photosSection, /endPhotoAssetThumbnailPreheat/);
assert.doesNotMatch(photosSection, /useIsFocused/);
assert.doesNotMatch(photosSection, /AppState/);
assert.doesNotMatch(photosSection, /onViewableItemsChanged/);

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

console.log("Photo asset thumbnail preheat remains available natively but dormant in production UI.");
