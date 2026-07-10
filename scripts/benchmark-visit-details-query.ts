#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildVisitsWithDetailsQuery,
  parseVisitDetailsRows,
  type VisitDetailsFilter,
  type VisitDetailsQueryRow,
} from "../utils/db/visit-details-core.ts";
import type { VisitWithDetails } from "../utils/db/types.ts";

interface Configuration {
  readonly visits: number;
  readonly photos: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly filter: VisitDetailsFilter | undefined;
  readonly outputPath: string;
}

interface DatasetCounts {
  readonly visitRows: number;
  readonly photoRows: number;
  readonly assignedPhotoRows: number;
  readonly resultVisitRows: number;
  readonly resultPreviewRows: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

interface LegacyVisitRow {
  readonly id: string;
  readonly [column: string]: unknown;
}

interface LegacyPreviewRow {
  readonly visitId: string;
  readonly uri: string;
}

interface Execution {
  readonly results: VisitWithDetails[];
  readonly databaseCalls: number;
  readonly rowsCrossingDatabaseBoundary: number;
  readonly boundVisitIds: number;
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly checksum: string;
  readonly execution: Execution;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

type Strategy = "legacyTwoCall" | "oneQueryExistingIndex" | "productionIndexed";

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 4_000,
  photos: 68_027,
  samples: 7,
  warmupIterations: 1,
  filter: undefined,
  outputPath: ".build/visit-details-query-profile.json",
};

const LEGACY_PHOTO_PRIORITY_SQL = `CASE
  WHEN foodDetected = 1 THEN 0
  WHEN foodDetected = 0 THEN 1
  ELSE 2
END ASC, creationTime ASC, id ASC`;
const PREVIEW_INDEX_SQL = `CREATE INDEX idx_photos_visit_preview ON photos(
  visitId,
  (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
  creationTime,
  id
)`;

function usage(): string {
  return `Usage: benchmark-visit-details-query.ts [options]

  --visits=N       Visit rows (default: ${DEFAULT_CONFIGURATION.visits})
  --photos=N       Photo rows (default: ${DEFAULT_CONFIGURATION.photos})
  --samples=N      Measured strategy trios (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy trios (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --filter=VALUE   all, pending, confirmed, rejected, or food (default: all)
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help`;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseFilter(value: string): VisitDetailsFilter | undefined {
  if (value === "all") {
    return undefined;
  }
  if (value === "pending" || value === "confirmed" || value === "rejected" || value === "food") {
    return value;
  }
  throw new RangeError("--filter must be all, pending, confirmed, rejected, or food.");
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
      case "--visits":
        configuration.visits = parseInteger(value, option);
        break;
      case "--photos":
        configuration.photos = parseInteger(value, option);
        break;
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--filter":
        configuration.filter = parseFilter(value);
        break;
      case "--output":
        if (!value) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (configuration.visits < 4) {
    throw new RangeError("--visits must be at least 4 to preserve the edge-case fixture.");
  }
  if (configuration.photos < configuration.visits + 2) {
    throw new RangeError("--photos must be at least --visits + 2.");
  }
  return configuration;
}

function visitId(index: number): string {
  switch (index) {
    case 0:
      return "visit-O'Brien's-table";
    case 1:
      return "訪問-東京-🍣";
    case 2:
      return 'visit-"quoted"-café';
    default:
      return `visit-${index.toString().padStart(6, "0")}`;
  }
}

function localRestaurantId(index: number): string {
  return `restaurant-${index.toString().padStart(5, "0")}`;
}

function michelinRestaurantId(index: number): string {
  return `michelin-${index.toString().padStart(5, "0")}`;
}

function statusForVisit(index: number): "pending" | "confirmed" | "rejected" {
  return index % 7 < 3 ? "pending" : index % 7 < 6 ? "confirmed" : "rejected";
}

function createDatabase(configuration: Configuration, includePreviewIndex: boolean): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -128000;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      award TEXT NOT NULL
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
      exportedToCalendarId TEXT,
      notes TEXT,
      updatedAt INTEGER,
      awardAtVisit TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER
    );
    CREATE INDEX idx_photos_visit_food_time ON photos(visitId, foodDetected, creationTime);
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_food_time ON visits(foodProbable, startTime DESC);
    CREATE INDEX idx_visits_time ON visits(startTime);
    ${includePreviewIndex ? `${PREVIEW_INDEX_SQL};` : ""}
    BEGIN;
  `);

  const localRestaurantCount = Math.max(1, Math.ceil(configuration.visits / 5));
  const michelinRestaurantCount = Math.max(1, Math.ceil(configuration.visits / 4));
  const insertLocal = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  for (let index = 0; index < localRestaurantCount; index++) {
    insertLocal.run(localRestaurantId(index), index === 0 ? "O'Brien's Local 🍽️" : `Local restaurant ${index}`);
  }
  const insertMichelin = database.prepare("INSERT INTO michelin_restaurants (id, name, award) VALUES (?, ?, ?)");
  const awards = ["Three Stars", "Two Stars", "One Star", "Bib Gourmand", "Selected"] as const;
  for (let index = 0; index < michelinRestaurantCount; index++) {
    insertMichelin.run(
      michelinRestaurantId(index),
      index === 1 ? "東京 Guide Restaurant" : `Guide restaurant ${index}`,
      awards[index % awards.length],
    );
  }

  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      exportedToCalendarId, notes, updatedAt, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const visitEpoch = 1_780_000_000_000;
  for (let index = 0; index < configuration.visits; index++) {
    const startTime = visitEpoch - index * 60_000;
    const restaurantId = index % 5 === 0 ? null : localRestaurantId(index % localRestaurantCount);
    const suggestedRestaurantId = index % 6 === 0 ? null : michelinRestaurantId(index % michelinRestaurantCount);
    const awardAtVisit = index % 37 === 0 ? "" : index % 11 === 0 ? `Historical award ${index % 4}` : null;
    insertVisit.run(
      visitId(index),
      restaurantId,
      suggestedRestaurantId,
      statusForVisit(index),
      startTime,
      startTime + 3_600_000,
      -70 + (index % 140),
      -170 + (index % 340),
      index % 4 === 0 ? 0 : 1,
      index % 9 === 0 ? `calendar-${index}` : null,
      index % 9 === 0 ? `Reservation ${index}` : null,
      index % 13 === 0 ? `Location ${index}` : null,
      index % 29 === 0 ? 1 : index % 29 === 1 ? null : 0,
      index % 31 === 0 ? `export-calendar-${index}` : null,
      index === 1 ? "notes 雪 'quoted' 🙂" : index % 17 === 0 ? `notes-${index}` : null,
      startTime + 42,
      awardAtVisit,
    );
  }

  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );
  let photoIndex = 0;
  const insertPhotoRow = (
    id: string,
    uri: string,
    creationTime: number,
    assignedVisitId: string | null,
    foodDetected: number | null,
  ) => {
    insertPhoto.run(id, uri, creationTime, assignedVisitId, foodDetected);
    photoIndex++;
  };

  const tiedIds = ["photo-tie-z", "photo-tie-a", "photo-tie-y", "photo-tie-b"];
  for (const id of tiedIds) {
    insertPhotoRow(id, `ph://${id}`, 1_700_000_000_000, visitId(0), 1);
  }

  for (let visitIndex = 1; visitIndex < configuration.visits - 1; visitIndex++) {
    const id = `photo-${photoIndex.toString().padStart(7, "0")}`;
    insertPhotoRow(
      id,
      visitIndex === 1 ? `ph://雪/'quoted'/🍣` : `ph://${id}/L0/001`,
      1_700_000_100_000 + photoIndex * 10,
      visitId(visitIndex),
      photoIndex % 3 === 0 ? 1 : photoIndex % 3 === 1 ? 0 : null,
    );
  }

  let randomState = 0x51f15e;
  while (photoIndex < configuration.photos) {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    const unit = randomState / 0x1_0000_0000;
    const range = photoIndex % 5 === 0 ? Math.max(1, Math.floor(configuration.visits / 10)) : configuration.visits - 1;
    const visitIndex = Math.min(configuration.visits - 2, Math.floor(unit * range));
    const id = `photo-${photoIndex.toString().padStart(7, "0")}`;
    const foodRoll = photoIndex % 10;
    const assignedVisitId = photoIndex % 997 === 0 ? null : visitId(visitIndex);
    insertPhotoRow(
      id,
      photoIndex === configuration.visits + 7 ? `ph://unicode-雪-"quoted"-\\slash` : `ph://${id}/L0/001`,
      1_700_000_100_000 + photoIndex * 10,
      assignedVisitId,
      foodRoll < 3 ? 1 : foodRoll < 7 ? 0 : null,
    );
  }

  database.exec(`
    UPDATE visits
    SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id);
    COMMIT;
    PRAGMA optimize;
  `);
  return database;
}

