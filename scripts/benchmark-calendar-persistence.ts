#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  buildCalendarEventPersistenceStatement,
  buildCalendarExportPersistenceStatement,
  CALENDAR_PERSISTENCE_BATCH_SIZE,
  coalesceCalendarEventUpdates,
  coalesceCalendarExportUpdates,
  type CalendarExportUpdate,
} from "../utils/db/calendar-persistence-core.ts";
import type { CalendarEventUpdate } from "../utils/db/types.ts";

interface Configuration {
  readonly visits: number;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface VisitRow {
  readonly id: string;
  readonly calendarEventId: string | null;
  readonly calendarEventTitle: string | null;
  readonly calendarEventLocation: string | null;
  readonly calendarEventIsAllDay: number | null;
  readonly exportedToCalendarId: string | null;
  readonly updatedAt: number;
  readonly payload: string;
}

interface Dataset {
  readonly initialRows: readonly VisitRow[];
  readonly enrichmentUpdates: readonly CalendarEventUpdate[];
  readonly exportUpdates: readonly CalendarExportUpdate[];
  readonly expectedRows: readonly VisitRow[];
  readonly expectedChecksum: string;
  readonly missingEnrichmentUpdates: number;
  readonly missingExportUpdates: number;
}

interface Measurement {
  readonly enrichmentMilliseconds: number;
  readonly exportMilliseconds: number;
  readonly totalMilliseconds: number;
  readonly executions: number;
  readonly statementsPrepared: number;
}

interface MeasurementSummary {
  readonly samplesMilliseconds: number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface StrategySummary {
  readonly enrichment: MeasurementSummary;
  readonly export: MeasurementSummary;
  readonly total: MeasurementSummary;
  readonly executions: number;
  readonly statementsPrepared: number;
}

type Strategy = "legacyPerRow" | "productionSetBased";

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 5_000,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/calendar-persistence-profile.json",
};
const UPDATED_AT = 1_789_000_000_123;
const LEGACY_ENRICHMENT_SQL = `UPDATE visits SET
  calendarEventId = ?,
  calendarEventTitle = ?,
  calendarEventLocation = ?,
  calendarEventIsAllDay = ?
  WHERE id = ?`;
const LEGACY_EXPORTED_SQL = `UPDATE visits
  SET calendarEventId = ?, calendarEventTitle = ?, exportedToCalendarId = ?, updatedAt = ?
  WHERE id = ?`;
const LEGACY_IMPORTED_SQL = `UPDATE visits
  SET calendarEventId = ?, calendarEventTitle = ?, updatedAt = ?
  WHERE id = ?`;

function usage(): string {
  return `Usage: benchmark-calendar-persistence.ts [options]

  --visits=N       Visit rows (default: ${DEFAULT_CONFIGURATION.visits})
  --samples=N      Measured strategy pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Warmup strategy pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
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
      case "--samples":
        configuration.samples = parseInteger(value, option);
        break;
      case "--warmup":
        configuration.warmupIterations = parseInteger(value, option, true);
        break;
      case "--output":
        if (value.length === 0) {
          throw new RangeError("--output cannot be empty.");
        }
        configuration.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
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

function createInitialRows(count: number): VisitRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: visitId(index),
    calendarEventId: index % 11 === 0 ? `old-event-${index}` : null,
    calendarEventTitle: index % 11 === 0 ? `Old title ${index}` : null,
    calendarEventLocation: index % 13 === 0 ? `Old location ${index}` : null,
    calendarEventIsAllDay: index % 17 === 0 ? 1 : 0,
    exportedToCalendarId: index % 7 === 0 ? `preexisting-calendar-${index % 5}` : null,
    updatedAt: 1_700_000_000_000 + index,
    payload: index === 1 ? `sentinel-雪-'quoted'-🙂` : `sentinel-${index.toString(36)}`,
  }));
}

function createEnrichmentUpdates(rows: readonly VisitRow[]): {
  readonly updates: CalendarEventUpdate[];
  readonly missingUpdates: number;
} {
  const updates: CalendarEventUpdate[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    updates.push({
      visitId: row.id,
      calendarEventId: `matched-event-${index}`,
      calendarEventTitle: index === 0 ? "Dinner at O'Brien's 🍽️" : `Matched title ${index}`,
      calendarEventLocation: index % 4 === 0 ? null : `Matched location ${index % 211}`,
      calendarEventIsAllDay: index % 19 === 0,
    });
    if (index % 137 === 0) {
      updates.push({
        visitId: row.id,
        calendarEventId: `matched-event-${index}-final`,
        calendarEventTitle: `Final title ${index}`,
        calendarEventLocation: index % 274 === 0 ? null : `Final location ${index}`,
        calendarEventIsAllDay: index % 2 === 0,
      });
    }
  }
  const missingUpdates = Math.max(3, Math.ceil(rows.length / 1_000));
  for (let index = 0; index < missingUpdates; index++) {
    updates.splice(Math.min(updates.length, index * 157 + 3), 0, {
      visitId: index === 0 ? "missing-O'Brien-不存在" : `missing-enrichment-${index}`,
      calendarEventId: `missing-event-${index}`,
      calendarEventTitle: `Missing ${index}`,
      calendarEventLocation: null,
      calendarEventIsAllDay: false,
    });
  }
  return { updates, missingUpdates };
}

function createExportUpdates(rows: readonly VisitRow[]): {
  readonly updates: CalendarExportUpdate[];
  readonly missingUpdates: number;
} {
  const updates: CalendarExportUpdate[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    updates.push({
      visitId: row.id,
      calendarEventId: `calendar-event-${index}`,
      calendarEventTitle: index === 1 ? "寿司 at 東京" : `Calendar title ${index}`,
      ...(index % 3 === 0 ? { exportedToCalendarId: `target-calendar-${index % 13}` } : {}),
    });

    // A later imported update changes event fields while retaining the calendar
    // written by the prior exported branch.
    if (index % 97 === 0) {
      updates.push({
        visitId: row.id,
        calendarEventId: `calendar-event-${index}-imported-final`,
        calendarEventTitle: `Imported final ${index}`,
      });
    }

    // An empty ID follows the same legacy imported branch as an absent ID.
    if (index % 131 === 0) {
      updates.push({
        visitId: row.id,
        calendarEventId: `calendar-event-${index}-empty-final`,
        calendarEventTitle: `Empty final ${index}`,
        exportedToCalendarId: "",
      });
    }

    // Exercise false -> truthy -> false, with the middle calendar surviving.
    if (index % 389 === 0) {
      updates.push(
        {
          visitId: row.id,
          calendarEventId: `calendar-event-${index}-exported-middle`,
          calendarEventTitle: `Exported middle ${index}`,
          exportedToCalendarId: `middle-calendar-${index}`,
        },
        {
          visitId: row.id,
          calendarEventId: `calendar-event-${index}-last`,
          calendarEventTitle: `Last imported ${index}`,
        },
      );
    }
  }
  const missingUpdates = Math.max(3, Math.ceil(rows.length / 1_250));
  for (let index = 0; index < missingUpdates; index++) {
    updates.splice(Math.min(updates.length, index * 193 + 7), 0, {
      visitId: index === 0 ? "missing-export-雪's" : `missing-export-${index}`,
      calendarEventId: `missing-export-event-${index}`,
      calendarEventTitle: `Missing export ${index}`,
      ...(index % 2 === 0 ? { exportedToCalendarId: `missing-calendar-${index}` } : {}),
    });
  }
  return { updates, missingUpdates };
}

function applyOracle(
  initialRows: readonly VisitRow[],
  enrichmentUpdates: readonly CalendarEventUpdate[],
  exportUpdates: readonly CalendarExportUpdate[],
): VisitRow[] {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  for (const update of enrichmentUpdates) {
    const row = rows.get(update.visitId);
    if (!row) {
      continue;
    }
    row.calendarEventId = update.calendarEventId;
    row.calendarEventTitle = update.calendarEventTitle;
    row.calendarEventLocation = update.calendarEventLocation;
    row.calendarEventIsAllDay = update.calendarEventIsAllDay ? 1 : 0;
  }
  for (const update of exportUpdates) {
    const row = rows.get(update.visitId);
    if (!row) {
      continue;
    }
    row.calendarEventId = update.calendarEventId;
    row.calendarEventTitle = update.calendarEventTitle;
    if (update.exportedToCalendarId) {
      row.exportedToCalendarId = update.exportedToCalendarId;
    }
    row.updatedAt = UPDATED_AT;
  }
  return [...rows.values()].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
}

function checksumRows(rows: readonly VisitRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function createDataset(configuration: Configuration): Dataset {
  const initialRows = createInitialRows(configuration.visits);
  const enrichment = createEnrichmentUpdates(initialRows);
  const exports = createExportUpdates(initialRows);
  const expectedRows = applyOracle(initialRows, enrichment.updates, exports.updates);
  return {
    initialRows,
    enrichmentUpdates: enrichment.updates,
    exportUpdates: exports.updates,
    expectedRows,
    expectedChecksum: checksumRows(expectedRows),
    missingEnrichmentUpdates: enrichment.missingUpdates,
    missingExportUpdates: exports.missingUpdates,
  };
}

function createDatabase(rows: readonly VisitRow[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      exportedToCalendarId TEXT,
      updatedAt INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    BEGIN;
  `);
  const insert = database.prepare(`INSERT INTO visits
    (id, calendarEventId, calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
     exportedToCalendarId, updatedAt, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.id,
      row.calendarEventId,
      row.calendarEventTitle,
      row.calendarEventLocation,
      row.calendarEventIsAllDay,
      row.exportedToCalendarId,
      row.updatedAt,
      row.payload,
    );
  }
  database.exec("COMMIT");
  return database;
}

function executeTransaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN EXCLUSIVE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function executeLegacy(database: DatabaseSync, dataset: Dataset): Measurement {
  let executions = 0;
  let statementsPrepared = 0;
  const totalStartedAt = performance.now();
  const enrichmentStartedAt = performance.now();
  executeTransaction(database, () => {
    for (const update of dataset.enrichmentUpdates) {
      statementsPrepared += 1;
      executions += 1;
      database
        .prepare(LEGACY_ENRICHMENT_SQL)
        .run(
          update.calendarEventId,
          update.calendarEventTitle,
          update.calendarEventLocation,
          update.calendarEventIsAllDay ? 1 : 0,
          update.visitId,
        );
    }
  });
  const enrichmentMilliseconds = performance.now() - enrichmentStartedAt;

  const exportStartedAt = performance.now();
  executeTransaction(database, () => {
    for (const update of dataset.exportUpdates) {
      statementsPrepared += 1;
      executions += 1;
      if (update.exportedToCalendarId) {
        database
          .prepare(LEGACY_EXPORTED_SQL)
          .run(
            update.calendarEventId,
            update.calendarEventTitle,
            update.exportedToCalendarId,
            UPDATED_AT,
            update.visitId,
          );
      } else {
        database
          .prepare(LEGACY_IMPORTED_SQL)
          .run(update.calendarEventId, update.calendarEventTitle, UPDATED_AT, update.visitId);
      }
    }
  });
  const exportMilliseconds = performance.now() - exportStartedAt;
  return {
    enrichmentMilliseconds,
    exportMilliseconds,
    totalMilliseconds: performance.now() - totalStartedAt,
    executions,
    statementsPrepared,
  };
}

function executeCandidateBatches<T>(
  database: DatabaseSync,
  updates: readonly T[],
  buildStatement: (batch: readonly T[]) => {
    readonly sql: string;
    readonly parameters: readonly (string | number | null)[];
  },
): { readonly executions: number; readonly statementsPrepared: number } {
  let executions = 0;
  let statementsPrepared = 0;
  let reusableFullBatchStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
  for (let offset = 0; offset < updates.length; offset += CALENDAR_PERSISTENCE_BATCH_SIZE) {
    const batch = updates.slice(offset, offset + CALENDAR_PERSISTENCE_BATCH_SIZE);
    const statement = buildStatement(batch);
    executions += 1;
    if (batch.length === CALENDAR_PERSISTENCE_BATCH_SIZE) {
      if (reusableFullBatchStatement === null) {
        reusableFullBatchStatement = database.prepare(statement.sql);
        statementsPrepared += 1;
      }
      reusableFullBatchStatement.run(...statement.parameters);
    } else {
      statementsPrepared += 1;
      database.prepare(statement.sql).run(...statement.parameters);
    }
  }
  return { executions, statementsPrepared };
}

function executeCandidate(database: DatabaseSync, dataset: Dataset): Measurement {
  let executions = 0;
  let statementsPrepared = 0;
  const totalStartedAt = performance.now();
  const enrichmentStartedAt = performance.now();
  const enrichmentUpdates = coalesceCalendarEventUpdates(dataset.enrichmentUpdates);
  executeTransaction(database, () => {
    const counts = executeCandidateBatches(database, enrichmentUpdates, buildCalendarEventPersistenceStatement);
    executions += counts.executions;
    statementsPrepared += counts.statementsPrepared;
  });
  const enrichmentMilliseconds = performance.now() - enrichmentStartedAt;

  const exportStartedAt = performance.now();
  const exportUpdates = coalesceCalendarExportUpdates(dataset.exportUpdates);
  executeTransaction(database, () => {
    const counts = executeCandidateBatches(database, exportUpdates, (batch) =>
      buildCalendarExportPersistenceStatement(batch, UPDATED_AT),
    );
    executions += counts.executions;
    statementsPrepared += counts.statementsPrepared;
  });
  const exportMilliseconds = performance.now() - exportStartedAt;
  return {
    enrichmentMilliseconds,
    exportMilliseconds,
    totalMilliseconds: performance.now() - totalStartedAt,
    executions,
    statementsPrepared,
  };
}

function readRows(database: DatabaseSync): VisitRow[] {
  return database
    .prepare(`SELECT id, calendarEventId, calendarEventTitle, calendarEventLocation,
      calendarEventIsAllDay, exportedToCalendarId, updatedAt, payload
      FROM visits ORDER BY id COLLATE BINARY`)
    .all()
    .map((row) => ({ ...row }) as unknown as VisitRow);
}

function runAndValidate(strategy: Strategy, dataset: Dataset): Measurement {
  const database = createDatabase(dataset.initialRows);
  try {
    const measurement =
      strategy === "legacyPerRow" ? executeLegacy(database, dataset) : executeCandidate(database, dataset);
    const rows = readRows(database);
    assert.deepEqual(rows, dataset.expectedRows, `${strategy}: full-row result differed from independent oracle`);
    assert.equal(checksumRows(rows), dataset.expectedChecksum, `${strategy}: deterministic checksum differed`);
    return measurement;
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
    maximumMilliseconds: rounded(sorted[sorted.length - 1]),
  };
}

function summarizeStrategy(measurements: readonly Measurement[]): StrategySummary {
  const first = measurements[0];
  for (const measurement of measurements) {
    assert.equal(measurement.executions, first.executions);
    assert.equal(measurement.statementsPrepared, first.statementsPrepared);
  }
  return {
    enrichment: summarize(measurements.map(({ enrichmentMilliseconds }) => enrichmentMilliseconds)),
    export: summarize(measurements.map(({ exportMilliseconds }) => exportMilliseconds)),
    total: summarize(measurements.map(({ totalMilliseconds }) => totalMilliseconds)),
    executions: first.executions,
    statementsPrepared: first.statementsPrepared,
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  return iteration % 2 === 0 ? ["legacyPerRow", "productionSetBased"] : ["productionSetBased", "legacyPerRow"];
}

const configuration = parseConfiguration(process.argv.slice(2));
if (configuration === null) {
  console.log(usage());
  process.exit(0);
}

const dataset = createDataset(configuration);
// Untimed full-scale parity pass before accepting any warmup or sample.
runAndValidate("legacyPerRow", dataset);
runAndValidate("productionSetBased", dataset);

for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
  for (const strategy of strategyOrder(warmup)) {
    runAndValidate(strategy, dataset);
  }
}

const measurements: Record<Strategy, Measurement[]> = {
  legacyPerRow: [],
  productionSetBased: [],
};
const measurementOrder: string[] = [];
for (let sample = 0; sample < configuration.samples; sample++) {
  const order = strategyOrder(sample);
  measurementOrder.push(order.join("-then-"));
  for (const strategy of order) {
    measurements[strategy].push(runAndValidate(strategy, dataset));
  }
}

const legacy = summarizeStrategy(measurements.legacyPerRow);
const candidate = summarizeStrategy(measurements.productionSetBased);
const runtimeDatabase = new DatabaseSync(":memory:");
const sqliteVersion = (runtimeDatabase.prepare("SELECT sqlite_version() AS version").get() as { version: string })
  .version;
runtimeDatabase.close();

const report = {
  schemaVersion: 1,
  status: "ok",
  runtime: { node: process.version, sqlite: sqliteVersion },
  configuration: {
    visits: configuration.visits,
    samples: configuration.samples,
    warmupIterations: configuration.warmupIterations,
    batchSize: CALENDAR_PERSISTENCE_BATCH_SIZE,
  },
  dataset: {
    visitRows: dataset.initialRows.length,
    rawEnrichmentUpdates: dataset.enrichmentUpdates.length,
    coalescedEnrichmentUpdates: coalesceCalendarEventUpdates(dataset.enrichmentUpdates).length,
    rawExportUpdates: dataset.exportUpdates.length,
    coalescedExportUpdates: coalesceCalendarExportUpdates(dataset.exportUpdates).length,
    missingEnrichmentUpdates: dataset.missingEnrichmentUpdates,
    missingExportUpdates: dataset.missingExportUpdates,
  },
  correctness: {
    exactFullRowParityWithIndependentSequentialOracle: true,
    resultValidatedAfterEveryRun: true,
    checksum: dataset.expectedChecksum,
    coveredSemantics: [
      "last enrichment update per visit wins",
      "last export event fields per visit win",
      "truthy exported calendar ID survives later imported or empty-ID updates",
      "preexisting exported calendar ID survives imported-only updates",
      "missing visits are ignored",
      "null locations and all-day values are preserved",
      "Unicode, emoji, apostrophes, and quotes remain parameterized",
      "updatedAt and unrelated payload columns match exactly",
    ],
  },
  fairness: {
    freshDatabasePerStrategyAndSample: true,
    databaseConstructionExcludedFromTiming: true,
    coalescingSqlConstructionTransactionsAndWritesIncluded: true,
    resultValidationExcludedFromTiming: true,
    measuredOrderAlternates: true,
  },
  timingScope:
    "isolated Node/V8 plus in-memory SQLite; excludes React Native/Expo asynchronous bridge overhead, so execution-count reduction is reported separately",
  measurementOrder,
  legacyPerRow: legacy,
  productionSetBased: candidate,
  improvement: {
    medianSpeedup: Number((legacy.total.medianMilliseconds / candidate.total.medianMilliseconds).toFixed(2)),
    executionReduction: Number((legacy.executions / candidate.executions).toFixed(2)),
    statementPreparationReduction: Number((legacy.statementsPrepared / candidate.statementsPrepared).toFixed(2)),
  },
};

const reportJson = `${JSON.stringify(report, null, 2)}\n`;
mkdirSync(dirname(configuration.outputPath), { recursive: true });
writeFileSync(configuration.outputPath, reportJson);
console.log(reportJson.trimEnd());
console.error(`Saved calendar persistence profile to ${configuration.outputPath}`);
