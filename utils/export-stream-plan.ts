import { EXPORT_PHOTO_PAGE_SIZE } from "./db/export-photos-core.ts";

/** Hard visit-count bound used by {@linkcode planExportPhotoBatches}. */
export const EXPORT_STREAM_MAX_VISITS_PER_BATCH = 256;

/** Options consumed by {@linkcode planExportPhotoBatches}. */
export interface ExportStreamPlanOptions {
  /**
   * Maximum combined photo count in a bounded batch. Must be a safe integer
   * between 1 and 4,000.
   *
   * @default 4000
   */
  readonly maxPhotosPerBatch?: number;
  /**
   * Maximum visit count in a bounded batch. Must be a safe integer between 1
   * and 256.
   *
   * @default 256
   */
  readonly maxVisitsPerBatch?: number;
}

/** A consecutive group returned by {@linkcode planExportPhotoBatches} whose exact photo count fits the bound. */
export interface BoundedExportPhotoBatch {
  /** Identifies the normal bounded-query path. */
  readonly mode: "bounded";
  /** Consecutive visit IDs in export output order. */
  readonly visitIds: readonly string[];
  /** Exact combined photo count; zero means the photo query can be skipped. */
  readonly photoCount: number;
}

/** One oversized visit returned by {@linkcode planExportPhotoBatches} for bounded keyset paging. */
export interface StreamingExportPhotoBatch {
  /** Identifies the dedicated keyset-streaming path. */
  readonly mode: "streaming";
  /** The single oversized visit ID. */
  readonly visitIds: readonly [string];
  /** Exact photo count, greater than the configured bounded-batch limit. */
  readonly photoCount: number;
}

/** One deterministic batch returned by {@linkcode planExportPhotoBatches}. */
export type ExportPhotoBatch = BoundedExportPhotoBatch | StreamingExportPhotoBatch;

function resolveBoundedMaximum(value: unknown, defaultValue: number, hardMaximum: number, name: string): number {
  const resolved = value === undefined ? defaultValue : value;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0 || (resolved as number) > hardMaximum) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${hardMaximum}.`);
  }
  return resolved as number;
}

/**
 * Greedily plan consecutive output-order visits from an exact count map.
 *
 * Bounded batches never exceed 4,000 photos or 256 visits by default. A visit
 * above the resolved photo bound becomes a dedicated streaming batch. Visits
 * with no photos remain in order and may form a zero-count batch, which callers
 * can skip by checking {@linkcode BoundedExportPhotoBatch.photoCount}.
 *
 * @throws {TypeError} When IDs, the count map, or the options object have an invalid type.
 * @throws {RangeError} When IDs are duplicated, the map is not exact, counts are invalid, or options exceed hard bounds.
 */
export function planExportPhotoBatches(
  orderedVisitIds: readonly string[],
  photoCountsByVisitId: ReadonlyMap<string, number>,
  options: ExportStreamPlanOptions = {},
): readonly ExportPhotoBatch[] {
  if (!Array.isArray(orderedVisitIds)) {
    throw new TypeError("Export stream planning requires an array of visit IDs.");
  }
  if (!(photoCountsByVisitId instanceof Map)) {
    throw new TypeError("Export stream planning requires a Map of exact photo counts.");
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Export stream planning options must be an object.");
  }

  const maxPhotosPerBatch = resolveBoundedMaximum(
    options.maxPhotosPerBatch,
    EXPORT_PHOTO_PAGE_SIZE,
    EXPORT_PHOTO_PAGE_SIZE,
    "maxPhotosPerBatch",
  );
  const maxVisitsPerBatch = resolveBoundedMaximum(
    options.maxVisitsPerBatch,
    EXPORT_STREAM_MAX_VISITS_PER_BATCH,
    EXPORT_STREAM_MAX_VISITS_PER_BATCH,
    "maxVisitsPerBatch",
  );

  const requestedVisitIds = new Set<string>();
  for (const visitId of orderedVisitIds) {
    if (typeof visitId !== "string") {
      throw new TypeError("Export stream planning requires string visit IDs.");
    }
    if (requestedVisitIds.has(visitId)) {
      throw new RangeError(`Export stream planning received duplicate visit ID ${JSON.stringify(visitId)}.`);
    }
    requestedVisitIds.add(visitId);
  }

  for (const [visitId, photoCount] of photoCountsByVisitId) {
    if (typeof visitId !== "string") {
      throw new TypeError("Export stream photo count maps require string visit IDs.");
    }
    if (!requestedVisitIds.has(visitId)) {
      throw new RangeError(`Export stream photo count map contains unexpected visit ID ${JSON.stringify(visitId)}.`);
    }
    if (!Number.isSafeInteger(photoCount) || photoCount < 0) {
      throw new RangeError(`Photo count for visit ${JSON.stringify(visitId)} must be a non-negative safe integer.`);
    }
  }

  const visitPhotoCounts = orderedVisitIds.map((visitId) => {
    if (!photoCountsByVisitId.has(visitId)) {
      throw new RangeError(`Export stream photo count map is missing visit ID ${JSON.stringify(visitId)}.`);
    }
    return photoCountsByVisitId.get(visitId)!;
  });

  const batches: ExportPhotoBatch[] = [];
  let boundedVisitIds: string[] = [];
  let boundedPhotoCount = 0;
  const flushBoundedBatch = (): void => {
    if (boundedVisitIds.length === 0) {
      return;
    }
    batches.push({ mode: "bounded", visitIds: boundedVisitIds, photoCount: boundedPhotoCount });
    boundedVisitIds = [];
    boundedPhotoCount = 0;
  };

  for (const [index, visitId] of orderedVisitIds.entries()) {
    const photoCount = visitPhotoCounts[index]!;
    if (photoCount > maxPhotosPerBatch) {
      flushBoundedBatch();
      batches.push({ mode: "streaming", visitIds: [visitId], photoCount });
      continue;
    }

    if (boundedVisitIds.length === maxVisitsPerBatch || boundedPhotoCount + photoCount > maxPhotosPerBatch) {
      flushBoundedBatch();
    }
    boundedVisitIds.push(visitId);
    boundedPhotoCount += photoCount;
  }
  flushBoundedBatch();

  return batches;
}
