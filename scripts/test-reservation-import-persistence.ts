#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  executeSetBasedReservationImportTransaction,
  type ReservationImportTransactionBackend,
} from "../utils/db/reservation-import-transaction-core.ts";
import type { ReservationOnlyVisitImportResult, ReservationOnlyVisitInput } from "../utils/db/types.ts";

// Keep DST fixtures deterministic on CI hosts whose system timezone is UTC.
process.env.TZ = "America/Los_Angeles";

export interface ReservationImportPersistenceMetrics {
  calls: number;
  reads: number;
  writes: number;
  parameterBytes: number;
}

type Metrics = ReservationImportPersistenceMetrics;

type Row = Record<string, unknown>;

process.env.TZ = "America/Los_Angeles";

export const RESERVATION_IMPORT_FIXED_NOW = 1_788_888_888_888;
const FIXED_NOW = RESERVATION_IMPORT_FIXED_NOW;
const BASE_TIME = new Date(2025, 0, 15, 18, 0, 0, 0).getTime();
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const BATCH_SIZE = 1_000;
const OVERLAP_BUFFER = 30 * 60 * 1_000;

function inputValues(parameters: readonly (string | number | null)[]): SQLInputValue[] {
  return parameters as SQLInputValue[];
}

function parameterSize(parameters: readonly (string | number | null)[]): number {
  return Buffer.byteLength(JSON.stringify(parameters), "utf8");
}

function backend(database: DatabaseSync, metrics: Metrics): ReservationImportTransactionBackend {
  return {
    getAllAsync: async <Result>(sql: string, parameters: Array<string | number | null>): Promise<Result[]> => {
      metrics.calls += 1;
      metrics.reads += 1;
      metrics.parameterBytes += parameterSize(parameters);
      return database.prepare(sql).all(...inputValues(parameters)) as Result[];
    },
    runAsync: async (sql: string, parameters: Array<string | number | null>) => {
      metrics.calls += 1;
      metrics.writes += 1;
      metrics.parameterBytes += parameterSize(parameters);
      const result = database.prepare(sql).run(...inputValues(parameters));
      return { changes: Number(result.changes) };
    },
  };
}

export function emptyReservationImportPersistenceMetrics(): Metrics {
  return { calls: 0, reads: 0, writes: 0, parameterBytes: 0 };
}

const emptyMetrics = emptyReservationImportPersistenceMetrics;

export function initializeReservationImportPersistenceDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      cuisine TEXT NOT NULL DEFAULT '',
      latestAwardYear INTEGER,
      award TEXT NOT NULL DEFAULT '',
      datasetVersion TEXT
    );
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      googlePlaceId TEXT,
      cuisine TEXT,
      priceLevel INTEGER,
      rating REAL,
      notes TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL DEFAULT 0,
      foodProbable INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId),
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
      FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
    );
    CREATE TABLE reservation_import_sources (
      sourceEventId TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      visitId TEXT NOT NULL,
      importedAt INTEGER NOT NULL,
      FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_visits_time ON visits(startTime);
    CREATE INDEX idx_visits_calendar_event ON visits(calendarEventId);
  `);
  const insertGuide = database.prepare(
    `INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
     VALUES (?, ?, ?, ?, '', '', '', 2026, 'Selected', 'fixture')`,
  );
  for (const [id, name, latitude, longitude] of [
    ["michelin-a", "Alpha Dining", 40.71, -74.0],
    ["michelin-b", "Beta Dining", 40.72, -74.01],
    ["michelin-c", "Café Neige", 40.73, -74.02],
    ["michelin-shared", "Shared Guide", 41, -73],
  ] as const) {
    insertGuide.run(id, name, latitude, longitude);
  }
}

const initializeDatabase = initializeReservationImportPersistenceDatabase;

export function insertReservationImportFixtureRestaurant(
  database: DatabaseSync,
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  optional: { address?: string | null; phone?: string | null; website?: string | null; cuisine?: string | null } = {},
): void {
  database
    .prepare(
      `INSERT INTO restaurants (id, name, latitude, longitude, address, phone, website, cuisine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      latitude,
      longitude,
      optional.address ?? null,
      optional.phone ?? null,
      optional.website ?? null,
      optional.cuisine ?? null,
    );
}

const insertRestaurant = insertReservationImportFixtureRestaurant;

interface SeedVisitOptions {
  id: string;
  startTime: number;
  restaurantId?: string | null;
  suggestedRestaurantId?: string | null;
  status?: "pending" | "confirmed" | "rejected";
  latitude?: number;
  longitude?: number;
  photoCount?: number;
  calendarEventId?: string | null;
  calendarEventTitle?: string | null;
  calendarEventLocation?: string | null;
  calendarEventIsAllDay?: number | null;
  awardAtVisit?: string | null;
  notes?: string | null;
  updatedAt?: number | null;
}