function legacySelection(filter?: VisitDetailsFilter): { readonly where: string; readonly parameters: string[] } {
  if (filter === "food") {
    return { where: "WHERE c.foodProbable = 1", parameters: [] };
  }
  if (filter) {
    return { where: "WHERE c.status = ?", parameters: [filter] };
  }
  return { where: "", parameters: [] };
}

function executeLegacy(database: DatabaseSync, filter?: VisitDetailsFilter): Execution {
  const selection = legacySelection(filter);
  const visits = database
    .prepare(
      `SELECT c.*,
              r.name AS restaurantName,
              m.name AS suggestedRestaurantName,
              COALESCE(c.awardAtVisit, m.award) AS suggestedRestaurantAward
       FROM visits c
       LEFT JOIN restaurants r ON c.restaurantId = r.id
       LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
       ${selection.where}
       ORDER BY c.startTime DESC`,
    )
    .all(...selection.parameters) as unknown as LegacyVisitRow[];

  if (visits.length === 0) {
    return { results: [], databaseCalls: 1, rowsCrossingDatabaseBoundary: 0, boundVisitIds: 0 };
  }
  const visitIds = visits.map((visit) => visit.id);
  const previews = database
    .prepare(
      `SELECT visitId, uri
       FROM (
         SELECT visitId,
                uri,
                ROW_NUMBER() OVER (PARTITION BY visitId ORDER BY ${LEGACY_PHOTO_PRIORITY_SQL}) AS rn
         FROM photos
         WHERE visitId IN (${visitIds.map(() => "?").join(", ")})
       )
       WHERE rn <= 3
       ORDER BY rn ASC`,
    )
    .all(...visitIds) as unknown as LegacyPreviewRow[];

  const previewsByVisit = new Map<string, string[]>();
  for (const preview of previews) {
    const existing = previewsByVisit.get(preview.visitId);
    if (existing) {
      existing.push(preview.uri);
    } else {
      previewsByVisit.set(preview.visitId, [preview.uri]);
    }
  }
  const results = visits.map((visit) => ({
    ...visit,
    previewPhotos: previewsByVisit.get(visit.id) ?? [],
  })) as VisitWithDetails[];
  return {
    results,
    databaseCalls: 2,
    rowsCrossingDatabaseBoundary: visits.length + previews.length,
    boundVisitIds: visitIds.length,
  };
}

