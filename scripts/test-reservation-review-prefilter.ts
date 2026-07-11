#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  finalizeReservationReviewPrefilterSnapshot,
  prepareReservationReviewPrefilter,
  readReservationReviewPrefilterSnapshotRows,
  RESERVATION_REVIEW_PREFILTER_CONFIRMED_DAYS_SQL,
  RESERVATION_REVIEW_PREFILTER_EXACT_FACTS_SQL,
  type ReservationReviewPrefilterCandidate,
  type ReservationReviewPrefilterSnapshot,
} from "../utils/db/reservation-review-prefilter-core.ts";

process.env.TZ = "America/Los_Angeles";

export interface PrefilterHarnessMetrics {
  queryCalls: number;
  returnedRows: number;
  returnedBytes: number;
  parameterBytes: number;
  localDateComparisons: number;
  nameNormalizations: number;
  fuzzyNameComparisons: number;
}

interface ExistingVisitRow {
  readonly restaurantId: string | null;
  readonly suggestedRestaurantId: string | null;
  readonly startTime: number;
  readonly restaurantName: string | null;
  readonly suggestedRestaurantName: string | null;
  readonly calendarEventTitle: string | null;
}

const BATCH_SIZE = 1_000;

function values(parameters: readonly (string | number | null)[]): SQLInputValue[] {
  return parameters as SQLInputValue[];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function emptyPrefilterHarnessMetrics(): PrefilterHarnessMetrics {
  return {
    queryCalls: 0,
    returnedRows: 0,
    returnedBytes: 0,
    parameterBytes: 0,
    localDateComparisons: 0,
    nameNormalizations: 0,
    fuzzyNameComparisons: 0,
  };
}

function query<Row>(
  database: DatabaseSync,
  metrics: PrefilterHarnessMetrics,
  sql: string,
  parameters: readonly (string | number | null)[],
): Row[] {
  metrics.queryCalls += 1;
  metrics.parameterBytes += serializedBytes(parameters);
  const rows = database.prepare(sql).all(...values(parameters)) as Row[];
  metrics.returnedRows += rows.length;
  metrics.returnedBytes += serializedBytes(rows);
  return rows;
}

export function initializePrefilterDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL DEFAULT 0,
      centerLon REAL NOT NULL DEFAULT 0,
      photoCount INTEGER NOT NULL DEFAULT 0,
      foodProbable INTEGER NOT NULL DEFAULT 0,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      exportedToCalendarId TEXT,
      notes TEXT,
      updatedAt INTEGER,
      awardAtVisit TEXT
    );
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_calendar_event ON visits(calendarEventId);
    CREATE TABLE reservation_import_sources (
      sourceEventId TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      visitId TEXT NOT NULL,
      importedAt INTEGER NOT NULL
    );
    CREATE TABLE dismissed_reservation_import_sources (
      sourceEventId TEXT PRIMARY KEY,
      dismissedAt INTEGER NOT NULL
    );
    CREATE TABLE reservation_import_review_exclusions (
      fingerprint TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      restaurantName TEXT NOT NULL,
      visitDate TEXT NOT NULL,
      action TEXT NOT NULL,
      excludedAt INTEGER NOT NULL
    );
  `);
}

export function localTimestamp(year: number, month: number, day: number, hour = 19, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function oracleLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function oracleLocalDateRange(timestamp: number): { readonly startTime: number; readonly endTime: number } {
  const date = new Date(timestamp);
  return {
    startTime: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    endTime: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
  };
}

function oracleSameLocalDate(a: number, b: number, metrics: PrefilterHarnessMetrics): boolean {
  metrics.localDateComparisons += 1;
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

// This literal oracle intentionally does not import production normalization or
// matching helpers. It is a direct copy of the behavior being replaced.
function oracleNormalizeName(value: string, metrics?: PrefilterHarnessMetrics): string {
  if (metrics) {
    metrics.nameNormalizations += 1;
  }
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/'s\b/g, "s")
    .replace(/[''’`´ʼʻ]/g, "")
    .replace(/\b(reservation|booking|dinner|lunch|brunch|breakfast|completed|at|for|via)\b/g, " ")
    .replace(/\b(resy|opentable|open table|tock)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function oracleSignificantWords(value: string): string[] {
  const ignored = new Set([
    "the",
    "restaurant",
    "cafe",
    "bar",
    "bistro",
    "kitchen",
    "grill",
    "house",
    "room",
    "and",
    "of",
    "in",
    "on",
  ]);
  return value.split(" ").filter((word) => word.length > 1 && !ignored.has(word));
}

function oracleNamesSimilar(a: string, b: string, metrics: PrefilterHarnessMetrics): boolean {
  metrics.fuzzyNameComparisons += 1;
  const normalizedA = oracleNormalizeName(a, metrics);
  const normalizedB = oracleNormalizeName(b, metrics);
  if (normalizedA.length < 3 || normalizedB.length < 3) {
    return false;
  }
  if (normalizedA === normalizedB) {
    return true;
  }
  if (normalizedA.length >= 6 && normalizedB.length >= 6) {
    return normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
  }
  const wordsA = oracleSignificantWords(normalizedA);
  const wordsB = oracleSignificantWords(normalizedB);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}

function oracleFingerprint(candidate: ReservationReviewPrefilterCandidate): string | null {
  const source = candidate.sourceName.trim().toLowerCase();
  const name = oracleNormalizeName(candidate.restaurantName);
  return !source || name.length < 3 ? null : `${source}:${oracleLocalDateKey(candidate.startTime)}:${name}`;
}

function oracleRestaurantMatch(
  candidate: ReservationReviewPrefilterCandidate,
  visit: ExistingVisitRow,
  metrics: PrefilterHarnessMetrics,
): boolean {
  if (
    candidate.restaurantId &&
    (visit.restaurantId === candidate.restaurantId || visit.suggestedRestaurantId === candidate.restaurantId)
  ) {
    return true;
  }
  if (
    candidate.suggestedRestaurantId &&
    (visit.restaurantId === candidate.suggestedRestaurantId ||
      visit.suggestedRestaurantId === candidate.suggestedRestaurantId)
  ) {
    return true;
  }
  return [visit.restaurantName, visit.suggestedRestaurantName, visit.calendarEventTitle].some(
    (name) => typeof name === "string" && oracleNamesSimilar(candidate.restaurantName, name, metrics),
  );
}

function batches<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    result.push(items.slice(offset, offset + BATCH_SIZE));
  }
  return result;
}

