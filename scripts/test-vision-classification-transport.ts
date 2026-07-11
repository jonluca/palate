#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH,
  PACKED_VISION_CLASSIFICATION_MAGIC,
  PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION,
  classifyWithVisionResultTransport,
  decodePackedVisionClassificationResults,
  resolveVisionResultTransport,
  type VisionClassificationResult,
} from "../utils/vision-classification-transport-core.ts";
import { encodePackedVisionClassificationResults } from "./vision-classification-transport-oracle.ts";

const STATUS_MISSING = 0;
const STATUS_SUCCESS = 1;
const STATUS_FAILURE = 2;
const STATUS_DUPLICATE = 3;

interface StringLayout {
  readonly lengthOffset: number;
  readonly bytesOffset: number;
  readonly byteLength: number;
}

interface LabelLayout {
  readonly stringIndexOffset: number;
  readonly confidenceOffset: number;
}

interface SlotLayout {
  readonly assetStringIndexOffset: number;
  readonly statusOffset: number;
  readonly status: number;
  readonly labelCountOffset?: number;
  readonly labels: readonly LabelLayout[];
  readonly errorStringIndexOffset?: number;
}

interface PayloadLayout {
  readonly strings: readonly StringLayout[];
  readonly slots: readonly SlotLayout[];
  readonly endOffset: number;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function mutableView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  mutableView(bytes).setUint16(offset, value, true);
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  mutableView(bytes).setUint32(offset, value, true);
}

function float32FromBits(bits: number): number {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, bits, true);
  return new DataView(bytes.buffer).getFloat32(0, true);
}

function float32Bits(value: number): number {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return new DataView(bytes.buffer).getUint32(0, true);
}

function inspectValidPayload(payload: Uint8Array): PayloadLayout {
  const view = mutableView(payload);
  const stringCount = view.getUint32(16, true);
  const slotCount = view.getUint32(12, true);
  const strings: StringLayout[] = [];
  let offset = PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH;

  for (let index = 0; index < stringCount; index++) {
    const lengthOffset = offset;
    const byteLength = view.getUint32(offset, true);
    offset += 4;
    strings.push({ lengthOffset, bytesOffset: offset, byteLength });
    offset += byteLength;
  }

  const slots: SlotLayout[] = [];
  for (let index = 0; index < slotCount; index++) {
    const assetStringIndexOffset = offset;
    offset += 4;
    const statusOffset = offset;
    const status = view.getUint8(offset);
    offset += 1;
    const labels: LabelLayout[] = [];
    let labelCountOffset: number | undefined;
    let errorStringIndexOffset: number | undefined;

    if (status === STATUS_SUCCESS) {
      labelCountOffset = offset;
      const labelCount = view.getUint16(offset, true);
      offset += 2;
      for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
        labels.push({ stringIndexOffset: offset, confidenceOffset: offset + 4 });
        offset += 8;
      }
    } else if (status === STATUS_FAILURE) {
      errorStringIndexOffset = offset;
      offset += 4;
    }

    slots.push({
      assetStringIndexOffset,
      statusOffset,
      status,
      labelCountOffset,
      labels,
      errorStringIndexOffset,
    });
  }

  return { strings, slots, endOffset: offset };
}

function expectDecodeFailure(
  assetIds: readonly string[],
  payload: Uint8Array,
  expected: RegExp,
  description: string,
): void {
  assert.throws(() => decodePackedVisionClassificationResults(assetIds, payload), expected, description);
}

function encoded(assetIds: readonly string[], results: readonly VisionClassificationResult[]): Uint8Array {
  return encodePackedVisionClassificationResults(assetIds, results);
}

assert.deepEqual(PACKED_VISION_CLASSIFICATION_MAGIC, [0x50, 0x56, 0x43, 0x31]);
assert.equal(PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION, 1);
assert.equal(PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH, 20);

// The empty page is still a complete, versioned packet and round-trips exactly.
const emptyPayload = encoded([], []);
assert.equal(emptyPayload.byteLength, PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH);
assert.deepEqual(decodePackedVisionClassificationResults([], emptyPayload), []);
assert.equal(Buffer.from(emptyPayload).toString("hex"), "5056433101000000140000000000000000000000");

