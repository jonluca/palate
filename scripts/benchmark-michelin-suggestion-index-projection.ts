#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { MichelinLocationIndex, type MichelinLocation } from "../utils/michelin-location-index.ts";
import {
  ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL,
  MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
  MICHELIN_SUGGESTION_LIMIT,
  MICHELIN_SUGGESTION_RADIUS_METERS,
} from "../utils/db/michelin-suggestion-index-core.ts";

type Strategy = "currentFullRows" | "minimalProjection";
type Phase = "load" | "build" | "search" | "total";

interface Configuration {
  readonly databasePath: string;
  readonly outputPath: string;
  readonly samples: number;
  readonly warmupPairs: number;
}

interface ActiveGuideFullRow extends MichelinLocation {
  readonly name: string;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion: string | null;
}

interface VisitCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

interface SuggestedMatch {
  readonly restaurantId: string;
  readonly distanceMeters: number;
}

interface VisitSuggestion {
  readonly primaryRestaurantId: string | null;
  readonly matches: readonly SuggestedMatch[];
}

interface FileSnapshot {
  readonly present: boolean;
  readonly bytes: number | null;
  readonly mode: number | null;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly main: FileSnapshot;
  readonly wal: FileSnapshot;
  readonly shm: FileSnapshot;
  readonly journal: FileSnapshot;
}

interface SequenceSnapshot {
  readonly rowCount: number;
  readonly sha256: string;
}

interface PhaseDurations {
  readonly load: number;
  readonly build: number;
  readonly search: number;
  readonly total: number;
}

interface Measurement {
  readonly durationsMilliseconds: PhaseDurations;
  readonly matchCount: number;
  readonly matchDigestSha256: string;
  readonly primaryMatchCount: number;
  readonly suggestions?: readonly VisitSuggestion[];
}

interface TimingSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

const DEFAULT_OUTPUT_PATH = ".build/michelin-suggestion-index-projection-profile.json";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const ACTIVE_FULL_ROWS_SQL = `SELECT m.*
  FROM michelin_restaurants m
  JOIN app_metadata metadata
    ON metadata.key = 'michelin_dataset_version'
   AND m.datasetVersion = metadata.value`;

const REAL_VISIT_WORKLOAD_SQL = `SELECT centerLat AS latitude, centerLon AS longitude
  FROM visits
  WHERE typeof(centerLat) IN ('integer', 'real')
    AND typeof(centerLon) IN ('integer', 'real')
    AND centerLat BETWEEN -90 AND 90
    AND centerLon BETWEEN -180 AND 180
  ORDER BY rowid`;

function usage(): string {
  return `Usage: benchmark-michelin-suggestion-index-projection.ts --database=PATH [options]

  --database=PATH  Palate database opened mode=ro and immutable (required)
  --samples=N      Measured counterbalanced A/B pairs (default: 11)
  --warmup=N       Counterbalanced warmup pairs (default: 3)
  --output=PATH    Aggregate-only JSON report (default: ${DEFAULT_OUTPUT_PATH})
  --help, -h       Show this help

The benchmark compares the current active-guide SELECT m.* source with an
id/latitude/longitude projection. Each timed sample includes SQLite statement
preparation/execution and row decoding, MichelinLocationIndex construction, and
the app's 200 m / five-result suggestion lookup over every valid persisted visit
centroid. It excludes Expo SQLite scheduling, the React Native runtime, writes,
Photos, and Calendar access. The report retains aggregate counts, hashes, byte
sizes, and timings only; it never retains restaurant fields, IDs, visit IDs, or
coordinates.`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
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
  let outputPath = resolve(DEFAULT_OUTPUT_PATH);
  let samples = 11;
  let warmupPairs = 3;

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
      case "--output":
        outputPath = resolve(value);
        break;
      case "--samples":
        samples = parseInteger(value, option);
        break;
      case "--warmup":
        warmupPairs = parseInteger(value, option, true);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (databasePath === null) {
    throw new Error("--database=PATH is required for immutable real-database profiling");
  }
  return { databasePath, outputPath, samples, warmupPairs };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { present: false, bytes: null, mode: null, sha256: null };
  }
  const metadata = statSync(path);
  if (!metadata.isFile()) {
    throw new Error(`Protected SQLite path is not a regular file: ${path}`);
  }
  return {
    present: true,
    bytes: metadata.size,
    mode: metadata.mode & 0o7777,
    sha256: sha256(readFileSync(path)),
  };
}

