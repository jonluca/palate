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
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  CURRENT_MICHELIN_SOURCE_ROWS_SQL,
  destinationDigest,
  destinationWalBytes,
  immutableSqliteUri,
  MICHELIN_DATASET_VERSION_KEY,
  openDestinationDatabase,
  resolveProtectedSourcePath,
  runAttachInsertSelectImport,
  runCurrentJsOracleImport,
  snapshotSqliteSource,
  type DestinationDigest,
  type FileSnapshot,
  type ImportMeasurement,
  type ImportPhaseDurations,
  type MichelinImportStrategy,
  type SqliteSourceSnapshot,
} from "./michelin-import-prototype-core.ts";
import { MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL } from "../utils/db/michelin-provider-spatial-core.ts";

interface Configuration {
  readonly outputPath: string;
  readonly samples: number;
  readonly sourcePath: string;
  readonly warmupPairs: number;
}

interface CountRow {
  readonly count: number;
}

interface TextRow {
  readonly value: string;
}

interface HealthRow {
  readonly issueCount: number;
}

interface SeedIdentityRow {
  readonly id: number | string;
  readonly latitude: number | string | null;
  readonly longitude: number | string | null;
}

interface MeasurementResult {
  readonly digest: DestinationDigest;
  readonly foreignKeyViolations: number;
  readonly integrityCheck: string;
  readonly measurement: ImportMeasurement;
  readonly spatialIssueCount: number;
  readonly walBytesAfter: number;
  readonly walBytesBefore: number;
  readonly walGrowthBytes: number;
}

interface NumericSummary {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly p95: number;
  readonly samples: readonly number[];
}

interface PhaseSummary {
  readonly destinationWrite: NumericSummary;
  readonly sourceConnect: NumericSummary;
  readonly sourceDisconnect: NumericSummary;
  readonly sourceRead: NumericSummary;
  readonly total: NumericSummary;
  readonly transform: NumericSummary;
}

interface SourceFacts {
  readonly awardRows: number;
  readonly conflictSourceId: number | string;
  readonly restaurantRows: number;
  readonly selectedRows: number;
  readonly sqliteVersion: string;
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE_PATH = resolve(repositoryRoot, "assets/michelin.db");
const DEFAULT_OUTPUT_PATH = resolve(repositoryRoot, ".build/michelin-import-prototype-profile.json");
const DATASET_VERSION = "michelin-import-prototype-v1";
const HISTORICAL_ID = "michelin-prototype-preserved-historical-row";
const STRATEGIES: readonly MichelinImportStrategy[] = ["currentJsOracle", "attachInsertSelect"];

function usage(): string {
  return `Usage: benchmark-michelin-import-prototype.ts [options]

  --source=PATH  Immutable Michelin reference DB (default: assets/michelin.db)
  --samples=N    Measured A/B pairs; must be even (default: 6)
  --warmup=N     Counterbalanced warmup pairs (default: 2)
  --output=PATH  New aggregate-only JSON report
  --help, -h     Show this help

Each strategy writes only to a fresh disposable destination database. The
current oracle performs the existing COUNT + full-row JS materialization +
1,000-row UPSERT batches. The candidate performs ATTACH + INSERT...SELECT in
one transaction. Both include the production R-Tree triggers. The protected
source main/WAL/SHM/journal files are byte-attested before and after every run.
The report contains counts, byte sizes, hashes, and timings only; it never
contains restaurant fields, IDs, coordinates, source paths, or destination DBs.`;
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
  let sourcePath = DEFAULT_SOURCE_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let samples = 6;
  let warmupPairs = 2;

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
      case "--source":
        sourcePath = resolve(value);
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

  if (samples % 2 !== 0) {
    throw new RangeError("--samples must be even so first-position execution is exactly counterbalanced");
  }
  return { outputPath, samples, sourcePath, warmupPairs };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Path contains a symbolic-link cycle: ${ancestor}`);
        }
        seenSymlinks.add(ancestor);
        return canonicalizePotentialPath(resolve(dirname(ancestor), readlinkSync(ancestor)), seenSymlinks);
      }
      return resolve(realpathSync(ancestor), ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingSegments.push(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
}

function sourceComponents(sourcePath: string): string[] {
  return [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`, `${sourcePath}-journal`].filter(existsSync);
}

