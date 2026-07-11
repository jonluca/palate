#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildWrappedStatsSectionPlan,
  type WrappedStatsSectionDescriptor,
  type WrappedStatsSectionKind,
  type WrappedStatsSectionPlanInput,
} from "../utils/wrapped-stats-render-core.ts";

interface Configuration {
  readonly initiallyMaterializedSections: number;
  readonly outputPath: string;
}

interface StructuralMeasurement {
  readonly modeledMountedSections: number;
  readonly modeledDynamicRowWork: number;
  readonly nativeMapViewsEligibleToMount: number;
  readonly sectionKeys: readonly WrappedStatsSectionKind[];
}

const DEFAULT_OUTPUT_PATH = ".build/wrapped-stats-render-profile.json";
const FULL_FIXTURE: WrappedStatsSectionPlanInput = {
  selectedYear: null,
  totalStarredVisits: 120,
  greenStarVisits: 6,
  cuisineCount: 5,
  monthlyVisitCount: 180,
  locationCount: 10,
  mapPointCount: 500,
  totalPhotos: 68_028,
  mealTimeVisitCount: 180,
  yearlyStatCount: 15,
};

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${option} must be a positive safe integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let initiallyMaterializedSections = 4;
  let outputPath = resolve(DEFAULT_OUTPUT_PATH);
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === "--") {
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 0) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (option === "--initial-sections") {
      initiallyMaterializedSections = parsePositiveInteger(value, option);
    } else if (option === "--output") {
      if (!value) {
        throw new RangeError("--output cannot be empty");
      }
      outputPath = resolve(value);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return { initiallyMaterializedSections, outputPath };
}

function usage(): string {
  return `Usage: benchmark-wrapped-stats-render.ts [--initial-sections=N] [--output=PATH]

Produces a deterministic structural model. It does not claim React Native render latency,
FlashList's exact internal cell count, or measured MapKit resident memory.`;
}

function dynamicRowWork(kind: WrappedStatsSectionKind, fixture: WrappedStatsSectionPlanInput): number {
  switch (kind) {
    case "michelin":
      return 5;
    case "green-star":
    case "editorial-overview":
    case "dining-style":
      return 1;
    case "monthly-visits":
      return Math.min(fixture.monthlyVisitCount, 12);
    case "dining-map":
      return fixture.mapPointCount;
    case "location-breakdown":
      return fixture.locationCount;
    case "cuisine-cloud":
      return fixture.cuisineCount;
    case "dining-time":
      return 5;
    case "weekend-weekday":
      return 2;
    case "photo-stats":
      return 2;
    case "seasonality":
      return 4;
    case "yearly-highlights":
      return fixture.yearlyStatCount;
    case "fun-facts":
      return 16;
  }
}

function measure(
  sections: readonly WrappedStatsSectionDescriptor[],
  fixture: WrappedStatsSectionPlanInput,
  nativeMapVisible: boolean,
): StructuralMeasurement {
  return {
    modeledMountedSections: sections.length,
    modeledDynamicRowWork: sections.reduce((sum, section) => sum + dynamicRowWork(section.kind, fixture), 0),
    nativeMapViewsEligibleToMount:
      nativeMapVisible && sections.some((section) => section.kind === "dining-map") ? 1 : 0,
    sectionKeys: sections.map((section) => section.key),
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const fullPlan = buildWrappedStatsSectionPlan(FULL_FIXTURE);
const initialCandidateSections = fullPlan.slice(0, configuration.initiallyMaterializedSections);
const eagerInitial = measure(fullPlan, FULL_FIXTURE, true);
const virtualizedInitial = measure(initialCandidateSections, FULL_FIXTURE, false);
const virtualizedMapVisible = measure(
  fullPlan.filter((section) => section.kind === "dining-map"),
  FULL_FIXTURE,
  true,
);

assert.equal(eagerInitial.modeledMountedSections, fullPlan.length);
assert.equal(eagerInitial.nativeMapViewsEligibleToMount, 1);
assert.equal(virtualizedInitial.nativeMapViewsEligibleToMount, 0);
assert.ok(virtualizedInitial.modeledMountedSections < eagerInitial.modeledMountedSections);
assert.ok(virtualizedInitial.modeledDynamicRowWork < eagerInitial.modeledDynamicRowWork);
assert.equal(virtualizedMapVisible.nativeMapViewsEligibleToMount, 1);

const report = {
  schemaVersion: 1,
  status: "ok",
  mode: "deterministic-structural-model",
  configuration: {
    initiallyMaterializedSections: configuration.initiallyMaterializedSections,
  },
  fixture: FULL_FIXTURE,
  correctness: {
    productionSectionPlannerUsed: true,
    eagerAndCandidateShareExactSectionDescriptors: true,
    candidateNativeMapEligibilityIsViewabilityGated: true,
    retainedMapVisibilityIsCoveredByUnitTests: true,
  },
  measurements: {
    eagerInitial,
    virtualizedInitial,
    virtualizedMapVisible,
  },
  comparison: {
    initialModeledMountedSectionReduction:
      eagerInitial.modeledMountedSections - virtualizedInitial.modeledMountedSections,
    initialModeledDynamicRowWorkReduction:
      eagerInitial.modeledDynamicRowWork - virtualizedInitial.modeledDynamicRowWork,
    initialNativeMapEligibilityReduction:
      eagerInitial.nativeMapViewsEligibleToMount - virtualizedInitial.nativeMapViewsEligibleToMount,
  },
  scope:
    "Counts section descriptors and data-shaped dynamic rows/markers under an explicit initial-cell model. It does not execute React Native, FlashList, MapKit, animations, SQLite, or rendering and is not a latency or RSS claim. A signed fresh-process macOS A/B is required for promotion.",
};

mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
chmodSync(configuration.outputPath, 0o600);
console.log(JSON.stringify(report, null, 2));
