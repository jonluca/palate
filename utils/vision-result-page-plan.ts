import { MAXIMUM_VISION_NATIVE_PAGE_SIZE } from "./food-detection-buffer-core.ts";

/** One contiguous native Vision request in the complete ordered input. */
export interface VisionResultPage {
  readonly offset: number;
  readonly endOffset: number;
  readonly count: number;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer; received ${value}.`);
  }
}

/**
 * Partitions an ordered Vision input into bounded, contiguous native requests.
 * The plan is pure so page-size tuning can be validated without Photos access.
 */
export function createVisionResultPagePlan(totalCount: number, pageSize: number): VisionResultPage[] {
  assertNonNegativeSafeInteger(totalCount, "Vision result count");
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAXIMUM_VISION_NATIVE_PAGE_SIZE) {
    throw new RangeError(
      `Vision result page size must be an integer from 1 through ${MAXIMUM_VISION_NATIVE_PAGE_SIZE}; received ${pageSize}.`,
    );
  }

  const pages: VisionResultPage[] = [];
  for (let offset = 0; offset < totalCount; offset += pageSize) {
    const endOffset = Math.min(offset + pageSize, totalCount);
    pages.push({ offset, endOffset, count: endOffset - offset });
  }
  return pages;
}

/**
 * Computes the realized pending-row high-water mark for a page-at-a-time
 * producer feeding fixed-size durable flushes.
 */
export function calculateVisionResultPeakBufferedRows(
  totalCount: number,
  pageSize: number,
  persistenceFlushSize: number,
): number {
  if (!Number.isSafeInteger(persistenceFlushSize) || persistenceFlushSize <= 0) {
    throw new RangeError(
      `Vision persistence flush size must be a positive safe integer; received ${persistenceFlushSize}.`,
    );
  }

  let pendingCount = 0;
  let peakCount = 0;
  for (const page of createVisionResultPagePlan(totalCount, pageSize)) {
    pendingCount += page.count;
    peakCount = Math.max(peakCount, pendingCount);
    pendingCount %= persistenceFlushSize;
  }
  return peakCount;
}
