#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  DEFAULT_MICHELIN_IMPORT_STRATEGY,
  MICHELIN_DATASET_VERSION_KEY,
  MICHELIN_IMPORT_ATTACH_STRATEGY,
  MICHELIN_IMPORT_ATTESTATION_KEY,
  MICHELIN_IMPORT_LEGACY_STRATEGY,
  MICHELIN_IMPORT_METADATA_UPSERT_SQL,
  MICHELIN_IMPORT_REQUEST_KEY,
  MichelinImportTerminalError,
  parseMichelinImportValidationRequest,
  resolveMichelinImportStrategy,
  serializeMichelinImportAttestation,
  type MichelinImportAttestation,
  type MichelinImportValidationRequest,
} from "../utils/db/michelin-import-core.ts";

const NOW_EPOCH_SECONDS = 1_800_000_000;
const VALID_RUN_ID = "signed-macos.run_2026-07-10";

function validationRequest(
  overrides: Partial<Record<keyof MichelinImportValidationRequest, unknown>> = {},
): Record<keyof MichelinImportValidationRequest, unknown> {
  return {
    schemaVersion: 1,
    runId: VALID_RUN_ID,
    requestedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
    expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 300,
    ...overrides,
  };
}

function encodeValidationRequest(
  overrides: Partial<Record<keyof MichelinImportValidationRequest, unknown>> = {},
): string {
  return JSON.stringify(validationRequest(overrides));
}

function assertRejectedValidationRequest(value: string | null | undefined, now = NOW_EPOCH_SECONDS): void {
  assert.equal(parseMichelinImportValidationRequest(value, now), null);
}

function baseAttestation(overrides: Partial<MichelinImportAttestation> = {}): MichelinImportAttestation {
  return {
    schemaVersion: 1,
    runId: VALID_RUN_ID,
    requestedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
    resolvedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
    fallbackReason: null,
    selectedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
    datasetVersion: "guide-2026-07-10",
    sourceRows: 28_787,
    importedRows: 28_785,
    observedAtEpochSeconds: NOW_EPOCH_SECONDS,
    ...overrides,
  };
}

function assertRejectedAttestation(attestation: MichelinImportAttestation): void {
  assert.throws(() => serializeMichelinImportAttestation(attestation), /Invalid Michelin import runtime attestation/);
}

assert.equal(MICHELIN_DATASET_VERSION_KEY, "michelin_dataset_version");
assert.equal(MICHELIN_IMPORT_REQUEST_KEY, "michelin_import_validation_request");
assert.equal(MICHELIN_IMPORT_ATTESTATION_KEY, "michelin_import_runtime_attestation");
assert.equal(MICHELIN_IMPORT_LEGACY_STRATEGY, "legacy-js-v1");
assert.equal(MICHELIN_IMPORT_ATTACH_STRATEGY, "attach-insert-select-v1");
assert.equal(DEFAULT_MICHELIN_IMPORT_STRATEGY, MICHELIN_IMPORT_LEGACY_STRATEGY);
assert.notEqual(MICHELIN_IMPORT_REQUEST_KEY, MICHELIN_IMPORT_ATTESTATION_KEY);

const validAttachRequest = validationRequest();
assert.deepEqual(
  parseMichelinImportValidationRequest(JSON.stringify(validAttachRequest), NOW_EPOCH_SECONDS),
  validAttachRequest,
);
const validLegacyRequest = validationRequest({
  runId: "a".repeat(128),
  requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  expiresAtEpochSeconds: NOW_EPOCH_SECONDS,
});
assert.deepEqual(
  parseMichelinImportValidationRequest(JSON.stringify(validLegacyRequest), NOW_EPOCH_SECONDS),
  validLegacyRequest,
  "the 128-character run-id and inclusive expiry boundaries must remain accepted",
);
assert.deepEqual(
  parseMichelinImportValidationRequest(
    JSON.stringify(
      validationRequest({
        expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 60 * 60,
      }),
    ),
    NOW_EPOCH_SECONDS,
  ),
  validationRequest({ expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 60 * 60 }),
  "the one-hour request lifetime boundary must remain accepted",
);

for (const value of [null, undefined, "", "not-json", "null", "[]", "true", '"string"']) {
  assertRejectedValidationRequest(value);
}
assertRejectedValidationRequest(encodeValidationRequest(), Number.NaN);
assertRejectedValidationRequest(encodeValidationRequest(), Number.POSITIVE_INFINITY);