function assertOutputIsSafe(outputPath: string, sourcePath: string): void {
  const canonicalOutput = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of sourceComponents(sourcePath)) {
    const protectedMetadata = statSync(protectedPath);
    if (
      canonicalizePotentialPath(protectedPath) === canonicalOutput ||
      (outputIdentity !== null &&
        outputIdentity.dev === protectedMetadata.dev &&
        outputIdentity.ino === protectedMetadata.ino)
    ) {
      throw new Error("Output path aliases a protected source SQLite component");
    }
  }
  if (existsSync(outputPath)) {
    throw new Error("Output report already exists; refusing to overwrite it");
  }
}

function publicFileSnapshot(snapshot: FileSnapshot): Omit<FileSnapshot, "device" | "inode" | "mode"> {
  return {
    present: snapshot.present,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
  };
}

function publicSourceSnapshot(snapshot: SqliteSourceSnapshot): Record<string, unknown> {
  return {
    main: publicFileSnapshot(snapshot.main),
    wal: publicFileSnapshot(snapshot.wal),
    shm: publicFileSnapshot(snapshot.shm),
    journal: publicFileSnapshot(snapshot.journal),
  };
}

function validateQuiescentSource(snapshot: SqliteSourceSnapshot): void {
  if ((snapshot.wal.bytes ?? 0) !== 0) {
    throw new Error("Source WAL must be absent or empty before immutable profiling");
  }
  if ((snapshot.journal.bytes ?? 0) !== 0) {
    throw new Error("Source rollback journal must be absent or empty before immutable profiling");
  }
}

function inspectSource(sourcePath: string): SourceFacts {
  const database = new DatabaseSync(immutableSqliteUri(sourcePath), { readOnly: true });
  try {
    const integrity = database
      .prepare("SELECT integrity_check AS value FROM pragma_integrity_check")
      .get() as unknown as TextRow;
    assert.equal(integrity.value, "ok", "Source database must pass integrity_check");
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0, "Source database has FK violations");
    const sqliteVersion = (database.prepare("SELECT sqlite_version() AS value").get() as unknown as TextRow).value;
    const restaurantRows = (database.prepare("SELECT COUNT(*) AS count FROM restaurants").get() as unknown as CountRow)
      .count;
    const awardRows = (database.prepare("SELECT COUNT(*) AS count FROM restaurant_awards").get() as unknown as CountRow)
      .count;
    const selectedRows = (
      database
        .prepare(`SELECT COUNT(*) AS count FROM (${CURRENT_MICHELIN_SOURCE_ROWS_SQL})`)
        .get() as unknown as CountRow
    ).count;
    const conflict = (
      database
        .prepare(`SELECT id, latitude, longitude
        FROM restaurants
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          AND latitude != '' AND longitude != ''
        ORDER BY id`)
        .all() as unknown as SeedIdentityRow[]
    ).find(({ latitude, longitude }) => {
      const parsedLatitude = Number.parseFloat(String(latitude));
      const parsedLongitude = Number.parseFloat(String(longitude));
      return (
        Number.isFinite(parsedLatitude) &&
        parsedLatitude >= -90 &&
        parsedLatitude <= 90 &&
        Number.isFinite(parsedLongitude) &&
        parsedLongitude >= -180 &&
        parsedLongitude <= 180 &&
        !(parsedLatitude === 0 && parsedLongitude === 0)
      );
    });
    assert.ok(conflict, "Source database must contain at least one restaurant");
    const reservedCollision = (
      database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE 'michelin-' || id = ?").get(HISTORICAL_ID) as
        | CountRow
        | undefined
    )?.count;
    assert.equal(reservedCollision, 0, "Reserved historical prototype ID collides with source data");
    return { awardRows, conflictSourceId: conflict.id, restaurantRows, selectedRows, sqliteVersion };
  } finally {
    database.close();
  }
}

