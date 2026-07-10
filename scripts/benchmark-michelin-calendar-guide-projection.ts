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
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL,
  ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL,
  parseMichelinCalendarHydrationRows,
  selectMichelinCalendarHydrationIds,
  type MichelinCalendarHydrationRow,
  type MichelinCalendarNameRow,
} from "../utils/db/michelin-calendar-match-core.ts";
import type { MichelinRestaurantRecord } from "../utils/db/types.ts";

type Strategy = "legacyFullGuide" | "twoStageProjection";

interface Configuration {
  readonly databasePath: string;
  readonly matchedRowTarget: number;
  readonly outputPath: string;
  readonly samples: number;
  readonly warmupIterations: number;
}

interface LegacyRow extends MichelinRestaurantRecord {
  readonly datasetVersion: string | null;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly nativeToJsPayloadBytes: number;
  readonly sqliteCalls: number;
  readonly result: MichelinRestaurantRecord[];
}

interface Summary {
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

const DATASET_KEY = "michelin_dataset_version";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const DEFAULT_OUTPUT = ".build/michelin-calendar-guide-profile.json";

function usage(): string {
  return `Usage: benchmark-michelin-calendar-guide-projection.ts --database=PATH [options]

  --database=PATH    Palate database opened mode=ro and immutable (required)
  --matched-rows=N   Deterministically request at least N real guide rows (default: 100)
  --samples=N        Counterbalanced measured pairs (default: 11)
  --warmup=N         Counterbalanced warmup pairs (default: 3)
  --output=PATH      Aggregate-only JSON report (default: ${DEFAULT_OUTPUT})
  --help, -h         Show this help

Timed regions are a Node node:sqlite/JavaScript model: they include the read
transaction, SQLite preparation/execution and row decoding, benchmark-only
name normalization, ID selection, hydration, and result shaping. They exclude
Expo's dedicated connection creation/closure, the real memoized production
normalizer, React Native scheduling/JSI behavior, source discovery, and checks. The
report contains counts, timings, byte sizes, and digests only; it never retains
restaurant IDs, names, coordinates, addresses, or Calendar data.`;
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
  let databasePath: string | null = null;
  let matchedRowTarget = 100;
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
      case "--matched-rows":
        matchedRowTarget = positiveInteger(value, option);
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
    throw new Error("--database=PATH is required for immutable real-guide profiling");
  }
  return { databasePath, matchedRowTarget, outputPath, samples, warmupIterations };
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
      throw new Error("Benchmark output must not alias the source database or one of its SQLite sidecars");
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

function installedExpoTransactionAttestation(): Record<string, unknown> {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const sourcePath = join(repositoryRoot, "node_modules/expo-sqlite/src/SQLiteDatabase.ts");
  const packagePath = join(repositoryRoot, "node_modules/expo-sqlite/package.json");
  const source = readFileSync(sourcePath, "utf8");
  const start = source.indexOf("public async withExclusiveTransactionAsync(");
  const end = source.indexOf("public isInTransactionSync()", start);
  if (start < 0 || end <= start) {
    throw new Error("Could not locate installed Expo dedicated transaction implementation");
  }
  const implementation = source.slice(start, end);
  assert.match(implementation, /Transaction\.createAsync\(this\)/);
  assert.match(implementation, /transaction\.execAsync\('BEGIN'\)/);
  assert.match(implementation, /transaction\.closeAsync\(\)/);
  assert.doesNotMatch(implementation, /BEGIN (?:IMMEDIATE|EXCLUSIVE)/);
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  return {
    packageVersion: typeof packageMetadata.version === "string" ? packageMetadata.version : null,
    implementationSha256: sha256Bytes(implementation),
    createsDedicatedTransactionConnection: true,
    executesLiteralDeferredBegin: true,
    closesDedicatedTransactionConnection: true,
  };
}

// This aggregate benchmark intentionally keeps normalization local so importing
// React Native Calendar modules is unnecessary. It exercises the same costly
// Unicode/string-work shape; production callback wiring is covered by the
// static integration assertion in the isolated correctness test.
function normalizeBenchmarkName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/[’'`´ʼʻ]/g, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^a-z0-9_\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickDeclaredColumns(row: LegacyRow): MichelinRestaurantRecord {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    location: row.location,
    cuisine: row.cuisine,
    latestAwardYear: row.latestAwardYear,
    award: row.award,
  };
}

