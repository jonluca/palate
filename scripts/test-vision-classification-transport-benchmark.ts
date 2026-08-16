#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openValidatedImmutableSource } from "./benchmark-vision-classification-transport.ts";

interface FileSnapshot {
  readonly bytes: number | null;
  readonly present: boolean;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly journal: FileSnapshot;
  readonly main: FileSnapshot;
  readonly shm: FileSnapshot;
  readonly wal: FileSnapshot;
}

interface BenchmarkReport {
  readonly schemaVersion: number;
  readonly dataset: {
    readonly analyzedRows: number;
    readonly fallbackReason: string | null;
    readonly mode: string;
  };
  readonly privacy: {
    readonly aggregateOnly: boolean;
    readonly databasePathRetained: boolean;
    readonly identifiersRetained: boolean;
    readonly labelTextRetained: boolean;
    readonly rawRowsRetained: boolean;
  };
  readonly sourceAttestation: {
    readonly after: SourceSnapshot;
    readonly before: SourceSnapshot;
    readonly mainAndSidecarsByteIdentical: boolean;
    readonly openMode: string;
  } | null;
}

type ValidatedImmutableSource = ReturnType<typeof openValidatedImmutableSource>;
type ImmutableOpenFailure = Extract<ValidatedImmutableSource, string>;
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;
type JsonNode = JsonValue | undefined;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

function isJsonBoolean(value: JsonNode): value is boolean {
  return typeof value === "boolean";
}

function isJsonNumber(value: JsonNode): value is number {
  return typeof value === "number";
}

function isJsonObject(value: JsonNode): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonString(value: JsonNode): value is string {
  return typeof value === "string";
}

function parseJsonValue(source: string): JsonValue {
  // JSON.parse either throws or returns exactly the recursive JSON domain represented by JsonValue.
  return JSON.parse(source);
}

function parseRecord(value: JsonNode, context: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value;
}

function parseBoolean(value: JsonNode, context: string): boolean {
  if (!isJsonBoolean(value)) {
    throw new TypeError(`${context} must be a boolean`);
  }
  return value;
}

function parseNumber(value: JsonNode, context: string): number {
  if (!isJsonNumber(value) || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  return value;
}

function parseString(value: JsonNode, context: string): string {
  if (!isJsonString(value)) {
    throw new TypeError(`${context} must be a string`);
  }
  return value;
}

function parseNullableNumber(value: JsonNode, context: string): number | null {
  return value === null ? null : parseNumber(value, context);
}

function parseNullableString(value: JsonNode, context: string): string | null {
  return value === null ? null : parseString(value, context);
}

function parseFileSnapshot(value: JsonNode, context: string): FileSnapshot {
  const record = parseRecord(value, context);
  return {
    bytes: parseNullableNumber(record.bytes, `${context}.bytes`),
    present: parseBoolean(record.present, `${context}.present`),
    sha256: parseNullableString(record.sha256, `${context}.sha256`),
  };
}

function parseSourceSnapshot(value: JsonNode, context: string): SourceSnapshot {
  const record = parseRecord(value, context);
  return {
    journal: parseFileSnapshot(record.journal, `${context}.journal`),
    main: parseFileSnapshot(record.main, `${context}.main`),
    shm: parseFileSnapshot(record.shm, `${context}.shm`),
    wal: parseFileSnapshot(record.wal, `${context}.wal`),
  };
}

function parseBenchmarkReport(serialized: string): BenchmarkReport {
  const parsed = parseJsonValue(serialized);
  const report = parseRecord(parsed, "benchmark report");
  const dataset = parseRecord(report.dataset, "benchmark report.dataset");
  const privacy = parseRecord(report.privacy, "benchmark report.privacy");
  const sourceAttestationValue = report.sourceAttestation;
  let sourceAttestation: BenchmarkReport["sourceAttestation"] = null;
  if (sourceAttestationValue !== null) {
    const attestation = parseRecord(sourceAttestationValue, "benchmark report.sourceAttestation");
    sourceAttestation = {
      after: parseSourceSnapshot(attestation.after, "benchmark report.sourceAttestation.after"),
      before: parseSourceSnapshot(attestation.before, "benchmark report.sourceAttestation.before"),
      mainAndSidecarsByteIdentical: parseBoolean(
        attestation.mainAndSidecarsByteIdentical,
        "benchmark report.sourceAttestation.mainAndSidecarsByteIdentical",
      ),
      openMode: parseString(attestation.openMode, "benchmark report.sourceAttestation.openMode"),
    };
  }
  return {
    schemaVersion: parseNumber(report.schemaVersion, "benchmark report.schemaVersion"),
    dataset: {
      analyzedRows: parseNumber(dataset.analyzedRows, "benchmark report.dataset.analyzedRows"),
      fallbackReason: parseNullableString(dataset.fallbackReason, "benchmark report.dataset.fallbackReason"),
      mode: parseString(dataset.mode, "benchmark report.dataset.mode"),
    },
    privacy: {
      aggregateOnly: parseBoolean(privacy.aggregateOnly, "benchmark report.privacy.aggregateOnly"),
      databasePathRetained: parseBoolean(privacy.databasePathRetained, "benchmark report.privacy.databasePathRetained"),
      identifiersRetained: parseBoolean(privacy.identifiersRetained, "benchmark report.privacy.identifiersRetained"),
      labelTextRetained: parseBoolean(privacy.labelTextRetained, "benchmark report.privacy.labelTextRetained"),
      rawRowsRetained: parseBoolean(privacy.rawRowsRetained, "benchmark report.privacy.rawRowsRetained"),
    },
    sourceAttestation,
  };
}

function hasErrorCode<Value>(error: Value, expectedCode: string): boolean {
  return error instanceof Error && "code" in error && error.code === expectedCode;
}

function isImmutableOpenFailure(value: ValidatedImmutableSource): value is ImmutableOpenFailure {
  return (
    value === "database-missing" ||
    value === "database-not-file" ||
    value === "database-unreadable" ||
    value === "nonempty-write-sidecar" ||
    value === "photos-schema-unavailable" ||
    value === "no-analyzed-photos"
  );
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = join(scriptDirectory, "benchmark-vision-classification-transport.ts");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "palate-vision-transport-benchmark-"));
const databasePath = join(temporaryDirectory, "fixture.db");
const journalPath = `${databasePath}-journal`;
const outputPath = join(temporaryDirectory, "aggregate.json");
const fixtureAssetId = "fixture-asset-private";

