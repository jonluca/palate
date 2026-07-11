import {
  PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH,
  PACKED_VISION_CLASSIFICATION_MAGIC,
  PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION,
  PACKED_VISION_CLASSIFICATION_SLOT_STATUS,
  assertVisionClassificationAssetIds,
  type VisionClassificationLabel,
  type VisionClassificationResult,
} from "../utils/vision-classification-transport-core.ts";

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const SLOT_STATUS = PACKED_VISION_CLASSIFICATION_SLOT_STATUS;

interface EncodedSuccessSlot {
  readonly assetStringIndex: number;
  readonly status: typeof SLOT_STATUS.success;
  readonly labels: readonly (readonly [stringIndex: number, confidence: number])[];
}

interface EncodedFailureSlot {
  readonly assetStringIndex: number;
  readonly status: typeof SLOT_STATUS.failure;
  readonly errorStringIndex: number;
}

interface EncodedEmptySlot {
  readonly assetStringIndex: number;
  readonly status: typeof SLOT_STATUS.missing | typeof SLOT_STATUS.duplicate;
}

type EncodedSlot = EncodedSuccessSlot | EncodedFailureSlot | EncodedEmptySlot;

function assertLabel(label: VisionClassificationLabel, resultIndex: number, labelIndex: number): void {
  if (typeof label?.label !== "string") {
    throw new TypeError(`Vision result ${resultIndex} label ${labelIndex} has an invalid identifier`);
  }
  if (typeof label.confidence !== "number" || !Number.isFinite(label.confidence)) {
    throw new TypeError(`Vision result ${resultIndex} label ${labelIndex} has a non-finite confidence`);
  }
}

function checkedAddByteLength(total: number, increment: number): number {
  const next = total + increment;
  if (!Number.isSafeInteger(next) || next > MAX_UINT32) {
    throw new RangeError("Packed Vision payload exceeds the V1 byte-length limit");
  }
  return next;
}

/**
 * Deterministic scripts-only oracle for the native binary V1 encoder.
 *
 * The wire format is little-endian and contains a versioned header, one
 * first-encounter-order UTF-8 string table, and exactly one status slot per
 * requested asset. Success/failure rows decode to the legacy result shape;
 * missing PhotoKit assets and repeated request identifiers remain explicit on
 * the wire but are omitted from the compatibility result.
 */
