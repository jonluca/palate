#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const statsScreen = readFileSync(new URL("../components/stats/stats-screen.tsx", import.meta.url), "utf8");
const renderCore = readFileSync(new URL("../utils/wrapped-stats-render-core.ts", import.meta.url), "utf8");

assert.match(statsScreen, /process\.env\.EXPO_PUBLIC_PALATE_STATS_RENDER_STRATEGY/);
assert.match(statsScreen, /WRAPPED_STATS_RENDER_STRATEGY === VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY/);
assert.match(statsScreen, /return <EagerStatsScreenLayout \{\.\.\.layoutProps\} \/>/);
assert.match(renderCore, /DEFAULT_WRAPPED_STATS_RENDER_STRATEGY = EAGER_WRAPPED_STATS_RENDER_STRATEGY/);
assert.match(statsScreen, /testID=\{"wrapped-stats-eager-v1"\}/);
assert.match(statsScreen, /testID=\{"wrapped-stats-virtualized-v1"\}/);

assert.match(statsScreen, /<FlashList[\s\S]*data=\{sections\}/);
assert.match(statsScreen, /getWrappedStatsSectionPlan\(stats, selectedYear\)/);
assert.match(statsScreen, /onViewableItemsChanged=\{onViewableItemsChanged\}/);
assert.match(statsScreen, /viewabilityConfig=\{WRAPPED_STATS_VIEWABILITY_CONFIG\}/);
assert.match(statsScreen, /React\.useReducer\(retainWrappedStatsMapVisibility, false\)/);
assert.match(statsScreen, /nativeMapEnabled=\{item\.kind !== "dining-map" \|\| nativeMapVisible\}/);
assert.match(statsScreen, /deferFullscreenMap=\{item\.kind === "dining-map"\}/);
assert.match(statsScreen, /Map preview loads when this section is visible\./);
assert.match(statsScreen, /nativeMapEnabled \? getMapCameraPosition\(points\) : null/);
assert.match(statsScreen, /nativeMapEnabled[\s\S]*\? points\.map[\s\S]*: \[\]/);

assert.match(statsScreen, /style=\{\{[\s\S]*height: 220,[\s\S]*\}\}/);
assert.match(statsScreen, /nativeMapEnabled && \(!deferFullscreenMap \|\| isFullscreenOpen\)/);
assert.match(statsScreen, /key=\{wrappedStatsVisibilityScopeKey\(selectedYear\)\}/);
assert.doesNotMatch(
  statsScreen,
  /photo-asset-thumbnail-preheat|PhotoAssetThumbnail|batch-asset-info/,
  "Stats rendering must not couple to or mutate the photo-thumbnail subsystem",
);

assert.doesNotMatch(
  renderCore,
  /from ["'](?:react|react-native|expo)/,
  "section planning core must remain platform independent",
);

console.log("wrapped stats render wiring tests passed");
