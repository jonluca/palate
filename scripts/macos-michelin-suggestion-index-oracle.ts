#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PRIMARY_RADIUS_METERS = 100;
const SUGGESTION_RADIUS_METERS = 200;
const SUGGESTION_LIMIT = 5;
const EARTH_RADIUS_METERS = 6_371_000;
const MIN_RADIUS_BOUNDARY_TOLERANCE_METERS = 1e-7;
const SUGGESTION_VERSION_SUFFIX = "geodesic-v1-r100-r200-l5";

type Mode = "prepare" | "compare" | "apply-fixture";

interface Configuration {
  readonly mode: Mode;
  readonly databasePath: string;
  readonly oraclePath: string;
  readonly guidePath?: string;
  readonly datasetVersion?: string;
  readonly outputPath?: string;
  readonly injectParityFailure: boolean;
}

interface MichelinLocation {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
}

interface VisitRow {
  readonly id: string;
  readonly status: string;
  readonly centerLat: number;
  readonly centerLon: number;
  readonly suggestedRestaurantId: string | null;
}

interface SuggestionRow {
  readonly visitId: string;
  readonly restaurantId: string;
  readonly distanceBits: string;
  readonly ordinal: number;
}

interface PrimaryRow {
  readonly visitId: string;
  readonly restaurantId: string | null;
}

interface Oracle {
  readonly schemaVersion: 1;
  readonly datasetVersion: string;
  readonly suggestionVersion: string;
  readonly activeGuide: readonly MichelinLocation[];
  readonly staleGuide: readonly MichelinLocation[];
  readonly pendingVisits: readonly string[];
  readonly expectedPendingPrimary: readonly PrimaryRow[];
  readonly expectedPendingSuggestions: readonly SuggestionRow[];
  readonly baselineNonPendingPrimary: readonly PrimaryRow[];
  readonly baselineNonPendingSuggestions: readonly SuggestionRow[];
}

interface ComparisonSummary {
  readonly schemaVersion: 1;
  readonly status: "ok" | "failed";
  readonly counts: {
    readonly activeGuideRows: number;
    readonly staleGuideRows: number;
    readonly pendingVisits: number;
    readonly pendingPrimarySuggestions: number;
    readonly pendingSuggestionRows: number;
    readonly nonPendingVisits: number;
    readonly nonPendingSuggestionRows: number;
  };
  readonly digests: Record<string, string>;
  readonly mismatches: Record<string, number>;
  readonly correctness: Record<string, boolean>;
}

function usage(): string {
  return `Usage:
  macos-michelin-suggestion-index-oracle.ts prepare --database=PATH --guide=PATH --dataset-version=HASH --oracle=PATH
  macos-michelin-suggestion-index-oracle.ts compare --database=PATH --oracle=PATH --output=PATH
  macos-michelin-suggestion-index-oracle.ts apply-fixture --database=PATH --oracle=PATH [--inject-parity-failure]

The prepare mode reads only closed, consolidated private copies. It builds a
private oracle from the signed app's bundled guide with an independent brute-
force geodesic search. Compare emits aggregate counts and hashes only.`;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return null;
  }
  const [modeArgument, ...options] = arguments_;
  if (modeArgument !== "prepare" && modeArgument !== "compare" && modeArgument !== "apply-fixture") {
    throw new Error(`Unknown mode: ${String(modeArgument)}`);
  }
  let databasePath: string | undefined;
  let oraclePath: string | undefined;
  let guidePath: string | undefined;
  let datasetVersion: string | undefined;
  let outputPath: string | undefined;
  let injectParityFailure = false;
  for (const option of options) {
    if (option === "--inject-parity-failure") {
      injectParityFailure = true;
      continue;
    }
    const separator = option.indexOf("=");
    if (!option.startsWith("--") || separator < 0) {
      throw new Error(`Unknown option: ${option}`);
    }
    const name = option.slice(0, separator);
    const value = option.slice(separator + 1);
    if (!value) {
      throw new Error(`${name} cannot be empty`);
    }
    switch (name) {
      case "--database":
        databasePath = resolve(value);
        break;
      case "--oracle":
        oraclePath = resolve(value);
        break;
      case "--guide":
        guidePath = resolve(value);
        break;
      case "--dataset-version":
        datasetVersion = value;
        break;
      case "--output":
        outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }
  if (!databasePath || !oraclePath) {
    throw new Error("--database and --oracle are required");
  }
  if (modeArgument === "prepare" && (!guidePath || !datasetVersion)) {
    throw new Error("prepare requires --guide and --dataset-version");
  }
  if (modeArgument === "compare" && !outputPath) {
    throw new Error("compare requires --output");
  }
  if (modeArgument !== "apply-fixture" && injectParityFailure) {
    throw new Error("--inject-parity-failure is test-only and valid only with apply-fixture");
  }
  return {
    mode: modeArgument,
    databasePath,
    oraclePath,
    guidePath,
    datasetVersion,
    outputPath,
    injectParityFailure,
  };
}