export function encodePackedVisionClassificationResults(
  assetIds: readonly string[],
  results: readonly VisionClassificationResult[],
): Uint8Array {
  assertVisionClassificationAssetIds(assetIds);
  if (assetIds.length > MAX_UINT32) {
    throw new RangeError("Packed Vision payload contains too many asset slots");
  }

  const firstInputIndexByAssetId = new Map<string, number>();
  assetIds.forEach((assetId, index) => {
    if (!firstInputIndexByAssetId.has(assetId)) {
      firstInputIndexByAssetId.set(assetId, index);
    }
  });

  const resultByInputIndex = new Map<number, VisionClassificationResult>();
  let previousInputIndex = -1;
  for (const [resultIndex, result] of results.entries()) {
    if (typeof result?.assetId !== "string") {
      throw new TypeError(`Vision result ${resultIndex} has an invalid asset ID`);
    }
    const inputIndex = firstInputIndexByAssetId.get(result.assetId);
    if (inputIndex === undefined) {
      throw new RangeError(`Vision result ${resultIndex} references an asset outside the request`);
    }
    if (inputIndex <= previousInputIndex) {
      throw new Error("Vision results must retain strictly increasing first-request order");
    }
    previousInputIndex = inputIndex;
    if (!Array.isArray(result.labels)) {
      throw new TypeError(`Vision result ${resultIndex} has invalid labels`);
    }
    if (result.error !== undefined) {
      if (typeof result.error !== "string") {
        throw new TypeError(`Vision result ${resultIndex} has an invalid error`);
      }
      if (result.labels.length !== 0) {
        throw new Error(`Vision failure result ${resultIndex} cannot contain labels`);
      }
    } else {
      result.labels.forEach((label, labelIndex) => assertLabel(label, resultIndex, labelIndex));
      if (result.labels.length > MAX_UINT16) {
        throw new RangeError(`Vision result ${resultIndex} contains too many labels`);
      }
    }
    resultByInputIndex.set(inputIndex, result);
  }

  const strings: string[] = [];
  const stringIndexByValue = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = stringIndexByValue.get(value);
    if (existing !== undefined) {
      return existing;
    }
    if (strings.length >= MAX_UINT32) {
      throw new RangeError("Packed Vision payload contains too many strings");
    }
    const index = strings.length;
    strings.push(value);
    stringIndexByValue.set(value, index);
    return index;
  };

  const slots: EncodedSlot[] = [];
  const encounteredAssetIds = new Set<string>();
  for (const [inputIndex, assetId] of assetIds.entries()) {
    const assetStringIndex = intern(assetId);
    if (encounteredAssetIds.has(assetId)) {
      slots.push({ assetStringIndex, status: SLOT_STATUS.duplicate });
      continue;
    }
    encounteredAssetIds.add(assetId);

    const result = resultByInputIndex.get(inputIndex);
    if (!result) {
      slots.push({ assetStringIndex, status: SLOT_STATUS.missing });
      continue;
    }
    if (result.error !== undefined) {
      slots.push({
        assetStringIndex,
        status: SLOT_STATUS.failure,
        errorStringIndex: intern(result.error),
      });
      continue;
    }
    slots.push({
      assetStringIndex,
      status: SLOT_STATUS.success,
      labels: result.labels.map((label) => [intern(label.label), label.confidence] as const),
    });
  }

  const encoder = new TextEncoder();
  const encodedStrings = strings.map((value) => encoder.encode(value));
  const validatingDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [index, encodedString] of encodedStrings.entries()) {
    if (validatingDecoder.decode(encodedString) !== strings[index]) {
      throw new TypeError(`Packed Vision string ${index} is not well-formed Unicode`);
    }
  }

  let byteLength = PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH;
  for (const encodedString of encodedStrings) {
    if (encodedString.byteLength > MAX_UINT32) {
      throw new RangeError("Packed Vision string exceeds the V1 byte-length limit");
    }
    byteLength = checkedAddByteLength(byteLength, 4 + encodedString.byteLength);
  }
  for (const slot of slots) {
    byteLength = checkedAddByteLength(byteLength, 5);
    if (slot.status === SLOT_STATUS.success) {
      byteLength = checkedAddByteLength(byteLength, 2 + slot.labels.length * 8);
    } else if (slot.status === SLOT_STATUS.failure) {
      byteLength = checkedAddByteLength(byteLength, 4);
    }
  }

  const payload = new Uint8Array(byteLength);
  const view = new DataView(payload.buffer);
  payload.set(PACKED_VISION_CLASSIFICATION_MAGIC, 0);
  view.setUint16(4, PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, byteLength, true);
  view.setUint32(12, slots.length, true);
  view.setUint32(16, strings.length, true);

  let offset = PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH;
  for (const encodedString of encodedStrings) {
    view.setUint32(offset, encodedString.byteLength, true);
    offset += 4;
    payload.set(encodedString, offset);
    offset += encodedString.byteLength;
  }
  for (const slot of slots) {
    view.setUint32(offset, slot.assetStringIndex, true);
    offset += 4;
    view.setUint8(offset, slot.status);
    offset += 1;
    if (slot.status === SLOT_STATUS.success) {
      view.setUint16(offset, slot.labels.length, true);
      offset += 2;
      for (const [stringIndex, confidence] of slot.labels) {
        view.setUint32(offset, stringIndex, true);
        offset += 4;
        view.setFloat32(offset, confidence, true);
        offset += 4;
      }
    } else if (slot.status === SLOT_STATUS.failure) {
      view.setUint32(offset, slot.errorStringIndex, true);
      offset += 4;
    }
  }

  if (offset !== byteLength) {
    throw new Error("Packed Vision encoder produced an inconsistent byte length");
  }
  return payload;
}