export function insertReservationImportFixtureVisit(database: DatabaseSync, options: SeedVisitOptions): void {
  database
    .prepare(
      `INSERT INTO visits (
        id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
        centerLat, centerLon, photoCount, foodProbable, calendarEventId,
        calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
        notes, updatedAt, exportedToCalendarId, awardAtVisit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      options.id,
      options.restaurantId ?? null,
      options.suggestedRestaurantId ?? null,
      options.status ?? "pending",
      options.startTime,
      options.startTime + 2 * HOUR,
      options.latitude ?? 40.71,
      options.longitude ?? -74,
      options.photoCount ?? 3,
      options.calendarEventId ?? null,
      options.calendarEventTitle ?? null,
      options.calendarEventLocation ?? null,
      options.calendarEventIsAllDay ?? null,
      options.notes ?? null,
      options.updatedAt ?? 1_700_000_000_000,
      options.awardAtVisit ?? null,
    );
}

const insertSeedVisit = insertReservationImportFixtureVisit;

export function makeReservationImportFixtureVisit(
  id: string,
  sourceEventId: string,
  startTime: number,
  restaurant: ReservationOnlyVisitInput["restaurant"],
  overrides: Partial<ReservationOnlyVisitInput> = {},
): ReservationOnlyVisitInput {
  return {
    id,
    sourceEventId,
    sourceName: "fixture-provider",
    sourceTitle: restaurant.name,
    sourceLocation: restaurant.address ?? null,
    startTime,
    endTime: startTime + 2 * HOUR,
    restaurant,
    suggestedRestaurantId: null,
    suggestedRestaurantDistance: null,
    awardAtVisit: null,
    notes: null,
    ...overrides,
  };
}

const makeVisit = makeReservationImportFixtureVisit;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function distanceMeters(firstLat: number, firstLon: number, secondLat: number, secondLon: number): number {
  const radians = (degrees: number) => degrees * (Math.PI / 180);
  const latitudeDelta = radians(secondLat - firstLat);
  const longitudeDelta = radians(secondLon - firstLon);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(firstLat)) * Math.cos(radians(secondLat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizeName(value: string): string {
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

function namesAreSimilar(first: string, second: string): boolean {
  const a = normalizeName(first);
  const b = normalizeName(second);
  if (a.length < 3 || b.length < 3) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.length >= 6 && b.length >= 6) {
    return a.includes(b) || b.includes(a);
  }
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
  const words = (value: string) => value.split(" ").filter((word) => word.length > 1 && !ignored.has(word));
  const aw = words(a);
  const bw = words(b);
  const shorter = aw.length <= bw.length ? aw : bw;
  const longer = aw.length <= bw.length ? bw : aw;
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}

function matchesRestaurant(reservation: ReservationOnlyVisitInput, visit: Row): boolean {
  if (
    visit.restaurantId === reservation.restaurant.id ||
    visit.suggestedRestaurantId === reservation.restaurant.id ||
    (Boolean(reservation.suggestedRestaurantId) &&
      (visit.restaurantId === reservation.suggestedRestaurantId ||
        visit.suggestedRestaurantId === reservation.suggestedRestaurantId))
  ) {
    return true;
  }
  return [reservation.restaurant.name, reservation.sourceTitle].some((candidate) =>
    [visit.restaurantName, visit.suggestedRestaurantName, visit.calendarEventTitle].some(
      (existing) => typeof existing === "string" && namesAreSimilar(candidate, existing),
    ),
  );
}

function overlapScore(reservation: ReservationOnlyVisitInput, visit: Row): number {
  if (visit.status === "rejected") {
    return 0;
  }
  if (visit.calendarEventId === reservation.sourceEventId) {
    return 10_000;
  }
  const startTime = Number(visit.startTime);
  const endTime = Number(visit.endTime);
  if (!(startTime < reservation.endTime + OVERLAP_BUFFER && endTime > reservation.startTime - OVERLAP_BUFFER)) {
    return 0;
  }
  const restaurantMatches = matchesRestaurant(reservation, visit);
  const distance = distanceMeters(
    Number(visit.centerLat),
    Number(visit.centerLon),
    reservation.restaurant.latitude,
    reservation.restaurant.longitude,
  );
  if (visit.status === "confirmed" && visit.restaurantId && !restaurantMatches && distance > 100) {
    return 0;
  }
  if (!restaurantMatches && distance > 350) {
    return 0;
  }
  const overlap = Math.max(0, Math.min(endTime, reservation.endTime) - Math.max(startTime, reservation.startTime));
  let score = (overlap / Math.max(1, reservation.endTime - reservation.startTime)) * 100;
  if (restaurantMatches) {
    score += 500;
  }
  if (distance <= 75) {
    score += 250;
  } else if (distance <= 150) {
    score += 150;
  } else if (distance <= 250) {
    score += 75;
  }
  if (Number(visit.photoCount) > 0) {
    score += 25;
  }
  if (visit.status === "pending") {
    score += 20;
  }
  return score;
}

function bestOverlap(reservation: ReservationOnlyVisitInput, visits: readonly Row[]): Row | null {
  let best: Row | null = null;
  let bestScore = 0;
  for (const visit of visits) {
    const score = overlapScore(reservation, visit);
    if (score > bestScore) {
      best = visit;
      bestScore = score;
    }
  }
  return best;
}

function sameLocalDate(first: number, second: number): boolean {
  const a = new Date(first);
  const b = new Date(second);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function localDateRange(timestamp: number): { startTime: number; endTime: number } {
  const date = new Date(timestamp);
  return {
    startTime: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    endTime: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
  };
}

function sameDateMatch(reservation: ReservationOnlyVisitInput, visits: readonly Row[]): Row | null {
  return (
    visits.find(
      (visit) =>
        visit.status === "confirmed" &&
        sameLocalDate(Number(visit.startTime), reservation.startTime) &&
        matchesRestaurant(reservation, visit),
    ) ?? null
  );
}

function externalRestaurant(id: unknown): boolean {
  return typeof id === "string" && (id.startsWith("resy-") || id.startsWith("tock-") || id.startsWith("opentable-"));
}

function countCall(metrics: Metrics, kind: "read" | "write", parameters: readonly unknown[]): void {
  metrics.calls += 1;
  metrics[kind === "read" ? "reads" : "writes"] += 1;
  metrics.parameterBytes += Buffer.byteLength(JSON.stringify(parameters), "utf8");
}

/** Independent literal transcription of the removed row-by-row behavior. */
export function executeLiteralReservationImportPersistence(
  database: DatabaseSync,
  visits: readonly ReservationOnlyVisitInput[],
  updatedAt: number,
  metrics: Metrics,
): ReservationOnlyVisitImportResult {
  if (visits.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: 0,
      skippedConflictCount: 0,
    };
  }
  const uniqueBySource = new Map<string, ReservationOnlyVisitInput>();
  for (const visit of visits) {
    if (!uniqueBySource.has(visit.sourceEventId)) {
      uniqueBySource.set(visit.sourceEventId, visit);
    }
  }
  const unique = [...uniqueBySource.values()];
  const existingSourceIds = new Set<string>();
  for (const batch of chunks(
    unique.map((visit) => visit.sourceEventId),
    BATCH_SIZE,
  )) {
    countCall(metrics, "read", batch);
    const linked = database
      .prepare(
        `SELECT sourceEventId FROM reservation_import_sources WHERE sourceEventId IN (${placeholders(batch.length)})`,
      )
      .all(...inputValues(batch)) as { sourceEventId: string }[];
    countCall(metrics, "read", batch);
    const legacy = database
      .prepare(`SELECT calendarEventId FROM visits WHERE calendarEventId IN (${placeholders(batch.length)})`)
      .all(...inputValues(batch)) as { calendarEventId: string }[];
    for (const row of linked) {
      existingSourceIds.add(row.sourceEventId);
    }
    for (const row of legacy) {
      existingSourceIds.add(row.calendarEventId);
    }
  }
  const fresh = unique.filter((visit) => !existingSourceIds.has(visit.sourceEventId));
  if (fresh.length === 0) {
    return {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: visits.length,
      skippedConflictCount: 0,
    };
  }

  const minimumStart = Math.min(...fresh.map((visit) => visit.startTime)) - OVERLAP_BUFFER;
  const maximumEnd = Math.max(...fresh.map((visit) => visit.endTime)) + OVERLAP_BUFFER;
  countCall(metrics, "read", [maximumEnd, minimumStart]);
  const overlapVisits = database
    .prepare(
      `SELECT v.*, r.name AS restaurantName, m.name AS suggestedRestaurantName
       FROM visits v
       LEFT JOIN restaurants r ON v.restaurantId = r.id
       LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
       WHERE v.startTime < ? AND v.endTime > ?
       ORDER BY v.startTime ASC`,
    )
    .all(maximumEnd, minimumStart) as Row[];
  const ranges = fresh.map((visit) => localDateRange(visit.startTime));
  const minimumDate = Math.min(...ranges.map((range) => range.startTime));
  const maximumDate = Math.max(...ranges.map((range) => range.endTime));
  countCall(metrics, "read", [minimumDate, maximumDate]);
  const sameDateVisits = database
    .prepare(
      `SELECT v.*, r.name AS restaurantName, m.name AS suggestedRestaurantName
       FROM visits v
       LEFT JOIN restaurants r ON v.restaurantId = r.id
       LEFT JOIN michelin_restaurants m ON v.suggestedRestaurantId = m.id
       WHERE v.status = 'confirmed' AND v.startTime >= ? AND v.startTime < ?
       ORDER BY v.startTime ASC`,
    )
    .all(minimumDate, maximumDate) as Row[];

  let insertedCount = 0;
  let linkedExistingCount = 0;
  let confirmedExistingCount = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const batch of chunks(fresh, BATCH_SIZE)) {
      const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const parameters = batch.flatMap((visit) => [
        visit.restaurant.id,
        visit.restaurant.name,
        visit.restaurant.latitude,
        visit.restaurant.longitude,
        visit.restaurant.address ?? null,
        visit.restaurant.phone ?? null,
        visit.restaurant.website ?? null,
        visit.restaurant.cuisine ?? null,
      ]);
      countCall(metrics, "write", parameters);
      database
        .prepare(
          `INSERT INTO restaurants (id, name, latitude, longitude, address, phone, website, cuisine)
           VALUES ${values}
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             latitude = excluded.latitude,
             longitude = excluded.longitude,
             address = COALESCE(excluded.address, restaurants.address),
             phone = COALESCE(excluded.phone, restaurants.phone),
             website = COALESCE(excluded.website, restaurants.website),
             cuisine = COALESCE(excluded.cuisine, restaurants.cuisine)`,
        )
        .run(...inputValues(parameters));
    }

    for (const visit of fresh) {
      const existing = bestOverlap(visit, overlapVisits) ?? sameDateMatch(visit, sameDateVisits);
      const targetVisitId = typeof existing?.id === "string" ? existing.id : visit.id;
      if (existing) {
        const wasConfirmed = existing.status === "confirmed" && Boolean(existing.restaurantId);
        const canUpgrade = Boolean(visit.suggestedRestaurantId) && externalRestaurant(existing.restaurantId);
        const canUseRestaurant =
          existing.status !== "rejected" &&
          (existing.status !== "confirmed" ||
            !existing.restaurantId ||
            existing.restaurantId === visit.restaurant.id ||
            canUpgrade);
        const shouldConfirm = canUseRestaurant && existing.restaurantId !== visit.restaurant.id;
        const assignments = ["updatedAt = ?"];
        const parameters: Array<string | number | null> = [updatedAt];
        if (!existing.calendarEventId) {
          assignments.push(
            "calendarEventId = ?",
            "calendarEventTitle = ?",
            "calendarEventLocation = ?",
            "calendarEventIsAllDay = 0",
          );
          parameters.push(visit.sourceEventId, visit.sourceTitle, visit.sourceLocation);
        }
        if (
          visit.suggestedRestaurantId &&
          canUseRestaurant &&
          existing.suggestedRestaurantId !== visit.suggestedRestaurantId
        ) {
          assignments.push("suggestedRestaurantId = ?");
          parameters.push(visit.suggestedRestaurantId);
        }
        if (shouldConfirm) {
          assignments.push("restaurantId = ?", "status = 'confirmed'", "awardAtVisit = ?");
          parameters.push(visit.restaurant.id, visit.awardAtVisit ?? null);
        } else if (existing.restaurantId === visit.restaurant.id && !existing.awardAtVisit && visit.awardAtVisit) {
          assignments.push("awardAtVisit = ?");
          parameters.push(visit.awardAtVisit);
        }
        parameters.push(String(existing.id));
        countCall(metrics, "write", parameters);
        database.prepare(`UPDATE visits SET ${assignments.join(", ")} WHERE id = ?`).run(...inputValues(parameters));
        linkedExistingCount += 1;
        if (!wasConfirmed && shouldConfirm) {
          confirmedExistingCount += 1;
        }
      } else {
        const parameters = [
          visit.id,
          visit.restaurant.id,
          visit.suggestedRestaurantId ?? null,
          visit.startTime,
          visit.endTime,
          visit.restaurant.latitude,
          visit.restaurant.longitude,
          visit.sourceEventId,
          visit.sourceTitle,
          visit.sourceLocation,
          visit.notes ?? null,
          updatedAt,
          visit.awardAtVisit ?? null,
        ];
        countCall(metrics, "write", parameters);
        const result = database
          .prepare(
            `INSERT OR IGNORE INTO visits (
              id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
              centerLat, centerLon, photoCount, foodProbable, calendarEventId,
              calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
              notes, updatedAt, awardAtVisit
            ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(...inputValues(parameters));
        if (Number(result.changes) > 0) {
          insertedCount += 1;
          overlapVisits.push({
            id: visit.id,
            restaurantId: visit.restaurant.id,
            suggestedRestaurantId: visit.suggestedRestaurantId ?? null,
            status: "confirmed",
            startTime: visit.startTime,
            endTime: visit.endTime,
            centerLat: visit.restaurant.latitude,
            centerLon: visit.restaurant.longitude,
            photoCount: 0,
            foodProbable: 0,
            calendarEventId: visit.sourceEventId,
            calendarEventTitle: visit.sourceTitle,
            calendarEventLocation: visit.sourceLocation,
            calendarEventIsAllDay: 0,
            exportedToCalendarId: null,
            notes: visit.notes ?? null,
            updatedAt,
            awardAtVisit: visit.awardAtVisit ?? null,
          });
        } else {
          linkedExistingCount += 1;
        }
      }
      const sourceParameters = [visit.sourceEventId, visit.sourceName, targetVisitId, updatedAt];
      countCall(metrics, "write", sourceParameters);
      database
        .prepare(
          `INSERT OR IGNORE INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
           VALUES (?, ?, ?, ?)`,
        )
        .run(...inputValues(sourceParameters));
      if (visit.suggestedRestaurantId) {
        const suggestionParameters = [
          targetVisitId,
          visit.suggestedRestaurantId,
          visit.suggestedRestaurantDistance ?? 0,
        ];
        countCall(metrics, "write", suggestionParameters);
        database
          .prepare(
            `INSERT OR REPLACE INTO visit_suggested_restaurants (visitId, restaurantId, distance)
             VALUES (?, ?, ?)`,
          )
          .run(...inputValues(suggestionParameters));
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    insertedCount,
    linkedExistingCount,
    confirmedExistingCount,
    skippedDuplicateCount: visits.length - fresh.length,
    skippedConflictCount: 0,
  };
}

const executeLiteralOracle = executeLiteralReservationImportPersistence;

export async function executeSetBasedReservationImportPersistence(
  database: DatabaseSync,
  visits: readonly ReservationOnlyVisitInput[],
  metrics: Metrics,
): Promise<ReservationOnlyVisitImportResult> {
  // Match Expo SQLite's deferred withExclusiveTransactionAsync semantics.
  database.exec("BEGIN");
  try {
    const result = await executeSetBasedReservationImportTransaction(backend(database, metrics), visits, FIXED_NOW);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const executeCandidate = executeSetBasedReservationImportPersistence;

const SNAPSHOT_TABLES = [
  "michelin_restaurants",
  "restaurants",
  "visits",
  "visit_suggested_restaurants",
  "reservation_import_sources",
] as const;

export function snapshotReservationImportPersistenceTables(database: DatabaseSync): Record<string, Row[]> {
  return Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => {
      const order =
        table === "visit_suggested_restaurants"
          ? "visitId, restaurantId"
          : table === "reservation_import_sources"
            ? "sourceEventId"
            : "id";
      return [table, database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[]];
    }),
  );
}

const snapshot = snapshotReservationImportPersistenceTables;

export function assertHealthyReservationImportPersistenceDatabase(database: DatabaseSync): void {
  assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

const assertHealthy = assertHealthyReservationImportPersistenceDatabase;

function seedRichFixture(database: DatabaseSync): ReservationOnlyVisitInput[] {
  insertRestaurant(database, "resy-old", "Old External", 40.71, -74, { address: "External address" });
  insertRestaurant(database, "local-a", "Local Alpha", 40.72, -74.01, { address: "Local address" });
  insertRestaurant(database, "local-same", "Café Neige", 40.73, -74.02);
  insertRestaurant(database, "collision-restaurant", "Collision Existing", 35, -120);
  insertSeedVisit(database, { id: "target-pending", startTime: BASE_TIME, status: "pending", restaurantId: null });
  insertSeedVisit(database, {
    id: "target-external",
    startTime: BASE_TIME + DAY,
    status: "confirmed",
    restaurantId: "resy-old",
    calendarEventId: "keep-calendar",
    calendarEventTitle: "Keep title",
    calendarEventIsAllDay: 1,
    awardAtVisit: "Keep award",
  });
  insertSeedVisit(database, {
    id: "target-local",
    startTime: BASE_TIME + 2 * DAY,
    status: "confirmed",
    restaurantId: "local-a",
    latitude: 40.72,
    longitude: -74.01,
  });
  insertSeedVisit(database, {
    id: "target-same-date",
    startTime: BASE_TIME + 3 * DAY - 9 * HOUR,
    status: "confirmed",
    restaurantId: "local-same",
    latitude: 40.73,
    longitude: -74.02,
  });
  insertSeedVisit(database, {
    id: "collision-id",
    startTime: BASE_TIME - 100 * DAY,
    status: "confirmed",
    restaurantId: "collision-restaurant",
    latitude: 35,
    longitude: -120,
  });
  insertSeedVisit(database, {
    id: "tie-first",
    startTime: BASE_TIME + 6 * DAY,
    status: "pending",
    latitude: 42,
    longitude: -71,
  });
  insertSeedVisit(database, {
    id: "tie-second",
    startTime: BASE_TIME + 6 * DAY,
    status: "pending",
    latitude: 42,
    longitude: -71,
  });
  database
    .prepare(
      `INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
       VALUES ('collision-id', 'michelin-a', 999)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
       VALUES ('already-imported', 'fixture-provider', 'collision-id', 1)`,
    )
    .run();

  const alpha = { id: "michelin-a", name: "Alpha Dining", latitude: 40.71, longitude: -74, address: "A" };
  const beta = { id: "michelin-b", name: "Beta Dining", latitude: 40.72, longitude: -74.01, address: "B" };
  const betaNearPending = { ...beta, latitude: 40.7101, longitude: -74.0001 };
  const same = { id: "local-same", name: "Cafe Neige", latitude: 40.73, longitude: -74.02 };
  const chain = { id: "resy-chain-old", name: "Chain Room", latitude: 39, longitude: -75 };
  const chainUpgrade = { id: "michelin-b", name: "Chain Room", latitude: 39, longitude: -75 };
  const sharedFirst = {
    id: "shared-provider",
    name: "Shared First",
    latitude: 10,
    longitude: 20,
    address: "First address",
    phone: "111",
    website: "https://first.example",
  };
  const sharedSecond = {
    id: "shared-provider",
    name: "Shared Second",
    latitude: 11,
    longitude: 21,
    address: null,
    phone: "222",
    website: null,
    cuisine: "Later cuisine",
  };
  const visits = [
    makeVisit("pending-a", "source-pending-a", BASE_TIME, alpha, {
      suggestedRestaurantId: "michelin-a",
      suggestedRestaurantDistance: 10,
      awardAtVisit: "Award A",
    }),
    makeVisit("pending-b", "source-pending-b", BASE_TIME + 5 * 60_000, betaNearPending, {
      suggestedRestaurantId: "michelin-b",
      suggestedRestaurantDistance: 20,
      awardAtVisit: "Award B",
    }),
    makeVisit("external-upgrade", "source-external", BASE_TIME + DAY, alpha, {
      suggestedRestaurantId: "michelin-a",
      suggestedRestaurantDistance: 30,
      awardAtVisit: "External award",
    }),
    makeVisit("local-protected", "source-local", BASE_TIME + 2 * DAY, beta, {
      suggestedRestaurantId: "michelin-b",
      suggestedRestaurantDistance: 40,
      awardAtVisit: "Should not replace",
    }),
    makeVisit("same-date-input", "source-same-date", BASE_TIME + 3 * DAY + 4 * HOUR, same, {
      awardAtVisit: "Same-date award",
    }),
    makeVisit(
      "collision-id",
      "source-collision",
      BASE_TIME + 4 * DAY,
      { id: "collision-new-restaurant", name: "Collision New", latitude: 20, longitude: 20 },
      { suggestedRestaurantId: "michelin-a", suggestedRestaurantDistance: 5 },
    ),
    makeVisit("chain-first", "source-chain-first", BASE_TIME + 5 * DAY, chain, {
      suggestedRestaurantId: "michelin-a",
      suggestedRestaurantDistance: 80,
      awardAtVisit: "Chain first award",
    }),
    makeVisit("chain-second", "source-chain-second", BASE_TIME + 5 * DAY + 15 * 60_000, chainUpgrade, {
      suggestedRestaurantId: "michelin-b",
      suggestedRestaurantDistance: 12,
      awardAtVisit: "Chain upgraded award",
    }),
    makeVisit("tie-input", "source-tie", BASE_TIME + 6 * DAY, {
      id: "tie-restaurant",
      name: "Tie",
      latitude: 42,
      longitude: -71,
    }),
    makeVisit("shared-one", "source-shared-one", BASE_TIME + 7 * DAY, sharedFirst),
    makeVisit("shared-two", "source-shared-two", BASE_TIME + 8 * DAY, sharedSecond),
    makeVisit("same-dynamic-id", "source-dynamic-one", BASE_TIME + 9 * DAY, {
      id: "dynamic-one-rest",
      name: "Dynamic One",
      latitude: -10,
      longitude: 30,
    }),
    makeVisit("same-dynamic-id", "source-dynamic-two", BASE_TIME + 10 * DAY, {
      id: "dynamic-two-rest",
      name: "Dynamic Two",
      latitude: -20,
      longitude: 40,
    }),
    makeVisit("skipped-id", "already-imported", BASE_TIME + 11 * DAY, alpha),
  ];
  visits.splice(2, 0, {
    ...visits[0]!,
    id: "duplicate-source-must-lose",
    sourceTitle: "Wrong duplicate",
  });
  return visits;
}

async function assertRichParity(): Promise<void> {
  const oracle = new DatabaseSync(":memory:");
  const candidate = new DatabaseSync(":memory:");
  initializeDatabase(oracle);
  initializeDatabase(candidate);
  const oracleInputs = seedRichFixture(oracle);
  const candidateInputs = seedRichFixture(candidate);
  const oracleMetrics = emptyMetrics();
  const candidateMetrics = emptyMetrics();
  const expected = executeLiteralOracle(oracle, oracleInputs, FIXED_NOW, oracleMetrics);
  const actual = await executeCandidate(candidate, candidateInputs, candidateMetrics);
  assert.deepEqual(actual, expected, "rich result counters");
  assert.deepEqual(snapshot(candidate), snapshot(oracle), "rich complete-table parity");
  assert.ok(
    candidateMetrics.calls <= 10,
    `candidate should use at most ten calls including lock setup, saw ${candidateMetrics.calls}`,
  );
  assert.ok(oracleMetrics.calls > candidateMetrics.calls * 3, "rich fixture should exercise structural call reduction");

  const pending = candidate.prepare("SELECT * FROM visits WHERE id = 'target-pending'").get() as Row;
  assert.equal(pending.restaurantId, "michelin-b", "last stale confirmation restaurant wins");
  assert.equal(pending.calendarEventId, "source-pending-b", "last stale calendar assignment wins");
  assert.equal(pending.awardAtVisit, "Award B", "last stale award assignment wins");
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-chain-second'")
        .get() as Row
    ).visitId,
    "chain-first",
    "later overlap links to an earlier inserted input",
  );
  const upgradedChain = candidate.prepare("SELECT * FROM visits WHERE id = 'chain-first'").get() as Row;
  assert.equal(upgradedChain.restaurantId, "michelin-b", "later input updates an earlier planned insert");
  assert.equal(upgradedChain.suggestedRestaurantId, "michelin-b");
  assert.equal(upgradedChain.awardAtVisit, "Chain upgraded award");
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-collision'")
        .get() as Row
    ).visitId,
    "collision-id",
    "ID collision retains legacy target mapping",
  );
  assert.equal(
    (
      candidate
        .prepare(
          "SELECT distance FROM visit_suggested_restaurants WHERE visitId = 'collision-id' AND restaurantId = 'michelin-a'",
        )
        .get() as Row
    ).distance,
    5,
    "ID collision still replaces the suggestion",
  );
  const shared = candidate.prepare("SELECT * FROM restaurants WHERE id = 'shared-provider'").get() as Row;
  assert.equal(shared.name, "Shared Second");
  assert.equal(shared.latitude, 11);
  assert.equal(shared.address, "First address", "later null optional restaurant field preserves prior value");
  assert.equal(shared.phone, "222", "later non-null optional restaurant field wins");
  assert.equal(shared.website, "https://first.example");
  assert.equal(shared.cuisine, "Later cuisine");
  assert.equal(
    candidate.prepare("SELECT COUNT(*) AS count FROM visits WHERE id = 'duplicate-source-must-lose'").get()?.count,
    0,
    "first source occurrence wins",
  );
  assertHealthy(oracle);
  assertHealthy(candidate);
  oracle.close();
  candidate.close();
}