// This vector is shared conceptually with the native encoder: it exercises a
// success, an omitted missing asset, an empty-message failure, and a repeated
// request that must remain explicit on the wire but omitted after decoding.
const goldenAssetIds = ["asset-a", "missing", "asset-b", "asset-a"];
const goldenResults: VisionClassificationResult[] = [
  {
    assetId: "asset-a",
    labels: [
      { label: "pizza", confidence: 0.5 },
      { label: "caf\u00e9", confidence: -0 },
    ],
  },
  { assetId: "asset-b", labels: [], error: "" },
];
const goldenPayload = encoded(goldenAssetIds, goldenResults);
const goldenHex = Buffer.from(goldenPayload).toString("hex");
const goldenDigest = createHash("sha256").update(goldenPayload).digest("hex");
assert.equal(
  goldenHex,
  "50564331010000007500000004000000060000000700000061737365742d610500000070697a7a6105000000636166c3a9070000006d697373696e670700000061737365742d620000000000000000010200010000000000003f020000000000008003000000000400000002050000000000000003",
  "V1 bytes are a cross-language compatibility contract",
);
assert.equal(
  goldenDigest,
  "8e62678196bef0f5445eaf70482b61737d69df6d217a58926ea6f3ff8b5a6709",
  "V1 payload digest must remain stable",
);
assert.deepEqual(decodePackedVisionClassificationResults(goldenAssetIds, goldenPayload), goldenResults);
const goldenLayout = inspectValidPayload(goldenPayload);
assert.deepEqual(
  goldenLayout.slots.map((slot) => slot.status),
  [STATUS_SUCCESS, STATUS_MISSING, STATUS_FAILURE, STATUS_DUPLICATE],
);
assert.equal(goldenLayout.endOffset, goldenPayload.byteLength);

// Runtime policy is native-explicit for OTA compatibility. Missing or unknown
// native resolution remains on legacy even when the method happens to exist.
assert.equal(resolveVisionResultTransport(true, undefined), "legacy");
assert.equal(resolveVisionResultTransport(true, "packed-v1"), "packed-v1");
assert.equal(resolveVisionResultTransport(true, "legacy"), "legacy");
assert.equal(resolveVisionResultTransport(true, "unknown"), "legacy");
assert.equal(resolveVisionResultTransport(false, undefined), "legacy");
assert.equal(resolveVisionResultTransport(false, "packed-v1"), "legacy");

const policyAssetIds = ["policy-asset"];
const policyResults: VisionClassificationResult[] = [
  { assetId: "policy-asset", labels: [{ label: "food", confidence: Math.fround(0.75) }] },
];
const policyPackedPayload = encoded(policyAssetIds, policyResults);
const policyPackedArrayBuffer = Uint8Array.from(policyPackedPayload).buffer;

{
  let packedCalls = 0;
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport(policyAssetIds, {
    resolvedTransport: "packed-v1",
    classifyPackedV1: async () => {
      packedCalls += 1;
      return policyPackedPayload;
    },
    classifyLegacy: async () => {
      legacyCalls += 1;
      return [];
    },
  });
  assert.deepEqual(results, policyResults);
  assert.equal(packedCalls, 1);
  assert.equal(legacyCalls, 0);
}

// Current Expo binaries return a native-owned ArrayBuffer without copying;
// the preceding case retains compatibility with older Data-to-Uint8Array binaries.
{
  let packedCalls = 0;
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport(policyAssetIds, {
    resolvedTransport: "packed-v1",
    classifyPackedV1: async () => {
      packedCalls += 1;
      return policyPackedArrayBuffer;
    },
    classifyLegacy: async () => {
      legacyCalls += 1;
      return [];
    },
  });
  assert.deepEqual(results, policyResults);
  assert.equal(packedCalls, 1);
  assert.equal(legacyCalls, 0);
}

