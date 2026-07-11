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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

type Mode = "compare" | "apply-fixture";

interface Configuration {
  readonly mode: Mode;
  readonly databasePath: string;
  readonly guidePath: string;
  readonly datasetVersion: string;
  readonly outputPath?: string;
  readonly injectSemanticCorruption: boolean;
}

interface GuideSourceRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly address: unknown;
  readonly location: unknown;
  readonly cuisine: unknown;
  readonly latest_distinction: unknown;
  readonly latest_year: unknown;
  readonly has_green_star: unknown;
}

interface CanonicalImportRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion: string;
}

interface ExpectedImport {
  readonly sourceRows: number;
  readonly rows: readonly CanonicalImportRow[];
}

interface ComparisonSummary {
  readonly schemaVersion: 1;
  readonly status: "ok" | "failed";
  readonly encoding: {
    readonly schema: "length-prefixed-v1";
    readonly stringEncoding: "utf8";
    readonly floatingPointEncoding: "ieee754-binary64-be";
    readonly integerEncoding: "signed-64-be";
    readonly rowOrder: "id-utf8-binary";
  };
  readonly counts: {
    readonly signedGuideSourceRows: number;
    readonly expectedActiveRows: number;
    readonly actualActiveRows: number;
  };
  readonly digests: {
    readonly expectedCanonicalRowsSha256: string;
    readonly actualCanonicalRowsSha256: string;
  };
  readonly mismatches: {
    readonly missingRows: number;
    readonly unexpectedRows: number;
    readonly contentRows: number;
  };
  readonly correctness: {
    readonly exactLegacySemanticRows: boolean;
    readonly exactIdsAndAllPersistedFields: boolean;
    readonly exactFloat64CoordinateBits: boolean;
    readonly exactDatasetVersion: boolean;
  };
}

const HASH_DOMAIN = Buffer.from("palate.michelin.import.oracle.length-prefixed.v1\0", "utf8");

function usage(): string {
  return `Usage:
  macos-michelin-import-oracle.ts compare --database=PATH --guide=PATH --dataset-version=HASH --output=PATH
  macos-michelin-import-oracle.ts apply-fixture --database=PATH --guide=PATH --dataset-version=HASH [--inject-semantic-corruption]

The independent oracle applies the legacy JavaScript transform to the signed
bundled guide. Compare emits aggregate counts and deterministic hashes only.`;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return null;
  }
  const [modeArgument, ...options] = arguments_;
  if (modeArgument !== "compare" && modeArgument !== "apply-fixture") {
    throw new Error(`Unknown mode: ${String(modeArgument)}`);
  }
  let databasePath: string | undefined;
  let guidePath: string | undefined;
  let datasetVersion: string | undefined;
  let outputPath: string | undefined;
  let injectSemanticCorruption = false;
  const seen = new Set<string>();
  for (const option of options) {
    if (option === "--inject-semantic-corruption") {
      assert.equal(injectSemanticCorruption, false, "--inject-semantic-corruption may be specified once");
      injectSemanticCorruption = true;
      continue;
    }
    const separator = option.indexOf("=");
    if (!option.startsWith("--") || separator < 0) {
      throw new Error(`Unknown option: ${option}`);
    }
    const name = option.slice(0, separator);
    const value = option.slice(separator + 1);
    if (!value || seen.has(name)) {
      throw new Error(`${name} must be nonempty and specified once`);
    }
    seen.add(name);
    switch (name) {
      case "--database":
        databasePath = resolve(value);
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
  if (!databasePath || !guidePath || !datasetVersion) {
    throw new Error("--database, --guide, and --dataset-version are required");
  }
  if (modeArgument === "compare" && !outputPath) {
    throw new Error("compare requires --output");
  }
  if (modeArgument === "compare" && injectSemanticCorruption) {
    throw new Error("--inject-semantic-corruption is test-only and valid only with apply-fixture");
  }
  if (datasetVersion.includes("\0") || Buffer.byteLength(datasetVersion, "utf8") > 512) {
    throw new Error("Dataset version is invalid");
  }
  return {
    mode: modeArgument,
    databasePath,
    guidePath,
    datasetVersion,
    outputPath,
    injectSemanticCorruption,
  };
}

function immutableUri(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  url.searchParams.set("cache", "private");
  return url.href;
}

function assertConsolidatedRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} must be a regular file`);
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
    throw new Error(`${label} failed integrity_check`);
  }
  return database;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  return value;
}

function requireNullableInteger(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer or null`);
  }
  return value as number;
}

function legacyString(value: unknown): string {
  // Expo SQLite exposes BLOBs as ArrayBuffer objects. JavaScript parseFloat
  // stringifies those as "[object ArrayBuffer]", which is not numeric.
  if (value instanceof Uint8Array) {
    return "[object ArrayBuffer]";
  }
  return String(value);
}

function legacyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  return !(typeof value === "number" && Number.isNaN(value));
}

function loadExpectedImport(guide: DatabaseSync, datasetVersion: string): ExpectedImport {
  const sourceCount = guide.prepare("SELECT COUNT(*) AS count FROM restaurants").get() as
    | { count?: unknown }
    | undefined;
  const sourceRows = sourceCount?.count;
  if (!Number.isSafeInteger(sourceRows) || (sourceRows as number) <= 0) {
    throw new Error("Signed guide source row count is invalid");
  }
  const rows = guide
    .prepare(
      `SELECT
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
           ON award.restaurant_id = latest.restaurant_id
          AND award.year = latest.max_year
       ) a ON r.id = a.restaurant_id
       WHERE r.latitude IS NOT NULL
         AND r.longitude IS NOT NULL
         AND r.latitude != ''
         AND r.longitude != ''`,
    )
    .all() as unknown as GuideSourceRow[];

  const imported: CanonicalImportRow[] = [];
  for (const row of rows) {
    const latitude = Number.parseFloat(legacyString(row.latitude));
    const longitude = Number.parseFloat(legacyString(row.longitude));
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
    if (typeof row.id !== "number" && typeof row.id !== "string") {
      throw new TypeError("Signed guide restaurant id cannot follow legacy string interpolation");
    }
    let award = row.latest_distinction === null ? "" : requireString(row.latest_distinction, "Latest distinction");
    if (legacyTruthy(row.has_green_star)) {
      award = award ? `${award}, Green Star` : "Green Star";
    }
    imported.push({
      id: `michelin-${String(row.id)}`,
      name: row.name === null ? "" : requireString(row.name, "Restaurant name"),
      latitude,
      longitude,
      address: requireString(row.address, "Restaurant address"),
      location: requireString(row.location, "Restaurant location"),
      cuisine: requireString(row.cuisine, "Restaurant cuisine"),
      latestAwardYear: requireNullableInteger(row.latest_year, "Latest award year"),
      award,
      datasetVersion,
    });
  }
  return { sourceRows: sourceRows as number, rows: canonicalRows(imported) };
}

function loadActualRows(database: DatabaseSync, datasetVersion: string): CanonicalImportRow[] {
  const rows = database
    .prepare(
      `SELECT id, name, latitude, longitude, address, location, cuisine,
              latestAwardYear, award, datasetVersion
       FROM michelin_restaurants
       WHERE datasetVersion = ?`,
    )
    .all(datasetVersion) as Array<Record<string, unknown>>;
  return canonicalRows(
    rows.map((row) => {
      if (typeof row.latitude !== "number" || !Number.isFinite(row.latitude)) {
        throw new TypeError("Persisted latitude must be finite binary64");
      }
      if (typeof row.longitude !== "number" || !Number.isFinite(row.longitude)) {
        throw new TypeError("Persisted longitude must be finite binary64");
      }
      return {
        id: requireString(row.id, "Persisted id"),
        name: requireString(row.name, "Persisted name"),
        latitude: row.latitude,
        longitude: row.longitude,
        address: requireString(row.address, "Persisted address"),
        location: requireString(row.location, "Persisted location"),
        cuisine: requireString(row.cuisine, "Persisted cuisine"),
        latestAwardYear: requireNullableInteger(row.latestAwardYear, "Persisted latest award year"),
        award: requireString(row.award, "Persisted award"),
        datasetVersion: requireString(row.datasetVersion, "Persisted dataset version"),
      };
    }),
  );
}

function canonicalRows(rows: readonly CanonicalImportRow[]): CanonicalImportRow[] {
  const sorted = [...rows].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.id === sorted[index]!.id) {
      throw new Error("Canonical Michelin import rows contain duplicate ids");
    }
  }
  return sorted;
}

function uint64(value: number): Buffer {
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function stringBytes(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([1]), uint64(bytes.length), bytes]);
}

function doubleBytes(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(9);
  bytes[0] = 2;
  bytes.writeDoubleBE(value, 1);
  return bytes;
}

function nullableIntegerBytes(value: number | null): Buffer {
  if (value === null) {
    return Buffer.from([3, 0]);
  }
  const bytes = Buffer.allocUnsafe(10);
  bytes[0] = 3;
  bytes[1] = 1;
  bytes.writeBigInt64BE(BigInt(value), 2);
  return bytes;
}

function canonicalRowBytes(row: CanonicalImportRow): Buffer {
  return Buffer.concat([
    stringBytes(row.id),
    stringBytes(row.name),
    doubleBytes(row.latitude),
    doubleBytes(row.longitude),
    stringBytes(row.address),
    stringBytes(row.location),
    stringBytes(row.cuisine),
    nullableIntegerBytes(row.latestAwardYear),
    stringBytes(row.award),
    stringBytes(row.datasetVersion),
  ]);
}

