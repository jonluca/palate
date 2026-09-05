export const PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION = 1;

export const PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH = 20;

export const PACKED_VISION_CLASSIFICATION_MAGIC = Object.freeze([0x50, 0x56, 0x43, 0x31] as const);

export const PACKED_VISION_CLASSIFICATION_SLOT_STATUS = Object.freeze({
  missing: 0,
  success: 1,
  failure: 2,
  duplicate: 3,
} as const);

export interface VisionClassificationLabel {
  readonly label: string;
  readonly confidence: number;
}

export interface VisionClassificationResult {
  readonly assetId: string;
  readonly labels: VisionClassificationLabel[];
  readonly error?: string;
}

export type VisionResultTransport = "legacy" | "packed-v1";

export type PackedVisionClassificationPayload = ArrayBuffer | Uint8Array;

interface VisionClassificationTransportMethods {
  readonly resolvedTransport?: string;
  readonly classifyLegacy: () => Promise<VisionClassificationResult[]>;
  readonly classifyPackedV1?: () => Promise<PackedVisionClassificationPayload>;
}

export function resolveVisionResultTransport(
  hasPackedV1Capability: boolean,
  resolvedTransport: string | undefined,
): VisionResultTransport {
  return hasPackedV1Capability && resolvedTransport === "packed-v1" ? "packed-v1" : "legacy";
}

/**
 * Packed V1 requires an explicit native resolution and method capability. Once
 * selected, rejection or malformed bytes fail without repeating Vision work.
 */
export async function classifyWithVisionResultTransport(
  assetIds: readonly string[],
  methods: VisionClassificationTransportMethods,
): Promise<VisionClassificationResult[]> {
  if (assetIds.length === 0) {
    return [];
  }
  const packedMethod = methods.classifyPackedV1;
  if (
    hasPackedVisionMethod(packedMethod) &&
    resolveVisionResultTransport(true, methods.resolvedTransport) === "packed-v1"
  ) {
    const payload = await packedMethod();
    return decodePackedVisionClassificationResults(assetIds, payload);
  }
  return methods.classifyLegacy();
}

function hasPackedVisionMethod(
  method: VisionClassificationTransportMethods["classifyPackedV1"],
): method is () => Promise<PackedVisionClassificationPayload> {
  return typeof method === "function";
}