{
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport(policyAssetIds, {
    resolvedTransport: "packed-v1",
    classifyLegacy: async () => {
      legacyCalls += 1;
      return policyResults;
    },
  });
  assert.deepEqual(results, policyResults);
  assert.equal(legacyCalls, 1, "an OTA running on an old binary must use the legacy method");
}

{
  let packedCalls = 0;
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport(policyAssetIds, {
    resolvedTransport: "legacy",
    classifyPackedV1: async () => {
      packedCalls += 1;
      return policyPackedPayload;
    },
    classifyLegacy: async () => {
      legacyCalls += 1;
      return policyResults;
    },
  });
  assert.deepEqual(results, policyResults);
  assert.equal(packedCalls, 0, "the native legacy A/B override must suppress packed work");
  assert.equal(legacyCalls, 1);
}

{
  let packedCalls = 0;
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport(policyAssetIds, {
    classifyPackedV1: async () => {
      packedCalls += 1;
      return policyPackedPayload;
    },
    classifyLegacy: async () => {
      legacyCalls += 1;
      return policyResults;
    },
  });
  assert.deepEqual(results, policyResults);
  assert.equal(packedCalls, 0, "missing native resolution must preserve legacy transport");
  assert.equal(legacyCalls, 1);
}

{
  let legacyCalls = 0;
  const malformed = copyBytes(policyPackedPayload);
  malformed[0] ^= 0xff;
  await assert.rejects(
    classifyWithVisionResultTransport(policyAssetIds, {
      resolvedTransport: "packed-v1",
      classifyPackedV1: async () => malformed,
      classifyLegacy: async () => {
        legacyCalls += 1;
        return policyResults;
      },
    }),
    /invalid magic/,
  );
  assert.equal(legacyCalls, 0, "malformed packed bytes must not repeat Vision through legacy");
}

{
  const packedFailure = new Error("injected packed native rejection");
  let legacyCalls = 0;
  await assert.rejects(
    classifyWithVisionResultTransport(policyAssetIds, {
      resolvedTransport: "packed-v1",
      classifyPackedV1: async () => {
        throw packedFailure;
      },
      classifyLegacy: async () => {
        legacyCalls += 1;
        return policyResults;
      },
    }),
    (error: unknown) => error === packedFailure,
  );
  assert.equal(legacyCalls, 0, "a rejected packed call must not be retried through legacy");
}

{
  let packedCalls = 0;
  let legacyCalls = 0;
  const results = await classifyWithVisionResultTransport([], {
    resolvedTransport: "packed-v1",
    classifyPackedV1: async () => {
      packedCalls += 1;
      return emptyPayload;
    },
    classifyLegacy: async () => {
      legacyCalls += 1;
      return [];
    },
  });
  assert.deepEqual(results, []);
  assert.equal(packedCalls, 0);
  assert.equal(legacyCalls, 0);
}

// Missing assets and duplicate requests are omitted from the compatibility
// result exactly as the legacy native compactMap path did.
const duplicateAssetIds = ["first", "missing", "first", "last"];
const duplicateResults: VisionClassificationResult[] = [
  { assetId: "first", labels: [] },
  { assetId: "last", labels: [{ label: "meal", confidence: Math.fround(0.75) }] },
];
const duplicatePayload = encoded(duplicateAssetIds, duplicateResults);
assert.deepEqual(decodePackedVisionClassificationResults(duplicateAssetIds, duplicatePayload), duplicateResults);
assert.deepEqual(
  inspectValidPayload(duplicatePayload).slots.map((slot) => slot.status),
  [STATUS_SUCCESS, STATUS_MISSING, STATUS_DUPLICATE, STATUS_SUCCESS],
);

// Failure is a distinct state even when its message is empty.
const emptyErrorPayload = encoded(["failed"], [{ assetId: "failed", labels: [], error: "" }]);
const [emptyErrorResult] = decodePackedVisionClassificationResults(["failed"], emptyErrorPayload);
assert.deepEqual(emptyErrorResult, { assetId: "failed", labels: [], error: "" });
assert.ok(Object.prototype.hasOwnProperty.call(emptyErrorResult, "error"));