function canonicalDigest(rows: readonly CanonicalImportRow[]): string {
  const hash = createHash("sha256");
  hash.update(HASH_DOMAIN);
  hash.update(uint64(rows.length));
  for (const row of rows) {
    const encoded = canonicalRowBytes(row);
    hash.update(uint64(encoded.length));
    hash.update(encoded);
  }
  return hash.digest("hex");
}

function mismatchCounts(
  expected: readonly CanonicalImportRow[],
  actual: readonly CanonicalImportRow[],
): { missingRows: number; unexpectedRows: number; contentRows: number } {
  const expectedById = new Map(expected.map((row) => [row.id, canonicalRowBytes(row)]));
  const actualById = new Map(actual.map((row) => [row.id, canonicalRowBytes(row)]));
  let missingRows = 0;
  let unexpectedRows = 0;
  let contentRows = 0;
  for (const [id, expectedBytes] of expectedById) {
    const actualBytes = actualById.get(id);
    if (!actualBytes) {
      missingRows += 1;
    } else if (!expectedBytes.equals(actualBytes)) {
      contentRows += 1;
    }
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) {
      unexpectedRows += 1;
    }
  }
  return { missingRows, unexpectedRows, contentRows };
}

function writeJsonAtomically(path: string, value: unknown): void {
  if (existsSync(path)) {
    throw new Error("Refusing to overwrite oracle output");
  }
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

function compare(configuration: Configuration): boolean {
  assert.ok(configuration.outputPath);
  if (
    resolve(configuration.outputPath) === configuration.databasePath ||
    resolve(configuration.outputPath) === configuration.guidePath
  ) {
    throw new Error("Oracle output aliases a protected input");
  }
  const guide = openImmutable(configuration.guidePath, "Signed bundled guide");
  const database = openImmutable(configuration.databasePath, "Result database");
  try {
    const expected = loadExpectedImport(guide, configuration.datasetVersion);
    const actual = loadActualRows(database, configuration.datasetVersion);
    const mismatches = mismatchCounts(expected.rows, actual);
    const expectedDigest = canonicalDigest(expected.rows);
    const actualDigest = canonicalDigest(actual);
    const exact =
      expectedDigest === actualDigest &&
      mismatches.missingRows === 0 &&
      mismatches.unexpectedRows === 0 &&
      mismatches.contentRows === 0;
    const summary: ComparisonSummary = {
      schemaVersion: 1,
      status: exact ? "ok" : "failed",
      encoding: {
        schema: "length-prefixed-v1",
        stringEncoding: "utf8",
        floatingPointEncoding: "ieee754-binary64-be",
        integerEncoding: "signed-64-be",
        rowOrder: "id-utf8-binary",
      },
      counts: {
        signedGuideSourceRows: expected.sourceRows,
        expectedActiveRows: expected.rows.length,
        actualActiveRows: actual.length,
      },
      digests: {
        expectedCanonicalRowsSha256: expectedDigest,
        actualCanonicalRowsSha256: actualDigest,
      },
      mismatches,
      correctness: {
        exactLegacySemanticRows: exact,
        exactIdsAndAllPersistedFields: exact,
        exactFloat64CoordinateBits: exact,
        exactDatasetVersion: exact,
      },
    };
    writeJsonAtomically(configuration.outputPath, summary);
    return exact;
  } finally {
    database.close();
    guide.close();
  }
}

function applyFixture(configuration: Configuration): void {
  const guide = openImmutable(configuration.guidePath, "Signed bundled guide");
  let expected: ExpectedImport;
  try {
    expected = loadExpectedImport(guide, configuration.datasetVersion);
  } finally {
    guide.close();
  }
  const database = new DatabaseSync(configuration.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    try {
      const upsert = database.prepare(
        `INSERT INTO michelin_restaurants
           (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           address = excluded.address,
           location = excluded.location,
           cuisine = excluded.cuisine,
           latestAwardYear = excluded.latestAwardYear,
           award = excluded.award,
           datasetVersion = excluded.datasetVersion`,
      );
      for (const row of expected.rows) {
        upsert.run(
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
      if (configuration.injectSemanticCorruption) {
        const firstRow = expected.rows[0];
        if (!firstRow) {
          throw new Error("Cannot inject semantic corruption into an empty guide");
        }
        database
          .prepare("UPDATE michelin_restaurants SET name = name || ? WHERE id = ?")
          .run("-same-count-semantic-corruption", firstRow.id);
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
  if (configuration.mode === "compare") {
    if (!compare(configuration)) {
      process.exitCode = 1;
    }
  } else {
    applyFixture(configuration);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