function executeProduction(database: DatabaseSync, filter?: VisitDetailsFilter): Execution {
  const query = buildVisitsWithDetailsQuery(filter);
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitDetailsQueryRow[];
  return {
    results: parseVisitDetailsRows(rows),
    databaseCalls: 1,
    rowsCrossingDatabaseBoundary: rows.length,
    boundVisitIds: 0,
  };
}

function assertEveryFilterParity(configuration: Configuration): string[] {
  const legacyDatabase = createDatabase(configuration, false);
  const fallbackDatabase = createDatabase(configuration, false);
  const productionDatabase = createDatabase(configuration, true);
  const validatedFilters: string[] = [];
  try {
    for (const filter of [undefined, "pending", "confirmed", "rejected", "food"] as const) {
      const legacy = executeLegacy(legacyDatabase, filter).results;
      const fallback = executeProduction(fallbackDatabase, filter).results;
      const production = executeProduction(productionDatabase, filter).results;
      assert.deepEqual(fallback, legacy, `${filter ?? "all"}: one-query legacy-index result differed`);
      assert.deepEqual(production, legacy, `${filter ?? "all"}: production result differed`);
      validatedFilters.push(filter ?? "all");
    }
    return validatedFilters;
  } finally {
    legacyDatabase.close();
    fallbackDatabase.close();
    productionDatabase.close();
  }
}

