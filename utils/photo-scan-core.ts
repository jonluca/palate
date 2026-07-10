export interface AssetScanPageProgress {
  readonly offset: number;
  readonly assetCount: number;
  readonly nextOffset: number | null;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
}

export interface MediaLibraryPageProgress {
  readonly assetCount: number;
  readonly endCursor: string | null | undefined;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
}

export interface MediaLibraryScanState {
  readonly processedAssets: number;
  readonly totalAssets: number;
  readonly nextCursor: string | undefined;
}

/**
 * Validate and reconcile one page from MediaLibrary's estimated, cursor-based
 * pagination. `hasNextPage` is authoritative; `totalCount` is only an estimate.
 */
export function getValidatedMediaLibraryPageState(
  previousCursor: string | undefined,
  processedAssets: number,
  currentTotalAssets: number,
  page: MediaLibraryPageProgress,
): MediaLibraryScanState {
  for (const [name, value] of [
    ["processed asset count", processedAssets],
    ["current total estimate", currentTotalAssets],
    ["page asset count", page.assetCount],
    ["page total estimate", page.totalCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`MediaLibrary returned an invalid ${name}: ${value}`);
    }
  }

  const nextProcessedAssets = processedAssets + page.assetCount;
  if (!Number.isSafeInteger(nextProcessedAssets)) {
    throw new Error("MediaLibrary processed asset count exceeds the safe integer range");
  }

  if (page.assetCount === 0) {
    if (page.hasNextPage) {
      throw new Error("MediaLibrary returned a nonterminal empty page");
    }

    return {
      processedAssets: nextProcessedAssets,
      totalAssets: nextProcessedAssets,
      nextCursor: undefined,
    };
  }

  if (typeof page.endCursor !== "string" || page.endCursor.length === 0) {
    throw new Error("MediaLibrary returned a nonempty page without a pagination cursor");
  }
  if (page.endCursor === previousCursor) {
    throw new Error(`MediaLibrary pagination cursor did not advance from ${page.endCursor}`);
  }

  if (!page.hasNextPage) {
    return {
      processedAssets: nextProcessedAssets,
      totalAssets: nextProcessedAssets,
      nextCursor: undefined,
    };
  }

  const minimumIncompleteTotal = nextProcessedAssets + 1;
  if (!Number.isSafeInteger(minimumIncompleteTotal)) {
    throw new Error("MediaLibrary cannot represent another page within the safe integer range");
  }

  return {
    processedAssets: nextProcessedAssets,
    totalAssets: Math.max(currentTotalAssets, page.totalCount, minimumIncompleteTotal),
    nextCursor: page.endCursor,
  };
}

/** Validate that a retained native PhotoKit page is contiguous and complete. */
export function getValidatedAssetScanNextOffset(
  expectedOffset: number,
  expectedTotalCount: number,
  page: AssetScanPageProgress,
): number {
  if (page.offset !== expectedOffset || page.totalCount !== expectedTotalCount) {
    throw new Error(
      `Native asset scan snapshot changed unexpectedly (offset ${page.offset}/${expectedOffset}, total ${page.totalCount}/${expectedTotalCount})`,
    );
  }
  if (!Number.isSafeInteger(page.assetCount) || page.assetCount <= 0) {
    throw new Error(`Native asset scan returned an empty or invalid page before offset ${expectedTotalCount}`);
  }

  const contiguousNextOffset = expectedOffset + page.assetCount;
  if (contiguousNextOffset > expectedTotalCount) {
    throw new Error(`Native asset scan page exceeds its snapshot (${contiguousNextOffset}/${expectedTotalCount})`);
  }

  if (page.hasNextPage) {
    if (page.nextOffset !== contiguousNextOffset || contiguousNextOffset >= expectedTotalCount) {
      throw new Error(
        `Native asset scan did not advance contiguously (${String(page.nextOffset)}/${contiguousNextOffset})`,
      );
    }
    return contiguousNextOffset;
  }

  if (page.nextOffset !== null || contiguousNextOffset !== expectedTotalCount) {
    throw new Error(
      `Native asset scan ended before consuming its snapshot (${contiguousNextOffset}/${expectedTotalCount})`,
    );
  }
  return expectedTotalCount;
}
