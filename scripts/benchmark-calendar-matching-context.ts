#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  buildCalendarEnrichmentVisitSnapshot,
  CALENDAR_ENRICHMENT_SNAPSHOT_SQL,
  type CalendarEnrichmentSnapshotRow,
} from "../utils/db/calendar-enrichment-snapshot-core.ts";

type Strategy = "legacyBatchedFullRows" | "singleQuerySkinnySnapshot" | "singleQueryGroupedJson";

interface Configuration {
  readonly batchSize: number;
  readonly databasePath: string;
  readonly outputPath: string;
  readonly samples: number;
  readonly warmupIterations: number;
}

interface VisitRow {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
}

interface FullSuggestionRow {
  readonly visitId: string;
  readonly id: string;
  readonly name: string;
  readonly distance: number;
  readonly [column: string]: unknown;
}

interface SkinnySuggestion {
  readonly id: string;
  readonly name: string;
}

interface GroupedJsonRow extends VisitRow {
  readonly suggestedRestaurantsJson: string;
}

interface CalendarMatchingVisit extends VisitRow {
  readonly suggestedRestaurants: readonly SkinnySuggestion[];
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly nativeToJsPayloadBytes: number;
  readonly rawRowCount: number;
  readonly result: readonly CalendarMatchingVisit[];
  readonly sqliteCalls: number;
}

interface MeasurementSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly size: number | null;
}

interface SequenceSnapshot {
  readonly rowCount: number;
  readonly sha256: string;
}

const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_OUTPUT = ".build/calendar-matching-context-profile.json";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

const VISITS_WITHOUT_CALENDAR_SQL = `SELECT id, startTime, endTime
FROM visits
WHERE calendarEventId IS NULL
ORDER BY startTime DESC`;

const GROUPED_JSON_CALENDAR_MATCHING_CONTEXT_SQL = `SELECT
  v.id,
  v.startTime,
  v.endTime,
  COALESCE(
    json_group_array(
      json_object('id', m.id, 'name', m.name)
      ORDER BY vsr.distance ASC, vsr.rowid ASC
    ) FILTER (WHERE m.id IS NOT NULL),
    json('[]')
  ) AS suggestedRestaurantsJson
FROM visits v
LEFT JOIN visit_suggested_restaurants vsr ON vsr.visitId = v.id
LEFT JOIN michelin_restaurants m ON m.id = vsr.restaurantId
WHERE v.calendarEventId IS NULL
GROUP BY v.id
ORDER BY v.startTime DESC, v.rowid ASC`;

function usage(): string {
  return `Usage: benchmark-calendar-matching-context.ts --database=PATH [options]

  --database=PATH   Palate database opened mode=ro and immutable (required)
  --batch-size=N    Legacy suggestion hydration batch size (default: ${DEFAULT_BATCH_SIZE})
  --samples=N       Counterbalanced measured pairs (default: 11)
  --warmup=N        Counterbalanced warmup pairs (default: 3)
  --output=PATH     Aggregate-only JSON report (default: ${DEFAULT_OUTPUT})
  --help, -h        Show this help

The legacy model reproduces Calendar enrichment's visit preload followed by
300-ID getSuggestedRestaurantsForVisits() calls, including complete Michelin
rows that native matching subsequently narrows to id/name. The candidates are
the production single joined skinny snapshot grouped in JS and a third one-row-
per-visit SQLite JSON aggregation parsed in JS.

The report contains only counts, timings, byte sizes, and semantic digests. It
never retains visit IDs, restaurant IDs/names, or other private database rows.`;
}

function positiveInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let batchSize = DEFAULT_BATCH_SIZE;
  let databasePath: string | null = null;
  let outputPath = DEFAULT_OUTPUT;
  let samples = 11;
  let warmupIterations = 3;

  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 0) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!value) {
      throw new RangeError(`${option} cannot be empty`);
    }
    switch (option) {
      case "--database":
        databasePath = resolve(value);
        break;
      case "--batch-size":
        batchSize = positiveInteger(value, option);
        break;
      case "--samples":
        samples = positiveInteger(value, option);
        break;
      case "--warmup":
        warmupIterations = positiveInteger(value, option, true);
        break;
      case "--output":
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (databasePath === null) {
    throw new Error("--database=PATH is required for immutable real-database profiling");
  }
  return { batchSize, databasePath, outputPath, samples, warmupIterations };
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, sha256: null, size: null };
  }
  const metadata = statSync(path);
  return { exists: true, sha256: sha256File(path), size: metadata.size };
}