function immutableUri(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function assertConsolidatedRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  for (const suffix of ["-wal", "-journal"] as const) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar) && statSync(sidecar).size !== 0) {
      throw new Error(`${label} has a nonempty ${suffix.slice(1)} sidecar`);
    }
  }
}

function openImmutable(path: string, label: string): DatabaseSync {
  assertConsolidatedRegularFile(path, label);
  const database = new DatabaseSync(immutableUri(path), { readOnly: true });
  database.exec("PRAGMA query_only = ON");
  const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
  if (integrity?.integrity_check !== "ok") {
    database.close();
    throw new Error(`${label} integrity_check failed: ${String(integrity?.integrity_check)}`);
  }
  return database;
}

function coordinate(name: string, value: unknown, limit: number): number {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(numeric) || numeric < -limit || numeric > limit) {
    throw new RangeError(`${name} must be finite and between ${-limit} and ${limit}`);
  }
  return numeric;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function doubleBits(value: number): string {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value, 0);
  return buffer.toString("hex");
}

function bitsDouble(bits: string): number {
  if (!/^[0-9a-f]{16}$/.test(bits)) {
    throw new Error(`Invalid IEEE-754 double encoding: ${bits}`);
  }
  return Buffer.from(bits, "hex").readDoubleBE(0);
}

function distanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const degreesToRadians = Math.PI / 180;
  const latitude1Radians = latitude1 * degreesToRadians;
  const latitude2Radians = latitude2 * degreesToRadians;
  const latitudeDelta = (latitude2 - latitude1) * degreesToRadians;
  const wrappedLongitudeDelta = ((((longitude2 - longitude1 + 180) % 360) + 360) % 360) - 180;
  const longitudeDelta = wrappedLongitudeDelta * degreesToRadians;
  const latitudeSine = Math.sin(latitudeDelta / 2);
  const longitudeSine = Math.sin(longitudeDelta / 2);
  const haversine =
    latitudeSine * latitudeSine +
    Math.cos(latitude1Radians) * Math.cos(latitude2Radians) * longitudeSine * longitudeSine;
  const clamped = Math.min(1, Math.max(0, haversine));
  const result = EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
  return result < 1e-9 ? 0 : result;
}

function canonicalGuide(rows: readonly MichelinLocation[]): MichelinLocation[] {
  return [...rows].sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) || left.latitude - right.latitude || left.longitude - right.longitude,
  );
}

function guideDigestRows(rows: readonly MichelinLocation[]): Array<[string, string, string]> {
  return rows.map(({ id, latitude, longitude }) => [id, doubleBits(latitude), doubleBits(longitude)]);
}

function loadBundledGuide(database: DatabaseSync): MichelinLocation[] {
  const rows = database
    .prepare(
      `SELECT id, latitude, longitude
       FROM restaurants
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         AND latitude != '' AND longitude != ''
       ORDER BY id`,
    )
    .all() as Array<{ id: unknown; latitude: unknown; longitude: unknown }>;
  const locations: MichelinLocation[] = [];
  for (const row of rows) {
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
      continue;
    }
    locations.push({ id: `michelin-${String(row.id)}`, latitude, longitude });
  }
  const canonical = canonicalGuide(locations);
  for (let index = 1; index < canonical.length; index += 1) {
    assert.notEqual(canonical[index - 1]!.id, canonical[index]!.id, "bundled guide IDs must be unique");
  }
  if (canonical.length === 0) {
    throw new Error("Bundled guide contains no valid locations");
  }
  return canonical;
}