// UTF-8 is lossless and does not normalize composed/decomposed strings. NULs
// are ordinary string bytes, not terminators.
const unicodeAssetIds = ["asset-\u4e8c\u0000\ud83c\udf63", "asset-error"];
const unicodeResults: VisionClassificationResult[] = [
  {
    assetId: unicodeAssetIds[0]!,
    labels: [
      { label: "caf\u00e9", confidence: Math.fround(0.9) },
      { label: "cafe\u0301", confidence: Math.fround(0.8) },
      { label: "\u5bff\u53f8 \ud83c\udf63\u0000tail", confidence: Math.fround(0.7) },
    ],
  },
  { assetId: "asset-error", labels: [], error: "\ud83d\udca5 failure\u0000detail" },
];
assert.deepEqual(
  decodePackedVisionClassificationResults(unicodeAssetIds, encoded(unicodeAssetIds, unicodeResults)),
  unicodeResults,
);
assert.notEqual(unicodeResults[0]!.labels[0]!.label, unicodeResults[0]!.labels[1]!.label);

// A leading U+FEFF is data, not a transport BOM. Each string-table entry is
// decoded independently, so cover asset, label, and error positions directly.
for (const { assetIds, results, description } of [
  {
    assetIds: ["\ufeffasset"],
    results: [{ assetId: "\ufeffasset", labels: [] }],
    description: "leading U+FEFF asset",
  },
  {
    assetIds: ["asset"],
    results: [{ assetId: "asset", labels: [{ label: "\ufefflabel", confidence: Math.fround(0.75) }] }],
    description: "leading U+FEFF label",
  },
  {
    assetIds: ["asset"],
    results: [{ assetId: "asset", labels: [], error: "\ufefferror" }],
    description: "leading U+FEFF error",
  },
] satisfies readonly {
  readonly assetIds: readonly string[];
  readonly results: readonly VisionClassificationResult[];
  readonly description: string;
}[]) {
  assert.deepEqual(decodePackedVisionClassificationResults(assetIds, encoded(assetIds, results)), results, description);
}

// The first-encounter string table interns repeated identifiers without
// changing result or label order.
const repeatedStringAssetIds = ["asset-a", "asset-b", "asset-c"];
const repeatedStringResults: VisionClassificationResult[] = [
  {
    assetId: "asset-a",
    labels: [
      { label: "shared", confidence: Math.fround(0.9) },
      { label: "shared", confidence: Math.fround(0.8) },
    ],
  },
  { assetId: "asset-b", labels: [{ label: "shared", confidence: Math.fround(0.7) }] },
  { assetId: "asset-c", labels: [], error: "shared" },
];
const repeatedStringPayload = encoded(repeatedStringAssetIds, repeatedStringResults);
assert.equal(mutableView(repeatedStringPayload).getUint32(16, true), 4);
assert.deepEqual(
  decodePackedVisionClassificationResults(repeatedStringAssetIds, repeatedStringPayload),
  repeatedStringResults,
);

// Confidence values are one Float32 on both sides of the native bridge.
const belowHalf = float32FromBits(0x3effffff);
const aboveHalf = float32FromBits(0x3f000001);
const confidenceValues = [-0, belowHalf, 0.5, aboveHalf, 1];
const confidenceResult: VisionClassificationResult = {
  assetId: "float32",
  labels: confidenceValues.map((confidence, index) => ({ label: `value-${index}`, confidence })),
};
const [decodedConfidenceResult] = decodePackedVisionClassificationResults(
  ["float32"],
  encoded(["float32"], [confidenceResult]),
);
assert.ok(decodedConfidenceResult);
assert.deepEqual(
  decodedConfidenceResult.labels.map((label) => float32Bits(label.confidence)),
  confidenceValues.map(float32Bits),
);
assert.ok(Object.is(decodedConfidenceResult.labels[0]!.confidence, -0));
assert.notEqual(float32Bits(belowHalf), float32Bits(0.5));
assert.notEqual(float32Bits(aboveHalf), float32Bits(0.5));