function snapshotSource(databasePath: string): Record<string, FileSnapshot> {
  return Object.fromEntries([
    ["main", snapshotFile(databasePath)],
    ...SIDECAR_SUFFIXES.map((suffix) => [suffix.slice(1), snapshotFile(`${databasePath}${suffix}`)] as const),
  ]);
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Output path contains a symbolic-link cycle at ${ancestor}`);
        }
        seenSymlinks.add(ancestor);
        return resolve(
          canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), seenSymlinks),
          ...missing,
        );
      }
      return resolve(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function sourcePathVariants(databasePath: string): string[] {
  return [...new Set([resolve(databasePath), realpathSync(databasePath)])];
}

function protectedSourcePaths(databasePath: string): string[] {
  return sourcePathVariants(databasePath).flatMap((base) => [
    base,
    ...SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const outputCanonical = canonicalizePotentialPath(resolvedOutput);
  const outputIdentity = existsSync(resolvedOutput) ? statSync(resolvedOutput) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    if (outputIdentity !== null && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not be a hard link to the source database or a SQLite sidecar");
      }
    }
  }
}

function assertSourceCanBeOpenedImmutable(databasePath: string): void {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${databasePath}`);
  }
  for (const base of sourcePathVariants(databasePath)) {
    for (const suffix of ["-wal", "-journal"] as const) {
      const sidecarPath = `${base}${suffix}`;
      if (existsSync(sidecarPath) && statSync(sidecarPath).size > 0) {
        throw new Error(`Source database has a non-empty ${suffix.slice(1)} sidecar: ${sidecarPath}`);
      }
    }
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(resolve(databasePath));
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number") {
    throw new TypeError("SQLite total_changes() did not return a number");
  }
  return row.count;
}