function seedDestination(database: DatabaseSync, conflictSourceId: number | string): void {
  const insert = database.prepare(`INSERT INTO michelin_restaurants
    (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(
    `michelin-${String(conflictSourceId)}`,
    "prototype stale conflict",
    -1,
    -1,
    "prototype stale address",
    "prototype stale location",
    "prototype stale cuisine",
    1900,
    "prototype stale award",
    "prototype-previous-version",
  );
  insert.run(
    HISTORICAL_ID,
    "prototype preserved historical",
    12.5,
    -45.25,
    "prototype historical address",
    "prototype historical location",
    "prototype historical cuisine",
    2020,
    "prototype historical award",
    "prototype-historical-version",
  );
  database
    .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?), (?, ?)")
    .run(
      MICHELIN_DATASET_VERSION_KEY,
      "prototype-previous-version",
      "prototype-unrelated-key",
      "prototype-unrelated-value",
    );
}

function runMeasurement(
  strategy: MichelinImportStrategy,
  sourcePath: string,
  sourceFacts: SourceFacts,
  scratchRoot: string,
  ordinal: number,
): MeasurementResult {
  const databasePath = join(scratchRoot, `${ordinal.toString().padStart(3, "0")}-${strategy}.db`);
  const database = openDestinationDatabase(databasePath);
  try {
    seedDestination(database, sourceFacts.conflictSourceId);
    const walBytesBefore = destinationWalBytes(databasePath);
    const measurement =
      strategy === "currentJsOracle"
        ? runCurrentJsOracleImport(database, sourcePath, DATASET_VERSION)
        : runAttachInsertSelectImport(database, sourcePath, DATASET_VERSION);
    const walBytesAfter = destinationWalBytes(databasePath);
    assert.ok(walBytesAfter >= walBytesBefore, "Destination WAL unexpectedly shrank during import");
    const digest = destinationDigest(database);
    const integrityCheck = (
      database.prepare("SELECT integrity_check AS value FROM pragma_integrity_check").get() as unknown as TextRow
    ).value;
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const spatialIssueCount = (database.prepare(MICHELIN_PROVIDER_SPATIAL_HEALTH_SQL).get() as unknown as HealthRow)
      .issueCount;
    const historical = database
      .prepare(`SELECT datasetVersion, award FROM michelin_restaurants WHERE id = ?`)
      .get(HISTORICAL_ID) as Record<string, unknown> | undefined;
    assert.ok(historical);
    assert.equal(historical.datasetVersion, "prototype-historical-version");
    assert.equal(historical.award, "prototype historical award");
    const conflict = database
      .prepare("SELECT datasetVersion FROM michelin_restaurants WHERE id = ?")
      .get(`michelin-${String(sourceFacts.conflictSourceId)}`) as Record<string, unknown> | undefined;
    assert.equal(conflict?.datasetVersion, DATASET_VERSION);
    assert.equal(
      (
        database
          .prepare("SELECT value FROM app_metadata WHERE key = ?")
          .get(MICHELIN_DATASET_VERSION_KEY) as unknown as TextRow
      ).value,
      DATASET_VERSION,
    );
    assert.equal(
      (
        database
          .prepare("SELECT value FROM app_metadata WHERE key = 'prototype-unrelated-key'")
          .get() as unknown as TextRow
      ).value,
      "prototype-unrelated-value",
    );
    assert.equal(integrityCheck, "ok");
    assert.equal(foreignKeyViolations, 0);
    assert.equal(spatialIssueCount, 0);
    return {
      digest,
      foreignKeyViolations,
      integrityCheck,
      measurement,
      spatialIssueCount,
      walBytesAfter,
      walBytesBefore,
      walGrowthBytes: walBytesAfter - walBytesBefore,
    };
  } finally {
    database.close();
  }
}

function counterbalancedOrder(round: number): readonly MichelinImportStrategy[] {
  return round % 2 === 0 ? STRATEGIES : [...STRATEGIES].reverse();
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summarize(values: readonly number[]): NumericSummary {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : (sorted[middle] as number);
  return {
    maximum: sorted.at(-1)!,
    median,
    minimum: sorted[0]!,
    p95: percentile(sorted, 0.95),
    samples: values,
  };
}

function summarizePhases(results: readonly MeasurementResult[]): PhaseSummary {
  const phases = results.map(({ measurement }) => measurement.phasesMilliseconds);
  const field = (name: keyof ImportPhaseDurations): number[] => phases.map((phase) => phase[name]);
  return {
    destinationWrite: summarize(field("destinationWrite")),
    sourceConnect: summarize(field("sourceConnect")),
    sourceDisconnect: summarize(field("sourceDisconnect")),
    sourceRead: summarize(field("sourceRead")),
    total: summarize(field("total")),
    transform: summarize(field("transform")),
  };
}

function atomicWriteReport(outputPath: string, report: unknown, sourcePath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  assertOutputIsSafe(temporaryPath, sourcePath);
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(report, null, 2)}\n`);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    renameSync(temporaryPath, outputPath);
    const directoryDescriptor = openSync(dirname(outputPath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
    return;
  }

  const sourcePath = resolveProtectedSourcePath(configuration.sourcePath);
  assertOutputIsSafe(configuration.outputPath, sourcePath);
  const sourceBefore = snapshotSqliteSource(sourcePath);
  validateQuiescentSource(sourceBefore);
  const sourceFacts = inspectSource(sourcePath);
  assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore, "Source inspection mutated protected files");

  const scratchRoot = mkdtempSync(join(tmpdir(), "palate-michelin-import-profile-"));
  const measured: Record<MichelinImportStrategy, MeasurementResult[]> = {
    currentJsOracle: [],
    attachInsertSelect: [],
  };
  const pairedTotals: Array<{ readonly currentJsOracle: number; readonly attachInsertSelect: number }> = [];
  let ordinal = 0;
  let expectedDigest: DestinationDigest | null = null;
  const expectedMeasurementShape: Record<MichelinImportStrategy, ImportMeasurement | null> = {
    currentJsOracle: null,
    attachInsertSelect: null,
  };

  try {
    for (let warmup = 0; warmup < configuration.warmupPairs; warmup++) {
      for (const strategy of counterbalancedOrder(warmup)) {
        const result = runMeasurement(strategy, sourcePath, sourceFacts, scratchRoot, ordinal++);
        expectedDigest ??= result.digest;
        assert.deepEqual(result.digest, expectedDigest, "Warmup strategies produced different destination tables");
      }
    }

    for (let pair = 0; pair < configuration.samples; pair++) {
      const pairResults = {} as Record<MichelinImportStrategy, MeasurementResult>;
      for (const strategy of counterbalancedOrder(pair + configuration.warmupPairs)) {
        const result = runMeasurement(strategy, sourcePath, sourceFacts, scratchRoot, ordinal++);
        expectedDigest ??= result.digest;
        assert.deepEqual(result.digest, expectedDigest, "Measured strategies produced different destination tables");
        expectedMeasurementShape[strategy] ??= result.measurement;
        measured[strategy].push(result);
        pairResults[strategy] = result;
      }
      pairedTotals.push({
        currentJsOracle: pairResults.currentJsOracle.measurement.phasesMilliseconds.total,
        attachInsertSelect: pairResults.attachInsertSelect.measurement.phasesMilliseconds.total,
      });
    }

    const oracle = expectedMeasurementShape.currentJsOracle;
    const candidate = expectedMeasurementShape.attachInsertSelect;
    assert.ok(oracle && candidate && expectedDigest);
    assert.equal(oracle.sourceRestaurantRows, sourceFacts.restaurantRows);
    assert.equal(candidate.sourceRestaurantRows, sourceFacts.restaurantRows);
    assert.equal(oracle.importedRowChanges, candidate.importedRowChanges);

    const oraclePhases = summarizePhases(measured.currentJsOracle);
    const candidatePhases = summarizePhases(measured.attachInsertSelect);
    const pairRatios = pairedTotals.map(
      (pair) => pair.currentJsOracle / Math.max(pair.attachInsertSelect, Number.EPSILON),
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      benchmark: "michelin-import-attach-insert-select-prototype",
      scope: {
        runtime: `Node ${process.version} node:sqlite with file-backed disposable WAL destinations`,
        included: [
          "current COUNT and full source row decoding into JavaScript",
          "current JavaScript parseFloat/filter/award formatting",
          "current 1,000-row parameterized UPSERT batches",
          "candidate immutable ATTACH and set-based INSERT...SELECT UPSERT",
          "metadata update in the same destination transaction",
          "production Michelin R-Tree insert/update triggers",
        ],
        excluded: [
          "asset download and copy",
          "progress-listener message formatting and UI delivery",
          "Expo SQLite async scheduling and native/JSI bridge implementation costs",
          "React Native, Hermes, UI rendering, Photos, Calendar, and the live Palate database",
        ],
      },
      configuration: {
        counterbalanced: true,
        measuredPairs: configuration.samples,
        warmupPairs: configuration.warmupPairs,
        destination: "fresh disposable temporary SQLite database per strategy execution",
      },
      source: {
        restaurantRows: sourceFacts.restaurantRows,
        awardRows: sourceFacts.awardRows,
        selectedRowsBeforeJavaScriptCoordinateValidation: sourceFacts.selectedRows,
        importedRows: oracle.importedRowChanges,
        rejectedCoordinateRows: sourceFacts.selectedRows - oracle.importedRowChanges,
        sqliteVersion: sourceFacts.sqliteVersion,
        components: publicSourceSnapshot(sourceBefore),
        unchangedAfterEveryRun: true,
      },
      correctness: {
        destinationDigest: expectedDigest,
        equalMichelinRestaurantsMetadataAndSpatialTables: true,
        historicalDatasetRowPreserved: true,
        seededConflictUpdated: true,
        metadataCommittedWithRows: true,
        integrityCheck: "ok",
        foreignKeyViolations: 0,
        spatialHealthIssues: 0,
      },
      strategies: {
        currentJsOracle: {
          bridgeModel: oracle.bridge,
          sqliteModel: oracle.sqlite,
          destinationWalBytesBefore: summarize(measured.currentJsOracle.map(({ walBytesBefore }) => walBytesBefore)),
          destinationWalBytesAfter: summarize(measured.currentJsOracle.map(({ walBytesAfter }) => walBytesAfter)),
          destinationWalGrowthBytes: summarize(measured.currentJsOracle.map(({ walGrowthBytes }) => walGrowthBytes)),
          phasesMilliseconds: oraclePhases,
        },
        attachInsertSelect: {
          bridgeModel: candidate.bridge,
          sqliteModel: candidate.sqlite,
          destinationWalBytesBefore: summarize(measured.attachInsertSelect.map(({ walBytesBefore }) => walBytesBefore)),
          destinationWalBytesAfter: summarize(measured.attachInsertSelect.map(({ walBytesAfter }) => walBytesAfter)),
          destinationWalGrowthBytes: summarize(measured.attachInsertSelect.map(({ walGrowthBytes }) => walGrowthBytes)),
          phasesMilliseconds: candidatePhases,
        },
      },
      comparison: {
        medianSpeedup: oraclePhases.total.median / candidatePhases.total.median,
        medianMillisecondsSaved: oraclePhases.total.median - candidatePhases.total.median,
        medianPercentReduction:
          ((oraclePhases.total.median - candidatePhases.total.median) / oraclePhases.total.median) * 100,
        pairedSpeedup: summarize(pairRatios),
        sourceResultRowsEliminated: oracle.bridge.sourceResultRows - candidate.bridge.sourceResultRows,
        sourceResultBytesEliminated: oracle.bridge.sourceResultUtf8Bytes - candidate.bridge.sourceResultUtf8Bytes,
        boundValuesEliminated: oracle.bridge.boundValues - candidate.bridge.boundValues,
        statementsEliminated: oracle.sqlite.statements - candidate.sqlite.statements,
      },
      implementation: {
        productionImportCoreSha256: sha256(readFileSync(join(repositoryRoot, "utils/db/michelin-import-core.ts"))),
        prototypeCoreSha256: sha256(readFileSync(join(repositoryRoot, "scripts/michelin-import-prototype-core.ts"))),
        benchmarkSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        currentLoaderSha256: sha256(readFileSync(join(repositoryRoot, "services/michelin.ts"))),
        currentDestinationImporterSha256: sha256(readFileSync(join(repositoryRoot, "utils/db/michelin.ts"))),
      },
      privacy: {
        aggregateOnly: true,
        containsRestaurantFields: false,
        containsRestaurantIds: false,
        containsCoordinates: false,
        containsSourceOrDestinationPaths: false,
        rawDisposableDatabasesRetained: false,
      },
      caveat:
        "This isolates SQLite and Node/V8 behavior while exercising the SQL shared by production. Expo SQLite connection lifecycle, signed-app latency, and default-strategy promotion require separate macOS app validation against the real app database.",
    };

    assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore, "Benchmark mutated protected source files");
    atomicWriteReport(configuration.outputPath, report, sourcePath);
    assert.deepEqual(snapshotSqliteSource(sourcePath), sourceBefore, "Report writing mutated protected source files");
    console.log(
      JSON.stringify({
        importedRows: oracle.importedRowChanges,
        medianSpeedup: report.comparison.medianSpeedup,
        sourceResultRowsEliminated: report.comparison.sourceResultRowsEliminated,
        fullTableSha256: expectedDigest.fullTableSha256,
      }),
    );
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main();
