#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Configuration {
  readonly databasePath: string | null;
  readonly outputPath: string;
}

interface VisitInterval {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

interface PlannedWindows {
  readonly baseUnionWindows: readonly TimeWindow[];
  readonly queryWindows: readonly TimeWindow[];
}

interface SerializedWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

interface PlanSummary {
  readonly strategy: "broad" | "sparse";
  readonly gapDays: number | null;
  readonly queryCount: number;
  readonly baseUnionWindowCount: number;
  readonly coveredMilliseconds: number;
  readonly coveredDays: number;
  readonly coveredPercentageOfBroad: number;
  readonly maximumWindowDurationMilliseconds: number;
  readonly maximumWindowDurationDays: number;
  readonly firstQueryWindow: SerializedWindow | null;
  readonly lastQueryWindow: SerializedWindow | null;
  readonly queryWindowSha256: string;
  readonly validation: {
    readonly allBufferedVisitIntervalsCovered: true;
    readonly sorted: true;
    readonly nonOverlapping: true;
    readonly maximumThreeYearWindowRespected: true;
  };
}

interface DatasetSummary {
  readonly source: "synthetic" | "database";
  readonly databasePath: string | null;
  readonly visitSelection: "all-synthetic-visits" | "all-database-visits-full-rescan";
  readonly visitCount: number;
  readonly distinctVisitIdCount: number;
  readonly zeroDurationVisitCount: number;
  readonly minimumVisitStartMs: number;
  readonly maximumVisitEndMs: number;
  readonly rawVisitSpanDays: number;
  readonly bufferedSearchSpanDays: number;
}

interface ProfileReport {
  readonly schemaVersion: 1;
  readonly benchmark: "calendar-query-window-plan";
  readonly scope: {
    readonly kind: "structural-query-plan-analysis";
    readonly eventKitInvoked: false;
    readonly eventKitLatencyIncluded: false;
    readonly note: string;
    readonly coverageSemantics: {
      readonly fixedDayMilliseconds: number;
      readonly coveredDays: string;
      readonly coveredPercentageOfBroad: string;
    };
  };
  readonly configuration: {
    readonly visitBufferMinutes: number;
    readonly maximumQueryWindowDays: number;
    readonly sparseGapSweepDays: readonly number[];
    readonly syntheticFixture: {
      readonly visitCount: number;
      readonly spanDays: number;
      readonly activeDayCount: number;
      readonly seed: number;
    } | null;
  };
  readonly correctness: {
    readonly allPassed: true;
    readonly passedFixtureCount: number;
    readonly passedFixtures: readonly string[];
  };
  readonly dataset: DatasetSummary;
  readonly broad: PlanSummary;
  readonly sparse: readonly PlanSummary[];
}

interface SQLiteVisitRow {
  readonly id: unknown;
  readonly startTime: unknown;
  readonly endTime: unknown;
}

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE;
const VISIT_BUFFER_MINUTES = 30;
const VISIT_BUFFER_MILLISECONDS = VISIT_BUFFER_MINUTES * MILLISECONDS_PER_MINUTE;
const MAXIMUM_QUERY_WINDOW_DAYS = 3 * 365;
const MAXIMUM_QUERY_WINDOW_MILLISECONDS = MAXIMUM_QUERY_WINDOW_DAYS * MILLISECONDS_PER_DAY;
const SPARSE_GAP_SWEEP_DAYS = [0, 1, 3, 7, 14, 30] as const;
const SYNTHETIC_VISIT_COUNT = 6_511;
const SYNTHETIC_SPAN_DAYS = 5_200;
const SYNTHETIC_ACTIVE_DAY_COUNT = 2_400;
const SYNTHETIC_START_MILLISECONDS = Date.UTC(2012, 3, 12, 0, 0, 0, 0);
const SYNTHETIC_SEED = 0x4341_4c51;
const DEFAULT_OUTPUT_PATH = ".build/calendar-query-window-profile.json";
const MAXIMUM_ABSOLUTE_MILLISECONDS = 8_640_000_000_000_000;

function usage(): string {
  return `Usage: benchmark-calendar-query-window-plan.ts [options]

  --database=PATH  Read all visits from an existing SQLite database in read-only
                   mode, modeling a full rescan without a calendar-link filter.
                   Without this option, use a deterministic ${SYNTHETIC_VISIT_COUNT.toLocaleString("en-US")}-visit fixture.
  --output=PATH    Deterministic JSON report path (default: ${DEFAULT_OUTPUT_PATH})
  --help, -h       Show this help

This profiler compares one broad date-range plan, split into EventKit-safe
three-year queries, with sparse unions of buffered visit intervals. It performs
structural timestamp analysis only: it does not invoke EventKit and does not
measure or predict EventKit latency.`;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let databasePath: string | null = null;
  let outputPath = DEFAULT_OUTPUT_PATH;

  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }

    const separatorIndex = argument.indexOf("=");
    if (!argument.startsWith("--") || separatorIndex === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const option = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);
    if (value.length === 0) {
      throw new RangeError(`${option} cannot be empty.`);
    }

    switch (option) {
      case "--database":
        databasePath = resolve(value);
        break;
      case "--output":
        outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return { databasePath, outputPath };
}

function assertSupportedTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAXIMUM_ABSOLUTE_MILLISECONDS) {
    throw new RangeError(`${label} must be a supported millisecond timestamp; received ${value}.`);
  }
}

function validateVisit(visit: VisitInterval): void {
  if (visit.id.length === 0) {
    throw new RangeError("Visit IDs cannot be empty.");
  }
  assertSupportedTimestamp(visit.startMs, `Visit ${visit.id} start`);
  assertSupportedTimestamp(visit.endMs, `Visit ${visit.id} end`);
  if (visit.endMs < visit.startMs) {
    throw new RangeError(`Visit ${visit.id} ends before it starts.`);
  }
}

function bufferedVisitWindows(visits: readonly VisitInterval[], bufferMilliseconds: number): TimeWindow[] {
  if (!Number.isSafeInteger(bufferMilliseconds) || bufferMilliseconds < 0) {
    throw new RangeError(`Buffer must be a non-negative safe integer; received ${bufferMilliseconds}.`);
  }

  return visits.map((visit) => {
    validateVisit(visit);
    const startMs = visit.startMs - bufferMilliseconds;
    const endMs = visit.endMs + bufferMilliseconds;
    assertSupportedTimestamp(startMs, `Buffered visit ${visit.id} start`);
    assertSupportedTimestamp(endMs, `Buffered visit ${visit.id} end`);
    return { startMs, endMs };
  });
}

function compareWindows(left: TimeWindow, right: TimeWindow): number {
  return left.startMs - right.startMs || left.endMs - right.endMs;
}