async function assertLargeParity(): Promise<void> {
  const oracle = new DatabaseSync(":memory:");
  const candidate = new DatabaseSync(":memory:");
  initializeDatabase(oracle);
  initializeDatabase(candidate);
  const restaurant = { id: "bulk-restaurant", name: "Bulk", latitude: 5, longitude: 6 };
  const inputs = Array.from({ length: 1_002 }, (_, index) =>
    makeVisit(
      `bulk-${index.toString().padStart(4, "0")}`,
      `bulk-source-${index.toString().padStart(4, "0")}`,
      BASE_TIME + index * 5 * HOUR,
      restaurant,
    ),
  );
  inputs.push({ ...inputs[0]!, id: "bulk-duplicate-source" });
  const oracleMetrics = emptyMetrics();
  const candidateMetrics = emptyMetrics();
  const expected = executeLiteralOracle(oracle, inputs, FIXED_NOW, oracleMetrics);
  const actual = await executeCandidate(candidate, inputs, candidateMetrics);
  assert.deepEqual(actual, expected, ">1000 result counters");
  assert.deepEqual(snapshot(candidate), snapshot(oracle), ">1000 complete-table parity");
  assert.equal(actual.insertedCount, 1_002);
  assert.equal(actual.skippedDuplicateCount, 1);
  assert.ok(candidateMetrics.calls <= 8, `large candidate call count: ${candidateMetrics.calls}`);
  assert.ok(oracleMetrics.calls >= 2_009, `large oracle statement count: ${oracleMetrics.calls}`);
  assertHealthy(candidate);
  oracle.close();
  candidate.close();
}

