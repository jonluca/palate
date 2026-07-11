#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowsAutomaticDeepScanFollowup,
  DEFAULT_VISIT_FOOD_DETECTION_STRATEGY,
  FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY,
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
  resolveVisitFoodDetectionStrategy,
  type VisitFoodDetectionStrategy,
} from "../modules/batch-asset-info/src/visit-food-detection-strategy.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

assert.equal(FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY, "full-plan-v1");
assert.equal(RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY, "rank3-bulk-tail-v1");
assert.equal(DEFAULT_VISIT_FOOD_DETECTION_STRATEGY, RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY);
assert.equal(allowsAutomaticDeepScanFollowup(FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY), true);
assert.equal(allowsAutomaticDeepScanFollowup(RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY), false);
assert.equal(allowsAutomaticDeepScanFollowup(FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY, true), false);
assert.equal(allowsAutomaticDeepScanFollowup(RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY, true), false);

const supported: readonly VisitFoodDetectionStrategy[] = [
  FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY,
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
];
for (const strategy of supported) {
  assert.equal(resolveVisitFoodDetectionStrategy(strategy), strategy);
}

for (const invalid of [
  undefined,
  null,
  "",
  "FULL-PLAN-V1",
  " full-plan-v1",
  "full-plan-v1 ",
  "rank-3-bulk-tail-v1",
  "rank3-bulk-tail-v2",
  1,
  true,
  {},
  ["full-plan-v1"],
]) {
  assert.equal(
    resolveVisitFoodDetectionStrategy(invalid),
    FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY,
    `missing or invalid native value must retain the older-binary full path: ${String(invalid)}`,
  );
}

const swiftModuleSource = readFileSync(
  join(repositoryRoot, "modules/batch-asset-info/ios/BatchAssetInfoModule.swift"),
  "utf8",
);
assert.match(swiftModuleSource, /Constant\("resolvedVisitFoodDetectionStrategy"\)/);
assert.match(swiftModuleSource, /PhotoAssetVisitFoodDetectionStrategy\.resolve\(\)\.rawValue/);
assert.match(swiftModuleSource, /Function\("isVisionVisitFoodValidationModeEnabled"\)/);
assert.match(swiftModuleSource, /PhotoAssetVisionVisitFoodValidationMode\.isEnabled\(\)/);

const sourceIndex = readFileSync(join(repositoryRoot, "modules/batch-asset-info/src/index.ts"), "utf8");
assert.match(sourceIndex, /readonly resolvedVisitFoodDetectionStrategy\?: string;/);
assert.match(sourceIndex, /isVisionVisitFoodValidationModeEnabled\?\(\): boolean;/);
assert.match(sourceIndex, /export function getResolvedVisitFoodDetectionStrategy\(\)/);
assert.match(sourceIndex, /export function isVisionVisitFoodValidationModeEnabled\(\)/);
assert.match(
  sourceIndex,
  /resolveVisitFoodDetectionStrategy\(BatchAssetInfoModule\?\.resolvedVisitFoodDetectionStrategy\)/,
);

const publicIndex = readFileSync(join(repositoryRoot, "modules/batch-asset-info/index.ts"), "utf8");
assert.match(publicIndex, /getResolvedVisitFoodDetectionStrategy,/);
assert.match(publicIndex, /allowsAutomaticDeepScanFollowup,/);
assert.match(publicIndex, /isVisionVisitFoodValidationModeEnabled,/);
assert.match(publicIndex, /resolveVisitFoodDetectionStrategy,/);
assert.match(publicIndex, /type VisitFoodDetectionStrategy,/);

const visitServiceSource = readFileSync(join(repositoryRoot, "services/visit.ts"), "utf8");
const deepScanStart = visitServiceSource.indexOf("export async function deepScanAllPhotosForFood");
const deepScanEnd = visitServiceSource.indexOf("export interface VisitFoodScanProgress", deepScanStart);
assert.ok(deepScanStart >= 0 && deepScanEnd > deepScanStart, "deep scan implementation must be locatable");
const deepScanSource = visitServiceSource.slice(deepScanStart, deepScanEnd);
assert.match(
  deepScanSource,
  /if \(isVisionVisitFoodValidationModeEnabled\(\)\) \{[\s\S]*detectFoodInVisits/,
  "validation Deep Scan must route both strategies through the visit-aware entry point",
);
assert.match(
  deepScanSource,
  /const photosToScan = photos \?\? \(await getUnanalyzedPhotoIds\(\)\)/,
  "ordinary explicit Deep Scan must retain its supplied-or-all-pending contract",
);
assert.doesNotMatch(
  deepScanSource,
  /getResolvedVisitFoodDetectionStrategy/,
  "ordinary explicit Deep Scan routing must not depend on the visit-aware strategy",
);

const reviewSource = readFileSync(join(repositoryRoot, "app/(app)/(tabs)/review.tsx"), "utf8");
assert.match(
  reviewSource,
  /allowsAutomaticDeepScanFollowup\([\s\S]*getResolvedVisitFoodDetectionStrategy\(\)[\s\S]*isVisionVisitFoodValidationModeEnabled\(\)[\s\S]*!isLoading/,
  "Review auto-start must honor adaptive and validation suppression",
);

const deepScanCardSource = readFileSync(join(repositoryRoot, "components/settings/deep-scan-card.tsx"), "utf8");
assert.match(
  deepScanCardSource,
  /source === "auto"[\s\S]*!allowsAutomaticDeepScanFollowup\([\s\S]*getResolvedVisitFoodDetectionStrategy\(\)[\s\S]*isVisionVisitFoodValidationModeEnabled\(\)/,
  "DeepScanCard auto-start must honor adaptive and validation suppression",
);

const useScanSource = readFileSync(join(repositoryRoot, "hooks/use-scan.ts"), "utf8");
assert.match(
  useScanSource,
  /!allowsAutomaticDeepScanFollowup\([\s\S]*getResolvedVisitFoodDetectionStrategy\(\)[\s\S]*isVisionVisitFoodValidationModeEnabled\(\)/,
  "scan follow-ups must honor adaptive and validation suppression",
);

console.log("Visit food-detection strategy tests passed.");
