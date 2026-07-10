#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { MergeableVisitGroup } from "../utils/db/types.ts";
import {
  buildVisitMergePlan,
  VISIT_MERGE_COPY_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL,
  VISIT_MERGE_DELETE_SOURCE_VISITS_SQL,
  VISIT_MERGE_MOVE_PHOTOS_SQL,
  VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL,
  VISIT_MERGE_PREFLIGHT_SQL,
  VISIT_MERGE_UPDATE_TARGETS_SQL,
  type VisitMergePreflightRow,
} from "../utils/db/visit-merge-core.ts";
import {
  CANDIDATE_BODY_CALLS,
  CANDIDATE_PREFLIGHT_CALLS,
  CANDIDATE_TRANSACTION_CONTROL_CALLS,
  FIXED_UPDATED_AT,
  LEGACY_CALLS_PER_SOURCE,
  assertDatabaseHealth,
  assertSnapshotsEquivalent,
  createGroup,
  createVisitMergeDatabase,
  executeCandidatePlan,
  executeLegacySequential,
  snapshotDatabase,
  type DatabaseSnapshot,
  type ExecutionCounts,
  type PhotoSeed,
  type VisitSeed,
} from "./test-visit-merge.ts";

interface Configuration {
  readonly databasePath: string | null;
  readonly samples: number;
  readonly warmupIterations: number;
  readonly outputPath: string;
}

interface SuggestionSeed {
  readonly visitId: string;
  readonly restaurantId: string;
  readonly distance: number;
}

interface ReservationSeed {
  readonly sourceEventId: string;
  readonly visitId: string;
}

interface Fixture {
  readonly mode: "deterministic-synthetic" | "mac-database-derived";
  readonly sourceDatabaseSha256: string | null;
  readonly sourceDatabaseBytes: number | null;
  readonly sourceSelectedVisitCount: number;
  readonly sourceSelectedPhotoCount: number;
  readonly sourceSelectedSuggestionCount: number;
  readonly restaurantIds: readonly string[];
  readonly michelinIds: readonly string[];
  readonly visits: readonly VisitSeed[];
  readonly photos: readonly PhotoSeed[];
  readonly suggestions: readonly SuggestionSeed[];
  readonly reservations: readonly ReservationSeed[];
  readonly groups: readonly MergeableVisitGroup[];
}

interface Measurement {
  readonly elapsedMilliseconds: number;
  readonly counts: ExecutionCounts;
  readonly exactFullSnapshotParity: boolean;
  readonly maximumCentroidAbsoluteDifference: number;
  readonly resultDigest: string;
}

interface Summary {
  readonly samplesMilliseconds: readonly number[];
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

interface CandidateDiagnostics {
  readonly phaseMilliseconds: Readonly<Record<string, number>>;
  readonly totalProfiledMilliseconds: number;
  readonly dominantPhase: { readonly name: string; readonly milliseconds: number; readonly percentage: number };
  readonly explainQueryPlan: Readonly<Record<string, readonly string[]>>;
  readonly indexSearchDetailCount: number;
  readonly indexedSearchDetails: readonly string[];
  readonly baseTableFullScanDetailCount: number;
  readonly exactFullSnapshotParity: boolean;
  readonly maximumCentroidAbsoluteDifference: number;
}

type Strategy = "legacySequential11Call" | "productionSetBasedTransaction";

const GROUP_COUNT = 37;
const VISITS_PER_GROUP = 5;
const SELECTED_VISIT_COUNT = GROUP_COUNT * VISITS_PER_GROUP;
const SOURCE_MERGE_COUNT = GROUP_COUNT * (VISITS_PER_GROUP - 1);
const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: null,
  samples: 7,
  warmupIterations: 1,
  outputPath: ".build/visit-merge-profile.json",
};

interface SourceVisitRow {
  readonly id: unknown;
  readonly suggestedRestaurantId: unknown;
  readonly startTime: unknown;
  readonly endTime: unknown;
  readonly centerLat: unknown;
  readonly centerLon: unknown;
  readonly photoCount: unknown;
  readonly foodProbable: unknown;
  readonly calendarEventId: unknown;
  readonly calendarEventTitle: unknown;
  readonly calendarEventLocation: unknown;
  readonly calendarEventIsAllDay: unknown;
  readonly exportedToCalendarId: unknown;
  readonly notes: unknown;
  readonly updatedAt: unknown;
  readonly awardAtVisit: unknown;
}

interface SourcePhotoRow {
  readonly id: unknown;
  readonly visitId: unknown;
  readonly creationTime: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly foodDetected: unknown;
}

interface SourceSuggestionRow {
  readonly visitId: unknown;
  readonly restaurantId: unknown;
  readonly distance: unknown;
}

