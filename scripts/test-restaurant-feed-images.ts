#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, root), "utf8");
const feed = read("app/(app)/(tabs)/index.tsx");

assert.match(feed, /import \{ Image \} from ["']expo-image["']/);
assert.doesNotMatch(feed, /PhotoAssetThumbnail/);
assert.doesNotMatch(feed, /useMappingHelper/);
assert.match(feed, /<View key=\{uri\}/);
assert.match(feed, /<Image recyclingKey=\{uri\} source=\{\{ uri \}\}/);
assert.match(feed, /contentFit=\{"cover"\}/);
assert.doesNotMatch(feed, /cachePolicy=/);
assert.match(feed, /photos\.slice\(0, 3\)/);
assert.match(feed, /drawDistance=\{1200\}/);
assert.match(feed, /"visited-photo" : "visited-plain"/);
assert.doesNotMatch(feed, /updatePhotoAssetThumbnailPreheat|endPhotoAssetThumbnailPreheat/);

console.log("restaurant feed image wiring tests passed");
