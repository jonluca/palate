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
  readonly resolvedTransport?: unknown;
  readonly classifyLegacy: () => Promise<VisionClassificationResult[]>;
  readonly classifyPackedV1?: () => Promise<PackedVisionClassificationPayload>;
}

export function resolveVisionResultTransport(
  hasPackedV1Capability: boolean,
  resolvedTransport: unknown,
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
  if (resolveVisionResultTransport(typeof packedMethod === "function", methods.resolvedTransport) === "packed-v1") {
    const payload = await packedMethod!();
    return decodePackedVisionClassificationResults(assetIds, payload);
  }
  return methods.classifyLegacy();
}

export function assertVisionClassificationAssetIds(assetIds: readonly string[]): void {
  for (const [index, assetId] of assetIds.entries()) {
    if (typeof assetId !== "string") {
      throw new TypeError(`Vision asset ID ${index} must be a string`);
    }
  }
}

class PackedVisionReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  readUint8(context: string): number {
    this.requireBytes(1, context);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16(context: string): number {
    this.requireBytes(2, context);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(context: string): number {
    this.requireBytes(4, context);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat32(context: string): number {
    this.requireBytes(4, context);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readBytes(byteLength: number, context: string): Uint8Array {
    this.requireBytes(byteLength, context);
    const value = this.bytes.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    return value;
  }

  private requireBytes(byteLength: number, context: string): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.remaining) {
      throw new RangeError(`Packed Vision payload is truncated while reading ${context}`);
    }
  }
}

/** Decode and strictly validate one native binary V1 result page. */
export function decodePackedVisionClassificationResults(
  assetIds: readonly string[],
  payload: PackedVisionClassificationPayload,
): VisionClassificationResult[] {
  assertVisionClassificationAssetIds(assetIds);
  const bytes =
    payload instanceof Uint8Array ? payload : payload instanceof ArrayBuffer ? new Uint8Array(payload) : undefined;
  if (!bytes) {
    throw new TypeError("Packed Vision payload must be an ArrayBuffer or Uint8Array");
  }
  const reader = new PackedVisionReader(bytes);
  for (const [index, expectedByte] of PACKED_VISION_CLASSIFICATION_MAGIC.entries()) {
    if (reader.readUint8("magic") !== expectedByte) {
      throw new TypeError(`Packed Vision payload has invalid magic at byte ${index}`);
    }
  }
  const version = reader.readUint16("schema version");
  if (version !== PACKED_VISION_CLASSIFICATION_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported packed Vision schema version: ${version}`);
  }
  if (reader.readUint16("flags") !== 0) {
    throw new RangeError("Packed Vision payload uses unsupported flags");
  }
  if (reader.readUint32("total byte length") !== bytes.byteLength) {
    throw new RangeError("Packed Vision payload declares an inconsistent byte length");
  }
  const slotCount = reader.readUint32("slot count");
  if (slotCount !== assetIds.length) {
    throw new RangeError("Packed Vision slot count does not match the request");
  }
  const stringCount = reader.readUint32("string count");
  if (stringCount > Math.floor(reader.remaining / 4)) {
    throw new RangeError("Packed Vision string count exceeds the remaining payload");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const strings: string[] = [];
  const uniqueStrings = new Set<string>();
  for (let index = 0; index < stringCount; index++) {
    const byteLength = reader.readUint32(`string ${index} byte length`);
    let value: string;
    try {
      value = decoder.decode(reader.readBytes(byteLength, `string ${index}`));
    } catch {
      throw new TypeError(`Packed Vision string ${index} is not valid UTF-8`);
    }
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
    if (index < 0 || index >= strings.length) {
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
  const encounteredAssetIds = new Set<string>();
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
    const assetId = resolveString(reader.readUint32(`slot ${slotIndex} asset`), `slot ${slotIndex} asset`);
    if (assetId !== assetIds[slotIndex]) {
      throw new Error(`Packed Vision slot ${slotIndex} does not match the requested asset`);
    }
    const isDuplicate = encounteredAssetIds.has(assetId);
    encounteredAssetIds.add(assetId);
    const status = reader.readUint8(`slot ${slotIndex} status`);

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
      const error = resolveString(reader.readUint32(`slot ${slotIndex} error`), `slot ${slotIndex} error`);
      results.push({ assetId, labels: [], error });
      continue;
    }
    if (status !== PACKED_VISION_CLASSIFICATION_SLOT_STATUS.success) {
      throw new RangeError(`Packed Vision slot ${slotIndex} has an unsupported status`);
    }

    const labelCount = reader.readUint16(`slot ${slotIndex} label count`);
    if (labelCount > Math.floor(reader.remaining / 8)) {
      throw new RangeError(`Packed Vision slot ${slotIndex} label count exceeds the remaining payload`);
    }
    const labels: VisionClassificationLabel[] = [];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const label = resolveString(reader.readUint32("label string index"), "label");
      const confidence = reader.readFloat32("label confidence");
      if (!Number.isFinite(confidence)) {
        throw new TypeError(`Packed Vision slot ${slotIndex} label ${labelIndex} has non-finite confidence`);
      }
      labels.push({ label, confidence });
    }
    results.push({ assetId, labels });
  }

  if (reader.remaining !== 0) {
    throw new RangeError(`Packed Vision payload has ${reader.remaining} trailing bytes at offset ${reader.position}`);
  }
  if (nextStringIndex !== strings.length) {
    throw new Error("Packed Vision string table contains unused values");
  }
  return results;
}