function resultChecksum(results: readonly VisitWithDetails[]): string {
  const hash = createHash("sha256");
  for (const result of results) {
    const serialized = JSON.stringify(result);
    hash.update(String(Buffer.byteLength(serialized)));
    hash.update(":");
    hash.update(serialized);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function executeStrategy(strategy: Strategy, configuration: Configuration): Measurement {
  const database = createDatabase(configuration, strategy === "productionIndexed");
  try {
    const startedAt = performance.now();
    const execution =
      strategy === "legacyTwoCall"
        ? executeLegacy(database, configuration.filter)
        : executeProduction(database, configuration.filter);
    const elapsedMilliseconds = performance.now() - startedAt;
    return {
      elapsedMilliseconds,
      checksum: resultChecksum(execution.results),
      execution,
    };
  } finally {
    database.close();
  }
}

function planDetails(database: DatabaseSync, sql: string, parameters: readonly (string | number)[] = []): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as unknown as QueryPlanRow[]).map(
    (row) => row.detail,
  );
}

function collectPlanEvidence(configuration: Configuration): {
  readonly productionByFilter: Record<string, string[]>;
  readonly oneQueryWithoutPreviewIndex: string[];
  readonly legacyPreview: string[];
} {
  const production = createDatabase(configuration, true);
  const fallback = createDatabase(configuration, false);
  try {
    const productionByFilter: Record<string, string[]> = {};
    for (const filter of [undefined, "pending", "food"] as const) {
      const query = buildVisitsWithDetailsQuery(filter);
      const details = planDetails(production, query.sql, query.parameters);
      const expectedVisitIndex =
        filter === undefined
          ? "idx_visits_time"
          : filter === "food"
            ? "idx_visits_food_time"
            : "idx_visits_status_time";
      assert.ok(
        details.some((detail) => detail.includes(expectedVisitIndex)),
        `${filter ?? "all"} plan missed ${expectedVisitIndex}`,
      );
      assert.ok(
        details.some((detail) => detail.includes("idx_photos_visit_preview")),
        `${filter ?? "all"} plan missed preview index`,
      );
      productionByFilter[filter ?? "all"] = details;
    }

    const selectedQuery = buildVisitsWithDetailsQuery(configuration.filter);
    const fallbackDetails = planDetails(fallback, selectedQuery.sql, selectedQuery.parameters);
    assert.ok(fallbackDetails.some((detail) => detail.includes("idx_photos_visit_food_time")));
    assert.ok(fallbackDetails.some((detail) => detail.includes("USE TEMP B-TREE FOR ORDER BY")));

    const legacyPreviewSql = `SELECT visitId, uri
      FROM (
        SELECT visitId, uri,
               ROW_NUMBER() OVER (PARTITION BY visitId ORDER BY ${LEGACY_PHOTO_PRIORITY_SQL}) AS rn
        FROM photos
        WHERE visitId IN (?, ?, ?)
      )
      WHERE rn <= 3
      ORDER BY rn ASC`;
    return {
      productionByFilter,
      oneQueryWithoutPreviewIndex: fallbackDetails,
      legacyPreview: planDetails(fallback, legacyPreviewSql, [visitId(0), visitId(1), visitId(2)]),
    };
  } finally {
    production.close();
    fallback.close();
  }
}