function sourceSnapshot(databasePath: string): SourceSnapshot {
  return {
    main: fileSnapshot(databasePath),
    wal: fileSnapshot(`${databasePath}-wal`),
    shm: fileSnapshot(`${databasePath}-shm`),
    journal: fileSnapshot(`${databasePath}-journal`),
  };
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Path contains a symbolic-link cycle at ${ancestor}`);
        }
        seenSymlinks.add(ancestor);
        return resolve(
          canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), seenSymlinks),
          ...missingSegments,
        );
      }
      return resolve(realpathSync(ancestor), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function protectedSourcePaths(databasePath: string): string[] {
  return [databasePath, ...SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)];
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const canonicalOutput = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === canonicalOutput) {
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

function assertImmutableSourceIsSafe(databasePath: string): string {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${databasePath}`);
  }
  const canonicalDatabasePath = realpathSync(databasePath);
  if (statSync(canonicalDatabasePath).nlink !== 1) {
    throw new Error(
      "Source database has hard-link aliases; their separate WAL/journal names make immutable profiling unsafe",
    );
  }
  for (const suffix of ["-wal", "-journal"] as const) {
    const sidecarPath = `${canonicalDatabasePath}${suffix}`;
    if (existsSync(sidecarPath) && statSync(sidecarPath).size > 0) {
      throw new Error(
        `Source database has a non-empty ${suffix.slice(1)} sidecar; checkpoint and close its writer before immutable profiling`,
      );
    }
  }
  return canonicalDatabasePath;
}

function immutableDatabaseUri(databasePath: string): string {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number") {
    throw new TypeError("SQLite total_changes() did not return a number");
  }
  return row.count;
}

function sqliteSequenceSnapshot(database: DatabaseSync): SequenceSnapshot {
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get() as { present?: unknown } | undefined;
  const rows =
    table?.present === 1 ? database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() : [];
  return { rowCount: rows.length, sha256: sha256(JSON.stringify(rows)) };
}

function loadRows(database: DatabaseSync, strategy: Strategy): readonly MichelinLocation[] {
  if (strategy === "currentFullRows") {
    return database.prepare(ACTIVE_FULL_ROWS_SQL).all() as unknown as readonly MichelinLocation[];
  }
  return database.prepare(ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL).all() as unknown as readonly MichelinLocation[];
}

function canonicalProjectedRows(rows: readonly MichelinLocation[]): MichelinLocation[] {
  return rows
    .map(({ id, latitude, longitude }) => ({ id, latitude, longitude }))
    .sort((left, right) =>
      left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : left.latitude - right.latitude || left.longitude - right.longitude,
    );
}

function findSuggestions(
  index: MichelinLocationIndex<MichelinLocation>,
  visits: readonly VisitCoordinate[],
): VisitSuggestion[] {
  return visits.map((visit) => {
    const matches = index
      .findNearby({
        latitude: visit.latitude,
        longitude: visit.longitude,
        radiusMeters: MICHELIN_SUGGESTION_RADIUS_METERS,
        limit: MICHELIN_SUGGESTION_LIMIT,
      })
      .map(({ restaurant, distanceMeters }) => ({ restaurantId: restaurant.id, distanceMeters }));
    return {
      primaryRestaurantId:
        matches.find(({ distanceMeters }) => distanceMeters <= MICHELIN_PRIMARY_MATCH_RADIUS_METERS)?.restaurantId ??
        null,
      matches,
    };
  });
}