function loadMainGuide(database: DatabaseSync, datasetVersion: string, active: boolean): MichelinLocation[] {
  const operator = active ? "=" : "IS NOT";
  const rows = database
    .prepare(
      `SELECT id, latitude, longitude
       FROM michelin_restaurants
       WHERE datasetVersion ${operator} ?
       ORDER BY id`,
    )
    .all(datasetVersion) as Array<{ id: string; latitude: unknown; longitude: unknown }>;
  return canonicalGuide(
    rows.map((row) => ({
      id: row.id,
      latitude: coordinate("restaurant latitude", row.latitude, 90),
      longitude: coordinate("restaurant longitude", row.longitude, 180),
    })),
  );
}

function loadVisits(database: DatabaseSync): VisitRow[] {
  return database
    .prepare(
      `SELECT id, status, centerLat, centerLon, suggestedRestaurantId
       FROM visits
       ORDER BY id`,
    )
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.id),
        status: String(value.status),
        centerLat: coordinate("visit latitude", value.centerLat, 90),
        centerLon: coordinate("visit longitude", value.centerLon, 180),
        suggestedRestaurantId: value.suggestedRestaurantId === null ? null : String(value.suggestedRestaurantId),
      };
    });
}

function loadSuggestionRows(database: DatabaseSync, pending: boolean): SuggestionRow[] {
  const operator = pending ? "=" : "!=";
  const rows = database
    .prepare(
      `SELECT vsr.visitId, vsr.restaurantId, vsr.distance
       FROM visit_suggested_restaurants vsr
       JOIN visits v ON v.id = vsr.visitId
       WHERE v.status ${operator} 'pending'
       ORDER BY vsr.visitId, vsr.distance, vsr.restaurantId`,
    )
    .all() as Array<{ visitId: string; restaurantId: string; distance: number }>;
  let previousVisitId: string | undefined;
  let ordinal = -1;
  return rows.map((row) => {
    if (row.visitId !== previousVisitId) {
      previousVisitId = row.visitId;
      ordinal = 0;
    } else {
      ordinal += 1;
    }
    return {
      visitId: row.visitId,
      restaurantId: row.restaurantId,
      distanceBits: doubleBits(row.distance),
      ordinal,
    };
  });
}

