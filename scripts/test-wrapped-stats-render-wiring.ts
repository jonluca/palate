#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const statsScreen = readFileSync(new URL("../components/stats/stats-screen.tsx", import.meta.url), "utf8");
const renderCore = readFileSync(new URL("../utils/wrapped-stats-render-core.ts", import.meta.url), "utf8");

assert.doesNotMatch(statsScreen, /process\.env\.EXPO_PUBLIC_PALATE_STATS_RENDER_STRATEGY/);
assert.doesNotMatch(statsScreen, /WRAPPED_STATS_RENDER_STRATEGY === VIRTUALIZED_WRAPPED_STATS_RENDER_STRATEGY/);
assert.match(statsScreen, /return <EagerStatsScreenLayout \{\.\.\.layoutProps\} \/>/);
assert.match(statsScreen, /enabled: isFocused \|\| !hasCachedAllTimeStats/);
assert.match(statsScreen, /if \(!isFocused \|\| !showConfetti\)/);
assert.match(statsScreen, /if \(isFocused && hasData\)/);
assert.match(renderCore, /DEFAULT_WRAPPED_STATS_RENDER_STRATEGY = EAGER_WRAPPED_STATS_RENDER_STRATEGY/);
assert.match(statsScreen, /testID=\{"wrapped-stats-eager-v1"\}/);
assert.match(statsScreen, /getWrappedStatsSectionPlan\(stats, selectedYear\)/);
assert.doesNotMatch(statsScreen, /testID=\{"wrapped-stats-virtualized-v1"\}/);
assert.doesNotMatch(statsScreen, /<FlashList/);
assert.doesNotMatch(statsScreen, /onViewableItemsChanged|retainWrappedStatsMapVisibility/);
assert.doesNotMatch(statsScreen, /nativeMapEnabled|deferFullscreenMap/);
assert.doesNotMatch(statsScreen, /Map preview loads when this section is visible\./);

assert.match(statsScreen, /style=\{\{[\s\S]*height: 220,[\s\S]*\}\}/);
assert.doesNotMatch(statsScreen, /key=\{wrappedStatsVisibilityScopeKey\(selectedYear\)\}/);
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

console.log("wrapped stats production UI uses the eager layout without a dormant virtualized path");
