#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL,
  HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL,
  MAX_MICHELIN_NAME_SEARCH_RESULTS,
  MICHELIN_NAME_SEARCH_DEBOUNCE_MS,
  createMichelinUnicodeNameIndex,
  isNonAsciiMichelinNameSearchQuery,
  normalizeMichelinNameSearchQuery,
  selectSortedMichelinUnicodeMatchIds,
  type MichelinUnicodeNameIndexRow,
  type MichelinUnicodeNameRow,
} from "../utils/db/michelin-name-search-core.ts";

interface Configuration {
  readonly measuredRuns: number;
  readonly warmupRuns: number;
}

interface SourceRestaurantRow {
  readonly id: number | string;
  readonly name: string | null;
  readonly latitude: number | string | null;
  readonly longitude: number | string | null;
  readonly address: string | null;
  readonly location: string | null;
  readonly cuisine: string | null;
  readonly latest_distinction: string | null;
  readonly latest_year: number | null;
  readonly has_green_star: number | string | Uint8Array | null;
}

interface MichelinSearchRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly location: string | null;
  readonly cuisine: string | null;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion: string | null;
}

interface FileSnapshot {
  readonly exists: boolean;
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

interface TransferMetrics {
  readonly jsToNativeParameterBytes: number;
  readonly nativeToJsBytes: number;
  readonly nativeToJsRows: number;
  readonly sqliteCalls: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly result: readonly MichelinSearchRow[];
  readonly retainedIndex: readonly MichelinUnicodeNameIndexRow[] | null;
  readonly rssDeltaBytes: number;
  readonly transfer: TransferMetrics;
}

interface TimingSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

interface IntegerSummary {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly p95: number;
  readonly samples: readonly number[];
}

interface StrategySamples {
  readonly elapsedMilliseconds: number[];
  readonly rssDeltaBytes: number[];
  transfer: TransferMetrics | null;
}

interface CandidateCacheState {
  index: readonly MichelinUnicodeNameIndexRow[] | null;
  readonly results: Map<string, readonly MichelinSearchRow[]>;
}

interface SearchEvent {
  readonly atMilliseconds: number;
  readonly query: string;
}

interface TraceMeasurement {
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly elapsedMilliseconds: number;
  readonly executedNormalizedQueries: readonly string[];
  readonly finalResult: readonly MichelinSearchRow[];
  readonly logicalSearchExecutions: number;
  readonly resultSequenceSha256: string;
  readonly transfer: TransferMetrics;
}

interface Workload {
  readonly label: string;
  readonly query: string;
}

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE_PATH = join(REPOSITORY_ROOT, "assets", "michelin.db");
const REPORT_PATH = join(REPOSITORY_ROOT, ".build", "michelin-name-search-profile.json");
const CORE_PATH = join(REPOSITORY_ROOT, "utils", "db", "michelin-name-search-core.ts");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DATASET_KEY = "michelin_dataset_version";
const DATASET_VERSION = "benchmark-bundled-guide";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

const SOURCE_RESTAURANTS_SQL = `SELECT
  r.id,
  r.name,
  r.latitude,
  r.longitude,
  r.address,
  r.location,
  r.cuisine,
  a.distinction AS latest_distinction,
  a.year AS latest_year,
  a.green_star AS has_green_star
FROM restaurants r
LEFT JOIN (
  SELECT award.*
  FROM restaurant_awards award
  INNER JOIN (
    SELECT restaurant_id, MAX(year) AS max_year
    FROM restaurant_awards
    GROUP BY restaurant_id
  ) latest
    ON latest.restaurant_id = award.restaurant_id
   AND latest.max_year = award.year
) a ON a.restaurant_id = r.id
WHERE r.latitude IS NOT NULL
  AND r.longitude IS NOT NULL
  AND r.latitude != ''
  AND r.longitude != ''`;

const LEGACY_ACTIVE_UNVISITED_FULL_ROWS_SQL = `SELECT m.*
FROM michelin_restaurants m
WHERE (
    NOT EXISTS (
      SELECT 1 FROM app_metadata WHERE key = ?
    ) OR m.datasetVersion = (
      SELECT value FROM app_metadata WHERE key = ?
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM visits v
    WHERE v.restaurantId = m.id AND v.status = 'confirmed'
  )`;

const WORKLOADS: readonly Workload[] = [
  { label: "broad-composed-accent", query: "é" },
  { label: "selective-composed-accent", query: "épi" },
  { label: "decomposed-accent", query: "e\u0301" },
  { label: "turkish-dotted-capital-i", query: "İ" },
  { label: "mixed-literal-wildcards", query: "é%_\\" },
];

const RAPID_TYPING_EVENTS: readonly SearchEvent[] = [
  { atMilliseconds: 0, query: "é" },
  { atMilliseconds: 60, query: "ép" },
  { atMilliseconds: 120, query: "épi" },
];

const BACKSPACE_EVENTS: readonly SearchEvent[] = [
  { atMilliseconds: 0, query: "épi" },
  { atMilliseconds: 300, query: "ép" },
  { atMilliseconds: 600, query: "épi" },
];

function usage(): string {
  return `Usage: benchmark-michelin-name-search.ts [options]

  --samples=N  Measured runs per strategy (default: 11)
  --warmup=N   Warmup runs per strategy (default: 3)
  --help, -h   Show this help

The bundled assets/michelin.db is always opened with node:sqlite readOnly=true
and PRAGMA query_only=ON. Imported guide rows and synthetic visit exclusions
exist only in an in-memory SQLite database. The aggregate report is always
written to .build/michelin-name-search-profile.json with mode 0600.`;
}

function parsePositiveInteger(value: string, option: string, allowZero: boolean): number {
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
  let measuredRuns = 11;
  let warmupRuns = 3;
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
    switch (option) {
      case "--samples":
        measuredRuns = parsePositiveInteger(value, option, false);
        break;
      case "--warmup":
        warmupRuns = parsePositiveInteger(value, option, true);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return { measuredRuns, warmupRuns };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, bytes: null, mode: null, sha256: null };
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Protected source component is not a regular non-symlink file: ${path}`);
  }
  return {
    exists: true,
    bytes: metadata.size,
    mode: metadata.mode & 0o7777,
    sha256: sha256(readFileSync(path)),
  };
}

function snapshotSource(): SourceSnapshot {
  return {
    main: fileSnapshot(GUIDE_PATH),
    wal: fileSnapshot(`${GUIDE_PATH}-wal`),
    shm: fileSnapshot(`${GUIDE_PATH}-shm`),
    journal: fileSnapshot(`${GUIDE_PATH}-journal`),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function addTransfer(left: TransferMetrics, right: TransferMetrics): TransferMetrics {
  return {
    jsToNativeParameterBytes: left.jsToNativeParameterBytes + right.jsToNativeParameterBytes,
    nativeToJsBytes: left.nativeToJsBytes + right.nativeToJsBytes,
    nativeToJsRows: left.nativeToJsRows + right.nativeToJsRows,
    sqliteCalls: left.sqliteCalls + right.sqliteCalls,
  };
}

function emptyTransfer(): TransferMetrics {
  return { jsToNativeParameterBytes: 0, nativeToJsBytes: 0, nativeToJsRows: 0, sqliteCalls: 0 };
}

function canonicalizeRow(row: MichelinSearchRow): MichelinSearchRow {
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
    datasetVersion: row.datasetVersion,
  };
}

function transformSourceRow(row: SourceRestaurantRow): MichelinSearchRow | null {
  const latitude = Number.parseFloat(String(row.latitude));
  const longitude = Number.parseFloat(String(row.longitude));
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }
  let award = row.latest_distinction ?? "";
  if (row.has_green_star) {
    award = award ? `${award}, Green Star` : "Green Star";
  }
  return {
    id: `michelin-${String(row.id)}`,
    name: row.name ?? "",
    latitude,
    longitude,
    address: row.address,
    location: row.location,
    cuisine: row.cuisine,
    latestAwardYear: row.latest_year,
    award,
    datasetVersion: DATASET_VERSION,
  };
}

function totalChanges(database: DatabaseSync): number {
  const result = database.prepare("SELECT total_changes() AS count").get() as { count?: unknown } | undefined;
  if (typeof result?.count !== "number") {
    throw new TypeError("SQLite total_changes() did not return a number");
  }
  return result.count;
}

function readBundledGuide(): {
  readonly importedRows: MichelinSearchRow[];
  readonly selectedSourceRows: number;
  readonly sourceTableRows: number;
} {
  if (!existsSync(GUIDE_PATH) || !statSync(GUIDE_PATH).isFile()) {
    throw new Error(`Bundled Michelin guide does not exist: ${GUIDE_PATH}`);
  }
  for (const suffix of ["-wal", "-journal"] as const) {
    const sidecar = `${GUIDE_PATH}${suffix}`;
    if (existsSync(sidecar) && statSync(sidecar).size > 0) {
      throw new Error(`Bundled guide has a non-empty ${suffix.slice(1)} sidecar`);
    }
  }

  const database = new DatabaseSync(GUIDE_PATH, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const changesBefore = totalChanges(database);
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    assert.equal(integrity?.integrity_check, "ok", "bundled guide integrity_check must pass");
    const sourceTableCount = database.prepare("SELECT COUNT(*) AS count FROM restaurants").get() as {
      count: number;
    };
    const sourceRows = database.prepare(SOURCE_RESTAURANTS_SQL).all() as unknown as SourceRestaurantRow[];
    const importedRows = sourceRows.flatMap((row) => {
      const transformed = transformSourceRow(row);
      return transformed === null ? [] : [transformed];
    });
    assert.equal(totalChanges(database), changesBefore, "read-only guide connection must not record writes");
    return {
      importedRows,
      selectedSourceRows: sourceRows.length,
      sourceTableRows: sourceTableCount.count,
    };
  } finally {
    database.close();
  }
}

function createMainDatabase(importedRows: readonly MichelinSearchRow[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      location TEXT,
      cuisine TEXT,
      latestAwardYear INTEGER,
      award TEXT NOT NULL,
      datasetVersion TEXT
    );
    CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX idx_visits_restaurant_status ON visits(restaurantId, status);
  `);
  const insert = database.prepare(`INSERT INTO michelin_restaurants
    (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  database.exec("BEGIN");
  try {
    for (const row of importedRows) {
      insert.run(
        row.id,
        row.name,
        row.latitude,
        row.longitude,
        row.address,
        row.location,
        row.cuisine,
        row.latestAwardYear,
        row.award,
        row.datasetVersion,
      );
    }
    database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run(DATASET_KEY, DATASET_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    database.close();
    throw error;
  }
  return database;
}

function addSyntheticVisitExclusions(database: DatabaseSync, importedRows: readonly MichelinSearchRow[]): number {
  const index = createMichelinUnicodeNameIndex(importedRows);
  const confirmedIds = new Set<string>();
  for (const workload of WORKLOADS) {
    const normalizedQuery = normalizeMichelinNameSearchQuery(workload.query);
    const matchingIds = selectSortedMichelinUnicodeMatchIds(index, normalizedQuery);
    const exclusionCount = Math.min(workload.label === "broad-composed-accent" ? 75 : 5, matchingIds.length - 1);
    for (const id of matchingIds.slice(0, Math.max(0, exclusionCount))) {
      confirmedIds.add(id);
    }
  }

  const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, ?)");
  database.exec("BEGIN");
  try {
    let ordinal = 0;
    for (const id of confirmedIds) {
      insertVisit.run(`confirmed-${ordinal}`, id, "confirmed");
      ordinal += 1;
    }
    const nonExcludedIds = importedRows
      .filter((row) => !confirmedIds.has(row.id))
      .slice(0, 20)
      .map((row) => row.id);
    for (const [index_, id] of nonExcludedIds.entries()) {
      insertVisit.run(`pending-${index_}`, id, index_ % 2 === 0 ? "pending" : "rejected");
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
  return confirmedIds.size;
}

function executeLegacy(database: DatabaseSync, normalizedQuery: string): Measurement {
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const parameters = [DATASET_KEY, DATASET_KEY] as const;
  const transferredRows = database
    .prepare(LEGACY_ACTIVE_UNVISITED_FULL_ROWS_SQL)
    .all(...parameters) as unknown as MichelinSearchRow[];
  const result = transferredRows
    .filter((restaurant) => restaurant.name.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, MAX_MICHELIN_NAME_SEARCH_RESULTS)
    .map(canonicalizeRow);
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    result,
    retainedIndex: null,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    transfer: {
      jsToNativeParameterBytes: jsonBytes(parameters),
      nativeToJsBytes: jsonBytes(transferredRows),
      nativeToJsRows: transferredRows.length,
      sqliteCalls: 1,
    },
  };
}

function executeCandidate(
  database: DatabaseSync,
  normalizedQuery: string,
  cachedIndex: readonly MichelinUnicodeNameIndexRow[] | null,
): Measurement {
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  let index = cachedIndex;
  let transfer = emptyTransfer();
  const datasetParameters = [DATASET_KEY] as const;
  const datasetRow = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(...datasetParameters) as
    | { value: string }
    | undefined;
  assert.equal(datasetRow?.value, DATASET_VERSION, "candidate cache key must resolve the active dataset version");
  transfer = addTransfer(transfer, {
    jsToNativeParameterBytes: jsonBytes(datasetParameters),
    nativeToJsBytes: jsonBytes(datasetRow),
    nativeToJsRows: datasetRow ? 1 : 0,
    sqliteCalls: 1,
  });
  if (index === null) {
    const indexParameters = [DATASET_KEY, DATASET_KEY] as const;
    const nameRows = database
      .prepare(ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL)
      .all(...indexParameters) as unknown as MichelinUnicodeNameRow[];
    index = createMichelinUnicodeNameIndex(nameRows);
    transfer = addTransfer(transfer, {
      jsToNativeParameterBytes: jsonBytes(indexParameters),
      nativeToJsBytes: jsonBytes(nameRows),
      nativeToJsRows: nameRows.length,
      sqliteCalls: 1,
    });
  }

  const sortedMatchingIds = selectSortedMichelinUnicodeMatchIds(index, normalizedQuery);
  let result: MichelinSearchRow[] = [];
  if (sortedMatchingIds.length > 0) {
    const hydrationParameters = [
      JSON.stringify(sortedMatchingIds),
      DATASET_KEY,
      DATASET_KEY,
      MAX_MICHELIN_NAME_SEARCH_RESULTS,
    ] as const;
    const hydratedRows = database
      .prepare(HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL)
      .all(...hydrationParameters) as unknown as MichelinSearchRow[];
    result = hydratedRows.map(canonicalizeRow);
    transfer = addTransfer(transfer, {
      jsToNativeParameterBytes: jsonBytes(hydrationParameters),
      nativeToJsBytes: jsonBytes(hydratedRows),
      nativeToJsRows: hydratedRows.length,
      sqliteCalls: 1,
    });
  }
  const datasetRowAfter = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(...datasetParameters) as
    | { value: string }
    | undefined;
  assert.deepEqual(datasetRowAfter, datasetRow, "candidate must finish on the dataset version used for selection");
  transfer = addTransfer(transfer, {
    jsToNativeParameterBytes: jsonBytes(datasetParameters),
    nativeToJsBytes: jsonBytes(datasetRowAfter),
    nativeToJsRows: datasetRowAfter ? 1 : 0,
    sqliteCalls: 1,
  });
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    result,
    retainedIndex: index,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    transfer,
  };
}

function executeCandidateWithCache(
  database: DatabaseSync,
  rawQuery: string,
  cache: CandidateCacheState,
): { readonly cacheHit: boolean; readonly measurement: Measurement } {
  const normalizedQuery = normalizeMichelinNameSearchQuery(rawQuery);
  const startedAt = performance.now();
  const cachedResult = cache.results.get(normalizedQuery);
  if (cachedResult !== undefined) {
    return {
      cacheHit: true,
      measurement: {
        elapsedMilliseconds: performance.now() - startedAt,
        result: cachedResult,
        retainedIndex: cache.index,
        rssDeltaBytes: 0,
        transfer: emptyTransfer(),
      },
    };
  }
  const measurement = executeCandidate(database, normalizedQuery, cache.index);
  cache.index = measurement.retainedIndex;
  cache.results.set(normalizedQuery, measurement.result);
  return { cacheHit: false, measurement };
}

function summarizeTiming(samples: readonly number[]): TimingSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
    samplesMilliseconds: [...samples],
  };
}

function summarizeIntegers(samples: readonly number[]): IntegerSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    minimum: sorted[0]!,
    median: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximum: sorted.at(-1)!,
    samples: [...samples],
  };
}

function assertStableTransfer(samples: StrategySamples, measurement: Measurement): void {
  if (samples.transfer === null) {
    samples.transfer = measurement.transfer;
  } else {
    assert.deepEqual(measurement.transfer, samples.transfer, "strategy transfer metrics must be deterministic");
  }
}

function createStrategySamples(): StrategySamples {
  return { elapsedMilliseconds: [], rssDeltaBytes: [], transfer: null };
}

function strategyReport(samples: StrategySamples): Record<string, unknown> {
  assert.ok(samples.transfer !== null);
  return {
    transfer: samples.transfer,
    nodeModelTiming: summarizeTiming(samples.elapsedMilliseconds),
    processRssDeltaBytes: summarizeIntegers(samples.rssDeltaBytes),
  };
}

function pickDebouncedEvents(events: readonly SearchEvent[]): SearchEvent[] {
  const selected: SearchEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index]!;
    const next = events[index + 1];
    if (!next || next.atMilliseconds - current.atMilliseconds > MICHELIN_NAME_SEARCH_DEBOUNCE_MS) {
      selected.push(current);
    }
  }
  return selected;
}

function executeLegacyTrace(database: DatabaseSync, events: readonly SearchEvent[]): TraceMeasurement {
  let transfer = emptyTransfer();
  let elapsedMilliseconds = 0;
  const resultSequence: Array<readonly MichelinSearchRow[]> = [];
  for (const event of events) {
    const measurement = executeLegacy(database, normalizeMichelinNameSearchQuery(event.query));
    transfer = addTransfer(transfer, measurement.transfer);
    elapsedMilliseconds += measurement.elapsedMilliseconds;
    resultSequence.push(measurement.result);
  }
  return {
    cacheHits: 0,
    cacheMisses: events.length,
    elapsedMilliseconds,
    executedNormalizedQueries: events.map((event) => normalizeMichelinNameSearchQuery(event.query)),
    finalResult: resultSequence.at(-1) ?? [],
    logicalSearchExecutions: events.length,
    resultSequenceSha256: sha256(JSON.stringify(resultSequence)),
    transfer,
  };
}

function executeCandidateTrace(
  database: DatabaseSync,
  events: readonly SearchEvent[],
  applyDebounce: boolean,
  prewarmQueries: readonly string[] = [],
): TraceMeasurement {
  const cache: CandidateCacheState = { index: null, results: new Map() };
  for (const query of prewarmQueries) {
    executeCandidateWithCache(database, query, cache);
  }
  const executedEvents = applyDebounce ? pickDebouncedEvents(events) : [...events];
  let transfer = emptyTransfer();
  let elapsedMilliseconds = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const resultSequence: Array<readonly MichelinSearchRow[]> = [];
  for (const event of executedEvents) {
    const execution = executeCandidateWithCache(database, event.query, cache);
    cacheHits += execution.cacheHit ? 1 : 0;
    cacheMisses += execution.cacheHit ? 0 : 1;
    transfer = addTransfer(transfer, execution.measurement.transfer);
    elapsedMilliseconds += execution.measurement.elapsedMilliseconds;
    resultSequence.push(execution.measurement.result);
  }
  return {
    cacheHits,
    cacheMisses,
    elapsedMilliseconds,
    executedNormalizedQueries: executedEvents.map((event) => normalizeMichelinNameSearchQuery(event.query)),
    finalResult: resultSequence.at(-1) ?? [],
    logicalSearchExecutions: executedEvents.length,
    resultSequenceSha256: sha256(JSON.stringify(resultSequence)),
    transfer,
  };
}

function traceReport(
  legacySamples: readonly TraceMeasurement[],
  candidateSamples: readonly TraceMeasurement[],
): Record<string, unknown> {
  assert.ok(legacySamples.length > 0 && candidateSamples.length > 0);
  const legacy = legacySamples[0]!;
  const candidate = candidateSamples[0]!;
  for (const sample of legacySamples) {
    assert.deepEqual(sample.transfer, legacy.transfer);
    assert.equal(sample.cacheHits, legacy.cacheHits);
    assert.equal(sample.cacheMisses, legacy.cacheMisses);
    assert.deepEqual(sample.executedNormalizedQueries, legacy.executedNormalizedQueries);
  }
  for (const sample of candidateSamples) {
    assert.deepEqual(sample.transfer, candidate.transfer);
    assert.equal(sample.cacheHits, candidate.cacheHits);
    assert.equal(sample.cacheMisses, candidate.cacheMisses);
    assert.deepEqual(sample.executedNormalizedQueries, candidate.executedNormalizedQueries);
  }
  return {
    legacyCurrentBehavior: {
      cacheHits: legacy.cacheHits,
      cacheMisses: legacy.cacheMisses,
      executedQueryCount: legacy.logicalSearchExecutions,
      sqliteCalls: legacy.transfer.sqliteCalls,
      nativeToJsRows: legacy.transfer.nativeToJsRows,
      nativeToJsBytes: legacy.transfer.nativeToJsBytes,
      resultSequenceSha256: legacy.resultSequenceSha256,
      nodeModelWorkTiming: summarizeTiming(legacySamples.map((sample) => sample.elapsedMilliseconds)),
    },
    candidateBehavior: {
      cacheHits: candidate.cacheHits,
      cacheMisses: candidate.cacheMisses,
      executedQueryCount: candidate.logicalSearchExecutions,
      sqliteCalls: candidate.transfer.sqliteCalls,
      nativeToJsRows: candidate.transfer.nativeToJsRows,
      nativeToJsBytes: candidate.transfer.nativeToJsBytes,
      resultSequenceSha256: candidate.resultSequenceSha256,
      nodeModelWorkTiming: summarizeTiming(candidateSamples.map((sample) => sample.elapsedMilliseconds)),
    },
  };
}

function assertReportTargetIsSafe(): void {
  const buildDirectory = dirname(REPORT_PATH);
  if (existsSync(buildDirectory)) {
    const metadata = lstatSync(buildDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(".build must be a real directory, not a file or symbolic link");
    }
  }
  if (!existsSync(REPORT_PATH)) {
    return;
  }
  const outputMetadata = lstatSync(REPORT_PATH);
  if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink()) {
    throw new Error("Benchmark report target must be a regular non-symlink file");
  }
  for (const path of [GUIDE_PATH, ...SIDECAR_SUFFIXES.map((suffix) => `${GUIDE_PATH}${suffix}`)]) {
    if (!existsSync(path)) {
      continue;
    }
    const sourceMetadata = statSync(path);
    if (sourceMetadata.dev === outputMetadata.dev && sourceMetadata.ino === outputMetadata.ino) {
      throw new Error("Benchmark report target aliases the bundled guide or a sidecar");
    }
  }
}

function writeReport(report: Record<string, unknown>): void {
  assertReportTargetIsSafe();
  mkdirSync(dirname(REPORT_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(REPORT_PATH, 0o600);
}

function run(configuration: Configuration): void {
  const sourceBefore = snapshotSource();
  const guide = readBundledGuide();
  const sourceAfterRead = snapshotSource();
  assert.deepEqual(sourceAfterRead, sourceBefore, "read-only guide loading must not change any SQLite component");
  assert.ok(guide.importedRows.length > 0, "bundled guide must contain importable rows");

  const database = createMainDatabase(guide.importedRows);
  let report: Record<string, unknown>;
  try {
    const confirmedVisitExclusions = addSyntheticVisitExclusions(database, guide.importedRows);
    const allUnicodeNameRows = database
      .prepare(ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL)
      .all(DATASET_KEY, DATASET_KEY) as unknown as MichelinUnicodeNameRow[];
    const retainedIndex = createMichelinUnicodeNameIndex(allUnicodeNameRows);
    const fullActiveRows = database
      .prepare(
        `SELECT m.* FROM michelin_restaurants m
         WHERE m.datasetVersion = (SELECT value FROM app_metadata WHERE key = ?)`,
      )
      .all(DATASET_KEY) as unknown as MichelinSearchRow[];

    const workloadReports: Record<string, unknown> = {};
    for (const workload of WORKLOADS) {
      const normalizedQuery = normalizeMichelinNameSearchQuery(workload.query);
      assert.ok(isNonAsciiMichelinNameSearchQuery(normalizedQuery), `${workload.label} must exercise Unicode path`);
      const oracle = executeLegacy(database, normalizedQuery);
      const coldCandidate = executeCandidate(database, normalizedQuery, null);
      const warmCandidate = executeCandidate(database, normalizedQuery, retainedIndex);
      assert.deepEqual(coldCandidate.result, oracle.result, `${workload.label} cold candidate must match legacy`);
      assert.deepEqual(warmCandidate.result, oracle.result, `${workload.label} warm candidate must match legacy`);

      const resultCache: CandidateCacheState = { index: retainedIndex, results: new Map() };
      const miss = executeCandidateWithCache(database, workload.query, resultCache);
      const hit = executeCandidateWithCache(database, `  ${workload.query}  `, resultCache);
      assert.equal(miss.cacheHit, false);
      assert.equal(hit.cacheHit, true);
      assert.deepEqual(hit.measurement.result, oracle.result);
      assert.deepEqual(hit.measurement.transfer, emptyTransfer());

      const samples = {
        legacy: createStrategySamples(),
        candidateCold: createStrategySamples(),
        candidateWarmIndex: createStrategySamples(),
        candidateResultCacheHit: createStrategySamples(),
      };
      const iterations = configuration.warmupRuns + configuration.measuredRuns;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const order = ["legacy", "candidateCold", "candidateWarmIndex"] as const;
        const rotated = order.map((_, index) => order[(index + iteration) % order.length]!);
        for (const strategy of rotated) {
          const measurement =
            strategy === "legacy"
              ? executeLegacy(database, normalizedQuery)
              : strategy === "candidateCold"
                ? executeCandidate(database, normalizedQuery, null)
                : executeCandidate(database, normalizedQuery, retainedIndex);
          assert.deepEqual(measurement.result, oracle.result);
          if (iteration >= configuration.warmupRuns) {
            assertStableTransfer(samples[strategy], measurement);
            samples[strategy].elapsedMilliseconds.push(measurement.elapsedMilliseconds);
            samples[strategy].rssDeltaBytes.push(measurement.rssDeltaBytes);
          }
        }

        const cache: CandidateCacheState = {
          index: retainedIndex,
          results: new Map([[normalizedQuery, oracle.result]]),
        };
        const cacheHit = executeCandidateWithCache(database, workload.query, cache);
        assert.equal(cacheHit.cacheHit, true);
        assert.deepEqual(cacheHit.measurement.result, oracle.result);
        if (iteration >= configuration.warmupRuns) {
          assertStableTransfer(samples.candidateResultCacheHit, cacheHit.measurement);
          samples.candidateResultCacheHit.elapsedMilliseconds.push(cacheHit.measurement.elapsedMilliseconds);
          samples.candidateResultCacheHit.rssDeltaBytes.push(cacheHit.measurement.rssDeltaBytes);
        }
      }

      assert.ok(samples.legacy.transfer !== null && samples.candidateCold.transfer !== null);
      const coldReduction =
        ((samples.legacy.transfer.nativeToJsBytes - samples.candidateCold.transfer.nativeToJsBytes) /
          samples.legacy.transfer.nativeToJsBytes) *
        100;
      assert.ok(coldReduction >= 90, `${workload.label} cold candidate must reduce native-to-JS bytes by at least 90%`);
      const resultSha256 = sha256(JSON.stringify(oracle.result));
      const matchingIds = selectSortedMichelinUnicodeMatchIds(retainedIndex, normalizedQuery);
      const legacyTiming = summarizeTiming(samples.legacy.elapsedMilliseconds);
      const coldTiming = summarizeTiming(samples.candidateCold.elapsedMilliseconds);
      const warmTiming = summarizeTiming(samples.candidateWarmIndex.elapsedMilliseconds);
      workloadReports[workload.label] = {
        query: {
          rawCodePoints: Array.from(
            workload.query,
            (character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`,
          ),
          normalizedCodePoints: Array.from(
            normalizedQuery,
            (character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`,
          ),
          rawUtf8Bytes: Buffer.byteLength(workload.query),
          normalizedUtf8Bytes: Buffer.byteLength(normalizedQuery),
        },
        sortedMatchingIdsBeforeVisitExclusion: matchingIds.length,
        returnedRows: oracle.result.length,
        exactResultSha256: resultSha256,
        strategies: {
          legacyFullActiveTransfer: strategyReport(samples.legacy),
          candidateColdIndex: strategyReport(samples.candidateCold),
          candidateWarmIndex: strategyReport(samples.candidateWarmIndex),
          candidateResultCacheHit: strategyReport(samples.candidateResultCacheHit),
        },
        comparison: {
          coldNativeToJsReductionPercent: coldReduction,
          coldMedianSpeedup: legacyTiming.medianMilliseconds / coldTiming.medianMilliseconds,
          warmIndexMedianSpeedup: legacyTiming.medianMilliseconds / warmTiming.medianMilliseconds,
          exactOrderedResultsMatch: true,
        },
      };
    }

    const rapidLegacySamples: TraceMeasurement[] = [];
    const rapidCandidateSamples: TraceMeasurement[] = [];
    const backspaceLegacySamples: TraceMeasurement[] = [];
    const backspaceCandidateSamples: TraceMeasurement[] = [];
    const traceIterations = configuration.warmupRuns + configuration.measuredRuns;
    for (let iteration = 0; iteration < traceIterations; iteration += 1) {
      const rapidLegacy = executeLegacyTrace(database, RAPID_TYPING_EVENTS);
      const rapidCandidate = executeCandidateTrace(database, RAPID_TYPING_EVENTS, true);
      assert.deepEqual(
        rapidCandidate.finalResult,
        rapidLegacy.finalResult,
        "debounced rapid trace final result must match",
      );

      const backspaceLegacy = executeLegacyTrace(database, BACKSPACE_EVENTS);
      const backspaceCandidate = executeCandidateTrace(database, BACKSPACE_EVENTS, false, ["épi"]);
      assert.deepEqual(
        backspaceCandidate.finalResult,
        backspaceLegacy.finalResult,
        "backspace final result must match",
      );
      if (iteration >= configuration.warmupRuns) {
        rapidLegacySamples.push(rapidLegacy);
        rapidCandidateSamples.push(rapidCandidate);
        backspaceLegacySamples.push(backspaceLegacy);
        backspaceCandidateSamples.push(backspaceCandidate);
      }
    }
    assert.equal(rapidCandidateSamples[0]!.logicalSearchExecutions, 1);
    assert.equal(backspaceCandidateSamples[0]!.cacheMisses, 1);
    assert.equal(backspaceCandidateSamples[0]!.cacheHits, 2);

    const reportSourceAfter = snapshotSource();
    assert.deepEqual(reportSourceAfter, sourceBefore, "benchmark must leave bundled guide and sidecars byte-identical");
    report = {
      schemaVersion: 1,
      status: "ok",
      generatedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        locale: new Intl.Collator().resolvedOptions().locale,
      },
      configuration: {
        measuredRuns: configuration.measuredRuns,
        warmupRuns: configuration.warmupRuns,
        maximumResults: MAX_MICHELIN_NAME_SEARCH_RESULTS,
        debounceMilliseconds: MICHELIN_NAME_SEARCH_DEBOUNCE_MS,
      },
      source: {
        relativePath: "assets/michelin.db",
        openOptions: { readOnly: true },
        pragmaQueryOnly: true,
        sourceTableRows: guide.sourceTableRows,
        selectedSourceRows: guide.selectedSourceRows,
        importedValidRows: guide.importedRows.length,
        before: sourceBefore,
        after: reportSourceAfter,
        byteIdentical: true,
      },
      isolatedMainDatabase: {
        storage: ":memory:",
        realNamesAndGuideFields: true,
        syntheticConfirmedVisitExclusions: confirmedVisitExclusions,
        livePalateDatabaseAccessed: false,
      },
      projection: {
        activeFullRowCount: fullActiveRows.length,
        activeFullRowsJsonUtf8Bytes: jsonBytes(fullActiveRows),
        unicodeNameRowCount: allUnicodeNameRows.length,
        unicodeNameRowsJsonUtf8Bytes: jsonBytes(allUnicodeNameRows),
        retainedIndexJsonUtf8Bytes: jsonBytes(retainedIndex),
        unicodeProjectionReductionVersusFullRowsPercent:
          ((jsonBytes(fullActiveRows) - jsonBytes(allUnicodeNameRows)) / jsonBytes(fullActiveRows)) * 100,
      },
      workloads: workloadReports,
      interactionModels: {
        rapidTyping: {
          inputOffsetsMilliseconds: RAPID_TYPING_EVENTS.map((event) => event.atMilliseconds),
          inputCount: RAPID_TYPING_EVENTS.length,
          debounceMilliseconds: MICHELIN_NAME_SEARCH_DEBOUNCE_MS,
          scheduledDebounceWaitExcludedFromWorkTiming: true,
          finalExactResultSha256: sha256(JSON.stringify(rapidLegacySamples[0]!.finalResult)),
          ...traceReport(rapidLegacySamples, rapidCandidateSamples),
        },
        backspaceAndResultCacheReuse: {
          inputOffsetsMilliseconds: BACKSPACE_EVENTS.map((event) => event.atMilliseconds),
          inputCount: BACKSPACE_EVENTS.length,
          prewarmedNormalizedResultCodePoints: Array.from(
            normalizeMichelinNameSearchQuery("épi"),
            (character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`,
          ),
          prewarmWorkExcludedFromTimingAndTransfer: true,
          finalExactResultSha256: sha256(JSON.stringify(backspaceLegacySamples[0]!.finalResult)),
          ...traceReport(backspaceLegacySamples, backspaceCandidateSamples),
        },
      },
      reproducibility: {
        bundledGuideSha256: sourceBefore.main.sha256,
        coreSourceSha256: sha256(readFileSync(CORE_PATH)),
        benchmarkSourceSha256: sha256(readFileSync(SCRIPT_PATH)),
      },
      assertions: {
        everyCandidateResultExactlyMatchesLiteralLegacyOracle: true,
        everyColdWorkloadReducesNativeToJsBytesByAtLeast90Percent: true,
        rapidTypingExecutesOneDebouncedLogicalSearch: true,
        backspaceReusesNormalizedResultCache: true,
        bundledGuideAndSidecarsByteIdentical: true,
        reportMode: "0600",
      },
      measurementModel: {
        includes: [
          "real bundled Michelin names and imported guide fields",
          "SQLite statement preparation, execution, and synchronous row decoding",
          "exact JavaScript toLowerCase/includes/localeCompare selection",
          "active dataset-version lookups before and after hydration",
          "ordered JSON-ID hydration and confirmed-visit exclusion",
          "cold Unicode projection/index creation, warm-index lookup, and result-cache-hit models",
        ],
        limitations: [
          "node:sqlite synchronous in-memory timings do not reproduce Expo SQLite async queueing or JSI bridge cost",
          "visit exclusions are synthetic and the live Palate database, Photos library, and Calendar are never accessed",
          "guide initialization/import and React rendering/input latency are outside timed regions",
          "debounce timing is a deterministic scheduling model; its 200 ms idle wait is reported but excluded from work timings",
          "RSS deltas are process-wide, allocator-dependent diagnostics and can be zero or negative",
          "native-to-JS and JS-to-native bytes are JSON UTF-8 payload models, not measured JSI wire bytes",
        ],
      },
      privacy: {
        aggregateOnly: true,
        rawRestaurantNamesOrIdsRetainedInReport: false,
      },
    };
  } finally {
    database.close();
  }

  const sourceAfter = snapshotSource();
  assert.deepEqual(sourceAfter, sourceBefore, "closed benchmark must leave bundled guide and sidecars byte-identical");
  writeReport(report);
  const serialized = JSON.stringify(report, null, 2);
  console.log(serialized);
  console.error(`Wrote ${resolve(REPORT_PATH)} (${Buffer.byteLength(serialized)} JSON bytes, mode 0600)`);
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
} else {
  run(configuration);
}
