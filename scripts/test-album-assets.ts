#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { resolveAlbumAssets } from "../services/album-assets-core.ts";

interface TestAsset {
  readonly id: string;
  readonly source: "page" | "direct";
}

const requestedIds = ["recent", "older", "deleted", "oldest", "older"];
const directCalls: string[] = [];
const assets = await resolveAlbumAssets<TestAsset>(
  requestedIds,
  [
    { id: "unrelated", source: "page" },
    { id: "recent", source: "page" },
  ],
  async (assetId) => {
    directCalls.push(assetId);
    if (assetId === "deleted") {
      throw new Error("asset was deleted");
    }
    return { id: assetId, source: "direct" };
  },
);

assert.deepEqual(
  assets,
  [
    { id: "recent", source: "page" },
    { id: "older", source: "direct" },
    { id: "oldest", source: "direct" },
  ],
  "a partial first-page match must not suppress direct lookup of older requested assets",
);
assert.deepEqual(
  directCalls,
  ["older", "deleted", "oldest"],
  "listed assets and duplicate requested IDs must not trigger redundant direct lookups",
);

const wrongAsset = await resolveAlbumAssets<TestAsset>(["requested"], [], async () => ({
  id: "different",
  source: "direct",
}));
assert.deepEqual(wrongAsset, [], "a direct lookup must not add a different asset than the requested ID");

console.log("Album asset resolution tests passed.");