function buildExpectedSuggestions(
  visits: readonly VisitRow[],
  restaurants: readonly MichelinLocation[],
): { primary: PrimaryRow[]; suggestions: SuggestionRow[] } {
  const primary: PrimaryRow[] = [];
  const suggestions: SuggestionRow[] = [];
  const boundaryToleranceMeters = Math.max(MIN_RADIUS_BOUNDARY_TOLERANCE_METERS, SUGGESTION_RADIUS_METERS * 1e-12);
  for (const visit of visits) {
    const matches = restaurants
      .map((restaurant) => ({
        restaurant,
        distance: distanceMeters(visit.centerLat, visit.centerLon, restaurant.latitude, restaurant.longitude),
      }))
      .filter(({ distance }) => distance <= SUGGESTION_RADIUS_METERS + boundaryToleranceMeters)
      .sort(
        (left, right) => left.distance - right.distance || compareCodeUnits(left.restaurant.id, right.restaurant.id),
      )
      .slice(0, SUGGESTION_LIMIT);
    primary.push({
      visitId: visit.id,
      restaurantId: matches.find(({ distance }) => distance <= PRIMARY_RADIUS_METERS)?.restaurant.id ?? null,
    });
    matches.forEach(({ restaurant, distance }, ordinal) => {
      suggestions.push({
        visitId: visit.id,
        restaurantId: restaurant.id,
        distanceBits: doubleBits(distance),
        ordinal,
      });
    });
  }
  return { primary, suggestions };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

function assertNewOutput(path: string, protectedPaths: readonly string[]): void {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite output: ${path}`);
  }
  const resolvedOutput = resolve(path);
  for (const protectedPath of protectedPaths) {
    if (resolvedOutput === resolve(protectedPath)) {
      throw new Error(`Output aliases a protected input: ${path}`);
    }
  }
}

function parseOracle(path: string): Oracle {
  const value = JSON.parse(readFileSync(path, "utf8")) as Oracle;
  if (
    value.schemaVersion !== 1 ||
    typeof value.datasetVersion !== "string" ||
    typeof value.suggestionVersion !== "string" ||
    !Array.isArray(value.activeGuide) ||
    !Array.isArray(value.staleGuide) ||
    !Array.isArray(value.pendingVisits) ||
    !Array.isArray(value.expectedPendingPrimary) ||
    !Array.isArray(value.expectedPendingSuggestions) ||
    !Array.isArray(value.baselineNonPendingPrimary) ||
    !Array.isArray(value.baselineNonPendingSuggestions)
  ) {
    throw new Error("Oracle JSON does not match schema version 1");
  }
  return value;
}

function prepare(configuration: Configuration): void {
  const { databasePath, oraclePath, guidePath, datasetVersion } = configuration;
  assert.ok(guidePath && datasetVersion);
  assertNewOutput(oraclePath, [databasePath, guidePath]);
  const main = openImmutable(databasePath, "Prepared main database");
  const guide = openImmutable(guidePath, "Signed bundled guide");
  try {
    const importedVersion = main
      .prepare("SELECT value FROM app_metadata WHERE key = 'michelin_dataset_version'")
      .get() as { value?: unknown } | undefined;
    if (importedVersion?.value !== datasetVersion) {
      throw new Error(
        `Prepared database guide version ${String(importedVersion?.value)} does not match signed guide ${datasetVersion}`,
      );
    }
    const activeGuide = loadBundledGuide(guide);
    const mainActiveGuide = loadMainGuide(main, datasetVersion, true);
    assert.deepEqual(
      guideDigestRows(mainActiveGuide),
      guideDigestRows(activeGuide),
      "main database active guide does not exactly match the signed bundled guide",
    );
    const staleGuide = loadMainGuide(main, datasetVersion, false);
    const visits = loadVisits(main);
    const pending = visits.filter(({ status }) => status === "pending");
    if (pending.length === 0) {
      throw new Error("Signed validation requires at least one persisted pending visit");
    }
    const expected = buildExpectedSuggestions(pending, activeGuide);
    if (expected.suggestions.length === 0) {
      throw new Error("Signed validation requires at least one expected pending Michelin suggestion");
    }
    const nonPending = visits.filter(({ status }) => status !== "pending");
    const oracle: Oracle = {
      schemaVersion: 1,
      datasetVersion,
      suggestionVersion: `${datasetVersion}:${SUGGESTION_VERSION_SUFFIX}`,
      activeGuide,
      staleGuide,
      pendingVisits: pending.map(({ id }) => id),
      expectedPendingPrimary: expected.primary,
      expectedPendingSuggestions: expected.suggestions,
      baselineNonPendingPrimary: nonPending.map(({ id, suggestedRestaurantId }) => ({
        visitId: id,
        restaurantId: suggestedRestaurantId,
      })),
      baselineNonPendingSuggestions: loadSuggestionRows(main, false),
    };
    writeJsonAtomically(oraclePath, oracle);
  } finally {
    guide.close();
    main.close();
  }
}

function mismatchCount(left: readonly unknown[], right: readonly unknown[]): number {
  const maximum = Math.max(left.length, right.length);
  let count = 0;
  for (let index = 0; index < maximum; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      count += 1;
    }
  }
  return count;
}

function compare(configuration: Configuration): boolean {
  assertNewOutput(configuration.outputPath!, [configuration.databasePath, configuration.oraclePath]);
  const oracle = parseOracle(configuration.oraclePath);
  const database = openImmutable(configuration.databasePath, "Result database");
  let summary: ComparisonSummary;
  try {
    const activeGuide = loadMainGuide(database, oracle.datasetVersion, true);
    const staleGuide = loadMainGuide(database, oracle.datasetVersion, false);
    const visits = loadVisits(database);
    const pendingIds = new Set(oracle.pendingVisits);
    const pending = visits.filter(({ id }) => pendingIds.has(id));
    const actualPendingPrimary = pending.map(({ id, suggestedRestaurantId }) => ({
      visitId: id,
      restaurantId: suggestedRestaurantId,
    }));
    const pendingSuggestions = database
      .prepare(
        `SELECT vsr.visitId, vsr.restaurantId, vsr.distance
         FROM visit_suggested_restaurants vsr
         JOIN visits v ON v.id = vsr.visitId
         WHERE v.id IN (SELECT value FROM json_each(?))
         ORDER BY vsr.visitId, vsr.distance, vsr.restaurantId`,
      )
      .all(JSON.stringify(oracle.pendingVisits)) as Array<{
      visitId: string;
      restaurantId: string;
      distance: number;
    }>;
    let previousVisitId: string | undefined;
    let ordinal = -1;
    const actualPendingSuggestions = pendingSuggestions.map((row) => {
      if (row.visitId !== previousVisitId) {
        previousVisitId = row.visitId;
        ordinal = 0;
      } else {
        ordinal += 1;
      }
      return {
        visitId: row.visitId,
        restaurantId: row.restaurantId,
        distanceBits: doubleBits(row.distance),
        ordinal,
      };
    });
    const baselineNonPendingIds = new Set(oracle.baselineNonPendingPrimary.map(({ visitId }) => visitId));
    const actualNonPendingPrimary = visits
      .filter(({ id }) => baselineNonPendingIds.has(id))
      .map(({ id, suggestedRestaurantId }) => ({ visitId: id, restaurantId: suggestedRestaurantId }));
    const actualNonPendingSuggestions = loadSuggestionRows(database, false).filter(({ visitId }) =>
      baselineNonPendingIds.has(visitId),
    );
    const suggestionVersion = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'michelin_suggestion_version'")
      .get() as { value?: unknown } | undefined;
    const datasetVersion = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'michelin_dataset_version'")
      .get() as { value?: unknown } | undefined;
    const staleSuggestionCount = Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM visit_suggested_restaurants vsr
             JOIN visits v ON v.id = vsr.visitId
             JOIN michelin_restaurants m ON m.id = vsr.restaurantId
             WHERE v.id IN (SELECT value FROM json_each(?))
               AND m.datasetVersion IS NOT ?`,
          )
          .get(JSON.stringify(oracle.pendingVisits), oracle.datasetVersion) as { count: number }
      ).count,
    );
    const missingPendingVisitCount = oracle.pendingVisits.length - pending.length;
    const mismatches = {
      datasetVersion: datasetVersion?.value === oracle.datasetVersion ? 0 : 1,
      suggestionVersion: suggestionVersion?.value === oracle.suggestionVersion ? 0 : 1,
      activeGuideRows: mismatchCount(guideDigestRows(activeGuide), guideDigestRows(oracle.activeGuide)),
      staleGuideRows: mismatchCount(guideDigestRows(staleGuide), guideDigestRows(oracle.staleGuide)),
      missingPendingVisits: missingPendingVisitCount,
      pendingPrimary: mismatchCount(actualPendingPrimary, oracle.expectedPendingPrimary),
      pendingSuggestions: mismatchCount(actualPendingSuggestions, oracle.expectedPendingSuggestions),
      nonPendingPrimary: mismatchCount(actualNonPendingPrimary, oracle.baselineNonPendingPrimary),
      nonPendingSuggestions: mismatchCount(actualNonPendingSuggestions, oracle.baselineNonPendingSuggestions),
      staleGuideSuggestions: staleSuggestionCount,
    };
    const correctness = {
      exactDatasetVersion: mismatches.datasetVersion === 0,
      exactSuggestionVersion: mismatches.suggestionVersion === 0,
      exactActiveGuideProjection: mismatches.activeGuideRows === 0,
      exactStaleGuidePreservation: mismatches.staleGuideRows === 0,
      exactPendingPrimarySuggestions: mismatches.pendingPrimary === 0,
      exactOrderedPendingSuggestionsAndDistanceBits: mismatches.pendingSuggestions === 0,
      exactNonPendingPrimaryPreservation: mismatches.nonPendingPrimary === 0,
      exactNonPendingSuggestionPreservation: mismatches.nonPendingSuggestions === 0,
      noStaleGuideSuggestionMatches: mismatches.staleGuideSuggestions === 0,
    };
    const ok = Object.values(mismatches).every((count) => count === 0);
    summary = {
      schemaVersion: 1,
      status: ok ? "ok" : "failed",
      counts: {
        activeGuideRows: activeGuide.length,
        staleGuideRows: staleGuide.length,
        pendingVisits: oracle.pendingVisits.length,
        pendingPrimarySuggestions: oracle.expectedPendingPrimary.filter(({ restaurantId }) => restaurantId !== null)
          .length,
        pendingSuggestionRows: oracle.expectedPendingSuggestions.length,
        nonPendingVisits: oracle.baselineNonPendingPrimary.length,
        nonPendingSuggestionRows: oracle.baselineNonPendingSuggestions.length,
      },
      digests: {
        activeGuideSha256: sha256(guideDigestRows(activeGuide)),
        staleGuideSha256: sha256(guideDigestRows(staleGuide)),
        pendingPrimarySha256: sha256(actualPendingPrimary),
        orderedPendingSuggestionBitsSha256: sha256(actualPendingSuggestions),
        nonPendingPrimarySha256: sha256(actualNonPendingPrimary),
        nonPendingSuggestionBitsSha256: sha256(actualNonPendingSuggestions),
      },
      mismatches,
      correctness,
    };
    writeJsonAtomically(configuration.outputPath!, summary);
    return ok;
  } finally {
    database.close();
  }
}