export function runLiteralLegacyPrefilter(
  database: DatabaseSync,
  candidates: readonly ReservationReviewPrefilterCandidate[],
  metrics = emptyPrefilterHarnessMetrics(),
): { readonly snapshot: ReservationReviewPrefilterSnapshot; readonly metrics: PrefilterHarnessMetrics } {
  const dismissedSourceEventIds = new Set<string>();
  const sourceEventIds = candidates.map(({ sourceEventId }) => sourceEventId);
  for (const batch of batches(sourceEventIds)) {
    const rows = query<{ sourceEventId: string }>(
      database,
      metrics,
      `SELECT sourceEventId FROM dismissed_reservation_import_sources WHERE sourceEventId IN (${batch.map(() => "?").join(", ")})`,
      batch,
    );
    rows.forEach(({ sourceEventId }) => dismissedSourceEventIds.add(sourceEventId));
  }

  // The legacy exclusion helper independently reads dismissals a second time.
  const excludedSourceEventIds = new Set<string>();
  for (const batch of batches(sourceEventIds)) {
    const rows = query<{ sourceEventId: string }>(
      database,
      metrics,
      `SELECT sourceEventId FROM dismissed_reservation_import_sources WHERE sourceEventId IN (${batch.map(() => "?").join(", ")})`,
      batch,
    );
    rows.forEach(({ sourceEventId }) => excludedSourceEventIds.add(sourceEventId));
  }
  const fingerprintsBySource = new Map<string, string>();
  for (const candidate of candidates) {
    if (excludedSourceEventIds.has(candidate.sourceEventId)) {
      continue;
    }
    const fingerprint = oracleFingerprint(candidate);
    if (fingerprint) {
      fingerprintsBySource.set(candidate.sourceEventId, fingerprint);
    }
  }
  const uniqueFingerprints = [...new Set(fingerprintsBySource.values())];
  const excludedFingerprints = new Set<string>();
  for (const batch of batches(uniqueFingerprints)) {
    const rows = query<{ fingerprint: string }>(
      database,
      metrics,
      `SELECT fingerprint FROM reservation_import_review_exclusions WHERE fingerprint IN (${batch.map(() => "?").join(", ")})`,
      batch,
    );
    rows.forEach(({ fingerprint }) => excludedFingerprints.add(fingerprint));
  }
  for (const [sourceEventId, fingerprint] of fingerprintsBySource) {
    if (excludedFingerprints.has(fingerprint)) {
      excludedSourceEventIds.add(sourceEventId);
    }
  }

  const exactConfirmedSourceEventIds = new Set<string>();
  for (const batch of batches(sourceEventIds)) {
    const placeholders = batch.map(() => "?").join(", ");
    const linked = query<{ sourceEventId: string }>(
      database,
      metrics,
      `SELECT sources.sourceEventId
       FROM reservation_import_sources AS sources
       LEFT JOIN visits AS visit ON visit.id = sources.visitId
       WHERE sources.sourceEventId IN (${placeholders})
         AND (visit.status = 'confirmed' OR visit.id IS NULL)`,
      batch,
    );
    const legacy = query<{ calendarEventId: string }>(
      database,
      metrics,
      `SELECT calendarEventId FROM visits
       WHERE calendarEventId IN (${placeholders}) AND status = 'confirmed'`,
      batch,
    );
    linked.forEach(({ sourceEventId }) => exactConfirmedSourceEventIds.add(sourceEventId));
    legacy.forEach(({ calendarEventId }) => exactConfirmedSourceEventIds.add(calendarEventId));
  }

  const sameDateCandidates = candidates.filter(({ sourceEventId }) => !excludedSourceEventIds.has(sourceEventId));
  const sameDateConfirmedSourceEventIds = new Set<string>();
  if (sameDateCandidates.length > 0) {
    const ranges = sameDateCandidates.map(({ startTime }) => oracleLocalDateRange(startTime));
    const minimum = Math.min(...ranges.map(({ startTime }) => startTime));
    const maximum = Math.max(...ranges.map(({ endTime }) => endTime));
    const visits = query<ExistingVisitRow>(
      database,
      metrics,
      `SELECT visit.restaurantId, visit.suggestedRestaurantId, visit.startTime,
              restaurant.name AS restaurantName,
              suggested.name AS suggestedRestaurantName,
              visit.calendarEventTitle
       FROM visits AS visit
       LEFT JOIN restaurants AS restaurant ON restaurant.id = visit.restaurantId
       LEFT JOIN michelin_restaurants AS suggested ON suggested.id = visit.suggestedRestaurantId
       WHERE visit.status = 'confirmed' AND visit.startTime >= ? AND visit.startTime < ?
       ORDER BY visit.startTime ASC`,
      [minimum, maximum],
    );
    for (const candidate of sameDateCandidates) {
      if (
        visits.find(
          (visit) =>
            oracleSameLocalDate(visit.startTime, candidate.startTime, metrics) &&
            oracleRestaurantMatch(candidate, visit, metrics),
        )
      ) {
        sameDateConfirmedSourceEventIds.add(candidate.sourceEventId);
      }
    }
  }
  return {
    snapshot: {
      dismissedSourceEventIds,
      excludedSourceEventIds,
      exactConfirmedSourceEventIds,
      sameDateConfirmedSourceEventIds,
    },
    metrics,
  };
}

