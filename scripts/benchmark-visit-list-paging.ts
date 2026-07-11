#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  buildVisitsWithDetailsQuery,
  parseVisitDetailsRows,
  type VisitDetailsQueryRow,
} from "../utils/db/visit-details-core.ts";
import {
  DEFAULT_VISIT_LIST_PAGE_SIZE,
  buildVisitListPageQuery,
  parseVisitListPageRows,
  type VisitListCursor,
  type VisitListFilter,
  type VisitListItem,
  type VisitListPageRow,
} from "../utils/db/visit-list-paging-core.ts";

interface Configuration {
  databasePath: string | null;
  filter: BenchmarkFilter;
  visits: number;
  photos: number;
  pageSize: number;
  samples: number;
  warmupIterations: number;
  outputPath: string;
}

interface DatasetSummary {
  readonly visits: number;
  readonly photos: number;
  readonly restaurants: number;
  readonly suggestedRestaurants: number;
  readonly pendingVisits: number;
  readonly confirmedVisits: number;
  readonly rejectedVisits: number;
  readonly foodProbableVisits: number;
}

type Strategy = "eager-full" | "candidate-first-page" | "candidate-full-traversal";
type BenchmarkFilter = "all" | VisitListFilter;

interface TransferShape {
  readonly queryCalls: number;
  readonly sqliteRows: number;
  readonly outputRows: number;
  readonly sqliteRowsJsonEquivalentBytes: number;
  readonly slimOutputJsonEquivalentBytes: number;
  readonly maximumRowsPerCall: number;
  readonly maximumJsonEquivalentBytesPerCall: number;
}

interface Measurement extends TransferShape {
  readonly queryMilliseconds: number;
  readonly parseAndProjectionMilliseconds: number;
  readonly queryAndParseMilliseconds: number;
  readonly outputSha256: string;
}

interface Execution {
  readonly measurement: Measurement;
  readonly output: VisitListItem[];
}

interface TimingSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface StrategyTimingReport {
  readonly query: TimingSummary;
  readonly parseAndSlimProjection: TimingSummary;
  readonly queryAndParse: TimingSummary;
  readonly transferShape: TransferShape;
  readonly measuredOutputSha256: string[];
}

interface FileComponentSnapshot {
  readonly component: "main" | "wal" | "shm" | "journal";
  readonly present: boolean;
  readonly modeOctal: string | null;
  readonly sizeBytes: string | null;
  readonly device: string | null;
  readonly inode: string | null;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly components: FileComponentSnapshot[];
}

interface QueryPlanRow {
  readonly detail: string;
}

const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  filter: "all",
  visits: 6_511,
  photos: 68_028,
  pageSize: DEFAULT_VISIT_LIST_PAGE_SIZE,
  samples: 7,
  warmupIterations: 1,
  outputPath: resolve(".build/visit-list-paging-profile.json"),
};

const SQLITE_SIDECARS = [
  { suffix: "-wal", component: "wal" },
  { suffix: "-shm", component: "shm" },
  { suffix: "-journal", component: "journal" },
] as const;