async function assertDstAndBoundaryParity(): Promise<void> {
  const oracle = new DatabaseSync(":memory:");
  const candidate = new DatabaseSync(":memory:");
  initializeDatabase(oracle);
  initializeDatabase(candidate);

  const seed = (database: DatabaseSync) => {
    insertRestaurant(database, "dst-rest", "DST Dining", 34, -118);
    insertRestaurant(database, "boundary-rest", "Boundary Dining", 35, -117);
    const springExisting = new Date(2025, 2, 9, 1, 0, 0, 0).getTime();
    const fallExisting = new Date(2025, 10, 2, 1, 0, 0, 0).getTime();
    const exactReservationStart = new Date(2025, 4, 10, 18, 0, 0, 0).getTime();
    const insideReservationStart = new Date(2025, 4, 11, 18, 0, 0, 0).getTime();
    insertSeedVisit(database, {
      id: "dst-spring-existing",
      startTime: springExisting,
      restaurantId: "dst-rest",
      status: "confirmed",
      latitude: 34,
      longitude: -118,
    });
    insertSeedVisit(database, {
      id: "dst-fall-existing",
      startTime: fallExisting,
      restaurantId: "dst-rest",
      status: "confirmed",
      latitude: 34,
      longitude: -118,
    });
    insertSeedVisit(database, {
      id: "boundary-exact-existing",
      startTime: exactReservationStart - 2 * HOUR - OVERLAP_BUFFER,
      restaurantId: null,
      status: "pending",
      latitude: 35,
      longitude: -117,
    });
    insertSeedVisit(database, {
      id: "boundary-inside-existing",
      startTime: insideReservationStart - 2 * HOUR - OVERLAP_BUFFER + 1,
      restaurantId: null,
      status: "pending",
      latitude: 35,
      longitude: -117,
    });
  };
  seed(oracle);
  seed(candidate);

  const springStart = new Date(2025, 2, 9, 0, 0, 0, 0).getTime();
  const springEnd = new Date(2025, 2, 10, 0, 0, 0, 0).getTime();
  const fallStart = new Date(2025, 10, 2, 0, 0, 0, 0).getTime();
  const fallEnd = new Date(2025, 10, 3, 0, 0, 0, 0).getTime();
  assert.equal(springEnd - springStart, 23 * HOUR, "spring-forward local date is 23 hours");
  assert.equal(fallEnd - fallStart, 25 * HOUR, "fall-back local date is 25 hours");

  const dstRestaurant = { id: "dst-rest", name: "DST Dining", latitude: 34, longitude: -118 };
  const boundaryRestaurant = {
    id: "boundary-rest",
    name: "Boundary Dining",
    latitude: 35,
    longitude: -117,
  };
  const inputs = [
    makeVisit("dst-spring-input", "source-dst-spring", new Date(2025, 2, 9, 22, 0, 0, 0).getTime(), dstRestaurant),
    makeVisit("dst-fall-input", "source-dst-fall", new Date(2025, 10, 2, 22, 0, 0, 0).getTime(), dstRestaurant),
    makeVisit(
      "boundary-exact-input",
      "source-boundary-exact",
      new Date(2025, 4, 10, 18, 0, 0, 0).getTime(),
      boundaryRestaurant,
    ),
    makeVisit(
      "boundary-inside-input",
      "source-boundary-inside",
      new Date(2025, 4, 11, 18, 0, 0, 0).getTime(),
      boundaryRestaurant,
    ),
  ];
  const expected = executeLiteralOracle(oracle, inputs, FIXED_NOW, emptyMetrics());
  const actual = await executeCandidate(candidate, inputs, emptyMetrics());
  assert.deepEqual(actual, expected, "DST/boundary result parity");
  assert.deepEqual(snapshot(candidate), snapshot(oracle), "DST/boundary complete-table parity");
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-dst-spring'")
        .get() as Row
    ).visitId,
    "dst-spring-existing",
    "same-local-date fallback spans the 23-hour day",
  );
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-dst-fall'")
        .get() as Row
    ).visitId,
    "dst-fall-existing",
    "same-local-date fallback spans the 25-hour day",
  );
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-boundary-exact'")
        .get() as Row
    ).visitId,
    "boundary-exact-input",
    "exact 30-minute separation is not an overlap",
  );
  assert.equal(
    (
      candidate
        .prepare("SELECT visitId FROM reservation_import_sources WHERE sourceEventId = 'source-boundary-inside'")
        .get() as Row
    ).visitId,
    "boundary-inside-existing",
    "one millisecond inside the 30-minute boundary overlaps",
  );
  assertHealthy(candidate);
  oracle.close();
  candidate.close();
}