function applyFixture(configuration: Configuration): void {
  const oracle = parseOracle(configuration.oraclePath);
  const database = new DatabaseSync(configuration.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    try {
      database.exec("CREATE TEMP TABLE validation_pending_visit_ids (id TEXT PRIMARY KEY)");
      const insertPending = database.prepare("INSERT INTO validation_pending_visit_ids (id) VALUES (?)");
      for (const visitId of oracle.pendingVisits) {
        insertPending.run(visitId);
      }
      database.exec(`
        DELETE FROM visit_suggested_restaurants
        WHERE visitId IN (SELECT id FROM validation_pending_visit_ids);
        UPDATE visits SET suggestedRestaurantId = NULL
        WHERE id IN (SELECT id FROM validation_pending_visit_ids);
      `);
      const insertSuggestion = database.prepare(
        "INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES (?, ?, ?)",
      );
      for (const row of oracle.expectedPendingSuggestions) {
        insertSuggestion.run(row.visitId, row.restaurantId, bitsDouble(row.distanceBits));
      }
      const updatePrimary = database.prepare("UPDATE visits SET suggestedRestaurantId = ? WHERE id = ?");
      for (const row of oracle.expectedPendingPrimary) {
        updatePrimary.run(row.restaurantId, row.visitId);
      }
      database
        .prepare(
          `INSERT INTO app_metadata (key, value) VALUES ('michelin_suggestion_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(oracle.suggestionVersion);
      if (configuration.injectParityFailure) {
        database.exec(`
          UPDATE visit_suggested_restaurants
          SET distance = distance + 1
          WHERE rowid = (
            SELECT vsr.rowid
            FROM visit_suggested_restaurants vsr
            JOIN visits v ON v.id = vsr.visitId
            WHERE v.status = 'pending'
            ORDER BY vsr.visitId, vsr.distance
            LIMIT 1
          );
        `);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  switch (configuration.mode) {
    case "prepare":
      prepare(configuration);
      break;
    case "compare":
      if (!compare(configuration)) {
        process.exitCode = 1;
      }
      break;
    case "apply-fixture":
      applyFixture(configuration);
      break;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