export async function runSnapshotPrefilter(
  database: DatabaseSync,
  candidates: readonly ReservationReviewPrefilterCandidate[],
  metrics = emptyPrefilterHarnessMetrics(),
): Promise<{ readonly snapshot: ReservationReviewPrefilterSnapshot; readonly metrics: PrefilterHarnessMetrics }> {
  const prepared = prepareReservationReviewPrefilter(candidates);
  database.exec("BEGIN");
  try {
    const rows = await readReservationReviewPrefilterSnapshotRows(
      {
        getAllAsync: async <Row>(sql: string, parameters: Array<string | number | null>) =>
          query<Row>(database, metrics, sql, parameters),
      },
      prepared,
    );
    database.exec("COMMIT");
    return { snapshot: finalizeReservationReviewPrefilterSnapshot(rows), metrics };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

export function snapshotHash(snapshot: ReservationReviewPrefilterSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        dismissed: sorted(snapshot.dismissedSourceEventIds),
        excluded: sorted(snapshot.excludedSourceEventIds),
        exactConfirmed: sorted(snapshot.exactConfirmedSourceEventIds),
        sameDateConfirmed: sorted(snapshot.sameDateConfirmedSourceEventIds),
      }),
    )
    .digest("hex");
}

function assertSnapshotEqual(
  actual: ReservationReviewPrefilterSnapshot,
  expected: ReservationReviewPrefilterSnapshot,
  label: string,
): void {
  assert.deepEqual(
    sorted(actual.dismissedSourceEventIds),
    sorted(expected.dismissedSourceEventIds),
    `${label}: dismissed`,
  );
  assert.deepEqual(
    sorted(actual.excludedSourceEventIds),
    sorted(expected.excludedSourceEventIds),
    `${label}: excluded`,
  );
  assert.deepEqual(
    sorted(actual.exactConfirmedSourceEventIds),
    sorted(expected.exactConfirmedSourceEventIds),
    `${label}: exact confirmed`,
  );
  assert.deepEqual(
    sorted(actual.sameDateConfirmedSourceEventIds),
    sorted(expected.sameDateConfirmedSourceEventIds),
    `${label}: same-date confirmed`,
  );
}