async function assertLateFailureRollback(): Promise<void> {
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  const before = snapshot(database);
  database.exec(`
    CREATE TRIGGER fail_late_source
    BEFORE INSERT ON reservation_import_sources
    WHEN NEW.sourceEventId = 'source-fail-late'
    BEGIN
      SELECT RAISE(ABORT, 'forced late reservation import failure');
    END;
  `);
  const beforeWithTrigger = snapshot(database);
  const restaurant = { id: "rollback-rest", name: "Rollback", latitude: 1, longitude: 2 };
  const inputs = [
    makeVisit("rollback-one", "source-ok-before-failure", BASE_TIME, restaurant, {
      suggestedRestaurantId: "michelin-a",
      suggestedRestaurantDistance: 1,
    }),
    makeVisit("rollback-two", "source-fail-late", BASE_TIME + DAY, restaurant, {
      suggestedRestaurantId: "michelin-b",
      suggestedRestaurantDistance: 2,
    }),
  ];
  await assert.rejects(executeCandidate(database, inputs, emptyMetrics()), /forced late reservation import failure/);
  assert.deepEqual(snapshot(database), beforeWithTrigger, "late source failure must roll back every earlier set write");
  database.exec("DROP TRIGGER fail_late_source");
  assert.deepEqual(snapshot(database), before);
  assertHealthy(database);
  database.close();
}