// DataView must honor a bridge-owned Uint8Array slice with a nonzero offset.
const padded = new Uint8Array(goldenPayload.byteLength + 19).fill(0xa5);
padded.set(goldenPayload, 7);
const offsetPayload = padded.subarray(7, 7 + goldenPayload.byteLength);
assert.equal(offsetPayload.byteOffset, 7);
assert.deepEqual(decodePackedVisionClassificationResults(goldenAssetIds, offsetPayload), goldenResults);

// Encoding and decoding are observationally immutable: frozen inputs work,
// source/payload bytes do not change, and repeated decodes allocate fresh rows.
const immutableAssetIds = ["immutable"];
const immutableResults: VisionClassificationResult[] = [
  { assetId: "immutable", labels: [{ label: "fixed", confidence: Math.fround(0.625) }] },
];
Object.freeze(immutableAssetIds);
Object.freeze(immutableResults[0]!.labels[0]!);
Object.freeze(immutableResults[0]!.labels);
Object.freeze(immutableResults[0]!);
Object.freeze(immutableResults);
const immutablePayload = encoded(immutableAssetIds, immutableResults);
const immutablePayloadBefore = copyBytes(immutablePayload);
const firstDecode = decodePackedVisionClassificationResults(immutableAssetIds, immutablePayload);
assert.deepEqual(immutablePayload, immutablePayloadBefore);
(firstDecode[0]!.labels[0] as { label: string }).label = "mutated decoded copy";
assert.deepEqual(decodePackedVisionClassificationResults(immutableAssetIds, immutablePayload), immutableResults);
assert.deepEqual(immutablePayload, immutablePayloadBefore);

// Encoder-side validation prevents ambiguous native output from entering the
// canonical packet in the first place.
assert.throws(
  () =>
    encoded(
      ["a", "b"],
      [
        { assetId: "a", labels: [] },
        { assetId: "a", labels: [] },
      ],
    ),
  /strictly increasing first-request order/,
);
assert.throws(
  () =>
    encoded(
      ["a", "b"],
      [
        { assetId: "b", labels: [] },
        { assetId: "a", labels: [] },
      ],
    ),
  /strictly increasing first-request order/,
);
assert.throws(() => encoded(["a"], [{ assetId: "outside", labels: [] }]), /outside the request/);
assert.throws(
  () => encoded(["a"], [{ assetId: "a", labels: [{ label: "bad", confidence: Number.NaN }] }]),
  /non-finite confidence/,
);
assert.throws(
  () =>
    encoded(
      ["a"],
      [
        { assetId: "a", labels: [], error: "failure" },
        { assetId: "a", labels: [] },
      ],
    ),
  /strictly increasing first-request order/,
);
assert.throws(
  () => encoded(["a"], [{ assetId: "a", labels: [{ label: "not-empty", confidence: 1 }], error: "failure" }]),
  /cannot contain labels/,
);

// Header corruption is rejected before any slot can be observed.
{
  const payload = copyBytes(goldenPayload);
  payload[0] ^= 0xff;
  expectDecodeFailure(goldenAssetIds, payload, /invalid magic/, "invalid magic");
}
{
  const payload = copyBytes(goldenPayload);
  setUint16(payload, 4, PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION + 1);
  expectDecodeFailure(goldenAssetIds, payload, /Unsupported packed Vision schema version/, "invalid version");
}
{
  const payload = copyBytes(goldenPayload);
  setUint16(payload, 6, 1);
  expectDecodeFailure(goldenAssetIds, payload, /unsupported flags/, "invalid flags");
}
{
  const payload = copyBytes(goldenPayload);
  setUint32(payload, 8, payload.byteLength - 1);
  expectDecodeFailure(goldenAssetIds, payload, /inconsistent byte length/, "invalid declared byte length");
}
{
  const payload = copyBytes(goldenPayload);
  setUint32(payload, 12, goldenAssetIds.length - 1);
  expectDecodeFailure(goldenAssetIds, payload, /slot count does not match/, "invalid slot count");
}

