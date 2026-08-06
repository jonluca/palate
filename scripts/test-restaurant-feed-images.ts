#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, root), "utf8");
const feed = read("app/(app)/(tabs)/index.tsx");
const renderDescriptor = read("modules/batch-asset-info/ios/Core/PhotoAssetThumbnailRenderDescriptor.swift");

assert.match(feed, /PhotoAssetThumbnail/);
assert.match(feed, /<PhotoAssetThumbnail\s+uri=\{uri\}/);
assert.doesNotMatch(feed, /from ["']expo-image["']/);
assert.match(feed, /useMappingHelper/);
assert.match(feed, /key=\{getMappingKey\(uri, index\)\}/);
assert.match(feed, /photos\.slice\(0, 3\)/);
assert.match(feed, /const RESTAURANT_FEED_DRAW_DISTANCE = 600/);
assert.match(feed, /drawDistance=\{RESTAURANT_FEED_DRAW_DISTANCE\}/);
assert.match(feed, /"visited-photo" : "visited-plain"/);
assert.doesNotMatch(feed, /updatePhotoAssetThumbnailPreheat|endPhotoAssetThumbnailPreheat/);
assert.match(renderDescriptor, /options\.deliveryMode = \.highQualityFormat/);
assert.doesNotMatch(renderDescriptor, /options\.deliveryMode = \.opportunistic/);

console.log("restaurant feed image wiring tests passed");