function mergeWindows(windows: readonly TimeWindow[], maximumGapMilliseconds: number): TimeWindow[] {
  if (!Number.isSafeInteger(maximumGapMilliseconds) || maximumGapMilliseconds < 0) {
    throw new RangeError(`Maximum gap must be a non-negative safe integer; received ${maximumGapMilliseconds}.`);
  }
  if (windows.length === 0) {
    return [];
  }

  const sorted = [...windows].sort(compareWindows);
  const merged: TimeWindow[] = [];
  let current = { ...sorted[0] };
  for (let index = 1; index < sorted.length; index++) {
    const next = sorted[index];
    if (next.startMs <= current.endMs + maximumGapMilliseconds) {
      current.endMs = Math.max(current.endMs, next.endMs);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

function splitWindowsAtMaximumDuration(
  baseWindows: readonly TimeWindow[],
  maximumDurationMilliseconds: number,
): TimeWindow[] {
  if (!Number.isSafeInteger(maximumDurationMilliseconds) || maximumDurationMilliseconds <= 0) {
    throw new RangeError(`Maximum duration must be a positive safe integer; received ${maximumDurationMilliseconds}.`);
  }

  const queryWindows: TimeWindow[] = [];
  for (const baseWindow of baseWindows) {
    assertSupportedTimestamp(baseWindow.startMs, "Base window start");
    assertSupportedTimestamp(baseWindow.endMs, "Base window end");
    if (baseWindow.endMs < baseWindow.startMs) {
      throw new RangeError("Base window ends before it starts.");
    }
    if (baseWindow.startMs === baseWindow.endMs) {
      queryWindows.push({ ...baseWindow });
      continue;
    }

    let startMs = baseWindow.startMs;
    while (startMs < baseWindow.endMs) {
      const endMs = Math.min(startMs + maximumDurationMilliseconds, baseWindow.endMs);
      assert.ok(endMs > startMs, "Window splitting must make forward progress.");
      queryWindows.push({ startMs, endMs });
      startMs = endMs;
    }
  }
  return queryWindows;
}

function planBroadWindows(visits: readonly VisitInterval[], bufferMilliseconds: number): PlannedWindows {
  const buffered = bufferedVisitWindows(visits, bufferMilliseconds);
  if (buffered.length === 0) {
    return { baseUnionWindows: [], queryWindows: [] };
  }

  const baseUnionWindows = [
    {
      startMs: Math.min(...buffered.map((window) => window.startMs)),
      endMs: Math.max(...buffered.map((window) => window.endMs)),
    },
  ];
  return {
    baseUnionWindows,
    queryWindows: splitWindowsAtMaximumDuration(baseUnionWindows, MAXIMUM_QUERY_WINDOW_MILLISECONDS),
  };
}

function planSparseWindows(
  visits: readonly VisitInterval[],
  bufferMilliseconds: number,
  maximumGapMilliseconds: number,
): PlannedWindows {
  const baseUnionWindows = mergeWindows(bufferedVisitWindows(visits, bufferMilliseconds), maximumGapMilliseconds);
  return {
    baseUnionWindows,
    queryWindows: splitWindowsAtMaximumDuration(baseUnionWindows, MAXIMUM_QUERY_WINDOW_MILLISECONDS),
  };
}

function assertWindowStructure(windows: readonly TimeWindow[]): void {
  for (const [index, window] of windows.entries()) {
    assertSupportedTimestamp(window.startMs, `Query window ${index} start`);
    assertSupportedTimestamp(window.endMs, `Query window ${index} end`);
    assert.ok(window.endMs >= window.startMs, `Query window ${index} must not be inverted.`);
    assert.ok(
      window.endMs - window.startMs <= MAXIMUM_QUERY_WINDOW_MILLISECONDS,
      `Query window ${index} exceeds three fixed 365-day years.`,
    );
    if (index > 0) {
      const previous = windows[index - 1];
      assert.ok(compareWindows(previous, window) <= 0, `Query window ${index} is not sorted.`);
      assert.ok(previous.endMs <= window.startMs, `Query windows ${index - 1} and ${index} overlap.`);
    }
  }
}

function isWindowFullyCovered(interval: TimeWindow, windows: readonly TimeWindow[]): boolean {
  if (interval.startMs === interval.endMs) {
    return windows.some((window) => window.startMs <= interval.startMs && window.endMs >= interval.endMs);
  }

  let coveredThrough = interval.startMs;
  for (const window of windows) {
    if (window.endMs < coveredThrough) {
      continue;
    }
    if (window.startMs > coveredThrough) {
      return false;
    }
    coveredThrough = Math.max(coveredThrough, window.endMs);
    if (coveredThrough >= interval.endMs) {
      return true;
    }
  }
  return false;
}

function validatePlan(visits: readonly VisitInterval[], bufferMilliseconds: number, plan: PlannedWindows): void {
  assertWindowStructure(plan.queryWindows);
  const buffered = bufferedVisitWindows(visits, bufferMilliseconds);
  for (const [index, interval] of buffered.entries()) {
    assert.ok(
      isWindowFullyCovered(interval, plan.queryWindows),
      `Buffered visit interval ${index} is not fully covered by the query windows.`,
    );
  }
  if (visits.length === 0) {
    assert.deepEqual(plan, { baseUnionWindows: [], queryWindows: [] });
  }
}

function serializeWindow(window: TimeWindow | undefined): SerializedWindow | null {
  return window
    ? {
        startMs: window.startMs,
        endMs: window.endMs,
        durationMs: window.endMs - window.startMs,
      }
    : null;
}

function rounded(value: number, fractionalDigits = 6): number {
  return Number(value.toFixed(fractionalDigits));
}

function totalCoveredMilliseconds(windows: readonly TimeWindow[]): number {
  return windows.reduce((total, window) => total + (window.endMs - window.startMs), 0);
}

function windowDigest(windows: readonly TimeWindow[]): string {
  const hash = createHash("sha256");
  for (const window of windows) {
    hash.update(`${window.startMs}:${window.endMs}\n`);
  }
  return hash.digest("hex");
}

function summarizePlan(
  strategy: PlanSummary["strategy"],
  gapDays: number | null,
  visits: readonly VisitInterval[],
  plan: PlannedWindows,
  broadCoveredMilliseconds: number,
): PlanSummary {
  validatePlan(visits, VISIT_BUFFER_MILLISECONDS, plan);
  const coveredMilliseconds = totalCoveredMilliseconds(plan.queryWindows);
  const maximumWindowDurationMilliseconds = plan.queryWindows.reduce(
    (maximum, window) => Math.max(maximum, window.endMs - window.startMs),
    0,
  );
  const coveredPercentageOfBroad =
    broadCoveredMilliseconds === 0 ? 100 : (coveredMilliseconds / broadCoveredMilliseconds) * 100;

  return {
    strategy,
    gapDays,
    queryCount: plan.queryWindows.length,
    baseUnionWindowCount: plan.baseUnionWindows.length,
    coveredMilliseconds,
    coveredDays: rounded(coveredMilliseconds / MILLISECONDS_PER_DAY),
    coveredPercentageOfBroad: rounded(coveredPercentageOfBroad),
    maximumWindowDurationMilliseconds,
    maximumWindowDurationDays: rounded(maximumWindowDurationMilliseconds / MILLISECONDS_PER_DAY),
    firstQueryWindow: serializeWindow(plan.queryWindows[0]),
    lastQueryWindow: serializeWindow(plan.queryWindows.at(-1)),
    queryWindowSha256: windowDigest(plan.queryWindows),
    validation: {
      allBufferedVisitIntervalsCovered: true,
      sorted: true,
      nonOverlapping: true,
      maximumThreeYearWindowRespected: true,
    },
  };
}

function runCorrectnessFixtures(): string[] {
  const fixtureNames = [
    "empty input produces no windows",
    "zero-duration visit retains its complete buffered interval",
    "duplicate and unordered visits produce sorted non-overlapping windows",
    "a gap exactly at the merge threshold is included",
    "an exact three-year window stays whole and one extra millisecond splits",
    "a buffered interval longer than three years remains fully covered across adjacent queries",
    "an inverted visit interval is rejected",
  ];

  const empty = planSparseWindows([], VISIT_BUFFER_MILLISECONDS, 0);
  validatePlan([], VISIT_BUFFER_MILLISECONDS, empty);

  const referenceTime = Date.UTC(2024, 0, 2, 12);
  const zeroDurationVisit = [{ id: "zero", startMs: referenceTime, endMs: referenceTime }];
  const zeroDurationPlan = planSparseWindows(zeroDurationVisit, VISIT_BUFFER_MILLISECONDS, 0);
  assert.deepEqual(zeroDurationPlan.baseUnionWindows, [
    {
      startMs: referenceTime - VISIT_BUFFER_MILLISECONDS,
      endMs: referenceTime + VISIT_BUFFER_MILLISECONDS,
    },
  ]);
  validatePlan(zeroDurationVisit, VISIT_BUFFER_MILLISECONDS, zeroDurationPlan);

  const duplicateAndUnordered = [
    { id: "late", startMs: referenceTime + 4 * MILLISECONDS_PER_DAY, endMs: referenceTime + 4 * MILLISECONDS_PER_DAY },
    { id: "duplicate-b", startMs: referenceTime, endMs: referenceTime },
    {
      id: "middle",
      startMs: referenceTime + 2 * MILLISECONDS_PER_DAY,
      endMs: referenceTime + 2 * MILLISECONDS_PER_DAY,
    },
    { id: "duplicate-a", startMs: referenceTime, endMs: referenceTime },
  ];
  const unorderedPlan = planSparseWindows(duplicateAndUnordered, 0, 0);
  assert.equal(unorderedPlan.baseUnionWindows.length, 3);
  validatePlan(duplicateAndUnordered, 0, unorderedPlan);

  const exactGapVisits = [
    { id: "gap-end", startMs: referenceTime + MILLISECONDS_PER_DAY, endMs: referenceTime + MILLISECONDS_PER_DAY },
    { id: "gap-start", startMs: referenceTime, endMs: referenceTime },
  ];
  assert.equal(planSparseWindows(exactGapVisits, 0, MILLISECONDS_PER_DAY - 1).baseUnionWindows.length, 2);
  assert.deepEqual(planSparseWindows(exactGapVisits, 0, MILLISECONDS_PER_DAY).baseUnionWindows, [
    { startMs: referenceTime, endMs: referenceTime + MILLISECONDS_PER_DAY },
  ]);

  const exactMaximum = splitWindowsAtMaximumDuration(
    [{ startMs: referenceTime, endMs: referenceTime + MAXIMUM_QUERY_WINDOW_MILLISECONDS }],
    MAXIMUM_QUERY_WINDOW_MILLISECONDS,
  );
  assert.equal(exactMaximum.length, 1);
  const overMaximum = splitWindowsAtMaximumDuration(
    [{ startMs: referenceTime, endMs: referenceTime + MAXIMUM_QUERY_WINDOW_MILLISECONDS + 1 }],
    MAXIMUM_QUERY_WINDOW_MILLISECONDS,
  );
  assert.equal(overMaximum.length, 2);
  assert.equal(overMaximum[0].endMs, overMaximum[1].startMs);
  assertWindowStructure(overMaximum);

  const longVisit = [
    {
      id: "long",
      startMs: referenceTime,
      endMs: referenceTime + MAXIMUM_QUERY_WINDOW_MILLISECONDS + MILLISECONDS_PER_DAY,
    },
  ];
  const longPlan = planSparseWindows(longVisit, 0, 0);
  assert.equal(longPlan.queryWindows.length, 2);
  validatePlan(longVisit, 0, longPlan);

  assert.throws(
    () => bufferedVisitWindows([{ id: "inverted", startMs: referenceTime + 1, endMs: referenceTime }], 0),
    /ends before it starts/,
  );

  return fixtureNames;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createSyntheticVisits(): VisitInterval[] {
  const random = createRandom(SYNTHETIC_SEED);
  const activeDaySet = new Set<number>([0, SYNTHETIC_SPAN_DAYS]);
  while (activeDaySet.size < SYNTHETIC_ACTIVE_DAY_COUNT) {
    activeDaySet.add(Math.floor(random() * (SYNTHETIC_SPAN_DAYS + 1)));
  }
  const activeDays = [...activeDaySet].sort((left, right) => left - right);

  const visits = Array.from({ length: SYNTHETIC_VISIT_COUNT }, (_, index): VisitInterval => {
    const activeDay = activeDays[index % activeDays.length];
    const cycle = Math.floor(index / activeDays.length);
    const minuteWithinDay = 6 * 60 + ((index * 137 + cycle * 43) % (16 * 60));
    const startMs =
      SYNTHETIC_START_MILLISECONDS + activeDay * MILLISECONDS_PER_DAY + minuteWithinDay * MILLISECONDS_PER_MINUTE;
    const durationMinutes = index % 997 === 0 ? 0 : 30 + ((index * 53 + cycle * 17) % 151);
    return {
      id: `synthetic-${index.toString().padStart(6, "0")}`,
      startMs,
      endMs: startMs + durationMinutes * MILLISECONDS_PER_MINUTE,
    };
  });

  // Deliberately seed SQLite in deterministic non-chronological order so the
  // planner, rather than fixture insertion order, guarantees sorted output.
  for (let index = visits.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [visits[index], visits[swapIndex]] = [visits[swapIndex], visits[index]];
  }
  return visits;
}

function seedSyntheticDatabase(database: DatabaseSync): void {
  const visits = createSyntheticVisits();
  database.exec(`
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL
    );
    BEGIN IMMEDIATE;
  `);
  const insert = database.prepare("INSERT INTO visits (id, startTime, endTime) VALUES (?, ?, ?)");
  try {
    for (const visit of visits) {
      insert.run(visit.id, visit.startMs, visit.endMs);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function parseSQLiteVisitRow(row: SQLiteVisitRow, index: number): VisitInterval {
  if (typeof row.id !== "string") {
    throw new TypeError(`Visit row ${index} has a non-string ID.`);
  }
  if (typeof row.startTime !== "number" || typeof row.endTime !== "number") {
    throw new TypeError(`Visit ${row.id} has non-numeric timestamps.`);
  }
  const visit = { id: row.id, startMs: row.startTime, endMs: row.endTime };
  validateVisit(visit);
  return visit;
}

function loadVisits(database: DatabaseSync): VisitInterval[] {
  const table = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'visits'").get() as
    | { name?: unknown }
    | undefined;
  if (table?.name !== "visits") {
    throw new Error("SQLite database does not contain a visits table.");
  }

  const rows = database
    .prepare("SELECT id, startTime, endTime FROM visits ORDER BY id DESC")
    .all() as unknown as SQLiteVisitRow[];
  return rows.map(parseSQLiteVisitRow);
}

function loadDataset(configuration: Configuration): {
  readonly source: DatasetSummary["source"];
  readonly databasePath: string | null;
  readonly visits: readonly VisitInterval[];
} {
  if (configuration.databasePath !== null) {
    if (!existsSync(configuration.databasePath) || !statSync(configuration.databasePath).isFile()) {
      throw new Error(`Database path is not a file: ${configuration.databasePath}`);
    }
    const database = new DatabaseSync(configuration.databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON;");
      const visits = loadVisits(database);
      return { source: "database", databasePath: configuration.databasePath, visits };
    } finally {
      database.close();
    }
  }

  const database = new DatabaseSync(":memory:");
  try {
    seedSyntheticDatabase(database);
    const visits = loadVisits(database);
    assert.equal(visits.length, SYNTHETIC_VISIT_COUNT);
    return { source: "synthetic", databasePath: null, visits };
  } finally {
    database.close();
  }
}

function summarizeDataset(
  source: DatasetSummary["source"],
  databasePath: string | null,
  visits: readonly VisitInterval[],
): DatasetSummary {
  if (visits.length === 0) {
    throw new Error("Calendar query-window profiling requires at least one visit.");
  }
  const minimumVisitStartMs = Math.min(...visits.map((visit) => visit.startMs));
  const maximumVisitEndMs = Math.max(...visits.map((visit) => visit.endMs));
  const buffered = bufferedVisitWindows(visits, VISIT_BUFFER_MILLISECONDS);
  const minimumBufferedStartMs = Math.min(...buffered.map((window) => window.startMs));
  const maximumBufferedEndMs = Math.max(...buffered.map((window) => window.endMs));

  return {
    source,
    databasePath,
    visitSelection: source === "database" ? "all-database-visits-full-rescan" : "all-synthetic-visits",
    visitCount: visits.length,
    distinctVisitIdCount: new Set(visits.map((visit) => visit.id)).size,
    zeroDurationVisitCount: visits.filter((visit) => visit.startMs === visit.endMs).length,
    minimumVisitStartMs,
    maximumVisitEndMs,
    rawVisitSpanDays: rounded((maximumVisitEndMs - minimumVisitStartMs) / MILLISECONDS_PER_DAY),
    bufferedSearchSpanDays: rounded((maximumBufferedEndMs - minimumBufferedStartMs) / MILLISECONDS_PER_DAY),
  };
}

function buildReport(configuration: Configuration): ProfileReport {
  const passedCorrectnessFixtures = runCorrectnessFixtures();
  const dataset = loadDataset(configuration);
  const datasetSummary = summarizeDataset(dataset.source, dataset.databasePath, dataset.visits);
  const broadPlan = planBroadWindows(dataset.visits, VISIT_BUFFER_MILLISECONDS);
  const broadCoveredMilliseconds = totalCoveredMilliseconds(broadPlan.queryWindows);
  const broad = summarizePlan("broad", null, dataset.visits, broadPlan, broadCoveredMilliseconds);
  const sparse = SPARSE_GAP_SWEEP_DAYS.map((gapDays) => {
    const plan = planSparseWindows(dataset.visits, VISIT_BUFFER_MILLISECONDS, gapDays * MILLISECONDS_PER_DAY);
    return summarizePlan("sparse", gapDays, dataset.visits, plan, broadCoveredMilliseconds);
  });

  return {
    schemaVersion: 1,
    benchmark: "calendar-query-window-plan",
    scope: {
      kind: "structural-query-plan-analysis",
      eventKitInvoked: false,
      eventKitLatencyIncluded: false,
      note: "Counts and coverage describe query-window structure only; EventKit latency and event materialization are intentionally excluded.",
      coverageSemantics: {
        fixedDayMilliseconds: MILLISECONDS_PER_DAY,
        coveredDays:
          "Sum of non-overlapping EventKit query-predicate durations in fixed 24-hour days, including gaps admitted by sparse coalescing.",
        coveredPercentageOfBroad:
          "Covered query-predicate duration divided by the buffered minimum-start to maximum-end broad query duration.",
      },
    },
    configuration: {
      visitBufferMinutes: VISIT_BUFFER_MINUTES,
      maximumQueryWindowDays: MAXIMUM_QUERY_WINDOW_DAYS,
      sparseGapSweepDays: SPARSE_GAP_SWEEP_DAYS,
      syntheticFixture:
        dataset.source === "synthetic"
          ? {
              visitCount: SYNTHETIC_VISIT_COUNT,
              spanDays: SYNTHETIC_SPAN_DAYS,
              activeDayCount: SYNTHETIC_ACTIVE_DAY_COUNT,
              seed: SYNTHETIC_SEED,
            }
          : null,
    },
    correctness: {
      allPassed: true,
      passedFixtureCount: passedCorrectnessFixtures.length,
      passedFixtures: passedCorrectnessFixtures,
    },
    dataset: datasetSummary,
    broad,
    sparse,
  };
}

function printSummary(report: ProfileReport, outputPath: string): void {
  console.log(
    `Calendar query-window structural profile (${report.dataset.source}, ${report.dataset.visitSelection}): ${report.dataset.visitCount.toLocaleString("en-US")} visits over ${report.dataset.rawVisitSpanDays.toFixed(3)} days`,
  );
  console.log("strategy\tgapDays\tqueries\tbaseUnions\tquerySpanDays\tpercentOfBroad\tmaxWindowDays");
  for (const plan of [report.broad, ...report.sparse]) {
    console.log(
      [
        plan.strategy,
        plan.gapDays ?? "-",
        plan.queryCount,
        plan.baseUnionWindowCount,
        plan.coveredDays.toFixed(6),
        plan.coveredPercentageOfBroad.toFixed(6),
        plan.maximumWindowDurationDays.toFixed(6),
      ].join("\t"),
    );
  }
  console.log("Structural analysis only: EventKit was not invoked and EventKit latency is excluded.");
  console.log(`Wrote ${outputPath}`);
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
    return;
  }

  const report = buildReport(configuration);
  const outputPath = resolve(configuration.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report, outputPath);
}

main();