function usage(): string {
  return `Usage: benchmark-visit-list-paging.ts [options]

  --database=PATH  Profile an existing Palate database with mode=ro and
                   immutable=1. A non-empty WAL/journal is rejected.
  --filter=FILTER  all, pending, confirmed, rejected, or food (default: all)
  --visits=N       Synthetic visits (default: ${DEFAULT_CONFIGURATION.visits})
  --photos=N       Synthetic photos (default: ${DEFAULT_CONFIGURATION.photos})
  --page-size=N    Candidate keyset page size (default: ${DEFAULT_CONFIGURATION.pageSize})
  --samples=N      Counterbalanced measured rounds (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Counterbalanced warmup rounds (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    Aggregate-only JSON report (default: .build/visit-list-paging-profile.json)
  --help, -h       Show this help

The eager strategy executes the literal current full visit-details query and
then projects its result to the fields rendered by All Visits. The candidate
strategies execute the production slim keyset query for one initial page and
for a complete compatibility traversal. JSON-equivalent byte accounting is
not included in query/parse timing.`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    switch (option) {
      case "--database":
        if (!value) {
          throw new RangeError("--database cannot be empty");
        }
        configuration.databasePath = resolve(value);
        break;
      case "--filter":
        if (!(["all", "pending", "confirmed", "rejected", "food"] as const).includes(value as BenchmarkFilter)) {
          throw new RangeError("--filter must be all, pending, confirmed, rejected, or food");
        }
        configuration.filter = value as BenchmarkFilter;
        break;
      case "--visits":
        configuration.visits = parseInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parseInteger(value, option, true);
        break;
      case "--page-size":
        configuration.pageSize = parseInteger(value, option);
        // Let the production builder enforce its public upper bound as well.
        buildVisitListPageQuery(undefined, null, configuration.pageSize);
        break;
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--output":
        if (!value) {
          throw new RangeError("--output cannot be empty");
        }
        configuration.outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function checksumRows(rows: readonly VisitListItem[]): string {
  return sha256(JSON.stringify(rows));
}

function productionFilter(filter: BenchmarkFilter): VisitListFilter | undefined {
  return filter === "all" ? undefined : filter;
}

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(databasePath);
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function canonicalizePotentialPath(path: string): string {
  const suffix: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function protectedSourcePaths(databasePath: string): string[] {
  return [databasePath, ...SQLITE_SIDECARS.map(({ suffix }) => `${databasePath}${suffix}`)];
}

function assertRegularNonSymlink(path: string, label: string): void {
  const identity = lstatSync(path);
  if (identity.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!identity.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

function prepareImmutableSource(databasePath: string): string {
  if (!existsSync(databasePath)) {
    throw new Error("Database source does not exist");
  }
  assertRegularNonSymlink(databasePath, "Database source");
  const canonicalMain = realpathSync(databasePath);
  for (const { suffix, component } of SQLITE_SIDECARS) {
    const sidecar = `${canonicalMain}${suffix}`;
    const sidecarIdentity = lstatIfPresent(sidecar);
    if (!sidecarIdentity) {
      continue;
    }
    assertRegularNonSymlink(sidecar, `SQLite ${component} sidecar`);
    if ((component === "wal" || component === "journal") && sidecarIdentity.size > 0) {
      throw new Error(`Immutable profiling requires an empty or absent ${component} sidecar`);
    }
  }
  return canonicalMain;
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  // existsSync follows links and returns false for a dangling link. lstat must
  // happen first so a dangling output can never be treated as absent.
  const outputIdentity = lstatIfPresent(outputPath);
  if (outputIdentity?.isSymbolicLink()) {
    throw new Error("Benchmark output must not be a symbolic link");
  }
  if (outputIdentity && !outputIdentity.isFile()) {
    throw new Error("Benchmark output must be a regular file when it already exists");
  }
  const outputCanonical = canonicalizePotentialPath(outputPath);
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or a SQLite sidecar");
    }
    const protectedIdentity = lstatIfPresent(protectedPath);
    if (outputIdentity && protectedIdentity) {
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not be a hard link to the source database or a SQLite sidecar");
      }
    }
  }
}

function snapshotSource(databasePath: string): SourceSnapshot {
  const componentSnapshot = (component: FileComponentSnapshot["component"], path: string): FileComponentSnapshot => {
    const identity = lstatIfPresent(path);
    if (!identity) {
      return {
        component,
        present: false,
        modeOctal: null,
        sizeBytes: null,
        device: null,
        inode: null,
        sha256: null,
      };
    }
    assert.ok(identity.isFile() && !identity.isSymbolicLink(), `${component} component must stay a regular file`);
    const bigintIdentity = lstatSync(path, { bigint: true });
    return {
      component,
      present: true,
      modeOctal: (bigintIdentity.mode & 0o7777n).toString(8),
      sizeBytes: bigintIdentity.size.toString(),
      device: bigintIdentity.dev.toString(),
      inode: bigintIdentity.ino.toString(),
      sha256: sha256File(path),
    };
  };
  return {
    components: [
      componentSnapshot("main", databasePath),
      ...SQLITE_SIDECARS.map(({ suffix, component }) => componentSnapshot(component, `${databasePath}${suffix}`)),
    ],
  };
}

function publishAggregateReport(outputPath: string, contents: string, databasePath: string | null): string {
  const descriptor = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const outputIdentity = fstatSync(descriptor);
    if (!outputIdentity.isFile()) {
      throw new Error("Benchmark output descriptor must reference a regular file");
    }
    if (databasePath) {
      for (const protectedPath of protectedSourcePaths(databasePath)) {
        const protectedIdentity = lstatIfPresent(protectedPath);
        if (
          protectedIdentity &&
          outputIdentity.dev === protectedIdentity.dev &&
          outputIdentity.ino === protectedIdentity.ino
        ) {
          throw new Error("Opened benchmark output must not be a hard link to a protected source component");
        }
      }
    }

    // Truncate only after the opened descriptor itself passes the hard-link
    // guard. O_NOFOLLOW closes the final-component symlink race.
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    assert.equal(fstatSync(descriptor).mode & 0o777, 0o600, "aggregate report mode must be 0600");
  } finally {
    closeSync(descriptor);
  }
  return sha256(contents);
}

function createSyntheticSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      award TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL,
      foodProbable INTEGER NOT NULL,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      notes TEXT,
      updatedAt INTEGER,
      exportedToCalendarId TEXT,
      awardAtVisit TEXT,
      FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
      FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER,
      FOREIGN KEY (visitId) REFERENCES visits(id)
    );

    CREATE INDEX idx_visits_time ON visits(startTime);
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_food_time ON visits(foodProbable, startTime DESC);
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
  `);
}

function seedSyntheticDatabase(database: DatabaseSync, configuration: Configuration): void {
  const restaurantCount = Math.max(1, Math.min(257, Math.ceil(configuration.visits / 5)));
  const suggestedRestaurantCount = Math.max(1, Math.min(181, Math.ceil(configuration.visits / 7)));
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertSuggestedRestaurant = database.prepare(
    "INSERT INTO michelin_restaurants (id, name, award) VALUES (?, ?, ?)",
  );
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      notes, updatedAt, exportedToCalendarId, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );

  const photosPerVisit = Math.floor(configuration.photos / configuration.visits);
  const visitsWithExtraPhoto = configuration.photos % configuration.visits;
  const baseTime = Date.UTC(2026, 6, 1, 19, 0, 0);
  let photoIndex = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < restaurantCount; index++) {
      insertRestaurant.run(`restaurant-${index.toString().padStart(4, "0")}`, `Synthetic Bistro ${index}`);
    }
    for (let index = 0; index < suggestedRestaurantCount; index++) {
      insertSuggestedRestaurant.run(
        `suggested-${index.toString().padStart(4, "0")}`,
        `Synthetic Guide Restaurant ${index}`,
        index % 4 === 0 ? "1 Star" : index % 4 === 1 ? "Bib Gourmand" : null,
      );
    }

    for (let index = 0; index < configuration.visits; index++) {
      const id = `visit-${index.toString().padStart(8, "0")}`;
      const photoCount = photosPerVisit + (index < visitsWithExtraPhoto ? 1 : 0);
      const hasFoodPhoto = photoCount > 0 && index % 3 === 0;
      const relationship = index % 5;
      const restaurantId =
        relationship === 0 || relationship === 2
          ? `restaurant-${(index % restaurantCount).toString().padStart(4, "0")}`
          : null;
      const suggestedRestaurantId =
        relationship === 1 || relationship === 2
          ? `suggested-${(index % suggestedRestaurantCount).toString().padStart(4, "0")}`
          : null;
      const startTime = baseTime - Math.floor(index / 3) * 60_000;
      const status = index % 7 === 0 ? "pending" : index % 11 === 0 ? "rejected" : "confirmed";
      insertVisit.run(
        id,
        restaurantId,
        suggestedRestaurantId,
        status,
        startTime,
        startTime + 90 * 60_000,
        37.7 + (index % 100) / 10_000,
        -122.4 - (index % 100) / 10_000,
        photoCount,
        hasFoodPhoto ? 1 : 0,
        index % 4 === 0 ? `calendar-${index.toString().padStart(8, "0")}` : null,
        index % 4 === 0 ? `Dinner reservation ${index}` : null,
        index % 4 === 0 ? `${index} Market Street` : null,
        index % 12 === 0 ? 1 : index % 4 === 0 ? 0 : null,
        index % 13 === 0 ? `Synthetic note ${index}: café “tasting”` : null,
        startTime + 1_234,
        index % 17 === 0 ? `export-${index}` : null,
        index % 19 === 0 ? "Selected" : null,
      );

      for (let withinVisit = 0; withinVisit < photoCount; withinVisit++) {
        const detected = hasFoodPhoto && withinVisit === 0 ? 1 : withinVisit % 4 === 0 ? null : 0;
        const idSuffix = photoIndex.toString().padStart(9, "0");
        const specialSuffix = photoIndex % 211 === 0 ? '-café-"quoted"' : "";
        insertPhoto.run(
          `photo-${idSuffix}`,
          `file:///synthetic/photo-library/${idSuffix}${specialSuffix}.heic`,
          startTime + withinVisit * 1_000,
          id,
          detected,
        );
        photoIndex++;
      }
    }
    assert.equal(photoIndex, configuration.photos, "synthetic photo generator must produce the requested count");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database.exec("ANALYZE");
}