async function assertWalInterleavingRecheck(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "palate-reservation-import-wal-"));
  const path = join(directory, "fixture.db");
  try {
    const setup = new DatabaseSync(path);
    setup.exec("PRAGMA journal_mode = WAL");
    initializeDatabase(setup);
    insertRestaurant(setup, "anchor-rest", "Anchor", 1, 2);
    insertSeedVisit(setup, {
      id: "anchor-visit",
      startTime: BASE_TIME - DAY,
      restaurantId: "anchor-rest",
      status: "confirmed",
      latitude: 1,
      longitude: 2,
    });
    setup.close();

    const candidate = new DatabaseSync(path);
    const writer = new DatabaseSync(path);
    candidate.exec("PRAGMA busy_timeout = 1000");
    writer.exec("PRAGMA busy_timeout = 1000");
    assert.equal(
      candidate
        .prepare("SELECT COUNT(*) AS count FROM reservation_import_sources WHERE sourceEventId = 'race-source'")
        .get()?.count,
      0,
      "stale pre-read observes no source",
    );
    writer
      .prepare(
        `INSERT INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
         VALUES ('race-source', 'other-writer', 'anchor-visit', 17)`,
      )
      .run();
    const before = snapshot(candidate);
    const result = await executeCandidate(
      candidate,
      [
        makeVisit("would-have-inserted", "race-source", BASE_TIME, {
          id: "race-rest",
          name: "Race",
          latitude: 1,
          longitude: 2,
        }),
      ],
      emptyMetrics(),
    );
    assert.deepEqual(result, {
      insertedCount: 0,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: 1,
      skippedConflictCount: 0,
    });
    assert.deepEqual(snapshot(candidate), before, "transactional source recheck observes the committed WAL writer");
    assertHealthy(candidate);
    candidate.close();
    writer.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertDeferredWriteIntentInterleaving(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "palate-reservation-import-write-intent-"));
  const path = join(directory, "fixture.db");
  let candidate: DatabaseSync | null = null;
  let writer: DatabaseSync | null = null;
  try {
    const setup = new DatabaseSync(path);
    setup.exec("PRAGMA journal_mode = WAL");
    initializeDatabase(setup);
    insertRestaurant(setup, "write-intent-anchor-rest", "Anchor", 1, 2);
    insertSeedVisit(setup, {
      id: "write-intent-anchor-visit",
      startTime: BASE_TIME - DAY,
      restaurantId: "write-intent-anchor-rest",
      status: "confirmed",
      latitude: 1,
      longitude: 2,
    });
    setup.close();

    candidate = new DatabaseSync(path);
    writer = new DatabaseSync(path);
    candidate.exec("PRAGMA busy_timeout = 1000; BEGIN");
    writer.exec("PRAGMA busy_timeout = 0");

    const metrics = emptyMetrics();
    const delegate = backend(candidate, metrics);
    const operations: Array<"read" | "write"> = [];
    let competingWriteBlocked = false;
    const transaction: ReservationImportTransactionBackend = {
      getAllAsync: async <Result>(sql: string, parameters: Array<string | number | null>) => {
        assert.ok(operations.length >= 2, "write intent must be acquired before the first recheck read");
        operations.push("read");
        return delegate.getAllAsync<Result>(sql, parameters);
      },
      runAsync: async (sql: string, parameters: Array<string | number | null>) => {
        operations.push("write");
        const result = await delegate.runAsync(sql, parameters);
        if (operations.length === 1) {
          assert.match(sql, /PRAGMA busy_timeout = 5000/);
        } else if (operations.length === 2) {
          assert.match(sql, /UPDATE reservation_import_sources[\s\S]*WHERE 0/);
          assert.equal(result.changes, 0, "write-intent statement must not mutate rows");
          assert.throws(
            () =>
              writer!
                .prepare(
                  `INSERT INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
                 VALUES ('write-intent-source', 'competing-writer', 'write-intent-anchor-visit', 17)`,
                )
                .run(),
            /database is locked/,
            "a competing writer must not commit between candidate recheck reads and writes",
          );
          competingWriteBlocked = true;
        }
        return result;
      },
    };

    const result = await executeSetBasedReservationImportTransaction(
      transaction,
      [
        makeVisit("write-intent-new-visit", "write-intent-source", BASE_TIME, {
          id: "write-intent-new-rest",
          name: "Write Intent",
          latitude: 10,
          longitude: 20,
        }),
      ],
      FIXED_NOW,
    );
    candidate.exec("COMMIT");

    assert.deepEqual(operations.slice(0, 2), ["write", "write"]);
    assert.equal(competingWriteBlocked, true);
    assert.deepEqual(result, {
      insertedCount: 1,
      linkedExistingCount: 0,
      confirmedExistingCount: 0,
      skippedDuplicateCount: 0,
      skippedConflictCount: 0,
    });
    assert.equal(
      writer
        .prepare(
          `INSERT OR IGNORE INTO reservation_import_sources (sourceEventId, source, visitId, importedAt)
           VALUES ('write-intent-source', 'competing-writer', 'write-intent-anchor-visit', 18)`,
        )
        .run().changes,
      0,
      "candidate source mapping wins after its locked transaction commits",
    );
    assertHealthy(candidate);
  } catch (error) {
    try {
      candidate?.exec("ROLLBACK");
    } catch {
      // The transaction may already be committed.
    }
    throw error;
  } finally {
    candidate?.close();
    writer?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertProductionWiring(): void {
  const calendarSource = readFileSync(new URL("../utils/db/calendar.ts", import.meta.url), "utf8");
  const barrelSource = readFileSync(new URL("../utils/db.ts", import.meta.url), "utf8");
  assert.match(calendarSource, /options\.strategy \?\? "legacy-row-v1"/);
  assert.match(calendarSource, /executeSetBasedReservationImportTransaction/);
  assert.match(calendarSource, /withExclusiveTransactionAsync/);
  assert.match(barrelSource, /ReservationOnlyVisitPersistenceStrategy/);
}

async function main(): Promise<void> {
  await assertRichParity();
  await assertLargeParity();
  await assertDstAndBoundaryParity();
  await assertLateFailureRollback();
  await assertWalInterleavingRecheck();
  await assertDeferredWriteIntentInterleaving();
  assertProductionWiring();

  console.log(
    "Reservation import persistence tests passed: independent literal parity, >1000 inputs, 23/25-hour DST dates, exact overlap boundaries, frozen matching semantics, ID/source/suggestion conflicts, late rollback, deferred write-intent/WAL rechecks, and legacy-default wiring.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