function summarizeSuggestions(suggestions: readonly VisitSuggestion[]): {
  readonly digest: string;
  readonly matchCount: number;
  readonly primaryMatchCount: number;
} {
  let matchCount = 0;
  let primaryMatchCount = 0;
  for (const suggestion of suggestions) {
    matchCount += suggestion.matches.length;
    if (suggestion.primaryRestaurantId !== null) {
      primaryMatchCount += 1;
    }
  }
  return {
    digest: sha256(JSON.stringify(suggestions)),
    matchCount,
    primaryMatchCount,
  };
}

function measureStrategy(
  database: DatabaseSync,
  strategy: Strategy,
  visits: readonly VisitCoordinate[],
  retainSuggestions: boolean,
): Measurement {
  const startedAt = performance.now();
  const rows = loadRows(database, strategy);
  const loadedAt = performance.now();
  const index = new MichelinLocationIndex(rows);
  const builtAt = performance.now();
  const suggestions = findSuggestions(index, visits);
  const completedAt = performance.now();
  const summary = summarizeSuggestions(suggestions);
  return {
    durationsMilliseconds: {
      load: loadedAt - startedAt,
      build: builtAt - loadedAt,
      search: completedAt - builtAt,
      total: completedAt - startedAt,
    },
    matchCount: summary.matchCount,
    matchDigestSha256: summary.digest,
    primaryMatchCount: summary.primaryMatchCount,
    ...(retainSuggestions ? { suggestions } : {}),
  };
}