assertRejectedValidationRequest(encodeValidationRequest({ schemaVersion: 2 }));
assertRejectedValidationRequest(encodeValidationRequest({ schemaVersion: "1" }));
assertRejectedValidationRequest(encodeValidationRequest({ requestedStrategy: "attach-v0" }));
assertRejectedValidationRequest(encodeValidationRequest({ requestedStrategy: null }));
assertRejectedValidationRequest(encodeValidationRequest({ runId: "" }));
assertRejectedValidationRequest(encodeValidationRequest({ runId: "a".repeat(129) }));
for (const runId of ["contains space", "contains/slash", "unicode-雪", "line\nbreak", 42, null]) {
  assertRejectedValidationRequest(encodeValidationRequest({ runId }));
}
assertRejectedValidationRequest(encodeValidationRequest({ expiresAtEpochSeconds: NOW_EPOCH_SECONDS - 1 }));
assertRejectedValidationRequest(encodeValidationRequest({ expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 3_601 }));
assertRejectedValidationRequest(encodeValidationRequest({ expiresAtEpochSeconds: "1800000300" }));
assertRejectedValidationRequest(encodeValidationRequest({ expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 0.5 }));
assertRejectedValidationRequest(encodeValidationRequest({ expiresAtEpochSeconds: Number.MAX_SAFE_INTEGER + 1 }));
assertRejectedValidationRequest(
  `{"schemaVersion":1,"runId":"${VALID_RUN_ID}","requestedStrategy":"${MICHELIN_IMPORT_ATTACH_STRATEGY}","expiresAtEpochSeconds":1e999}`,
);

const requestWithoutRunId = validationRequest();
delete requestWithoutRunId.runId;
assertRejectedValidationRequest(JSON.stringify(requestWithoutRunId));
assertRejectedValidationRequest(JSON.stringify({ ...validationRequest(), unexpected: true }));
assertRejectedValidationRequest(
  JSON.stringify({
    expiresAtEpochSeconds: NOW_EPOCH_SECONDS + 300,
    requestedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
    runId: VALID_RUN_ID,
    schemaVersion: 1,
    constructor: "unexpected",
  }),
);

const compactRequest = encodeValidationRequest();
const requestAtByteLimit = `${compactRequest}${" ".repeat(4_096 - Buffer.byteLength(compactRequest))}`;
assert.equal(Buffer.byteLength(requestAtByteLimit), 4_096);
assert.deepEqual(parseMichelinImportValidationRequest(requestAtByteLimit, NOW_EPOCH_SECONDS), validAttachRequest);
assertRejectedValidationRequest(`${requestAtByteLimit} `);

assert.deepEqual(resolveMichelinImportStrategy(null, false), {
  requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  fallbackReason: null,
  runId: null,
});
assert.deepEqual(resolveMichelinImportStrategy(null, true), {
  requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  fallbackReason: null,
  runId: null,
});
assert.deepEqual(resolveMichelinImportStrategy(validAttachRequest as MichelinImportValidationRequest, true), {
  requestedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
  resolvedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
  fallbackReason: null,
  runId: VALID_RUN_ID,
});
assert.deepEqual(resolveMichelinImportStrategy(validAttachRequest as MichelinImportValidationRequest, false), {
  requestedStrategy: MICHELIN_IMPORT_ATTACH_STRATEGY,
  resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  fallbackReason: "sqlite-uri-unavailable",
  runId: VALID_RUN_ID,
});
assert.deepEqual(resolveMichelinImportStrategy(validLegacyRequest as MichelinImportValidationRequest, false), {
  requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  fallbackReason: null,
  runId: "a".repeat(128),
});

const attestation = baseAttestation();
const serializedAttestation = serializeMichelinImportAttestation(attestation);
assert.deepEqual(JSON.parse(serializedAttestation), attestation);
assert.equal(serializedAttestation, JSON.stringify(attestation));
assert.doesNotMatch(serializedAttestation, /\n/);
assert.deepEqual(
  JSON.parse(
    serializeMichelinImportAttestation(
      baseAttestation({
        runId: null,
        requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
        resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
        selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
      }),
    ),
  ),
  baseAttestation({
    runId: null,
    requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  }),
);
const fallbackAttestation = baseAttestation({
  resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
  fallbackReason: "sqlite-uri-unavailable",
  selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
});
assert.deepEqual(JSON.parse(serializeMichelinImportAttestation(fallbackAttestation)), fallbackAttestation);
const boundaryAttestation = baseAttestation({
  datasetVersion: "v".repeat(512),
  sourceRows: 0,
  observedAtEpochSeconds: 0,
});
assert.deepEqual(JSON.parse(serializeMichelinImportAttestation(boundaryAttestation)), boundaryAttestation);