function measurePreviewIndexBuild(configuration: Configuration): {
  readonly milliseconds: number;
  readonly additionalPages: number;
  readonly pageSizeBytes: number;
  readonly approximateAdditionalBytes: number;
} {
  const database = createDatabase(configuration, false);
  try {
    const pageSizeBytes = Number((database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const pagesBefore = Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const startedAt = performance.now();
    database.exec(PREVIEW_INDEX_SQL);
    const milliseconds = performance.now() - startedAt;
    const pagesAfter = Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const additionalPages = pagesAfter - pagesBefore;
    return {
      milliseconds: rounded(milliseconds),
      additionalPages,
      pageSizeBytes,
      approximateAdditionalBytes: additionalPages * pageSizeBytes,
    };
  } finally {
    database.close();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(values: readonly number[]): MeasurementSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMilliseconds: values.map(rounded),
    minimumMilliseconds: rounded(sorted[0]),
    medianMilliseconds: rounded(median(values)),
    p95Milliseconds: rounded(percentile95(values)),
    maximumMilliseconds: rounded(sorted.at(-1) ?? 0),
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  const strategies: readonly Strategy[] = ["legacyTwoCall", "oneQueryExistingIndex", "productionIndexed"];
  const offset = iteration % strategies.length;
  return [...strategies.slice(offset), ...strategies.slice(0, offset)];
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const validatedFilters = assertEveryFilterParity(configuration);
const untimedLegacy = executeStrategy("legacyTwoCall", configuration);
const untimedFallback = executeStrategy("oneQueryExistingIndex", configuration);
const untimedProduction = executeStrategy("productionIndexed", configuration);
assert.deepEqual(untimedFallback.execution.results, untimedLegacy.execution.results);
assert.deepEqual(untimedProduction.execution.results, untimedLegacy.execution.results);
assert.equal(untimedFallback.checksum, untimedLegacy.checksum);
assert.equal(untimedProduction.checksum, untimedLegacy.checksum);
const expectedChecksum = untimedLegacy.checksum;

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  for (const strategy of strategyOrder(warmup)) {
    assert.equal(executeStrategy(strategy, configuration).checksum, expectedChecksum);
  }
}

const measurements: Record<Strategy, number[]> = {
  legacyTwoCall: [],
  oneQueryExistingIndex: [],
  productionIndexed: [],
};
const measurementOrder: string[] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order = strategyOrder(sample);
  measurementOrder.push(order.join("-then-"));
  for (const strategy of order) {
    const measurement = executeStrategy(strategy, configuration);
    assert.equal(measurement.checksum, expectedChecksum, `${strategy} changed the ordered full-result checksum`);
    measurements[strategy].push(measurement.elapsedMilliseconds);
  }
}

const plans = collectPlanEvidence(configuration);
const previewIndexBuild = measurePreviewIndexBuild(configuration);
const countsDatabase = createDatabase(configuration, true);
const assignedPhotoRows = Number(
  (countsDatabase.prepare("SELECT COUNT(*) AS count FROM photos WHERE visitId IS NOT NULL").get() as { count: number })
    .count,
);
const sqliteVersion = (countsDatabase.prepare("SELECT sqlite_version() AS version").get() as { version: string })
  .version;
countsDatabase.close();

const dataset: DatasetCounts = {
  visitRows: configuration.visits,
  photoRows: configuration.photos,
  assignedPhotoRows,
  resultVisitRows: untimedLegacy.execution.results.length,
  resultPreviewRows: untimedLegacy.execution.rowsCrossingDatabaseBoundary - untimedLegacy.execution.results.length,
};
const legacy = summarize(measurements.legacyTwoCall);
const fallback = summarize(measurements.oneQueryExistingIndex);
const production = summarize(measurements.productionIndexed);
const report = {
  schemaVersion: 1,
  status: "ok",
  runtime: { node: process.version, sqlite: sqliteVersion },
  configuration: {
    visits: configuration.visits,
    photos: configuration.photos,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    filter: configuration.filter ?? "all",
  },
  dataset,
  correctness: {
    exactFullOrderedResultParity: true,
    resultValidatedAfterEveryRun: true,
    validatedFilters,
    sha256: expectedChecksum,
    coveredSemantics: [
      "all/status/food filters",
      "true, false, and null food-photo priority",
      "oldest creation time within priority",
      "photo ID as deterministic equal-rank tie breaker",
      "Unicode, emoji, apostrophes, quotes, and backslashes",
      "missing optional joins and no-photo visits",
      "historical award including empty string, with current-award fallback",
    ],
  },
  fairness: {
    freshDeterministicDatabasePerStrategyAndSample: true,
    databaseConstructionExcludedFromTiming: true,
    queryConstructionPreparationExecutionAndResultMappingIncluded: true,
    checksumValidationExcludedFromTiming: true,
    strategyOrderRotates: true,
    oneTimeIndexBuildExcludedFromSteadyStateQueryTiming: true,
    ongoingIndexWriteMaintenanceNotMeasured: true,
  },
  measurementOrder,
  queryPlans: plans,
  oneTimePreviewIndexBuild: {
    ...previewIndexBuild,
    scope: "synthetic in-memory SQLite; real on-disk migration cost may differ",
  },
  legacyTwoCall: {
    timing: legacy,
    databaseCalls: untimedLegacy.execution.databaseCalls,
    rowsCrossingDatabaseBoundary: untimedLegacy.execution.rowsCrossingDatabaseBoundary,
    boundVisitIds: untimedLegacy.execution.boundVisitIds,
  },
  oneQueryExistingIndex: {
    timing: fallback,
    databaseCalls: untimedFallback.execution.databaseCalls,
    rowsCrossingDatabaseBoundary: untimedFallback.execution.rowsCrossingDatabaseBoundary,
    boundVisitIds: untimedFallback.execution.boundVisitIds,
  },
  productionIndexed: {
    timing: production,
    databaseCalls: untimedProduction.execution.databaseCalls,
    rowsCrossingDatabaseBoundary: untimedProduction.execution.rowsCrossingDatabaseBoundary,
    boundVisitIds: untimedProduction.execution.boundVisitIds,
  },
  improvement: {
    oneQueryMedianSpeedupBeforeDedicatedIndex: Number(
      (legacy.medianMilliseconds / fallback.medianMilliseconds).toFixed(2),
    ),
    productionMedianSpeedup: Number((legacy.medianMilliseconds / production.medianMilliseconds).toFixed(2)),
    dedicatedIndexSpeedupWithinOneQuery: Number(
      (fallback.medianMilliseconds / production.medianMilliseconds).toFixed(2),
    ),
    databaseCallReduction: untimedLegacy.execution.databaseCalls / untimedProduction.execution.databaseCalls,
    rowsCrossingReduction: Number(
      (
        untimedLegacy.execution.rowsCrossingDatabaseBoundary / untimedProduction.execution.rowsCrossingDatabaseBoundary
      ).toFixed(2),
    ),
  },
  timingScope:
    "Node/V8 plus in-memory SQLite; real Expo async-call and native-to-JS row-materialization savings are represented separately by call and row counts.",
};

const reportJson = `${JSON.stringify(report, null, 2)}\n`;
mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, reportJson);
console.log(reportJson.trimEnd());
console.error(`Saved visit details query profile to ${configuration.outputPath}`);