function insertVisit(
  database: DatabaseSync,
  row: {
    readonly id: string;
    readonly status: "confirmed" | "pending" | "rejected";
    readonly startTime: number;
    readonly restaurantId?: string | null;
    readonly restaurantName?: string | null;
    readonly suggestedRestaurantId?: string | null;
    readonly suggestedRestaurantName?: string | null;
    readonly calendarEventId?: string | null;
    readonly calendarEventTitle?: string | null;
  },
): void {
  if (row.restaurantId && row.restaurantName) {
    database
      .prepare("INSERT OR IGNORE INTO restaurants (id, name) VALUES (?, ?)")
      .run(row.restaurantId, row.restaurantName);
  }
  if (row.suggestedRestaurantId && row.suggestedRestaurantName) {
    database
      .prepare("INSERT OR IGNORE INTO michelin_restaurants (id, name) VALUES (?, ?)")
      .run(row.suggestedRestaurantId, row.suggestedRestaurantName);
  }
  database
    .prepare(
      `INSERT INTO visits (
         id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
         calendarEventId, calendarEventTitle
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.restaurantId ?? null,
      row.suggestedRestaurantId ?? null,
      row.status,
      row.startTime,
      row.startTime + 2 * 60 * 60 * 1_000,
      row.calendarEventId ?? null,
      row.calendarEventTitle ?? null,
    );
}

function candidate(
  sourceEventId: string,
  restaurantName: string,
  startTime: number,
  overrides: Partial<ReservationReviewPrefilterCandidate> = {},
): ReservationReviewPrefilterCandidate {
  return {
    sourceEventId,
    sourceName: "resy",
    restaurantName,
    startTime,
    restaurantId: `provider-${sourceEventId}`,
    ...overrides,
  };
}

async function assertComprehensiveParity(): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    initializePrefilterDatabase(database);
    const base = localTimestamp(2025, 1, 15);
    const dismissedCandidate = candidate("dismissed", "Dismissed Place", base);
    const fingerprintCandidate = candidate("fingerprint-new-id", "Café Tock Dinner", base);
    const fingerprint = oracleFingerprint(fingerprintCandidate)!;
    database.prepare("INSERT INTO dismissed_reservation_import_sources VALUES (?, ?)").run("dismissed", 1);
    const exclusion = database.prepare("INSERT INTO reservation_import_review_exclusions VALUES (?, ?, ?, ?, ?, ?)");
    exclusion.run(fingerprint, "resy", "Café Tock Dinner", "2025-01-15", "dismissed", 1);
    exclusion.run(oracleFingerprint(dismissedCandidate)!, "resy", "Dismissed Place", "2025-01-15", "approved", 1);

    insertVisit(database, { id: "source-confirmed-visit", status: "confirmed", startTime: base });
    insertVisit(database, { id: "source-pending-visit", status: "pending", startTime: base });
    insertVisit(database, { id: "source-rejected-visit", status: "rejected", startTime: base });
    database
      .prepare("INSERT INTO reservation_import_sources VALUES (?, ?, ?, ?)")
      .run("source-confirmed", "resy", "source-confirmed-visit", 1);
    database
      .prepare("INSERT INTO reservation_import_sources VALUES (?, ?, ?, ?)")
      .run("source-pending", "resy", "source-pending-visit", 1);
    database
      .prepare("INSERT INTO reservation_import_sources VALUES (?, ?, ?, ?)")
      .run("source-rejected", "resy", "source-rejected-visit", 1);
    database
      .prepare("INSERT INTO reservation_import_sources VALUES (?, ?, ?, ?)")
      .run("source-orphan", "resy", "missing-visit", 1);

    insertVisit(database, {
      id: "legacy-confirmed-visit",
      status: "confirmed",
      startTime: base,
      calendarEventId: "legacy-confirmed",
    });
    insertVisit(database, {
      id: "legacy-pending-visit",
      status: "pending",
      startTime: base,
      calendarEventId: "legacy-pending",
    });
    insertVisit(database, {
      id: "restaurant-id-visit",
      status: "confirmed",
      startTime: base,
      restaurantId: "restaurant-id",
      restaurantName: "Unrelated",
    });
    insertVisit(database, {
      id: "suggested-id-visit",
      status: "confirmed",
      startTime: base,
      suggestedRestaurantId: "michelin-42",
      suggestedRestaurantName: "Other Name",
    });
    insertVisit(database, {
      id: "normalized-name-visit",
      status: "confirmed",
      startTime: base,
      calendarEventTitle: "Cafe",
    });
    insertVisit(database, {
      id: "substring-name-visit",
      status: "confirmed",
      startTime: base,
      calendarEventTitle: "Chez Panisse Restaurant Berkeley",
    });
    insertVisit(database, {
      id: "word-name-visit",
      status: "confirmed",
      startTime: base,
      calendarEventTitle: "Nobu Cafe",
    });

    const spring = localTimestamp(2025, 3, 9, 3, 30);
    const fall = localTimestamp(2025, 11, 2, 1, 30);
    const beforeNewYear = Date.UTC(2026, 0, 1, 7, 30);
    const afterNewYear = Date.UTC(2026, 0, 1, 8, 30);
    insertVisit(database, { id: "spring", status: "confirmed", startTime: spring, calendarEventTitle: "Spring Cafe" });
    insertVisit(database, { id: "fall", status: "confirmed", startTime: fall, calendarEventTitle: "Fall Cafe" });
    insertVisit(database, {
      id: "year-before",
      status: "confirmed",
      startTime: beforeNewYear,
      calendarEventTitle: "Year Cafe",
    });
    insertVisit(database, {
      id: "year-after",
      status: "confirmed",
      startTime: afterNewYear,
      calendarEventTitle: "New Cafe",
    });

    const candidates = [
      dismissedCandidate,
      fingerprintCandidate,
      candidate("null-fingerprint", "Xi", base, { sourceName: "" }),
      candidate("source-confirmed", "Source Confirmed", base),
      candidate("source-pending", "Source Pending", base),
      candidate("source-rejected", "Source Rejected", base),
      candidate("source-orphan", "Source Orphan", base),
      candidate("legacy-confirmed", "Legacy Confirmed", base),
      candidate("legacy-pending", "Legacy Pending", base),
      candidate("id-restaurant", "Wrong Name", base, { restaurantId: "restaurant-id" }),
      candidate("id-suggested", "Wrong Name", base, { restaurantId: "michelin-42" }),
      candidate("candidate-suggested", "Wrong Name", base, {
        restaurantId: null,
        suggestedRestaurantId: "restaurant-id",
      }),
      candidate("name-normalized", "Café Tock Dinner", base, { restaurantId: null, sourceName: "opentable" }),
      candidate("name-substring", "Chez Panisse", base, { restaurantId: null }),
      candidate("name-words", "Nobu", base, { restaurantId: null }),
      candidate("name-short-false", "Xi", base, { restaurantId: null }),
      candidate("different-day", "Cafe", base + 24 * 60 * 60 * 1_000, { restaurantId: null }),
      candidate("dst-spring", "Spring Café", spring, { restaurantId: null }),
      candidate("dst-fall", "Fall Café", fall, { restaurantId: null }),
      candidate("year-before", "Year Café", beforeNewYear, { restaurantId: null }),
      candidate("year-after", "New Café", afterNewYear, { restaurantId: null }),
    ];

    const before = database
      .prepare("SELECT name, (SELECT COUNT(*) FROM visits) AS count FROM sqlite_schema ORDER BY name")
      .all();
    const totalChangesBefore = (database.prepare("SELECT total_changes() AS value").get() as { value: number }).value;
    const legacy = runLiteralLegacyPrefilter(database, candidates);
    const optimized = await runSnapshotPrefilter(database, candidates);
    assertSnapshotEqual(optimized.snapshot, legacy.snapshot, "comprehensive fixture");
    assert.deepEqual(sorted(optimized.snapshot.dismissedSourceEventIds), ["dismissed"]);
    assert.deepEqual(sorted(optimized.snapshot.excludedSourceEventIds), ["dismissed", "fingerprint-new-id"]);
    assert.deepEqual(sorted(optimized.snapshot.exactConfirmedSourceEventIds), [
      "legacy-confirmed",
      "source-confirmed",
      "source-orphan",
    ]);
    for (const expected of [
      "id-restaurant",
      "id-suggested",
      "candidate-suggested",
      "name-normalized",
      "name-substring",
      "name-words",
      "dst-spring",
      "dst-fall",
      "year-before",
      "year-after",
    ]) {
      assert(optimized.snapshot.sameDateConfirmedSourceEventIds.has(expected), `missing ${expected}`);
    }
    assert(!optimized.snapshot.sameDateConfirmedSourceEventIds.has("name-short-false"));
    assert(!optimized.snapshot.sameDateConfirmedSourceEventIds.has("different-day"));
    assert.equal(optimized.metrics.queryCalls, 2);
    const after = database
      .prepare("SELECT name, (SELECT COUNT(*) FROM visits) AS count FROM sqlite_schema ORDER BY name")
      .all();
    assert.deepEqual(after, before, "prefilter must not write schema or visit rows");
    assert.equal(
      (database.prepare("SELECT total_changes() AS value").get() as { value: number }).value,
      totalChangesBefore,
      "prefilter must execute no writes",
    );
  } finally {
    database.close();
  }
}

async function assertScaleBoundaries(): Promise<void> {
  for (const scale of [0, 1, 1_000, 1_001]) {
    const database = new DatabaseSync(":memory:");
    try {
      initializePrefilterDatabase(database);
      const candidates = Array.from({ length: scale }, (_, index) =>
        candidate(`scale-${scale}-${index}`, `Scale Restaurant ${index}`, localTimestamp(2025, 1, 1 + (index % 20))),
      );
      const legacy = runLiteralLegacyPrefilter(database, candidates);
      const optimized = await runSnapshotPrefilter(database, candidates);
      assertSnapshotEqual(optimized.snapshot, legacy.snapshot, `scale ${scale}`);
      assert.equal(optimized.metrics.queryCalls, scale === 0 ? 0 : 2, `optimized calls at ${scale}`);
      const expectedLegacyCalls = scale === 0 ? 0 : 4 * Math.ceil(scale / 1_000) + Math.ceil(scale / 1_000) + 1;
      assert.equal(legacy.metrics.queryCalls, expectedLegacyCalls, `legacy calls at ${scale}`);
    } finally {
      database.close();
    }
  }
}

async function assertAllExcludedSkipsSameDateSelect(): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    initializePrefilterDatabase(database);
    const input = [candidate("all-excluded", "Excluded Cafe", localTimestamp(2025, 6, 1))];
    database
      .prepare("INSERT INTO dismissed_reservation_import_sources (sourceEventId, dismissedAt) VALUES (?, ?)")
      .run(input[0]!.sourceEventId, 1);
    const legacy = runLiteralLegacyPrefilter(database, input);
    const optimized = await runSnapshotPrefilter(database, input);
    assertSnapshotEqual(optimized.snapshot, legacy.snapshot, "all-excluded fixture");
    assert.equal(optimized.metrics.queryCalls, 1, "all-excluded input needs only the exact-facts SELECT");
    assert.equal(legacy.metrics.queryCalls, 4);
  } finally {
    database.close();
  }
}

function explainDetails(database: DatabaseSync, sql: string, parameter: string): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter) as Array<{ detail: string }>).map(
    ({ detail }) => detail,
  );
}

function assertQueryPlans(): void {
  const database = new DatabaseSync(":memory:");
  try {
    initializePrefilterDatabase(database);
    const prepared = prepareReservationReviewPrefilter([candidate("plan", "Plan Cafe", localTimestamp(2025, 1, 1))]);
    const exact = explainDetails(
      database,
      RESERVATION_REVIEW_PREFILTER_EXACT_FACTS_SQL,
      prepared.exactFactsPayload,
    ).join("\n");
    assert.match(exact, /sqlite_autoindex_dismissed_reservation_import_sources_1/);
    assert.match(exact, /sqlite_autoindex_reservation_import_review_exclusions_1/);
    assert.match(exact, /sqlite_autoindex_reservation_import_sources_1/);
    assert.match(exact, /idx_visits_calendar_event/);
    const day = oracleLocalDateRange(localTimestamp(2025, 1, 1));
    const days = JSON.stringify([{ dayKey: "2025-01-01", ...day }]);
    const sameDate = explainDetails(database, RESERVATION_REVIEW_PREFILTER_CONFIRMED_DAYS_SQL, days).join("\n");
    assert.match(sameDate, /idx_visits_status_time \(status=\? AND startTime>\? AND startTime<\?\)/);
    assert.doesNotMatch(sameDate, /SCAN visit(?:\s|$)/);
  } finally {
    database.close();
  }
}

async function assertWalSnapshotContract(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "palate-review-prefilter-"));
  const path = join(directory, "fixture.db");
  const reader = new DatabaseSync(path);
  const writer = new DatabaseSync(path);
  try {
    reader.exec("PRAGMA journal_mode = WAL");
    initializePrefilterDatabase(reader);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000");
    const startTime = localTimestamp(2025, 4, 10);
    const input = [candidate("snapshot", "Snapshot Cafe", startTime, { restaurantId: null })];
    const prepared = prepareReservationReviewPrefilter(input);
    let calls = 0;
    reader.exec("BEGIN");
    const rows = await readReservationReviewPrefilterSnapshotRows(
      {
        getAllAsync: async <Row>(sql: string, parameters: Array<string | number | null>) => {
          const result = reader.prepare(sql).all(...values(parameters)) as Row[];
          calls += 1;
          if (calls === 1) {
            writer.exec("BEGIN IMMEDIATE");
            insertVisit(writer, {
              id: "concurrent-confirmed",
              status: "confirmed",
              startTime,
              calendarEventTitle: "Snapshot Cafe",
            });
            writer.exec("COMMIT");
          }
          return result;
        },
      },
      prepared,
    );
    reader.exec("COMMIT");
    assert.equal(calls, 2);
    const initialSnapshot = finalizeReservationReviewPrefilterSnapshot(rows);
    assert.deepEqual(sorted(initialSnapshot.sameDateConfirmedSourceEventIds), []);

    // Model the service's post-location integration: location resolution returns
    // null, so the candidate cannot enter the richer located-visit overlap path.
    // The fresh unresolved snapshot must still observe the concurrent commit and
    // keep the candidate out of review.
    const locatedSourceEventIds = new Set<string>();
    const unresolvedCandidates = input.filter(({ sourceEventId }) => !locatedSourceEventIds.has(sourceEventId));
    const fresh = await runSnapshotPrefilter(reader, unresolvedCandidates);
    assert.deepEqual(sorted(fresh.snapshot.sameDateConfirmedSourceEventIds), ["snapshot"]);
    const confirmedAfterLocation = new Set([
      ...initialSnapshot.exactConfirmedSourceEventIds,
      ...initialSnapshot.sameDateConfirmedSourceEventIds,
      ...fresh.snapshot.exactConfirmedSourceEventIds,
      ...fresh.snapshot.sameDateConfirmedSourceEventIds,
    ]);
    const reviewCandidates = input.filter(({ sourceEventId }) => !confirmedAfterLocation.has(sourceEventId));
    assert.deepEqual(reviewCandidates, [], "location-null candidate must be excluded after concurrent confirmation");
  } finally {
    writer.close();
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertProductionWiring(): void {
  const service = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
  const calendar = readFileSync(new URL("../utils/db/calendar.ts", import.meta.url), "utf8");
  const reviewStart = service.indexOf("export async function filterProviderReservationReviewCandidates");
  assert(reviewStart >= 0);
  const review = service.slice(reviewStart);
  assert.match(review, /getProviderReservationReviewPrefilterSnapshot\(deduped\.reservations\)/);
  assert.match(review, /getProviderReservationReviewPrefilterSnapshot\(unresolvedReservations\)/);
  assert.match(review, /buildReservationReviewVisits\(/);
  assert.match(review, /getReservationOnlyVisitsMappedToConfirmedVisitSourceIds\(visits\)/);
  assert.match(review, /unresolvedRecheck\.exactConfirmedSourceEventIds/);
  assert.match(review, /unresolvedRecheck\.sameDateConfirmedSourceEventIds/);
  assert.match(review, /\.\.\.unresolvedSourceEventIdsMappedToConfirmedVisits/);
  assert.doesNotMatch(review, /buildReservationOnlyVisits\(/);
  const reviewBuilder = service.slice(
    service.indexOf("function buildReservationReviewVisits"),
    service.indexOf("async function resolveReservationLocations"),
  );
  assert.match(reviewBuilder, /toReservationOnlyVisit\([\s\S]*null,[\s\n]*\)/);
  assert.doesNotMatch(
    reviewBuilder,
    /resolveReservationAwardsInBatches|readAwardsForProviderImportOrThrow|getAwardForDate/,
  );
  const importStart = service.indexOf("export async function importReservationVisitHistory");
  const importEnd = service.indexOf("export async function filterProviderReservationReviewCandidates");
  assert.match(service.slice(importStart, importEnd), /await buildReservationOnlyVisits\(/);
  assert.match(calendar, /withExclusiveTransactionAsync\(async \(transaction\) =>/);
  const transactionEnd = calendar.indexOf(
    "if (!snapshotRows)",
    calendar.indexOf("getProviderReservationReviewPrefilterSnapshot"),
  );
  const finalizeIndex = calendar.indexOf("return finalizeReservationReviewPrefilterSnapshot", transactionEnd);
  assert(
    transactionEnd >= 0 && finalizeIndex > transactionEnd,
    "final matching must occur after transaction completion",
  );
}

async function main(): Promise<void> {
  await assertComprehensiveParity();
  await assertScaleBoundaries();
  await assertAllExcludedSkipsSameDateSelect();
  assertQueryPlans();
  await assertWalSnapshotContract();
  assertProductionWiring();
  console.log("Reservation review prefilter oracle: passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