function datasetSummary(database: DatabaseSync): DatasetSummary {
  const row = database
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM visits) AS visits,
        (SELECT COUNT(*) FROM photos) AS photos,
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM michelin_restaurants) AS suggestedRestaurants,
        (SELECT COUNT(*) FROM visits WHERE status = 'pending') AS pendingVisits,
        (SELECT COUNT(*) FROM visits WHERE status = 'confirmed') AS confirmedVisits,
        (SELECT COUNT(*) FROM visits WHERE status = 'rejected') AS rejectedVisits,
        (SELECT COUNT(*) FROM visits WHERE foodProbable = 1) AS foodProbableVisits
    `)
    .get() as unknown as DatasetSummary;
  return row;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function projectEagerVisit(row: ReturnType<typeof parseVisitDetailsRows>[number]): VisitListItem {
  if (row.status !== "pending" && row.status !== "confirmed" && row.status !== "rejected") {
    throw new Error(`Eager visit query returned unsupported status: ${String(row.status)}`);
  }
  return {
    id: row.id,
    status: row.status,
    startTime: row.startTime,
    photoCount: row.photoCount,
    foodProbable: normalizeBoolean(row.foodProbable),
    calendarEventTitle: row.calendarEventTitle,
    calendarEventIsAllDay: row.calendarEventIsAllDay === null ? null : normalizeBoolean(row.calendarEventIsAllDay),
    restaurantName: row.restaurantName,
    suggestedRestaurantName: row.suggestedRestaurantName,
    previewPhotos: row.previewPhotos,
  };
}

function executeEager(database: DatabaseSync, filter: BenchmarkFilter): Execution {
  const query = buildVisitsWithDetailsQuery(productionFilter(filter));
  const queryStartedAt = performance.now();
  const rawRows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitDetailsQueryRow[];
  const queryCompletedAt = performance.now();
  const parseStartedAt = performance.now();
  const output = parseVisitDetailsRows(rawRows).map(projectEagerVisit);
  const parseCompletedAt = performance.now();
  const queryMilliseconds = queryCompletedAt - queryStartedAt;
  const parseAndProjectionMilliseconds = parseCompletedAt - parseStartedAt;
  const sqliteRowsJsonEquivalentBytes = serializedBytes(rawRows);
  return {
    output,
    measurement: {
      queryMilliseconds,
      parseAndProjectionMilliseconds,
      queryAndParseMilliseconds: queryMilliseconds + parseAndProjectionMilliseconds,
      queryCalls: 1,
      sqliteRows: rawRows.length,
      outputRows: output.length,
      sqliteRowsJsonEquivalentBytes,
      slimOutputJsonEquivalentBytes: serializedBytes(output),
      maximumRowsPerCall: rawRows.length,
      maximumJsonEquivalentBytesPerCall: sqliteRowsJsonEquivalentBytes,
      outputSha256: checksumRows(output),
    },
  };
}

function executeCandidateFirstPage(database: DatabaseSync, filter: BenchmarkFilter, pageSize: number): Execution {
  const query = buildVisitListPageQuery(productionFilter(filter), null, pageSize);
  const queryStartedAt = performance.now();
  const rawRows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitListPageRow[];
  const queryCompletedAt = performance.now();
  const parseStartedAt = performance.now();
  const output = parseVisitListPageRows(rawRows, pageSize).visits;
  const parseCompletedAt = performance.now();
  const queryMilliseconds = queryCompletedAt - queryStartedAt;
  const parseAndProjectionMilliseconds = parseCompletedAt - parseStartedAt;
  const sqliteRowsJsonEquivalentBytes = serializedBytes(rawRows);
  return {
    output,
    measurement: {
      queryMilliseconds,
      parseAndProjectionMilliseconds,
      queryAndParseMilliseconds: queryMilliseconds + parseAndProjectionMilliseconds,
      queryCalls: 1,
      sqliteRows: rawRows.length,
      outputRows: output.length,
      sqliteRowsJsonEquivalentBytes,
      slimOutputJsonEquivalentBytes: serializedBytes(output),
      maximumRowsPerCall: rawRows.length,
      maximumJsonEquivalentBytesPerCall: sqliteRowsJsonEquivalentBytes,
      outputSha256: checksumRows(output),
    },
  };
}

function executeCandidateFullTraversal(database: DatabaseSync, filter: BenchmarkFilter, pageSize: number): Execution {
  const output: VisitListItem[] = [];
  let cursor: VisitListCursor | null = null;
  let queryCalls = 0;
  let sqliteRows = 0;
  let sqliteRowsJsonEquivalentBytes = 0;
  let maximumRowsPerCall = 0;
  let maximumJsonEquivalentBytesPerCall = 0;
  let queryMilliseconds = 0;
  let parseAndProjectionMilliseconds = 0;

  do {
    const query = buildVisitListPageQuery(productionFilter(filter), cursor, pageSize);
    const queryStartedAt = performance.now();
    const rawRows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitListPageRow[];
    const queryCompletedAt = performance.now();
    const parseStartedAt = performance.now();
    const page = parseVisitListPageRows(rawRows, pageSize);
    output.push(...page.visits);
    cursor = page.nextCursor;
    const parseCompletedAt = performance.now();
    const callBytes = serializedBytes(rawRows);

    queryCalls++;
    sqliteRows += rawRows.length;
    sqliteRowsJsonEquivalentBytes += callBytes;
    maximumRowsPerCall = Math.max(maximumRowsPerCall, rawRows.length);
    maximumJsonEquivalentBytesPerCall = Math.max(maximumJsonEquivalentBytesPerCall, callBytes);
    queryMilliseconds += queryCompletedAt - queryStartedAt;
    parseAndProjectionMilliseconds += parseCompletedAt - parseStartedAt;
  } while (cursor);

  return {
    output,
    measurement: {
      queryMilliseconds,
      parseAndProjectionMilliseconds,
      queryAndParseMilliseconds: queryMilliseconds + parseAndProjectionMilliseconds,
      queryCalls,
      sqliteRows,
      outputRows: output.length,
      sqliteRowsJsonEquivalentBytes,
      slimOutputJsonEquivalentBytes: serializedBytes(output),
      maximumRowsPerCall,
      maximumJsonEquivalentBytesPerCall,
      outputSha256: checksumRows(output),
    },
  };
}

function executeStrategy(
  database: DatabaseSync,
  strategy: Strategy,
  filter: BenchmarkFilter,
  pageSize: number,
): Execution {
  switch (strategy) {
    case "eager-full":
      return executeEager(database, filter);
    case "candidate-first-page":
      return executeCandidateFirstPage(database, filter, pageSize);
    case "candidate-full-traversal":
      return executeCandidateFullTraversal(database, filter, pageSize);
  }
}

function transferShape(measurement: Measurement): TransferShape {
  return {
    queryCalls: measurement.queryCalls,
    sqliteRows: measurement.sqliteRows,
    outputRows: measurement.outputRows,
    sqliteRowsJsonEquivalentBytes: measurement.sqliteRowsJsonEquivalentBytes,
    slimOutputJsonEquivalentBytes: measurement.slimOutputJsonEquivalentBytes,
    maximumRowsPerCall: measurement.maximumRowsPerCall,
    maximumJsonEquivalentBytesPerCall: measurement.maximumJsonEquivalentBytesPerCall,
  };
}

function summarize(samples: readonly number[]): TimingSummary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0],
    medianMilliseconds: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function counterbalancedOrder(strategies: readonly Strategy[], round: number): Strategy[] {
  const base = round % 2 === 0 ? [...strategies] : [...strategies].reverse();
  const offset = round % strategies.length;
  return [...base.slice(offset), ...base.slice(0, offset)];
}

function explainQuery(database: DatabaseSync, sql: string, parameters: readonly (string | number)[]): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as unknown as QueryPlanRow[]).map(
    ({ detail }) => detail,
  );
}

function queryPlans(database: DatabaseSync, filter: BenchmarkFilter, pageSize: number): Record<string, string[]> {
  const selectedFilter = productionFilter(filter);
  const eager = buildVisitsWithDetailsQuery(selectedFilter);
  const first = buildVisitListPageQuery(selectedFilter, null, pageSize);
  const continuation = buildVisitListPageQuery(
    selectedFilter,
    { startTime: Date.UTC(2026, 0, 1), id: "query-plan-cursor" },
    pageSize,
  );
  return {
    eagerFull: explainQuery(database, eager.sql, eager.parameters),
    candidateFirstPage: explainQuery(database, first.sql, first.parameters),
    candidateContinuationPage: explainQuery(database, continuation.sql, continuation.parameters),
  };
}

function validateQueryPlanContract(plans: Record<string, string[]>, filter: BenchmarkFilter) {
  const expectedVisitIndex =
    filter === "all" ? "idx_visits_time" : filter === "food" ? "idx_visits_food_time" : "idx_visits_status_time";
  for (const [label, details] of Object.entries(plans)) {
    assert(
      details.some((detail) => detail.includes(expectedVisitIndex)),
      `${label} must use existing production index ${expectedVisitIndex}`,
    );
    assert(
      details.some((detail) => detail.includes("idx_photos_visit_preview")),
      `${label} must use the indexed preview lookup`,
    );
    for (const detail of details.filter((entry) => entry.includes("TEMP B-TREE"))) {
      assert(
        detail.includes("USE TEMP B-TREE FOR LAST TERM OF ORDER BY"),
        `${label} may sort only the final ID tie term: ${detail}`,
      );
    }
    assert(
      !details.some((detail) => detail.includes("USE TEMP B-TREE FOR ORDER BY")),
      `${label} must not sort the complete order`,
    );
  }
  return {
    filter,
    expectedVisitIndex,
    existingPrefixIndexUsedByEveryPlan: true,
    fullOrderSortRejected: true,
    onlyPermittedTemporarySort: "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
  };
}

function totalChanges(database: DatabaseSync): number {
  return (database.prepare("SELECT total_changes() AS value").get() as { value: number }).value;
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

async function run(configuration: Configuration): Promise<void> {
  let database: DatabaseSync;
  let mode: "synthetic" | "immutable-real";
  let canonicalSource: string | null = null;
  let sourceBefore: SourceSnapshot | null = null;
  let syntheticBuildMilliseconds: number | null = null;

  if (configuration.databasePath) {
    canonicalSource = prepareImmutableSource(configuration.databasePath);
    assertOutputDoesNotAliasSource(canonicalSource, configuration.outputPath);
    sourceBefore = snapshotSource(canonicalSource);
    database = new DatabaseSync(immutableDatabaseUri(canonicalSource), { readOnly: true });
    mode = "immutable-real";
  } else {
    database = new DatabaseSync(":memory:");
    mode = "synthetic";
    createSyntheticSchema(database);
    const buildStartedAt = performance.now();
    seedSyntheticDatabase(database, configuration);
    syntheticBuildMilliseconds = performance.now() - buildStartedAt;
  }

  let report: Record<string, unknown> | null = null;
  let benchmarkFailure: { readonly error: unknown } | null = null;
  try {
    database.exec("PRAGMA query_only = ON; BEGIN");
    const changesBefore = totalChanges(database);
    const dataset = datasetSummary(database);
    const plans = queryPlans(database, configuration.filter, configuration.pageSize);
    const planValidation = validateQueryPlanContract(plans, configuration.filter);

    const oracleEagerBefore = executeEager(database, configuration.filter);
    const oracleFirstBefore = executeCandidateFirstPage(database, configuration.filter, configuration.pageSize);
    const oracleFullBefore = executeCandidateFullTraversal(database, configuration.filter, configuration.pageSize);
    const expectedPrefix = oracleEagerBefore.output.slice(0, configuration.pageSize);
    assert.deepEqual(
      oracleFirstBefore.output,
      expectedPrefix,
      "candidate first page must exactly match the eager slim-render prefix",
    );
    assert.deepEqual(
      oracleFullBefore.output,
      oracleEagerBefore.output,
      "candidate complete traversal must exactly match the eager slim-render output",
    );
    const fullOutputSha256 = checksumRows(oracleEagerBefore.output);
    const prefixOutputSha256 = checksumRows(expectedPrefix);

    const strategies: Strategy[] = ["eager-full", "candidate-first-page", "candidate-full-traversal"];
    for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
      for (const strategy of counterbalancedOrder(strategies, warmup)) {
        const execution = executeStrategy(database, strategy, configuration.filter, configuration.pageSize);
        assert.equal(
          execution.measurement.outputSha256,
          strategy === "candidate-first-page" ? prefixOutputSha256 : fullOutputSha256,
          `warmup ${strategy} output hash diverged`,
        );
      }
    }

    const measurements = Object.fromEntries(strategies.map((strategy) => [strategy, [] as Measurement[]])) as Record<
      Strategy,
      Measurement[]
    >;
    const measurementOrder: Strategy[][] = [];
    for (let sample = 0; sample < configuration.samples; sample++) {
      const order = counterbalancedOrder(strategies, sample + configuration.warmupIterations);
      measurementOrder.push(order);
      for (const strategy of order) {
        const execution = executeStrategy(database, strategy, configuration.filter, configuration.pageSize);
        assert.equal(
          execution.measurement.outputSha256,
          strategy === "candidate-first-page" ? prefixOutputSha256 : fullOutputSha256,
          `sample ${sample + 1} ${strategy} output hash diverged`,
        );
        measurements[strategy].push(execution.measurement);
      }
    }

    const oracleEagerAfter = executeEager(database, configuration.filter);
    const oracleFirstAfter = executeCandidateFirstPage(database, configuration.filter, configuration.pageSize);
    const oracleFullAfter = executeCandidateFullTraversal(database, configuration.filter, configuration.pageSize);
    assert.deepEqual(oracleEagerAfter.output, oracleEagerBefore.output, "eager oracle changed during profiling");
    assert.deepEqual(oracleFirstAfter.output, expectedPrefix, "first-page output changed during profiling");
    assert.deepEqual(oracleFullAfter.output, oracleEagerBefore.output, "full traversal changed during profiling");
    assert.equal(totalChanges(database), changesBefore, "read-only benchmark must not change SQLite total_changes()");

    const timingByStrategy = Object.fromEntries(
      strategies.map((strategy) => {
        const strategyMeasurements = measurements[strategy];
        const expectedShape = transferShape(strategyMeasurements[0]);
        for (const measurement of strategyMeasurements) {
          assert.deepEqual(
            transferShape(measurement),
            expectedShape,
            `${strategy} transfer shape changed across samples`,
          );
        }
        return [
          strategy,
          {
            query: summarize(strategyMeasurements.map(({ queryMilliseconds }) => queryMilliseconds)),
            parseAndSlimProjection: summarize(
              strategyMeasurements.map(({ parseAndProjectionMilliseconds }) => parseAndProjectionMilliseconds),
            ),
            queryAndParse: summarize(
              strategyMeasurements.map(({ queryAndParseMilliseconds }) => queryAndParseMilliseconds),
            ),
            transferShape: expectedShape,
            measuredOutputSha256: [...new Set(strategyMeasurements.map(({ outputSha256 }) => outputSha256))],
          },
        ];
      }),
    ) as Record<Strategy, StrategyTimingReport>;

    const eagerShape = transferShape(measurements["eager-full"][0]);
    const firstShape = transferShape(measurements["candidate-first-page"][0]);
    const fullShape = transferShape(measurements["candidate-full-traversal"][0]);
    const eagerMedian = timingByStrategy["eager-full"].queryAndParse.medianMilliseconds;
    const firstMedian = timingByStrategy["candidate-first-page"].queryAndParse.medianMilliseconds;
    const fullMedian = timingByStrategy["candidate-full-traversal"].queryAndParse.medianMilliseconds;

    report = {
      schemaVersion: 2,
      status: "ok",
      benchmarkScope:
        mode === "immutable-real"
          ? "Node/V8 node:sqlite against one immutable, query-only real Palate database read transaction. Timings include statement preparation/execution and production parsing/slim projection; they exclude JSON byte-accounting, Expo SQLite scheduling, the React Native bridge, Hermes, FlashList rendering, Photos, and Calendar."
          : "Node/V8 node:sqlite against a deterministic in-memory current-Mac-scale fixture. Timings include statement preparation/execution and production parsing/slim projection; they exclude JSON byte-accounting, Expo SQLite scheduling, the React Native bridge, Hermes, FlashList rendering, Photos, and Calendar.",
      consistencyModel:
        "The profiler holds one read transaction for deterministic full-traversal parity. Production page requests use independent snapshots and rely on mutation-triggered list resets, so this benchmark does not imply snapshot consistency across an actual scroll.",
      strategyContracts: {
        eagerFull:
          "buildVisitsWithDetailsQuery() + parseVisitDetailsRows(), followed by only the fields rendered by All Visits",
        candidateFirstPage:
          "buildVisitListPageQuery() + parseVisitListPageRows() for the initial keyset page, including one lookahead SQL row when available",
        candidateFullTraversal:
          "Repeated production slim keyset pages to exhaustion; retained as a correctness and complete-traversal cost oracle",
      },
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        sqlite: (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
      },
      configuration: {
        mode,
        filter: configuration.filter,
        requestedSyntheticVisits: mode === "synthetic" ? configuration.visits : null,
        requestedSyntheticPhotos: mode === "synthetic" ? configuration.photos : null,
        pageSize: configuration.pageSize,
        samples: configuration.samples,
        warmupIterations: configuration.warmupIterations,
      },
      dataset: {
        ...dataset,
        syntheticBuildMilliseconds,
      },
      correctness: {
        exactFirstPagePrefixParityBeforeTiming: true,
        exactFullTraversalParityBeforeTiming: true,
        exactFirstPagePrefixParityAfterTiming: true,
        exactFullTraversalParityAfterTiming: true,
        fullSlimRenderOutputSha256: fullOutputSha256,
        firstPageSlimRenderPrefixSha256: prefixOutputSha256,
        hashEncoding:
          "SHA-256 of UTF-8 JSON.stringify over ordered slim-render objects with production field insertion order",
        fullRowsCompared: oracleEagerBefore.output.length,
        prefixRowsCompared: expectedPrefix.length,
        totalChangesBefore: changesBefore,
        totalChangesAfter: totalChanges(database),
      },
      transferAndTimingComparison: {
        eagerFull: eagerShape,
        candidateFirstPage: {
          ...firstShape,
          sqliteRowReductionFraction: 1 - (safeRatio(firstShape.sqliteRows, eagerShape.sqliteRows) ?? 1),
          sqlitePayloadReductionFraction:
            1 - (safeRatio(firstShape.sqliteRowsJsonEquivalentBytes, eagerShape.sqliteRowsJsonEquivalentBytes) ?? 1),
          medianQueryAndParseSpeedup: safeRatio(eagerMedian, firstMedian),
        },
        candidateFullTraversal: {
          ...fullShape,
          sqlitePayloadRatioVersusEager: safeRatio(
            fullShape.sqliteRowsJsonEquivalentBytes,
            eagerShape.sqliteRowsJsonEquivalentBytes,
          ),
          medianQueryAndParseSpeedup: safeRatio(eagerMedian, fullMedian),
        },
      },
      timings: timingByStrategy,
      measurementOrder,
      queryPlans: plans,
      queryPlanValidation: planValidation,
      privacy: {
        aggregateOnly: true,
        rawRowsRetainedInReport: false,
        visitIdentifiersRetainedInReport: false,
        restaurantIdentifiersOrNamesRetainedInReport: false,
        photoUrisRetainedInReport: false,
        sourceOrOutputPathsRetainedInReport: false,
        photosLibraryAccessed: false,
        calendarLibraryAccessed: false,
      },
    };
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the primary failure if the transaction already ended.
    }
    benchmarkFailure = { error };
  } finally {
    database.close();
  }

  let sourceGuardFailure: { readonly error: unknown } | null = null;
  if (canonicalSource) {
    try {
      const sourceAfter = snapshotSource(canonicalSource);
      assert.deepEqual(
        sourceAfter,
        sourceBefore,
        "immutable profiling changed source identity, mode, size, or contents",
      );
    } catch (error) {
      sourceGuardFailure = { error };
    }
  }
  if (benchmarkFailure && sourceGuardFailure) {
    throw new AggregateError(
      [benchmarkFailure.error, sourceGuardFailure.error],
      "The benchmark failed and the immutable source attestation also changed",
    );
  }
  if (sourceGuardFailure) {
    throw sourceGuardFailure.error;
  }
  if (benchmarkFailure) {
    throw benchmarkFailure.error;
  }
  assert.ok(report, "successful benchmark must produce an aggregate report");

  if (canonicalSource) {
    report.sourceAttestation = {
      guardedBeforeAndAfter: true,
      comparisonFields: ["presence", "mode", "size", "device", "inode", "sha256"],
      before: sourceBefore,
      afterMatchesBefore: true,
      nonemptyWalOrJournalRejected: true,
      immutableFileUri: true,
      queryOnly: true,
      singleReadTransaction: true,
      outputPublication:
        "O_NOFOLLOW file descriptor, pre-truncation hard-link identity check, mode 0600, fsync, then source re-attestation before reporting success",
    };
    assertOutputDoesNotAliasSource(canonicalSource, configuration.outputPath);
  }

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  if (canonicalSource) {
    assertOutputDoesNotAliasSource(canonicalSource, configuration.outputPath);
  }
  const reportContents = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = publishAggregateReport(configuration.outputPath, reportContents, canonicalSource);
  if (canonicalSource) {
    assertOutputDoesNotAliasSource(canonicalSource, configuration.outputPath);
    assert.deepEqual(
      snapshotSource(canonicalSource),
      sourceBefore,
      "report publication changed source identity, mode, size, or contents",
    );
  }
  assert.equal(sha256File(configuration.outputPath), reportSha256, "published aggregate report hash changed");
  console.log(
    `Visit-list paging benchmark: wrote aggregate ${mode} report (${report.dataset && (report.dataset as DatasetSummary).visits} visits; SHA-256 ${reportSha256}).`,
  );
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
} else {
  await run(configuration);
}