function snapshotSqliteSequence(database: DatabaseSync): SequenceSnapshot {
  const present = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get() as { present?: unknown } | undefined;
  const rows =
    present?.present === 1 ? database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() : [];
  return { rowCount: rows.length, sha256: sha256Bytes(JSON.stringify(rows)) };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function executeLegacy(database: DatabaseSync, batchSize: number): Measurement {
  const startedAt = performance.now();
  const visitRows = database.prepare(VISITS_WITHOUT_CALENDAR_SQL).all() as unknown as VisitRow[];
  const rawPayloads: unknown[] = [visitRows];
  let rawRowCount = visitRows.length;
  let sqliteCalls = 1;
  const suggestionsByVisit = new Map<string, SkinnySuggestion[]>();

  for (let offset = 0; offset < visitRows.length; offset += batchSize) {
    const visitIds = visitRows.slice(offset, offset + batchSize).map((visit) => visit.id);
    const placeholders = visitIds.map(() => "?").join(", ");
    const suggestionRows = database
      .prepare(
        `SELECT m.*, vsr.distance, vsr.visitId
         FROM visit_suggested_restaurants vsr
         JOIN michelin_restaurants m ON vsr.restaurantId = m.id
         WHERE vsr.visitId IN (${placeholders})
         ORDER BY vsr.visitId, vsr.distance ASC`,
      )
      .all(...visitIds) as unknown as FullSuggestionRow[];
    sqliteCalls++;
    rawPayloads.push(suggestionRows);
    rawRowCount += suggestionRows.length;

    for (const row of suggestionRows) {
      const suggestions = suggestionsByVisit.get(row.visitId) ?? [];
      suggestions.push({ id: row.id, name: row.name });
      suggestionsByVisit.set(row.visitId, suggestions);
    }
  }

  const result = visitRows.map((visit) => ({
    ...visit,
    suggestedRestaurants: suggestionsByVisit.get(visit.id) ?? [],
  }));
  const elapsedMilliseconds = performance.now() - startedAt;
  return {
    elapsedMilliseconds,
    nativeToJsPayloadBytes: rawPayloads.reduce<number>((total, payload) => total + serializedBytes(payload), 0),
    rawRowCount,
    result,
    sqliteCalls,
  };
}

function executeJoinedCandidate(database: DatabaseSync): Measurement {
  const startedAt = performance.now();
  const rows = database.prepare(CALENDAR_ENRICHMENT_SNAPSHOT_SQL).all() as unknown as CalendarEnrichmentSnapshotRow[];
  const result = buildCalendarEnrichmentVisitSnapshot(rows);
  const elapsedMilliseconds = performance.now() - startedAt;
  return {
    elapsedMilliseconds,
    nativeToJsPayloadBytes: serializedBytes(rows),
    rawRowCount: rows.length,
    result,
    sqliteCalls: 1,
  };
}

function executeGroupedJsonCandidate(database: DatabaseSync): Measurement {
  const startedAt = performance.now();
  const rows = database.prepare(GROUPED_JSON_CALENDAR_MATCHING_CONTEXT_SQL).all() as unknown as GroupedJsonRow[];
  const result = rows.map((row) => {
    const suggestedRestaurants = JSON.parse(row.suggestedRestaurantsJson) as unknown;
    if (!Array.isArray(suggestedRestaurants)) {
      throw new TypeError("Grouped Calendar suggestions must decode to an array");
    }
    return {
      id: row.id,
      startTime: row.startTime,
      endTime: row.endTime,
      suggestedRestaurants: suggestedRestaurants as SkinnySuggestion[],
    };
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  return {
    elapsedMilliseconds,
    nativeToJsPayloadBytes: serializedBytes(rows),
    rawRowCount: rows.length,
    result,
    sqliteCalls: 1,
  };
}

function executeStrategy(database: DatabaseSync, strategy: Strategy, batchSize: number): Measurement {
  switch (strategy) {
    case "legacyBatchedFullRows":
      return executeLegacy(database, batchSize);
    case "singleQuerySkinnySnapshot":
      return executeJoinedCandidate(database);
    case "singleQueryGroupedJson":
      return executeGroupedJsonCandidate(database);
  }
}

function summarize(samples: readonly number[]): MeasurementSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function run(configuration: Configuration): void {
  assertSourceCanBeOpenedImmutable(configuration.databasePath);
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  const sourceBefore = snapshotSource(configuration.databasePath);
  const database = new DatabaseSync(immutableDatabaseUri(configuration.databasePath), { readOnly: true });
  let report: Record<string, unknown>;
  let totalChangesBefore = 0;
  let totalChangesAfter = 0;
  let sequenceBefore: SequenceSnapshot = { rowCount: 0, sha256: "" };
  let sequenceAfter: SequenceSnapshot = { rowCount: 0, sha256: "" };

  try {
    database.exec("PRAGMA query_only = ON");
    totalChangesBefore = totalChanges(database);
    sequenceBefore = snapshotSqliteSequence(database);
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    assert.equal(integrity?.integrity_check, "ok", "source integrity_check must pass");

    const oracle = executeLegacy(database, configuration.batchSize);
    const joinedCandidate = executeJoinedCandidate(database);
    const groupedJsonCandidate = executeGroupedJsonCandidate(database);
    assert.deepEqual(
      joinedCandidate.result,
      oracle.result,
      "joined skinny context must exactly match the legacy native input",
    );
    assert.deepEqual(
      groupedJsonCandidate.result,
      oracle.result,
      "grouped JSON context must exactly match the legacy native input",
    );
    assert.equal(joinedCandidate.sqliteCalls, 1);
    assert.equal(groupedJsonCandidate.sqliteCalls, 1);
    assert.equal(oracle.sqliteCalls, 1 + Math.ceil(oracle.result.length / configuration.batchSize));
    assert.ok(
      joinedCandidate.nativeToJsPayloadBytes < oracle.nativeToJsPayloadBytes,
      "joined skinny context must reduce the serialized native-to-JS payload proxy",
    );
    assert.ok(
      groupedJsonCandidate.nativeToJsPayloadBytes < joinedCandidate.nativeToJsPayloadBytes,
      "grouped JSON must reduce payload relative to repeated joined visit fields",
    );
    assert.ok(
      groupedJsonCandidate.rawRowCount < joinedCandidate.rawRowCount,
      "grouped JSON must return fewer native rows than the repeated joined shape",
    );

    const payloadBytes: Record<Strategy, number> = {
      legacyBatchedFullRows: oracle.nativeToJsPayloadBytes,
      singleQuerySkinnySnapshot: joinedCandidate.nativeToJsPayloadBytes,
      singleQueryGroupedJson: groupedJsonCandidate.nativeToJsPayloadBytes,
    };
    const timings: Record<Strategy, number[]> = {
      legacyBatchedFullRows: [],
      singleQuerySkinnySnapshot: [],
      singleQueryGroupedJson: [],
    };
    const counterbalancedOrders: readonly (readonly Strategy[])[] = [
      ["legacyBatchedFullRows", "singleQuerySkinnySnapshot", "singleQueryGroupedJson"],
      ["singleQuerySkinnySnapshot", "singleQueryGroupedJson", "legacyBatchedFullRows"],
      ["singleQueryGroupedJson", "legacyBatchedFullRows", "singleQuerySkinnySnapshot"],
      ["singleQueryGroupedJson", "singleQuerySkinnySnapshot", "legacyBatchedFullRows"],
      ["singleQuerySkinnySnapshot", "legacyBatchedFullRows", "singleQueryGroupedJson"],
      ["legacyBatchedFullRows", "singleQueryGroupedJson", "singleQuerySkinnySnapshot"],
    ];
    const measuredIterations = configuration.warmupIterations + configuration.samples;
    for (let iteration = 0; iteration < measuredIterations; iteration++) {
      const order = counterbalancedOrders[iteration % counterbalancedOrders.length]!;
      for (const strategy of order) {
        const measurement = executeStrategy(database, strategy, configuration.batchSize);
        assert.deepEqual(measurement.result, oracle.result, `${strategy} result drifted during profiling`);
        assert.equal(measurement.nativeToJsPayloadBytes, payloadBytes[strategy]);
        if (iteration >= configuration.warmupIterations) {
          timings[strategy].push(measurement.elapsedMilliseconds);
        }
      }
    }

    const legacySummary = summarize(timings.legacyBatchedFullRows);
    const joinedSummary = summarize(timings.singleQuerySkinnySnapshot);
    const groupedJsonSummary = summarize(timings.singleQueryGroupedJson);
    const suggestionCount = oracle.result.reduce((count, visit) => count + visit.suggestedRestaurants.length, 0);
    const visitsWithSuggestions = oracle.result.filter((visit) => visit.suggestedRestaurants.length > 0).length;
    const semanticSha256 = sha256Bytes(JSON.stringify(oracle.result));

    report = {
      schemaVersion: 2,
      status: "ok",
      generatedAt: new Date().toISOString(),
      configuration: {
        batchSize: configuration.batchSize,
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
      },
      measurementModel: {
        runtime: "Node.js node:sqlite plus JavaScript result shaping",
        scope: "isolated Calendar native-matching database context preload model",
        includes: [
          "SQLite statement preparation, execution, and row decoding",
          "legacy batch construction and Map grouping",
          "production candidate joined-row grouping and validation",
          "grouped candidate ordered SQLite JSON aggregation and per-visit JSON.parse",
        ],
        excludes: [
          "Expo connection acquisition and JSI/native bridge serialization",
          "EventKit reads and Calendar matching",
          "Calendar persistence and UI work",
          "serialized-payload proxy calculation",
        ],
        serializedPayloadDefinition:
          "UTF-8 bytes of JSON.stringify(raw rows) per SQLite call; a stable proxy, not measured Expo bridge bytes",
      },
      source: {
        databaseBytes: statSync(configuration.databasePath).size,
        databaseSha256: sha256File(configuration.databasePath),
        integrityCheck: "ok",
      },
      workload: {
        visitCount: oracle.result.length,
        visitsWithSuggestions,
        suggestionCount,
        semanticSha256,
      },
      correctness: {
        exactNativeInputParity: true,
        comparedFields: ["visit id", "visit start/end time", "ordered suggestion id/name arrays"],
        comparisonMethod: "assert.deepEqual over every shaped visit and ordered suggestion",
      },
      strategies: {
        legacyBatchedFullRows: {
          sqliteCalls: oracle.sqliteCalls,
          rawRowsReturned: oracle.rawRowCount,
          serializedPayloadBytes: payloadBytes.legacyBatchedFullRows,
          queryShape: "one skinny visits query plus batched SELECT m.* suggestion hydration",
          nodeModelTiming: legacySummary,
        },
        singleQuerySkinnySnapshot: {
          sqliteCalls: joinedCandidate.sqliteCalls,
          rawRowsReturned: joinedCandidate.rawRowCount,
          serializedPayloadBytes: payloadBytes.singleQuerySkinnySnapshot,
          queryShape: "one ordered joined query with nullable suggestion id/name fields",
          nodeModelTiming: joinedSummary,
        },
        singleQueryGroupedJson: {
          sqliteCalls: groupedJsonCandidate.sqliteCalls,
          rawRowsReturned: groupedJsonCandidate.rawRowCount,
          serializedPayloadBytes: payloadBytes.singleQueryGroupedJson,
          queryShape: "one row per visit with an ordered suggestion id/name JSON array",
          nodeModelTiming: groupedJsonSummary,
        },
      },
      comparison: {
        joinedVsLegacy: {
          sqliteCallsSaved: oracle.sqliteCalls - joinedCandidate.sqliteCalls,
          sqliteCallReductionPercent: ((oracle.sqliteCalls - joinedCandidate.sqliteCalls) / oracle.sqliteCalls) * 100,
          serializedPayloadBytesSaved: payloadBytes.legacyBatchedFullRows - payloadBytes.singleQuerySkinnySnapshot,
          serializedPayloadReductionPercent:
            ((payloadBytes.legacyBatchedFullRows - payloadBytes.singleQuerySkinnySnapshot) /
              payloadBytes.legacyBatchedFullRows) *
            100,
          nodeModelMedianMillisecondsSaved: legacySummary.medianMilliseconds - joinedSummary.medianMilliseconds,
          nodeModelMedianSpeedup: legacySummary.medianMilliseconds / joinedSummary.medianMilliseconds,
        },
        groupedJsonVsLegacy: {
          sqliteCallsSaved: oracle.sqliteCalls - groupedJsonCandidate.sqliteCalls,
          sqliteCallReductionPercent:
            ((oracle.sqliteCalls - groupedJsonCandidate.sqliteCalls) / oracle.sqliteCalls) * 100,
          serializedPayloadBytesSaved: payloadBytes.legacyBatchedFullRows - payloadBytes.singleQueryGroupedJson,
          serializedPayloadReductionPercent:
            ((payloadBytes.legacyBatchedFullRows - payloadBytes.singleQueryGroupedJson) /
              payloadBytes.legacyBatchedFullRows) *
            100,
          nodeModelMedianMillisecondsSaved: legacySummary.medianMilliseconds - groupedJsonSummary.medianMilliseconds,
          nodeModelMedianSpeedup: legacySummary.medianMilliseconds / groupedJsonSummary.medianMilliseconds,
        },
        groupedJsonVsJoined: {
          sqliteCallDifference: groupedJsonCandidate.sqliteCalls - joinedCandidate.sqliteCalls,
          rawRowsSaved: joinedCandidate.rawRowCount - groupedJsonCandidate.rawRowCount,
          rawRowReductionPercent:
            ((joinedCandidate.rawRowCount - groupedJsonCandidate.rawRowCount) / joinedCandidate.rawRowCount) * 100,
          serializedPayloadBytesSaved: payloadBytes.singleQuerySkinnySnapshot - payloadBytes.singleQueryGroupedJson,
          serializedPayloadReductionPercent:
            ((payloadBytes.singleQuerySkinnySnapshot - payloadBytes.singleQueryGroupedJson) /
              payloadBytes.singleQuerySkinnySnapshot) *
            100,
          nodeModelMedianMillisecondsDifference:
            groupedJsonSummary.medianMilliseconds - joinedSummary.medianMilliseconds,
          nodeModelMedianRatio: groupedJsonSummary.medianMilliseconds / joinedSummary.medianMilliseconds,
        },
      },
      privacy: {
        aggregateOnly: true,
        rawVisitFieldsRetainedInReport: false,
        rawRestaurantFieldsRetainedInReport: false,
        calendarLibraryAccessed: false,
      },
    };

    totalChangesAfter = totalChanges(database);
    sequenceAfter = snapshotSqliteSequence(database);
    assert.equal(totalChangesAfter, totalChangesBefore, "read-only benchmark must not increment total_changes()");
    assert.deepEqual(sequenceAfter, sequenceBefore, "read-only benchmark must not change sqlite_sequence");
  } finally {
    database.close();
  }

  const sourceAfter = snapshotSource(configuration.databasePath);
  assert.deepEqual(sourceAfter, sourceBefore, "immutable benchmark must not alter the source or any SQLite sidecar");
  report.sourceAttestation = { before: sourceBefore, after: sourceAfter, byteIdentical: true };
  report.writeInvariants = {
    totalChangesBefore,
    totalChangesAfter,
    totalChangesUnchanged: totalChangesAfter === totalChangesBefore,
    sqliteSequenceBefore: sequenceBefore,
    sqliteSequenceAfter: sequenceAfter,
    sqliteSequenceUnchanged: sequenceBefore.sha256 === sequenceAfter.sha256,
    mainAndSidecarsByteIdentical: true,
    databaseOpenMode: "mode=ro, immutable=1, PRAGMA query_only=ON",
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, serialized);
  console.log(serialized.trimEnd());
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
} else {
  run(configuration);
}