// String-table lengths and UTF-8 are independently validated.
{
  const payload = copyBytes(goldenPayload);
  const [firstString] = inspectValidPayload(payload).strings;
  assert.ok(firstString);
  setUint32(payload, firstString.lengthOffset, payload.byteLength);
  expectDecodeFailure(
    goldenAssetIds,
    payload,
    /truncated while reading string 0|not valid UTF-8/,
    "oversized string length",
  );
}
{
  const assetIds = ["aa"];
  const payload = encoded(assetIds, []);
  const [firstString] = inspectValidPayload(payload).strings;
  assert.ok(firstString && firstString.byteLength === 2);
  payload[firstString.bytesOffset] = 0xc0;
  payload[firstString.bytesOffset + 1] = 0xaf;
  expectDecodeFailure(assetIds, payload, /not valid UTF-8/, "invalid UTF-8");
}
{
  const assetIds = ["a", "b"];
  const payload = encoded(assetIds, []);
  const [firstString, secondString] = inspectValidPayload(payload).strings;
  assert.ok(firstString && secondString && firstString.byteLength === secondString.byteLength);
  payload[secondString.bytesOffset] = payload[firstString.bytesOffset]!;
  expectDecodeFailure(assetIds, payload, /duplicate values/, "duplicate string-table values");
}

// Canonical encounter order, references, and slot identity are fail-closed.
{
  const assetIds = ["a", "b"];
  const payload = encoded(assetIds, []);
  const [firstSlot] = inspectValidPayload(payload).slots;
  assert.ok(firstSlot);
  setUint32(payload, firstSlot.assetStringIndexOffset, 1);
  expectDecodeFailure(assetIds, payload, /canonical encounter order/, "out-of-order first string reference");
}
{
  const payload = copyBytes(goldenPayload);
  const [firstSlot] = inspectValidPayload(payload).slots;
  assert.ok(firstSlot);
  setUint32(payload, firstSlot.assetStringIndexOffset, 0xffffffff);
  expectDecodeFailure(goldenAssetIds, payload, /invalid string index/, "invalid asset string reference");
}
{
  const assetIds = ["asset"];
  const payload = encoded(assetIds, [{ assetId: "asset", labels: [{ label: "label", confidence: 1 }] }]);
  const [firstSlot] = inspectValidPayload(payload).slots;
  assert.ok(firstSlot?.labels[0]);
  setUint32(payload, firstSlot.labels[0].stringIndexOffset, 0xffffffff);
  expectDecodeFailure(assetIds, payload, /invalid string index/, "invalid label string reference");
}
{
  const assetIds = ["asset"];
  const payload = encoded(assetIds, [{ assetId: "asset", labels: [], error: "failure" }]);
  const [firstSlot] = inspectValidPayload(payload).slots;
  assert.ok(firstSlot?.errorStringIndexOffset !== undefined);
  setUint32(payload, firstSlot.errorStringIndexOffset, 0xffffffff);
  expectDecodeFailure(assetIds, payload, /invalid string index/, "invalid error string reference");
}
expectDecodeFailure(
  ["wrong", ...goldenAssetIds.slice(1)],
  goldenPayload,
  /does not match the requested asset/,
  "asset identity mismatch",
);

// Unknown statuses and invalid duplicate markers cannot silently turn a
// failure/missing slot into a successful database update.
{
  const payload = copyBytes(goldenPayload);
  const firstSlot = inspectValidPayload(payload).slots[0]!;
  payload[firstSlot.statusOffset] = 0xff;
  expectDecodeFailure(goldenAssetIds, payload, /unsupported status/, "unknown slot status");
}
{
  const assetIds = ["first"];
  const payload = encoded(assetIds, []);
  const firstSlot = inspectValidPayload(payload).slots[0]!;
  payload[firstSlot.statusOffset] = STATUS_DUPLICATE;
  expectDecodeFailure(assetIds, payload, /marks a first request as duplicate/, "first request marked duplicate");
}
{
  const assetIds = ["same", "same"];
  const payload = encoded(assetIds, []);
  const repeatedSlot = inspectValidPayload(payload).slots[1]!;
  payload[repeatedSlot.statusOffset] = STATUS_MISSING;
  expectDecodeFailure(assetIds, payload, /does not mark a repeated request as duplicate/, "duplicate marker omitted");
}