function snapshotFile(path: string): FileSnapshot {
  try {
    const bytes = readFileSync(path);
    return {
      bytes: bytes.byteLength,
      present: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { bytes: null, present: false, sha256: null };
    }
    throw error;
  }
}

function sourceSnapshot(path: string): SourceSnapshot {
  const main = realpathSync(path);
  return {
    journal: snapshotFile(`${main}-journal`),
    main: snapshotFile(main),
    shm: snapshotFile(`${main}-shm`),
    wal: snapshotFile(`${main}-wal`),
  };
}

function immutableDatabase(path: string): DatabaseSync {
  const url = pathToFileURL(realpathSync(path));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, { readOnly: true });
}

try {
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec(`
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        allLabels TEXT,
        foodLabels TEXT
      );
      CREATE TABLE food_keywords (
        keyword TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL
      );
    `);
    fixture.prepare("INSERT INTO food_keywords (keyword, enabled) VALUES (?, 1)").run("pizza");
    fixture
      .prepare("INSERT INTO photos (id, allLabels, foodLabels) VALUES (?, ?, ?)")
      .run(
        fixtureAssetId,
        JSON.stringify([{ label: "pizza", confidence: Math.fround(0.5) }]),
        JSON.stringify([{ label: "pizza", confidence: Math.fround(0.5) }]),
      );
  } finally {
    fixture.close();
  }

  // Simulate a writer publishing WAL or rollback-journal data after the
  // immutable connection opens. Validation must observe either one before any
  // benchmark query.
  for (const suffix of ["-wal", "-journal"] as const) {
    const racedOpen = openValidatedImmutableSource(databasePath, (path) => {
      const database = immutableDatabase(path);
      writeFileSync(`${path}${suffix}`, "pending write data", { mode: 0o600 });
      return database;
    });
    assert.equal(racedOpen, "nonempty-write-sidecar", `${suffix} data introduced during open must be rejected`);
    rmSync(`${databasePath}${suffix}`, { force: true });
  }

  // An empty journal is safe but must still be represented exactly in the
  // before/after attestation rather than silently omitted.
  writeFileSync(journalPath, "", { mode: 0o600 });
  const validatedOpen = openValidatedImmutableSource(databasePath);
  if (isImmutableOpenFailure(validatedOpen)) {
    throw new Error(`Expected an immutable source handle, received ${validatedOpen}`);
  }
  assert.deepEqual(validatedOpen.sourceBefore.journal, {
    bytes: 0,
    present: true,
    sha256: createHash("sha256").update("").digest("hex"),
  });
  validatedOpen.database.close();

  const sourceBefore = sourceSnapshot(databasePath);
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      benchmarkPath,
      `--database=${databasePath}`,
      "--samples=1",
      "--warmup=0",
      `--output=${outputPath}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `benchmark failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(sourceSnapshot(databasePath), sourceBefore, "benchmark changed its fixture source or a sidecar");

  const reportText = readFileSync(outputPath, "utf8");
  const report = parseBenchmarkReport(reportText);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.dataset.mode, "immutable-real");
  assert.equal(report.dataset.fallbackReason, null);
  assert.equal(report.dataset.analyzedRows, 1);
  assert.deepEqual(report.sourceAttestation?.before, sourceBefore);
  assert.deepEqual(report.sourceAttestation?.after, sourceBefore);
  assert.equal(report.sourceAttestation?.mainAndSidecarsByteIdentical, true);
  assert.match(report.sourceAttestation?.openMode ?? "", /immutable=1/);
  assert.deepEqual(report.privacy, {
    aggregateOnly: true,
    databasePathRetained: false,
    identifiersRetained: false,
    labelTextRetained: false,
    rawRowsRetained: false,
  });
  assert.equal(reportText.includes(databasePath), false, "aggregate report retained its database path");
  assert.equal(reportText.includes(fixtureAssetId), false, "aggregate report retained a photo identifier");
  assert.equal(reportText.includes("pizza"), false, "aggregate report retained label text");
  assert.equal(statSync(outputPath).mode & 0o777, 0o600, "aggregate report permissions must remain private");
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

console.log(
  "Vision classification transport benchmark tests passed: post-open sidecar validation, journal attestation, read-only source identity, and aggregate-only output.",
);