function summarize(samples: readonly number[]): TimingSummary {
  assert.ok(samples.length > 0, "timing summary requires at least one sample");
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

function summarizePhases(samples: Readonly<Record<Phase, readonly number[]>>): Record<Phase, TimingSummary> {
  return {
    load: summarize(samples.load),
    build: summarize(samples.build),
    search: summarize(samples.search),
    total: summarize(samples.total),
  };
}

function counterbalancedOrder(pair: number): readonly Strategy[] {
  return pair % 2 === 0 ? ["currentFullRows", "minimalProjection"] : ["minimalProjection", "currentFullRows"];
}

function median(values: readonly number[]): number {
  return summarize(values).medianMilliseconds;
}

function writeReportAtomically(databasePath: string, outputPath: string, report: unknown): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  assertOutputDoesNotAliasSource(databasePath, outputPath);
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  assertOutputDoesNotAliasSource(databasePath, temporaryPath);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, outputPath);
    const directoryDescriptor = openSync(dirname(outputPath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

function run(configuration: Configuration): void {
  const databasePath = assertImmutableSourceIsSafe(configuration.databasePath);
  assertOutputDoesNotAliasSource(databasePath, configuration.outputPath);
  const sourceBefore = sourceSnapshot(databasePath);
  assert.equal(sourceBefore.main.present, true);

  const database = new DatabaseSync(immutableDatabaseUri(databasePath), { readOnly: true });
  let report: Record<string, unknown>;
  try {
    database.exec("PRAGMA query_only = ON");
    assert.deepEqual(
      sourceSnapshot(databasePath),
      sourceBefore,
      "source or sidecars changed while opening the immutable database",
    );
    assertImmutableSourceIsSafe(databasePath);
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`Source integrity_check failed: ${String(integrity?.integrity_check)}`);
    }
    const foreignKeyViolationCount = database.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyViolationCount !== 0) {
      throw new Error(`Source foreign_key_check returned ${foreignKeyViolationCount} violation(s)`);
    }

    const totalChangesBefore = totalChanges(database);
    const sequenceBefore = sqliteSequenceSnapshot(database);
    database.exec("BEGIN");
    try {
      const visits = database.prepare(REAL_VISIT_WORKLOAD_SQL).all() as unknown as VisitCoordinate[];
      if (visits.length === 0) {
        throw new Error("Real-database benchmark requires at least one valid persisted visit centroid");
      }

      const fullRows = loadRows(database, "currentFullRows") as readonly ActiveGuideFullRow[];
      const minimalRows = loadRows(database, "minimalProjection");
      if (fullRows.length === 0) {
        throw new Error("Real-database benchmark requires active Michelin guide rows");
      }
      assert.equal(minimalRows.length, fullRows.length, "minimal projection must retain every active guide row");
      assert.deepEqual(
        canonicalProjectedRows(minimalRows),
        canonicalProjectedRows(fullRows),
        "minimal projection must preserve exact active-guide IDs and coordinates",
      );
      assert.deepEqual(Object.keys(minimalRows[0]!).sort(), ["id", "latitude", "longitude"]);

      const payloadBytes = {
        currentFullRows: Buffer.byteLength(JSON.stringify(fullRows), "utf8"),
        minimalProjection: Buffer.byteLength(JSON.stringify(minimalRows), "utf8"),
      };
      assert.ok(payloadBytes.minimalProjection < payloadBytes.currentFullRows);

      const oracle = measureStrategy(database, "currentFullRows", visits, true);
      const candidate = measureStrategy(database, "minimalProjection", visits, true);
      assert.deepEqual(
        candidate.suggestions,
        oracle.suggestions,
        "minimal projection changed suggestion IDs or distances",
      );
      assert.equal(candidate.matchDigestSha256, oracle.matchDigestSha256);

      const phaseSamples: Record<Strategy, Record<Phase, number[]>> = {
        currentFullRows: { load: [], build: [], search: [], total: [] },
        minimalProjection: { load: [], build: [], search: [], total: [] },
      };
      const measuredOrders: Strategy[][] = [];
      const totalPairs = configuration.warmupPairs + configuration.samples;
      for (let pair = 0; pair < totalPairs; pair++) {
        const order = counterbalancedOrder(pair);
        if (pair >= configuration.warmupPairs) {
          measuredOrders.push([...order]);
        }
        for (const strategy of order) {
          const measurement = measureStrategy(database, strategy, visits, false);
          assert.equal(measurement.matchDigestSha256, oracle.matchDigestSha256);
          assert.equal(measurement.matchCount, oracle.matchCount);
          assert.equal(measurement.primaryMatchCount, oracle.primaryMatchCount);
          if (pair >= configuration.warmupPairs) {
            for (const phase of ["load", "build", "search", "total"] as const) {
              phaseSamples[strategy][phase].push(measurement.durationsMilliseconds[phase]);
            }
          }
        }
      }

      database.exec("COMMIT");
      const fullTimings = summarizePhases(phaseSamples.currentFullRows);
      const minimalTimings = summarizePhases(phaseSamples.minimalProjection);
      const pairedTotalDeltaMilliseconds = phaseSamples.minimalProjection.total.map(
        (value, index) => value - phaseSamples.currentFullRows.total[index]!,
      );
      const sourceDuringRead = sourceSnapshot(databasePath);
      assert.deepEqual(sourceDuringRead, sourceBefore, "immutable read changed the source database or a sidecar");

      const totalChangesAfter = totalChanges(database);
      const sequenceAfter = sqliteSequenceSnapshot(database);
      report = {
        schemaVersion: 1,
        status: "ok",
        generatedAt: new Date().toISOString(),
        configuration: {
          samples: configuration.samples,
          warmupPairs: configuration.warmupPairs,
          suggestionRadiusMeters: MICHELIN_SUGGESTION_RADIUS_METERS,
          primaryMatchRadiusMeters: MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
          resultLimit: MICHELIN_SUGGESTION_LIMIT,
        },
        measurementModel: {
          mode: "immutable-real-db-visits",
          runtime: "Node.js node:sqlite plus production MichelinLocationIndex",
          workload: "all persisted finite in-range visit centroids",
          includes: [
            "SQLite statement preparation, execution, and raw-row decoding",
            "MichelinLocationIndex construction",
            "200 m geodesic searches capped at five results",
            "100 m primary-suggestion selection",
          ],
          excludes: [
            "Expo SQLite scheduling and native-to-JS serialization",
            "Hermes and React Native runtime effects",
            "visit grouping, writes, UI work, Photos, and Calendar access",
          ],
          payloadBytesAre: "UTF-8 JSON structural proxy, not measured Expo/JSI wire bytes",
        },
        source: {
          activeGuideRowCount: fullRows.length,
          validVisitCentroidCount: visits.length,
          fullRowColumnCount: Object.keys(fullRows[0]!).length,
          minimalRowColumnCount: Object.keys(minimalRows[0]!).length,
          integrityCheck: "ok",
          foreignKeyViolationCount,
          components: sourceBefore,
        },
        correctness: {
          exactProjectedRowParity: true,
          exactSuggestionIdAndDistanceParity: true,
          suggestionDigestSha256: oracle.matchDigestSha256,
          suggestionCount: oracle.matchCount,
          primarySuggestionCount: oracle.primaryMatchCount,
        },
        strategies: {
          currentFullRows: {
            queryShape: "active-guide SELECT m.*",
            projectedColumns: Object.keys(fullRows[0]!).length,
            payloadBytes: payloadBytes.currentFullRows,
            nodeModelTiming: fullTimings,
          },
          minimalProjection: {
            queryShape: "active-guide SELECT id, latitude, longitude",
            projectedColumns: 3,
            payloadBytes: payloadBytes.minimalProjection,
            nodeModelTiming: minimalTimings,
          },
        },
        comparison: {
          payloadBytesSaved: payloadBytes.currentFullRows - payloadBytes.minimalProjection,
          payloadBytesReductionPercent: (1 - payloadBytes.minimalProjection / payloadBytes.currentFullRows) * 100,
          medianTotalSpeedupRatio: fullTimings.total.medianMilliseconds / minimalTimings.total.medianMilliseconds,
          medianLoadSpeedupRatio: fullTimings.load.medianMilliseconds / minimalTimings.load.medianMilliseconds,
          pairedTotalDeltaMilliseconds,
          medianPairedTotalDeltaMilliseconds: median(pairedTotalDeltaMilliseconds),
          minimalProjectionWins: pairedTotalDeltaMilliseconds.filter((delta) => delta < 0).length,
          pairCount: configuration.samples,
        },
        counterbalancing: {
          enabled: true,
          alternatesFirstStrategyByPair: true,
          measuredOrders,
        },
        sourceAttestation: {
          openMode: "mode=ro, immutable=1, PRAGMA query_only=ON, one read transaction",
          nonEmptyWalRejected: true,
          nonEmptyJournalRejected: true,
          mainWalShmJournalByteIdentical: true,
        },
        writeInvariants: {
          totalChangesUnchanged: totalChangesAfter === totalChangesBefore,
          sqliteSequenceUnchanged:
            sequenceAfter.rowCount === sequenceBefore.rowCount && sequenceAfter.sha256 === sequenceBefore.sha256,
          mainWalShmJournalByteIdentical: true,
        },
        privacy: {
          aggregateOnly: true,
          sourceAndOutputPathsRetained: false,
          rawRestaurantFieldsRetained: false,
          restaurantIdsRetained: false,
          rawVisitFieldsRetained: false,
          visitIdsOrCoordinatesRetained: false,
          photosLibraryAccessed: false,
          calendarDataAccessed: false,
        },
      };
      assert.equal(totalChangesAfter, totalChangesBefore, "benchmark must not change SQLite total_changes()");
      assert.deepEqual(sequenceAfter, sequenceBefore, "benchmark must not change sqlite_sequence");
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  } finally {
    database.close();
  }

  const sourceAfterRead = sourceSnapshot(databasePath);
  assert.deepEqual(sourceAfterRead, sourceBefore, "benchmark changed source main/WAL/SHM/journal identity");
  writeReportAtomically(databasePath, configuration.outputPath, report!);
  assert.deepEqual(
    sourceSnapshot(databasePath),
    sourceBefore,
    "writing the aggregate report changed source main/WAL/SHM/journal identity",
  );

  const comparison = report!.comparison as {
    medianTotalSpeedupRatio: number;
    minimalProjectionWins: number;
    pairCount: number;
    payloadBytesReductionPercent: number;
  };
  console.log(
    `Michelin suggestion index projection: ${comparison.medianTotalSpeedupRatio.toFixed(3)}x median total, ` +
      `${comparison.minimalProjectionWins}/${comparison.pairCount} paired wins, ` +
      `${comparison.payloadBytesReductionPercent.toFixed(3)}% fewer modeled payload bytes.`,
  );
}

try {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
  } else {
    run(configuration);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