/** Decode and strictly validate one native binary V1 result page. */
export function decodePackedVisionClassificationResults(
  assetIds: readonly string[],
  payload: PackedVisionClassificationPayload,
): VisionClassificationResult[] {
  const bytes =
    payload instanceof Uint8Array ? payload : payload instanceof ArrayBuffer ? new Uint8Array(payload) : undefined;
  if (!bytes) {
    throw new TypeError("Packed Vision payload must be an ArrayBuffer or Uint8Array");
  }
  const byteLength = bytes.byteLength;
  if (byteLength < PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH) {
    throw new RangeError("Packed Vision payload is truncated while reading the header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
  for (let index = 0; index < PACKED_VISION_CLASSIFICATION_MAGIC.length; index++) {
    if (bytes[index] !== PACKED_VISION_CLASSIFICATION_MAGIC[index]) {
      throw new TypeError(`Packed Vision payload has invalid magic at byte ${index}`);
    }
  }
  const version = view.getUint16(4, true);
  if (version !== PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported packed Vision schema version: ${version}`);
  }
  if (view.getUint16(6, true) !== 0) {
    throw new RangeError("Packed Vision payload uses unsupported flags");
  }
  if (view.getUint32(8, true) !== byteLength) {
    throw new RangeError("Packed Vision payload declares an inconsistent byte length");
  }
  const slotCount = view.getUint32(12, true);
  if (slotCount !== assetIds.length) {
    throw new RangeError("Packed Vision slot count does not match the request");
  }
  const stringCount = view.getUint32(16, true);
  let offset = PACKED_VISION_CLASSIFICATION_HEADER_BYTE_LENGTH;
  if (stringCount > Math.floor((byteLength - offset) / 4)) {
    throw new RangeError("Packed Vision string count exceeds the remaining payload");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const strings: string[] = [];
  const uniqueStrings = new Set<string>();
  for (let index = 0; index < stringCount; index++) {
    if (offset + 4 > byteLength) {
      throw new RangeError(`Packed Vision payload is truncated while reading string ${index} byte length`);
    }
    const stringByteLength = view.getUint32(offset, true);
    offset += 4;
    if (stringByteLength > byteLength - offset) {
      throw new RangeError(`Packed Vision payload is truncated while reading string ${index}`);
    }
    let value: string;
    try {
      value = decoder.decode(bytes.subarray(offset, offset + stringByteLength));
    } catch {
      throw new TypeError(`Packed Vision string ${index} is not valid UTF-8`);
    }
    offset += stringByteLength;
    if (uniqueStrings.has(value)) {
      throw new Error("Packed Vision string table contains duplicate values");
    }
    uniqueStrings.add(value);
    strings.push(value);
  }

  // Canonical first-use order means every index below this cursor has already
  // been encountered. Tracking the cursor avoids a per-page string-keyed map.
  let nextStringIndex = 0;
  const resolveString = (index: number, context: string): string => {
    // Every reference comes from getUint32, so it is already a nonnegative integer.
    if (index >= strings.length) {
      throw new RangeError(`Packed Vision ${context} has an invalid string index`);
    }
    if (index > nextStringIndex) {
      throw new Error("Packed Vision string table is not in canonical encounter order");
    }
    if (index === nextStringIndex) {
      nextStringIndex += 1;
    }
    return strings[index]!;
  };

  const results: VisionClassificationResult[] = [];
  // String-table uniqueness was checked above: its integer indices identify
  // assets exactly, without hashing the same native identifier for every slot.
  const encounteredAssets = new Uint8Array(stringCount);
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
    if (offset + 5 > byteLength) {
      throw new RangeError(`Packed Vision payload is truncated while reading slot ${slotIndex}`);
    }
    const assetStringIndex = view.getUint32(offset, true);
    const assetId = resolveString(assetStringIndex, "asset");
    if (assetId !== assetIds[slotIndex]) {
      throw new Error(`Packed Vision slot ${slotIndex} does not match the requested asset`);
    }
    const isDuplicate = encounteredAssets[assetStringIndex] !== 0;
    encounteredAssets[assetStringIndex] = 1;
    const status = view.getUint8(offset + 4);
    offset += 5;

    if (status === PACKED_VISION_CLASSIFICATION_SLOT_STATUS.duplicate) {
      if (!isDuplicate) {
        throw new Error(`Packed Vision slot ${slotIndex} marks a first request as duplicate`);
      }
      continue;
    }
    if (isDuplicate) {
      throw new Error(`Packed Vision slot ${slotIndex} does not mark a repeated request as duplicate`);
    }
    if (status === PACKED_VISION_CLASSIFICATION_SLOT_STATUS.missing) {
      continue;
    }
    if (status === PACKED_VISION_CLASSIFICATION_SLOT_STATUS.failure) {
      if (offset + 4 > byteLength) {
        throw new RangeError(`Packed Vision payload is truncated while reading slot ${slotIndex} error`);
      }
      const error = resolveString(view.getUint32(offset, true), "error");
      offset += 4;
      results.push({ assetId, labels: [], error });
      continue;
    }
    if (status !== PACKED_VISION_CLASSIFICATION_SLOT_STATUS.success) {
      throw new RangeError(`Packed Vision slot ${slotIndex} has an unsupported status`);
    }

    if (offset + 2 > byteLength) {
      throw new RangeError(`Packed Vision payload is truncated while reading slot ${slotIndex} label count`);
    }
    const labelCount = view.getUint16(offset, true);
    offset += 2;
    // Validate the complete fixed-width label block once before reading any
    // of its scalars. Error-context strings are only allocated on failure.
    if (labelCount * 8 > byteLength - offset) {
      throw new RangeError(`Packed Vision slot ${slotIndex} label count exceeds the remaining payload`);
    }
    const labels: VisionClassificationLabel[] = [];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const label = resolveString(view.getUint32(offset, true), "label");
      const confidence = view.getFloat32(offset + 4, true);
      offset += 8;
      if (!Number.isFinite(confidence)) {
        throw new TypeError(`Packed Vision slot ${slotIndex} label ${labelIndex} has non-finite confidence`);
      }
      labels.push({ label, confidence });
    }
    results.push({ assetId, labels });
  }

  if (offset !== byteLength) {
    throw new RangeError(`Packed Vision payload has ${byteLength - offset} trailing bytes at offset ${offset}`);
  }
  if (nextStringIndex !== strings.length) {
    throw new Error("Packed Vision string table contains unused values");
  }
  return results;
}