function usage(): string {
  return `Usage: benchmark-visit-merge.ts [options]

  --database=PATH  Derive an anonymized 37x5 fixture from the 185 highest-photo
                   visits in an existing Palate SQLite database, opened read-only.
  --samples=N      Measured counterbalanced pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N       Counterbalanced warmup pairs (default: ${DEFAULT_CONFIGURATION.warmupIterations})
  --output=PATH    JSON report path (default: ${DEFAULT_CONFIGURATION.outputPath})
  --help, -h       Show this help

Timed regions include only JavaScript orchestration and in-memory SQLite merge
operations. Fixture loading/seeding, snapshots, validation, Expo's async bridge,
the macOS app, PhotoKit, and EventKit are excluded.`;
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
  let configuration = { ...DEFAULT_CONFIGURATION };
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
    if (value.length === 0) {
      throw new RangeError(`${option} cannot be empty.`);
    }
    switch (option) {
      case "--database":
        configuration = { ...configuration, databasePath: resolve(value) };
        break;
      case "--samples":
        configuration = { ...configuration, samples: parseInteger(value, option) };
        break;
      case "--warmup":
        configuration = { ...configuration, warmupIterations: parseInteger(value, option, true) };
        break;
      case "--output":
        configuration = { ...configuration, outputPath: value };
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function anonymizedVisitId(index: number): string {
  if (index === 0) {
    return "profile-target-O'Brien";
  }
  if (index === 1) {
    return "訪問-profile-🍣";
  }
  if (index === 17) {
    return "";
  }
  return `profile-visit-${index.toString().padStart(3, "0")}`;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : finiteNumber(value, "SQLite numeric value");
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("SQLite text value must be a string or null.");
  }
  return value;
}

function createGroups(visitIds: readonly string[]): MergeableVisitGroup[] {
  assert.equal(visitIds.length, SELECTED_VISIT_COUNT);
  return Array.from({ length: GROUP_COUNT }, (_, groupIndex) => {
    const offset = groupIndex * VISITS_PER_GROUP;
    return createGroup(
      `profile-restaurant-${groupIndex.toString().padStart(2, "0")}`,
      visitIds.slice(offset, offset + VISITS_PER_GROUP),
      1_700_000_000_000 + groupIndex * 7 * 24 * 60 * 60 * 1_000,
    );
  });
}

function addEdgeSuggestions(
  groups: readonly MergeableVisitGroup[],
  suggestions: SuggestionSeed[],
  michelinIds: Set<string>,
): void {
  const existing = new Set(suggestions.map(({ visitId, restaurantId }) => `${visitId}\0${restaurantId}`));
  const add = (visitId: string, restaurantId: string, distance: number): void => {
    const key = `${visitId}\0${restaurantId}`;
    if (existing.has(key)) {
      return;
    }
    existing.add(key);
    michelinIds.add(restaurantId);
    suggestions.push({ visitId, restaurantId, distance });
  };
  for (const [groupIndex, group] of groups.entries()) {
    const common = `edge-common-${groupIndex}`;
    const sourceShared = `edge-source-shared-${groupIndex}`;
    for (const [memberIndex, visit] of group.visits.entries()) {
      add(visit.id, common, 100 + memberIndex);
      add(visit.id, `edge-unique-${groupIndex}-${memberIndex}`, 200 + memberIndex);
      if (memberIndex === 1 || memberIndex === 2) {
        add(visit.id, sourceShared, 300 + memberIndex);
      }
    }
  }
}

function createSyntheticFixture(): Fixture {
  const visitIds = Array.from({ length: SELECTED_VISIT_COUNT }, (_, index) => anonymizedVisitId(index));
  const groups = createGroups(visitIds);
  const restaurantIds = groups.map(({ restaurantId }) => restaurantId);
  const michelinIds = new Set<string>();
  const visits: VisitSeed[] = [];
  const photos: PhotoSeed[] = [];
  const suggestions: SuggestionSeed[] = [];
  const reservations: ReservationSeed[] = [];

  for (let index = 0; index < SELECTED_VISIT_COUNT; index++) {
    const groupIndex = Math.floor(index / VISITS_PER_GROUP);
    const memberIndex = index % VISITS_PER_GROUP;
    const id = visitIds[index]!;
    const primarySuggestion = `primary-${index % 53}`;
    michelinIds.add(primarySuggestion);
    const startTime = 1_700_000_000_000 + groupIndex * 7 * 86_400_000 + memberIndex * 3_600_000;
    visits.push({
      id,
      restaurantId: restaurantIds[groupIndex],
      suggestedRestaurantId: primarySuggestion,
      status: "confirmed",
      startTime,
      endTime: startTime + 45 * 60_000 + (index % 5) * 60_000,
      centerLat: 30 + index * 0.001,
      centerLon: -120 - index * 0.001,
      photoCount: 10_000 + index,
      foodProbable: index % 19 === 0 ? 1 : 0,
      calendarEventId: index % 3 === 0 ? `calendar-event-${index}` : null,
      calendarEventTitle: index % 3 === 0 ? `Calendar fixture ${index}` : null,
      calendarEventLocation: index % 6 === 0 ? `Location ${index % 17}` : null,
      calendarEventIsAllDay: index % 29 === 0 ? 1 : 0,
      exportedToCalendarId: index % 31 === 0 ? `export-calendar-${index}` : null,
      notes: index % 11 === 0 ? `Notes ${index} 雪` : null,
      updatedAt: 1_600_000_000_000 + index,
      awardAtVisit: index % 7 === 0 ? "One Star" : null,
    });

    const photoCount = 5 + (index % 8);
    for (let photoIndex = 0; photoIndex < photoCount; photoIndex++) {
      const forceNoCompleteLocation = groupIndex === GROUP_COUNT - 1;
      const latitude =
        forceNoCompleteLocation || photoIndex % 11 === 0 ? null : 30 + index * 0.001 + photoIndex * 0.000_01;
      const longitude =
        forceNoCompleteLocation || photoIndex % 7 === 0 ? null : -120 - index * 0.001 - photoIndex * 0.000_01;
      photos.push({
        id: `synthetic-photo-${index.toString().padStart(3, "0")}-${photoIndex.toString().padStart(2, "0")}`,
        visitId: id,
        creationTime: startTime + photoIndex * 1_000,
        latitude,
        longitude,
        foodDetected: (index + photoIndex) % 23 === 0 ? 1 : photoIndex % 13 === 0 ? null : 0,
      });
    }

    if (memberIndex > 0) {
      reservations.push({ sourceEventId: `reservation-${index.toString().padStart(3, "0")}`, visitId: id });
    }
  }

  addEdgeSuggestions(groups, suggestions, michelinIds);
  return {
    mode: "deterministic-synthetic",
    sourceDatabaseSha256: null,
    sourceDatabaseBytes: null,
    sourceSelectedVisitCount: SELECTED_VISIT_COUNT,
    sourceSelectedPhotoCount: photos.length,
    sourceSelectedSuggestionCount: 0,
    restaurantIds,
    michelinIds: [...michelinIds].sort(),
    visits,
    photos,
    suggestions,
    reservations,
    groups,
  };
}

function assertSourceTable(database: DatabaseSync, table: string): void {
  const row = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
    | { name?: unknown }
    | undefined;
  if (row?.name !== table) {
    throw new Error(`Source database does not contain ${table}.`);
  }
}

function createMacDerivedFixture(path: string): Fixture {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Database path is not a file: ${path}`);
  }
  const sourceDatabaseSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceDatabaseBytes = statSync(path).size;
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON");
    for (const table of ["visits", "photos", "visit_suggested_restaurants"]) {
      assertSourceTable(source, table);
    }

    const sourceVisits = source
      .prepare(`SELECT
        id, suggestedRestaurantId, startTime, endTime, centerLat, centerLon,
        photoCount, foodProbable, calendarEventId, calendarEventTitle,
        calendarEventLocation, calendarEventIsAllDay, exportedToCalendarId,
        notes, updatedAt, awardAtVisit
      FROM visits ORDER BY photoCount DESC, id LIMIT ?`)
      .all(SELECTED_VISIT_COUNT) as unknown as SourceVisitRow[];
    if (sourceVisits.length !== SELECTED_VISIT_COUNT) {
      throw new Error(`Mac-derived fixture requires at least ${SELECTED_VISIT_COUNT} visits.`);
    }

    const rawToAnonymizedVisit = new Map<string, string>();
    for (const [index, visit] of sourceVisits.entries()) {
      if (typeof visit.id !== "string") {
        throw new TypeError(`Source visit ${index} has a non-string ID.`);
      }
      rawToAnonymizedVisit.set(visit.id, anonymizedVisitId(index));
    }
    const rawVisitIds = sourceVisits.map(({ id }) => id as string);
    const visitPayload = JSON.stringify(rawVisitIds);

    const sourcePhotos = source
      .prepare(`SELECT p.id, p.visitId, p.creationTime, p.latitude, p.longitude, p.foodDetected
        FROM photos AS p
        JOIN json_each(?) AS selected ON selected.value = p.visitId
        ORDER BY p.id`)
      .all(visitPayload) as unknown as SourcePhotoRow[];
    const sourceSuggestions = source
      .prepare(`SELECT s.visitId, s.restaurantId, s.distance
        FROM visit_suggested_restaurants AS s
        JOIN json_each(?) AS selected ON selected.value = s.visitId
        ORDER BY s.visitId, s.restaurantId`)
      .all(visitPayload) as unknown as SourceSuggestionRow[];

    const visitIds = sourceVisits.map((_, index) => anonymizedVisitId(index));
    const groups = createGroups(visitIds);
    const restaurantIds = groups.map(({ restaurantId }) => restaurantId);
    const rawToAnonymizedMichelin = new Map<string, string>();
    const michelinIds = new Set<string>();
    const mapMichelin = (raw: string): string => {
      const existing = rawToAnonymizedMichelin.get(raw);
      if (existing) {
        return existing;
      }
      const mapped = `source-michelin-${rawToAnonymizedMichelin.size.toString().padStart(3, "0")}`;
      rawToAnonymizedMichelin.set(raw, mapped);
      michelinIds.add(mapped);
      return mapped;
    };

    const visits: VisitSeed[] = sourceVisits.map((visit, index) => {
      const groupIndex = Math.floor(index / VISITS_PER_GROUP);
      const memberIndex = index % VISITS_PER_GROUP;
      const originalStartTime = finiteNumber(visit.startTime, `visit ${index} startTime`);
      const originalEndTime = finiteNumber(visit.endTime, `visit ${index} endTime`);
      const duration = Math.max(0, originalEndTime - originalStartTime);
      const startTime = 1_700_000_000_000 + groupIndex * 7 * 86_400_000 + memberIndex * 3_600_000;
      const rawSuggested = nullableString(visit.suggestedRestaurantId);
      return {
        id: visitIds[index]!,
        restaurantId: restaurantIds[groupIndex],
        suggestedRestaurantId: rawSuggested === null ? null : mapMichelin(rawSuggested),
        status: "confirmed",
        startTime,
        endTime: startTime + duration,
        centerLat: finiteNumber(visit.centerLat, `visit ${index} centerLat`),
        centerLon: finiteNumber(visit.centerLon, `visit ${index} centerLon`),
        photoCount: finiteNumber(visit.photoCount, `visit ${index} photoCount`),
        foodProbable: finiteNumber(visit.foodProbable, `visit ${index} foodProbable`) === 0 ? 0 : 1,
        calendarEventId: visit.calendarEventId === null ? null : `calendar-event-${index}`,
        calendarEventTitle: visit.calendarEventTitle === null ? null : `Calendar title ${index}`,
        calendarEventLocation: visit.calendarEventLocation === null ? null : `Calendar location ${index % 19}`,
        calendarEventIsAllDay: nullableNumber(visit.calendarEventIsAllDay),
        exportedToCalendarId: visit.exportedToCalendarId === null ? null : `export-calendar-${index}`,
        notes: visit.notes === null ? null : `Sanitized notes ${index}`,
        updatedAt: nullableNumber(visit.updatedAt),
        awardAtVisit: nullableString(visit.awardAtVisit),
      };
    });

    const photos: PhotoSeed[] = sourcePhotos.map((photo, index) => {
      if (typeof photo.visitId !== "string") {
        throw new TypeError(`Source photo ${index} has a non-string visit ID.`);
      }
      const visitId = rawToAnonymizedVisit.get(photo.visitId);
      if (visitId === undefined) {
        throw new Error(`Source photo ${index} references an unselected visit.`);
      }
      return {
        id: `mac-photo-${index.toString().padStart(6, "0")}`,
        visitId,
        creationTime: finiteNumber(photo.creationTime, `photo ${index} creationTime`),
        latitude: nullableNumber(photo.latitude),
        longitude: nullableNumber(photo.longitude),
        foodDetected: nullableNumber(photo.foodDetected),
      };
    });
    // Mac data currently has complete coordinates in the high-photo selection;
    // add bounded anonymized sentinels so partial/null rules remain represented.
    photos.push(
      { id: "edge-partial-lat", visitId: visitIds[1]!, creationTime: 1, latitude: 1, longitude: null, foodDetected: 0 },
      { id: "edge-partial-lon", visitId: visitIds[2]!, creationTime: 2, latitude: null, longitude: 2, foodDetected: 0 },
      {
        id: "edge-no-location-food",
        visitId: visitIds[3]!,
        creationTime: 3,
        latitude: null,
        longitude: null,
        foodDetected: 1,
      },
    );

    const suggestions: SuggestionSeed[] = sourceSuggestions.map((suggestion, index) => {
      if (typeof suggestion.visitId !== "string" || typeof suggestion.restaurantId !== "string") {
        throw new TypeError(`Source suggestion ${index} has invalid identifiers.`);
      }
      const visitId = rawToAnonymizedVisit.get(suggestion.visitId);
      if (visitId === undefined) {
        throw new Error(`Source suggestion ${index} references an unselected visit.`);
      }
      return {
        visitId,
        restaurantId: mapMichelin(suggestion.restaurantId),
        distance: finiteNumber(suggestion.distance, `suggestion ${index} distance`),
      };
    });
    addEdgeSuggestions(groups, suggestions, michelinIds);

    const reservations: ReservationSeed[] = [];
    for (const [index, visitId] of visitIds.entries()) {
      if (index % VISITS_PER_GROUP !== 0) {
        reservations.push({ sourceEventId: `reservation-${index.toString().padStart(3, "0")}`, visitId });
      }
    }

    return {
      mode: "mac-database-derived",
      sourceDatabaseSha256,
      sourceDatabaseBytes,
      sourceSelectedVisitCount: sourceVisits.length,
      sourceSelectedPhotoCount: sourcePhotos.length,
      sourceSelectedSuggestionCount: sourceSuggestions.length,
      restaurantIds,
      michelinIds: [...michelinIds].sort(),
      visits,
      photos,
      suggestions,
      reservations,
      groups,
    };
  } finally {
    source.close();
  }
}

function seedDatabase(database: DatabaseSync, fixture: Fixture): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants VALUES (?, ?, ?, ?, ?)");
  const insertMichelin = database.prepare("INSERT INTO michelin_restaurants VALUES (?, ?)");
  const insertVisit = database.prepare(`INSERT INTO visits (
    id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
    centerLat, centerLon, photoCount, foodProbable, calendarEventId,
    calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
    exportedToCalendarId, notes, updatedAt, awardAtVisit, marker
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPhoto = database.prepare(`INSERT INTO photos (
    id, uri, creationTime, latitude, longitude, visitId, foodDetected,
    foodLabels, foodConfidence, allLabels, mediaType, duration, marker
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSuggestion = database.prepare(`INSERT INTO visit_suggested_restaurants
    (visitId, restaurantId, distance, marker) VALUES (?, ?, ?, ?)`);
  const insertReservation = database.prepare(`INSERT INTO reservation_import_sources
    (sourceEventId, source, visitId, importedAt, marker) VALUES (?, ?, ?, ?, ?)`);

  database.exec("BEGIN");
  try {
    for (const id of fixture.restaurantIds) {
      insertRestaurant.run(id, `Restaurant ${id}`, 37.5, -122.4, `restaurant-marker:${id}`);
    }
    for (const id of fixture.michelinIds) {
      insertMichelin.run(id, `Michelin ${id}`);
    }
    for (const visit of fixture.visits) {
      insertVisit.run(
        visit.id,
        visit.restaurantId ?? null,
        visit.suggestedRestaurantId ?? null,
        visit.status ?? "confirmed",
        visit.startTime,
        visit.endTime,
        visit.centerLat,
        visit.centerLon,
        visit.photoCount ?? 0,
        visit.foodProbable ?? 0,
        visit.calendarEventId ?? null,
        visit.calendarEventTitle ?? null,
        visit.calendarEventLocation ?? null,
        visit.calendarEventIsAllDay ?? null,
        visit.exportedToCalendarId ?? null,
        visit.notes ?? null,
        visit.updatedAt ?? null,
        visit.awardAtVisit ?? null,
        `visit-marker:${visit.id}`,
      );
    }
    for (const photo of fixture.photos) {
      insertPhoto.run(
        photo.id,
        `fixture://${encodeURIComponent(photo.id)}`,
        photo.creationTime ?? 1_700_000_000_000,
        photo.latitude,
        photo.longitude,
        photo.visitId,
        photo.foodDetected ?? null,
        `[{"label":"profile","confidence":0.75}]`,
        0.75,
        `[{"label":"all-profile","confidence":0.8}]`,
        photo.id.includes("video") ? "video" : "photo",
        photo.id.includes("video") ? 12.5 : null,
        `photo-marker:${photo.id}`,
      );
    }
    for (const suggestion of fixture.suggestions) {
      insertSuggestion.run(
        suggestion.visitId,
        suggestion.restaurantId,
        suggestion.distance,
        `suggestion-marker:${suggestion.visitId}:${suggestion.restaurantId}`,
      );
    }
    for (const reservation of fixture.reservations) {
      insertReservation.run(
        reservation.sourceEventId,
        "profile-provider",
        reservation.visitId,
        1_700_123_456_789,
        `reservation-marker:${reservation.sourceEventId}`,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function profileCandidateStatements(fixture: Fixture, expectedSnapshot: DatabaseSnapshot): CandidateDiagnostics {
  const database = createVisitMergeDatabase();
  try {
    seedDatabase(database, fixture);
    const plan = buildVisitMergePlan(fixture.groups);
    const statements = [
      { name: "preflight", sql: VISIT_MERGE_PREFLIGHT_SQL, parameters: [plan.payload] as const },
      { name: "movePhotos", sql: VISIT_MERGE_MOVE_PHOTOS_SQL, parameters: [plan.payload] as const },
      {
        name: "updateTargets",
        sql: VISIT_MERGE_UPDATE_TARGETS_SQL,
        parameters: [plan.payload, FIXED_UPDATED_AT] as const,
      },
      { name: "copySuggestions", sql: VISIT_MERGE_COPY_SUGGESTIONS_SQL, parameters: [plan.payload] as const },
      {
        name: "moveReservationSources",
        sql: VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL,
        parameters: [plan.payload] as const,
      },
      {
        name: "deleteSourceSuggestions",
        sql: VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL,
        parameters: [plan.payload] as const,
      },
      { name: "deleteSourceVisits", sql: VISIT_MERGE_DELETE_SOURCE_VISITS_SQL, parameters: [plan.payload] as const },
    ];
    const explainQueryPlan: Record<string, string[]> = {};
    for (const statement of statements) {
      const rows = database.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.parameters) as Array<{
        detail?: unknown;
      }>;
      explainQueryPlan[statement.name] = rows.map(({ detail }) => String(detail));
    }

    const phaseMilliseconds: Record<string, number> = {};
    const profile = <T>(name: string, operation: () => T): T => {
      const startedAt = performance.now();
      try {
        return operation();
      } finally {
        phaseMilliseconds[name] = performance.now() - startedAt;
      }
    };

    profile("beginTransaction", () => database.exec("BEGIN IMMEDIATE"));
    try {
      const preflight = profile("preflight", () => database.prepare(VISIT_MERGE_PREFLIGHT_SQL).get(plan.payload)) as
        | VisitMergePreflightRow
        | undefined;
      if (
        !preflight ||
        preflight.plannedVisitCount !== plan.referencedVisitCount ||
        preflight.existingVisitCount !== plan.referencedVisitCount
      ) {
        throw new Error("Diagnostic preflight failed");
      }
      profile("movePhotos", () => database.prepare(VISIT_MERGE_MOVE_PHOTOS_SQL).run(plan.payload));
      const targetUpdate = profile("updateTargets", () =>
        database.prepare(VISIT_MERGE_UPDATE_TARGETS_SQL).run(plan.payload, FIXED_UPDATED_AT),
      );
      assert.equal(Number(targetUpdate.changes), plan.targetVisitIds.length);
      profile("copySuggestions", () => database.prepare(VISIT_MERGE_COPY_SUGGESTIONS_SQL).run(plan.payload));
      profile("moveReservationSources", () =>
        database.prepare(VISIT_MERGE_MOVE_RESERVATION_SOURCES_SQL).run(plan.payload),
      );
      profile("deleteSourceSuggestions", () =>
        database.prepare(VISIT_MERGE_DELETE_SOURCE_SUGGESTIONS_SQL).run(plan.payload),
      );
      const sourceDelete = profile("deleteSourceVisits", () =>
        database.prepare(VISIT_MERGE_DELETE_SOURCE_VISITS_SQL).run(plan.payload),
      );
      assert.equal(Number(sourceDelete.changes), plan.mergeCount);
      profile("commitTransaction", () => database.exec("COMMIT"));
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    assertDatabaseHealth(database);
    const parity = assertSnapshotsEquivalent(snapshotDatabase(database), expectedSnapshot);
    const totalProfiledMilliseconds = Object.values(phaseMilliseconds).reduce((sum, value) => sum + value, 0);
    const [dominantName, dominantMilliseconds] = Object.entries(phaseMilliseconds).sort(
      (left, right) => right[1] - left[1],
    )[0]!;
    const details = Object.values(explainQueryPlan).flat();
    const indexedSearchDetails = details.filter((detail) => /\bSEARCH\b.*\bUSING\b/i.test(detail));
    const baseTableFullScanDetails = details.filter(
      (detail) =>
        /\bSCAN\s+(?:photos|photo|visits|target|visit_suggested_restaurants|source_suggestions|reservation_import_sources|reservation_source)\b/i.test(
          detail,
        ) && !/\bUSING\b/i.test(detail),
    );
    return {
      phaseMilliseconds,
      totalProfiledMilliseconds,
      dominantPhase: {
        name: dominantName,
        milliseconds: dominantMilliseconds,
        percentage: (dominantMilliseconds / Math.max(totalProfiledMilliseconds, Number.EPSILON)) * 100,
      },
      explainQueryPlan,
      indexSearchDetailCount: indexedSearchDetails.length,
      indexedSearchDetails,
      baseTableFullScanDetailCount: baseTableFullScanDetails.length,
      exactFullSnapshotParity: parity.exact,
      maximumCentroidAbsoluteDifference: parity.maximumCentroidAbsoluteDifference,
    };
  } finally {
    database.close();
  }
}

function buildOracle(fixture: Fixture): {
  readonly snapshot: DatabaseSnapshot;
  readonly digest: string;
  readonly counts: ExecutionCounts;
} {
  const database = createVisitMergeDatabase();
  try {
    seedDatabase(database, fixture);
    const counts = executeLegacySequential(database, fixture.groups, FIXED_UPDATED_AT);
    assert.equal(counts.mergeCount, SOURCE_MERGE_COUNT);
    assert.equal(counts.executionCalls, SOURCE_MERGE_COUNT * LEGACY_CALLS_PER_SOURCE);
    assertDatabaseHealth(database);
    const snapshot = snapshotDatabase(database);
    const parity = assertSnapshotsEquivalent(snapshot, snapshot);
    return { snapshot, digest: parity.digest, counts };
  } finally {
    database.close();
  }
}

function measure(
  strategy: Strategy,
  fixture: Fixture,
  expectedSnapshot: DatabaseSnapshot,
  expectedDigest: string,
): Measurement {
  const database = createVisitMergeDatabase();
  try {
    seedDatabase(database, fixture);
    const startedAt = performance.now();
    const counts =
      strategy === "legacySequential11Call"
        ? executeLegacySequential(database, fixture.groups, FIXED_UPDATED_AT)
        : executeCandidatePlan(database, fixture.groups, FIXED_UPDATED_AT);
    const elapsedMilliseconds = performance.now() - startedAt;

    assert.equal(counts.mergeCount, SOURCE_MERGE_COUNT);
    assertDatabaseHealth(database);
    const parity = assertSnapshotsEquivalent(snapshotDatabase(database), expectedSnapshot);
    return {
      elapsedMilliseconds,
      counts,
      exactFullSnapshotParity: parity.exact,
      maximumCentroidAbsoluteDifference: parity.maximumCentroidAbsoluteDifference,
      // The independent oracle digest identifies the fully compared expected
      // state. Candidate centroids may differ by floating-point accumulation
      // order; assertSnapshotsEquivalent has already bounded that difference.
      resultDigest: expectedDigest,
    };
  } finally {
    database.close();
  }
}

function summarize(samples: readonly number[]): Summary {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    samplesMilliseconds: [...samples],
    minimumMilliseconds: sorted[0]!,
    medianMilliseconds: median,
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximumMilliseconds: sorted.at(-1)!,
  };
}

function strategyOrder(iteration: number): readonly Strategy[] {
  return iteration % 2 === 0
    ? ["legacySequential11Call", "productionSetBasedTransaction"]
    : ["productionSetBasedTransaction", "legacySequential11Call"];
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (configuration === null) {
    console.log(usage());
    return;
  }
  const fixture =
    configuration.databasePath === null
      ? createSyntheticFixture()
      : createMacDerivedFixture(configuration.databasePath);
  assert.equal(fixture.groups.length, GROUP_COUNT);
  assert.equal(
    fixture.groups.reduce((sum, group) => sum + Math.max(0, group.visits.length - 1), 0),
    SOURCE_MERGE_COUNT,
  );

  const oracle = buildOracle(fixture);
  const candidateDiagnostics = profileCandidateStatements(fixture, oracle.snapshot);
  // Validate production once before any warmup or measured timing.
  const productionValidation = measure("productionSetBasedTransaction", fixture, oracle.snapshot, oracle.digest);

  for (let iteration = 0; iteration < configuration.warmupIterations; iteration++) {
    for (const strategy of strategyOrder(iteration)) {
      measure(strategy, fixture, oracle.snapshot, oracle.digest);
    }
  }

  const measurements: Record<Strategy, Measurement[]> = {
    legacySequential11Call: [],
    productionSetBasedTransaction: [],
  };
  for (let iteration = 0; iteration < configuration.samples; iteration++) {
    for (const strategy of strategyOrder(iteration)) {
      measurements[strategy].push(measure(strategy, fixture, oracle.snapshot, oracle.digest));
    }
  }

  const legacySummary = summarize(
    measurements.legacySequential11Call.map(({ elapsedMilliseconds }) => elapsedMilliseconds),
  );
  const productionSummary = summarize(
    measurements.productionSetBasedTransaction.map(({ elapsedMilliseconds }) => elapsedMilliseconds),
  );
  const legacyCounts = measurements.legacySequential11Call[0]!.counts;
  const productionCounts = measurements.productionSetBasedTransaction[0]!.counts;
  for (const measurement of measurements.legacySequential11Call) {
    assert.equal(measurement.counts.executionCalls, SOURCE_MERGE_COUNT * LEGACY_CALLS_PER_SOURCE);
    assert.equal(measurement.counts.transactionControlCalls, 0);
    assert.equal(measurement.counts.statementPreparations, SOURCE_MERGE_COUNT * LEGACY_CALLS_PER_SOURCE);
    assert.equal(measurement.resultDigest, oracle.digest);
  }
  for (const measurement of measurements.productionSetBasedTransaction) {
    assert.equal(measurement.counts.executionCalls, CANDIDATE_PREFLIGHT_CALLS + CANDIDATE_BODY_CALLS);
    assert.equal(measurement.counts.transactionControlCalls, CANDIDATE_TRANSACTION_CONTROL_CALLS);
    assert.equal(measurement.counts.statementPreparations, CANDIDATE_PREFLIGHT_CALLS + CANDIDATE_BODY_CALLS);
    assert.equal(measurement.resultDigest, oracle.digest);
  }
  assert.equal(legacyCounts.executionCalls, SOURCE_MERGE_COUNT * LEGACY_CALLS_PER_SOURCE);
  assert.equal(productionCounts.executionCalls, CANDIDATE_PREFLIGHT_CALLS + CANDIDATE_BODY_CALLS);
  assert.equal(productionCounts.transactionControlCalls, CANDIDATE_TRANSACTION_CONTROL_CALLS);

  const allExact = [
    productionValidation,
    ...measurements.legacySequential11Call,
    ...measurements.productionSetBasedTransaction,
  ].every(({ exactFullSnapshotParity }) => exactFullSnapshotParity);
  const maximumCentroidAbsoluteDifference = Math.max(
    ...[
      productionValidation,
      ...measurements.legacySequential11Call,
      ...measurements.productionSetBasedTransaction,
    ].map(({ maximumCentroidAbsoluteDifference: difference }) => difference),
  );
  const payloadBytes = Buffer.byteLength(buildVisitMergePlan(fixture.groups).payload, "utf8");
  const avoidedExecutionCalls = legacyCounts.executionCalls - productionCounts.executionCalls;
  const additionalRawSQLiteMilliseconds = productionSummary.medianMilliseconds - legacySummary.medianMilliseconds;

  const report = {
    schemaVersion: 1,
    status: "ok",
    benchmark: "visit-merge",
    generatedAt: new Date().toISOString(),
    configuration: {
      samples: configuration.samples,
      warmupIterations: configuration.warmupIterations,
      fixedUpdatedAt: FIXED_UPDATED_AT,
    },
    fixture: {
      mode: fixture.mode,
      selection:
        fixture.mode === "mac-database-derived"
          ? "185 visits ordered by photoCount DESC, id; anonymized and transformed into 37 groups of 5"
          : "deterministic 37 groups of 5",
      rawIdentifiersIncludedInReport: false,
      sourceDatabaseSha256: fixture.sourceDatabaseSha256,
      sourceDatabaseBytes: fixture.sourceDatabaseBytes,
      sourceSelectedVisitCount: fixture.sourceSelectedVisitCount,
      sourceSelectedPhotoCount: fixture.sourceSelectedPhotoCount,
      sourceSelectedSuggestionCount: fixture.sourceSelectedSuggestionCount,
      seededVisitCount: fixture.visits.length,
      seededPhotoCount: fixture.photos.length,
      seededSuggestionCount: fixture.suggestions.length,
      seededReservationCount: fixture.reservations.length,
      groupCount: fixture.groups.length,
      visitsPerGroup: VISITS_PER_GROUP,
      sourceMergeCount: SOURCE_MERGE_COUNT,
    },
    correctness: {
      independentLiteralSequentialOracle: true,
      fullOrderedTablesCompared: [
        "michelin_restaurants",
        "restaurants",
        "visits",
        "photos",
        "visit_suggested_restaurants",
        "reservation_import_sources",
      ],
      resultValidatedAfterEveryRun: true,
      exactFullSnapshotParity: allExact,
      exactAllNonCentroidFields: true,
      everyCentroidWithinDeclaredTolerance: true,
      centroidToleranceUsed: allExact ? 0 : 1e-12,
      maximumCentroidAbsoluteDifference,
      quickCheckPassedAfterEveryRun: true,
      foreignKeyCheckPassedAfterEveryRun: true,
      independentOracleSnapshotDigest: oracle.digest,
    },
    operationCounts: {
      legacySequential11Call: {
        executionCalls: legacyCounts.executionCalls,
        transactionControlCalls: legacyCounts.transactionControlCalls,
        totalExplicitCalls: legacyCounts.executionCalls + legacyCounts.transactionControlCalls,
        statementPreparations: legacyCounts.statementPreparations,
        callsPerSource: LEGACY_CALLS_PER_SOURCE,
        implicitWriteTransactionsUpperBound: SOURCE_MERGE_COUNT * 6,
      },
      productionSetBasedTransaction: {
        executionCalls: productionCounts.executionCalls,
        preflightCalls: CANDIDATE_PREFLIGHT_CALLS,
        transactionBodyCallsIncludingPreflight: productionCounts.executionCalls,
        mutationCallsAfterPreflight: CANDIDATE_BODY_CALLS,
        transactionControlCalls: productionCounts.transactionControlCalls,
        totalExplicitCalls: productionCounts.executionCalls + productionCounts.transactionControlCalls,
        statementPreparations: productionCounts.statementPreparations,
        explicitTransactions: 1,
        planPayloadBytes: payloadBytes,
      },
      fullPathModeledOperations: {
        note: "Counts one common group-discovery read, merge execution calls, and explicit candidate transaction controls. Legacy implicit transaction internals are not observable here and are excluded.",
        legacy: 1 + legacyCounts.executionCalls,
        production: 1 + productionCounts.executionCalls + productionCounts.transactionControlCalls,
      },
      JavaScriptApiBoundary: {
        legacyDatabaseMethodCallsAfterDiscovery: legacyCounts.executionCalls,
        productionExclusiveTransactionWrapperCallsAfterDiscovery: 1,
        productionTransactionCallbackDatabaseMethodCalls: productionCounts.executionCalls,
      },
    },
    timings: {
      legacySequential11Call: legacySummary,
      productionSetBasedTransaction: productionSummary,
      medianRawSQLiteSpeedup:
        legacySummary.medianMilliseconds / Math.max(productionSummary.medianMilliseconds, Number.EPSILON),
      avoidedExecutionCalls,
      additionalRawSQLiteMilliseconds,
      breakEvenAsyncOverheadMicrosecondsPerAvoidedCall:
        additionalRawSQLiteMilliseconds <= 0
          ? 0
          : (additionalRawSQLiteMilliseconds * 1_000) / Math.max(1, avoidedExecutionCalls),
    },
    diagnostics: {
      productionSetBasedTransaction: candidateDiagnostics,
      note: "Phase timings and EXPLAIN QUERY PLAN come from one separate untimed diagnostic execution over the same fixture. Base-table full-scan counts exclude json_each virtual-table and materialized CTE scans.",
    },
    measurementScope:
      "Timed regions include JavaScript orchestration and in-memory node:sqlite merge operations only. Fixture loading/seeding, snapshots, correctness validation, Expo's asynchronous bridge, the macOS app, PhotoKit, EventKit, and durable filesystem I/O are excluded. Call-count reduction is structural; raw timing is not an app-latency claim.",
  };

  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

main();