assertRejectedAttestation(baseAttestation({ schemaVersion: 2 as 1 }));
for (const runId of ["", "unsafe run id", "雪", "a".repeat(129)]) {
  assertRejectedAttestation(baseAttestation({ runId }));
}
assertRejectedAttestation(baseAttestation({ datasetVersion: "" }));
assertRejectedAttestation(baseAttestation({ datasetVersion: "version\0suffix" }));
assertRejectedAttestation(baseAttestation({ datasetVersion: "v".repeat(513) }));
assertRejectedAttestation(
  baseAttestation({ requestedStrategy: "unknown-strategy" as typeof MICHELIN_IMPORT_ATTACH_STRATEGY }),
);
assertRejectedAttestation(
  baseAttestation({ resolvedStrategy: "unknown-strategy" as typeof MICHELIN_IMPORT_ATTACH_STRATEGY }),
);
assertRejectedAttestation(
  baseAttestation({ selectedStrategy: "unknown-strategy" as typeof MICHELIN_IMPORT_ATTACH_STRATEGY }),
);
assertRejectedAttestation(baseAttestation({ selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY }));
assertRejectedAttestation(baseAttestation({ resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY }));
assertRejectedAttestation(baseAttestation({ fallbackReason: "sqlite-uri-unavailable" }));
assertRejectedAttestation(
  baseAttestation({
    requestedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    resolvedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    selectedStrategy: MICHELIN_IMPORT_LEGACY_STRATEGY,
    fallbackReason: "sqlite-uri-unavailable",
  }),
);
for (const sourceRows of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assertRejectedAttestation(baseAttestation({ sourceRows }));
}
for (const importedRows of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assertRejectedAttestation(baseAttestation({ importedRows }));
}
for (const observedAtEpochSeconds of [
  -1,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]) {
  assertRejectedAttestation(baseAttestation({ observedAtEpochSeconds }));
}

assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /FROM\s+michelin_source\.restaurants\s+r/i);
assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /FROM\s+michelin_source\.restaurant_awards\s+award/i);
assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /INSERT\s+INTO\s+michelin_restaurants\b/i);
assert.match(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /ON\s+CONFLICT\s*\(id\)\s+DO\s+UPDATE/i);
assert.equal(
  ATTACHED_MICHELIN_INSERT_SELECT_SQL.match(/\?/g)?.length,
  1,
  "the dataset version must be the only bound value in the set-based import",
);
assert.doesNotMatch(ATTACHED_MICHELIN_INSERT_SELECT_SQL, /\b(?:ATTACH|DETACH|PRAGMA)\b/i);
assert.doesNotMatch(
  ATTACHED_MICHELIN_INSERT_SELECT_SQL,
  /\b(?:INSERT\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+michelin_source\b/i,
  "the shared import statement must never mutate the attached source schema",
);
assert.match(MICHELIN_IMPORT_METADATA_UPSERT_SQL, /INSERT\s+INTO\s+app_metadata\s*\(key,\s*value\)/i);
assert.match(MICHELIN_IMPORT_METADATA_UPSERT_SQL, /ON\s+CONFLICT\s*\(key\)\s+DO\s+UPDATE/i);
assert.equal(MICHELIN_IMPORT_METADATA_UPSERT_SQL.match(/\?/g)?.length, 2);
assert.doesNotMatch(MICHELIN_IMPORT_METADATA_UPSERT_SQL, /michelin_source/i);

const terminalCause = new Error("sqlite write failed");
const terminalError = new MichelinImportTerminalError("Michelin import became terminal", terminalCause);
assert.equal(terminalError.name, "MichelinImportTerminalError");
assert.equal(terminalError.message, "Michelin import became terminal");
assert.equal(terminalError.cause, terminalCause);
assert.ok(terminalError instanceof Error);
assert.ok(terminalError instanceof MichelinImportTerminalError);

console.log("Michelin import core tests passed");
