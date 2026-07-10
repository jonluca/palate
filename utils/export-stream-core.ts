import type { ExportData, ExportVisit, ExportVisitPhoto } from "./export-core";

export type TextFragmentSink = (fragment: string) => void;
export type Utf8ChunkSink = (chunk: Uint8Array) => void;

export type ExportVisitHeader = Omit<ExportVisit, "photos">;
export type ExportStreamDocument = Pick<ExportData, "exportedAt" | "stats" | "restaurants">;

export class ExportStreamStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportStreamStateError";
  }
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Export stream values must be JSON-serializable.");
  }
  return serialized;
}

function indentAllLines(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return `${indentation}${value.replaceAll("\n", `\n${indentation}`)}`;
}

function indentContinuationLines(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value.replaceAll("\n", `\n${indentation}`);
}

function serializeVisitPrefix(visit: ExportVisitHeader): string {
  // Remove a runtime photos property as well as the compile-time one, then append
  // it last so the streamed property order matches the canonical export shape.
  const { photos: _ignoredPhotos, ...visitFields } = visit as ExportVisit;
  const serialized = stringifyJson({ ...visitFields, photos: [] });
  const expectedSuffix = '  "photos": []\n}';
  if (!serialized.endsWith(expectedSuffix)) {
    throw new TypeError("Export visit serialization did not end with the photos property.");
  }
  const emptyArrayAndObjectSuffix = "[]\n}";
  return serialized.slice(0, -emptyArrayAndObjectSuffix.length);
}

/**
 * Stateful, synchronous JSON writer for the canonical Palate export shape.
 * Only the current photo is serialized; completed photos are never retained.
 */
export class ExportJsonStreamWriter {
  private readonly sink: TextFragmentSink;
  private readonly documentPrefix: string;
  private readonly serializedRestaurants: string;
  private state: "ready" | "visit" | "finished" | "failed" = "ready";
  private started = false;
  private hasVisits = false;
  private hasPhotosInCurrentVisit = false;

  constructor(sink: TextFragmentSink, document: ExportStreamDocument) {
    if (typeof sink !== "function") {
      throw new TypeError("Export stream sink must be a function.");
    }
    this.sink = sink;
    this.documentPrefix = `{
  "exportedAt": ${stringifyJson(document.exportedAt)},
  "stats": ${indentContinuationLines(stringifyJson(document.stats), 2)},
  "visits": `;
    this.serializedRestaurants = indentContinuationLines(stringifyJson(document.restaurants), 2);
  }

  beginVisit(visit: ExportVisitHeader): void {
    this.assertUsable("begin a visit");
    if (this.state === "visit") {
      throw new ExportStreamStateError("Cannot begin a visit before ending the current visit.");
    }

    const prefix = indentAllLines(serializeVisitPrefix(visit), 4);
    this.ensureStarted();
    this.emit(`${this.hasVisits ? ",\n" : "[\n"}${prefix}`);
    this.hasVisits = true;
    this.hasPhotosInCurrentVisit = false;
    this.state = "visit";
  }

  writePhoto(photo: ExportVisitPhoto): void {
    this.assertUsable("write a photo");
    if (this.state !== "visit") {
      throw new ExportStreamStateError("Cannot write a photo without an active visit.");
    }

    const serializedPhoto = indentAllLines(stringifyJson(photo), 8);
    this.emit(`${this.hasPhotosInCurrentVisit ? ",\n" : "[\n"}${serializedPhoto}`);
    this.hasPhotosInCurrentVisit = true;
  }

  endVisit(): void {
    this.assertUsable("end a visit");
    if (this.state !== "visit") {
      throw new ExportStreamStateError("Cannot end a visit when no visit is active.");
    }

    this.emit(this.hasPhotosInCurrentVisit ? "\n      ]\n    }" : "[]\n    }");
    this.hasPhotosInCurrentVisit = false;
    this.state = "ready";
  }

  finish(): void {
    this.assertUsable("finish the export");
    if (this.state === "visit") {
      throw new ExportStreamStateError("Cannot finish the export before ending the current visit.");
    }

    this.ensureStarted();
    const visitsSuffix = this.hasVisits ? "\n  ],\n" : "[],\n";
    this.emit(`${visitsSuffix}  "restaurants": ${this.serializedRestaurants}\n}`);
    this.state = "finished";
  }

  private ensureStarted(): void {
    if (this.started) {
      return;
    }
    this.emit(this.documentPrefix);
    this.started = true;
  }

  private assertUsable(action: string): void {
    if (this.state === "finished") {
      throw new ExportStreamStateError(`Cannot ${action} after the export is finished.`);
    }
    if (this.state === "failed") {
      throw new ExportStreamStateError(`Cannot ${action} after the export sink failed.`);
    }
  }

  private emit(fragment: string): void {
    try {
      this.sink(fragment);
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
}

/**
 * Buffers complete text fragments and writes UTF-8 chunks synchronously.
 * Normal fragments never push the buffer past `maxBufferedCodeUnits`. A single
 * oversized fragment is allowed and flushed whole, so surrogate pairs within a
 * fragment are never split by the buffer.
 */
export class BoundedUtf8BufferingSink {
  readonly maxBufferedCodeUnits: number;
  readonly write: TextFragmentSink;

  private readonly sink: Utf8ChunkSink;
  private readonly encoder = new TextEncoder();
  private fragments: string[] = [];
  private codeUnits = 0;
  private maximumCodeUnits = 0;
  private closed = false;

  constructor(sink: Utf8ChunkSink, maxBufferedCodeUnits: number = 64 * 1024) {
    if (typeof sink !== "function") {
      throw new TypeError("UTF-8 chunk sink must be a function.");
    }
    if (!Number.isSafeInteger(maxBufferedCodeUnits) || maxBufferedCodeUnits <= 0) {
      throw new RangeError("Maximum buffered code units must be a positive safe integer.");
    }
    this.sink = sink;
    this.maxBufferedCodeUnits = maxBufferedCodeUnits;
    this.write = (fragment: string) => this.writeFragment(fragment);
  }

  get bufferedCodeUnits(): number {
    return this.codeUnits;
  }

  get maximumBufferedCodeUnitsObserved(): number {
    return this.maximumCodeUnits;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  flush(): void {
    if (this.closed || this.fragments.length === 0) {
      return;
    }

    const chunk = this.encoder.encode(this.fragments.join(""));
    // Clear only after a successful write so callers can retry flush/close when
    // an atomic synchronous sink rejects a chunk.
    this.sink(chunk);
    this.fragments = [];
    this.codeUnits = 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.flush();
    this.closed = true;
  }

  private writeFragment(fragment: string): void {
    if (this.closed) {
      throw new ExportStreamStateError("Cannot write to a closed UTF-8 buffer.");
    }
    if (typeof fragment !== "string") {
      throw new TypeError("UTF-8 buffer fragments must be strings.");
    }
    if (fragment.length === 0) {
      return;
    }

    if (fragment.length > this.maxBufferedCodeUnits) {
      this.flush();
      this.buffer(fragment);
      this.flush();
      return;
    }

    if (this.codeUnits > 0 && this.codeUnits + fragment.length > this.maxBufferedCodeUnits) {
      this.flush();
    }
    this.buffer(fragment);
  }

  private buffer(fragment: string): void {
    this.fragments.push(fragment);
    this.codeUnits += fragment.length;
    this.maximumCodeUnits = Math.max(this.maximumCodeUnits, this.codeUnits);
  }
}