// Truncating at every possible byte boundary rejects. Appending data also
// rejects after the declared length is adjusted, proving trailing bytes are not
// hidden behind the header-length guard.
for (let endOffset = 0; endOffset < goldenPayload.byteLength; endOffset++) {
  expectDecodeFailure(
    goldenAssetIds,
    goldenPayload.slice(0, endOffset),
    /truncated|inconsistent byte length|string count exceeds|slot count does not match|invalid magic/,
    `truncation at byte ${endOffset}`,
  );
}
{
  const payload = new Uint8Array(goldenPayload.byteLength + 1);
  payload.set(goldenPayload);
  payload[payload.length - 1] = 0xee;
  setUint32(payload, 8, payload.byteLength);
  expectDecodeFailure(goldenAssetIds, payload, /1 trailing bytes/, "trailing byte");
}

// Label counts are bounded by the remaining bytes, and non-finite Float32
// payloads never reach food filtering or persistence.
{
  const assetIds = ["asset"];
  const payload = encoded(assetIds, [{ assetId: "asset", labels: [{ label: "label", confidence: 1 }] }]);
  const firstSlot = inspectValidPayload(payload).slots[0]!;
  assert.ok(firstSlot.labelCountOffset !== undefined);
  setUint16(payload, firstSlot.labelCountOffset, 0xffff);
  expectDecodeFailure(assetIds, payload, /label count exceeds/, "oversized label count");
}
for (const [description, bits] of [
  ["positive infinity", 0x7f800000],
  ["negative infinity", 0xff800000],
  ["NaN", 0x7fc00001],
] as const) {
  const assetIds = ["asset"];
  const payload = encoded(assetIds, [{ assetId: "asset", labels: [{ label: "label", confidence: 1 }] }]);
  const confidenceOffset = inspectValidPayload(payload).slots[0]!.labels[0]!.confidenceOffset;
  setUint32(payload, confidenceOffset, bits);
  expectDecodeFailure(assetIds, payload, /non-finite confidence/, description);
}

// The packed form materially reduces the bridge payload for the real workload
// shape: many photos reuse a finite Vision vocabulary while retaining their
// individual confidence values and exact label order.
const structuralAssetIds = Array.from(
  { length: 256 },
  (_, index) => `asset-${index.toString().padStart(4, "0")}-opaque-local-identifier`,
);
const structuralVocabulary = Array.from(
  { length: 24 },
  (_, index) => `vision-classification-label-${index.toString().padStart(2, "0")}`,
);
const structuralResults: VisionClassificationResult[] = structuralAssetIds.map((assetId, assetIndex) => ({
  assetId,
  labels: Array.from({ length: 20 }, (_, labelIndex) => ({
    label: structuralVocabulary[(assetIndex + labelIndex) % structuralVocabulary.length]!,
    confidence: Math.fround(1 - labelIndex / 25 - (assetIndex % 7) / 1_000),
  })),
}));
const structuralPacked = encoded(structuralAssetIds, structuralResults);
const legacyJsonBytes = Buffer.byteLength(JSON.stringify(structuralResults), "utf8");
assert.deepEqual(decodePackedVisionClassificationResults(structuralAssetIds, structuralPacked), structuralResults);
assert.ok(
  structuralPacked.byteLength < legacyJsonBytes * 0.3,
  `expected packed payload under 30% of legacy JSON bytes; packed=${structuralPacked.byteLength}, legacy=${legacyJsonBytes}`,
);

console.log(
  `Vision classification transport tests passed: golden ${goldenPayload.byteLength} bytes (${goldenDigest}); ` +
    `structural ${structuralPacked.byteLength}/${legacyJsonBytes} bytes (${(
      (structuralPacked.byteLength / legacyJsonBytes) *
      100
    ).toFixed(2)}%).`,
);