function selectRequestedNames(rows: readonly MichelinCalendarNameRow[], targetRows: number): Set<string> {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const normalized = normalizeBenchmarkName(row.name);
    if (normalized) {
      groups.set(normalized, (groups.get(normalized) ?? 0) + 1);
    }
  }
  const requested = new Set<string>();
  let selectedRows = 0;
  for (const [normalized, count] of groups) {
    requested.add(normalized);
    selectedRows += count;
    if (selectedRows >= targetRows) {
      break;
    }
  }
  if (requested.size === 0) {
    throw new Error("The source database has no non-empty Michelin restaurant names");
  }
  return requested;
}

function executeLegacy(database: DatabaseSync, requestedNames: ReadonlySet<string>): Measurement {
  const startedAt = performance.now();
  database.exec("BEGIN");
  try {
    const transferredRows = database
      .prepare(
        `SELECT m.*
         FROM michelin_restaurants m
         WHERE NOT EXISTS (
           SELECT 1 FROM app_metadata WHERE key = ?
         ) OR m.datasetVersion = (
           SELECT value FROM app_metadata WHERE key = ?
         )`,
      )
      .all(DATASET_KEY, DATASET_KEY) as unknown as LegacyRow[];
    const result = transferredRows
      .filter((row) => requestedNames.has(normalizeBenchmarkName(row.name)))
      .map(pickDeclaredColumns);
    database.exec("COMMIT");
    const elapsedMilliseconds = performance.now() - startedAt;
    const nativeToJsPayloadBytes = Buffer.byteLength(JSON.stringify(transferredRows));
    return {
      elapsedMilliseconds,
      nativeToJsPayloadBytes,
      sqliteCalls: 1,
      result,
    };
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function executeCandidate(database: DatabaseSync, requestedNames: ReadonlySet<string>): Measurement {
  const startedAt = performance.now();
  database.exec("BEGIN");
  try {
    const nameRows = database
      .prepare(ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL)
      .all(DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarNameRow[];
    const hydrationIds = selectMichelinCalendarHydrationIds(nameRows, requestedNames, normalizeBenchmarkName);
    const hydratedRows = database
      .prepare(ACTIVE_MICHELIN_CALENDAR_HYDRATION_SQL)
      .all(JSON.stringify(hydrationIds), DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarHydrationRow[];
    assert.equal(hydratedRows.length, hydrationIds.length);
    const result = parseMichelinCalendarHydrationRows(hydratedRows);
    database.exec("COMMIT");
    const elapsedMilliseconds = performance.now() - startedAt;
    const nativeToJsPayloadBytes =
      Buffer.byteLength(JSON.stringify(nameRows)) + Buffer.byteLength(JSON.stringify(hydratedRows));
    return {
      elapsedMilliseconds,
      nativeToJsPayloadBytes,
      sqliteCalls: 2,
      result,
    };
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function summarize(samples: readonly number[]): Summary {
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
  const expoTransactionAttestation = installedExpoTransactionAttestation();
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
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`Source integrity_check failed: ${String(integrity?.integrity_check)}`);
    }
    const sourceNameRows = database
      .prepare(ACTIVE_MICHELIN_CALENDAR_NAME_ROWS_SQL)
      .all(DATASET_KEY, DATASET_KEY) as unknown as MichelinCalendarNameRow[];
    if (sourceNameRows.length === 0) {
      throw new Error("Real-database benchmark requires active Michelin guide rows");
    }
    const requestedNames = selectRequestedNames(sourceNameRows, configuration.matchedRowTarget);
    const oracle = executeLegacy(database, requestedNames);
    const candidate = executeCandidate(database, requestedNames);
    assert.deepEqual(candidate.result, oracle.result, "candidate must match the literal full-guide strategy");
    assert.ok(candidate.result.length >= configuration.matchedRowTarget);

    const timings: Record<Strategy, number[]> = { legacyFullGuide: [], twoStageProjection: [] };
    const payloadBytes: Record<Strategy, number> = {
      legacyFullGuide: oracle.nativeToJsPayloadBytes,
      twoStageProjection: candidate.nativeToJsPayloadBytes,
    };
    const measuredIterations = configuration.warmupIterations + configuration.samples;
    for (let iteration = 0; iteration < measuredIterations; iteration++) {
      const order: readonly Strategy[] =
        iteration % 2 === 0 ? ["legacyFullGuide", "twoStageProjection"] : ["twoStageProjection", "legacyFullGuide"];
      for (const strategy of order) {
        const measurement =
          strategy === "legacyFullGuide"
            ? executeLegacy(database, requestedNames)
            : executeCandidate(database, requestedNames);
        assert.deepEqual(measurement.result, oracle.result);
        assert.equal(measurement.nativeToJsPayloadBytes, payloadBytes[strategy]);
        if (iteration >= configuration.warmupIterations) {
          timings[strategy].push(measurement.elapsedMilliseconds);
        }
      }
    }

    const legacySummary = summarize(timings.legacyFullGuide);
    const candidateSummary = summarize(timings.twoStageProjection);
    const resultDigest = sha256Bytes(JSON.stringify(oracle.result));
    report = {
      schemaVersion: 1,
      status: "ok",
      generatedAt: new Date().toISOString(),
      configuration: {
        matchedRowTarget: configuration.matchedRowTarget,
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
      },
      measurementModel: {
        runtime: "Node.js node:sqlite plus benchmark-local JavaScript",
        scope: "query/normalization/hydration model, not end-to-end Expo helper timing",
        includes: [
          "deferred BEGIN and COMMIT",
          "SQLite statement preparation, execution, and row decoding",
          "non-memoized benchmark normalization",
          "ID selection, selective hydration, and result shaping",
        ],
        excludes: [
          "Expo dedicated transaction connection creation and closure",
          "the real memoized Calendar normalization implementation",
          "React Native scheduling and JSI/runtime effects",
        ],
        installedExpoTransactionAttestation: expoTransactionAttestation,
      },
      source: {
        activeGuideRowCount: sourceNameRows.length,
        databaseBytes: statSync(configuration.databasePath).size,
        databaseSha256: sha256File(configuration.databasePath),
        integrityCheck: "ok",
      },
      workload: {
        matchedNormalizedNameCount: requestedNames.size,
        matchedRestaurantCount: oracle.result.length,
        semanticSha256: resultDigest,
      },
      strategies: {
        legacyFullGuide: {
          sqliteCalls: oracle.sqliteCalls,
          nativeToJsPayloadBytes: payloadBytes.legacyFullGuide,
          transactionMode: "Node DatabaseSync deferred BEGIN read transaction",
          timedRegionIncludesReadTransaction: true,
          nodeModelTiming: legacySummary,
        },
        twoStageProjection: {
          sqliteCalls: candidate.sqliteCalls,
          nativeToJsPayloadBytes: payloadBytes.twoStageProjection,
          transactionMode: "Node DatabaseSync deferred BEGIN read transaction",
          timedRegionIncludesReadTransaction: true,
          nodeModelTiming: candidateSummary,
        },
      },
      comparison: {
        nodeModelMedianMillisecondsSaved: legacySummary.medianMilliseconds - candidateSummary.medianMilliseconds,
        nodeModelMedianSpeedup: legacySummary.medianMilliseconds / candidateSummary.medianMilliseconds,
        nativeToJsPayloadBytesSaved: payloadBytes.legacyFullGuide - payloadBytes.twoStageProjection,
        nativeToJsPayloadReductionPercent:
          ((payloadBytes.legacyFullGuide - payloadBytes.twoStageProjection) / payloadBytes.legacyFullGuide) * 100,
      },
      privacy: {
        aggregateOnly: true,
        calendarDataAccessed: false,
        rawRestaurantFieldsRetainedInReport: false,
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
    benchmarkTransactionMode: "deferred BEGIN on the immutable mode=ro source",
    installedExpoProductionMode: expoTransactionAttestation,
    productionWriterReservation: false,
    productionTradeoff:
      "the SELECT-only snapshot reserves no WAL writer but can retain WAL frames until JS normalization and hydration commit",
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
