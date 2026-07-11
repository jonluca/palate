export const INCREMENTAL_PHOTO_SCAN_EXISTING_IDS_SQL = "SELECT id FROM photos ORDER BY rowid ASC";

export interface RetainedAssetScanSession {
  readonly sessionId: string;
  readonly totalCount: number;
  readonly maxPageSize: number;
}

export interface IncrementalAssetScanSession extends RetainedAssetScanSession {
  readonly libraryTotalCount: number;
  readonly excludedVisibleCount: number;
  readonly excludedPhotosWithLocation: number;
  readonly excludedSkippedAssets: number;
}

export type PreferredAssetScanSession =
  | { readonly kind: "full"; readonly session: RetainedAssetScanSession }
  | { readonly kind: "incremental"; readonly session: IncrementalAssetScanSession };

export interface PreferredAssetScanDependencies {
  readonly databaseBackedIncrementalAvailable?: boolean;
  readonly preferDatabaseBackedIncremental?: boolean;
  readonly incrementalAvailable: boolean;
  readonly beginDatabaseBackedIncrementalScan?: () => Promise<IncrementalAssetScanSession>;
  readonly loadExistingAssetIds: () => Promise<string[]>;
  readonly beginFullScan: () => Promise<RetainedAssetScanSession>;
  readonly beginIncrementalScan: (existingAssetIds: string[]) => Promise<IncrementalAssetScanSession>;
  readonly onIncrementalBeginFailure?: (error: unknown) => void;
}

/**
 * Prefer native incremental filtering when the database is nonempty. Only a
 * failure from the incremental begin call falls back; later scan failures are
 * deliberately outside this selector and remain terminal.
 */
export async function beginPreferredAssetScan(
  dependencies: PreferredAssetScanDependencies,
): Promise<PreferredAssetScanSession> {
  if (
    dependencies.preferDatabaseBackedIncremental &&
    dependencies.databaseBackedIncrementalAvailable &&
    dependencies.beginDatabaseBackedIncrementalScan
  ) {
    try {
      return {
        kind: "incremental",
        session: await dependencies.beginDatabaseBackedIncrementalScan(),
      };
    } catch (error) {
      dependencies.onIncrementalBeginFailure?.(error);
      return { kind: "full", session: await dependencies.beginFullScan() };
    }
  }

  if (!dependencies.incrementalAvailable) {
    return { kind: "full", session: await dependencies.beginFullScan() };
  }

  const existingAssetIds = await dependencies.loadExistingAssetIds();
  if (existingAssetIds.length === 0) {
    return { kind: "full", session: await dependencies.beginFullScan() };
  }

  try {
    return {
      kind: "incremental",
      session: await dependencies.beginIncrementalScan(existingAssetIds),
    };
  } catch (error) {
    dependencies.onIncrementalBeginFailure?.(error);
    return { kind: "full", session: await dependencies.beginFullScan() };
  }
}

export interface IncrementalPhotoScanInitialProgress {
  readonly totalAssets: number;
  readonly processedAssets: number;
  readonly photosWithLocation: number;
  readonly skippedAssets: number;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Incremental asset scan returned an invalid ${name}: ${value}`);
  }
}

/** Validate native exclusion counters and translate them to public progress. */
export function getIncrementalPhotoScanInitialProgress(
  session: IncrementalAssetScanSession,
): IncrementalPhotoScanInitialProgress {
  for (const [name, value] of [
    ["unknown asset count", session.totalCount],
    ["library total count", session.libraryTotalCount],
    ["excluded visible count", session.excludedVisibleCount],
    ["excluded located-photo count", session.excludedPhotosWithLocation],
    ["excluded skipped-asset count", session.excludedSkippedAssets],
    ["maximum page size", session.maxPageSize],
  ] as const) {
    assertNonNegativeSafeInteger(value, name);
  }
  if (session.maxPageSize === 0) {
    throw new Error("Incremental asset scan returned a zero maximum page size");
  }
  if (session.totalCount + session.excludedVisibleCount !== session.libraryTotalCount) {
    throw new Error(
      `Incremental asset scan counts are inconsistent (${session.totalCount} unknown + ${session.excludedVisibleCount} excluded != ${session.libraryTotalCount} visible)`,
    );
  }
  if (
    session.excludedPhotosWithLocation > session.excludedVisibleCount ||
    session.excludedSkippedAssets > session.excludedVisibleCount ||
    session.excludedPhotosWithLocation + session.excludedSkippedAssets > session.excludedVisibleCount
  ) {
    throw new Error("Incremental asset scan exclusion counters exceed the excluded visible count");
  }

  return {
    totalAssets: session.libraryTotalCount,
    processedAssets: session.excludedVisibleCount,
    photosWithLocation: session.excludedPhotosWithLocation,
    skippedAssets: session.excludedSkippedAssets,
  };
}

/**
 * Validate a just-created incremental session and release its retained native
 * snapshot before propagating a malformed-session error.
 */
export async function getIncrementalPhotoScanInitialProgressWithCleanup(
  session: IncrementalAssetScanSession,
  endSession: (sessionId: string) => Promise<void>,
  onCleanupFailure?: (error: unknown) => void,
): Promise<IncrementalPhotoScanInitialProgress> {
  try {
    return getIncrementalPhotoScanInitialProgress(session);
  } catch (validationError) {
    try {
      await endSession(session.sessionId);
    } catch (cleanupError) {
      onCleanupFailure?.(cleanupError);
    }
    throw validationError;
  }
}

export interface PhotoScanAssetRecord {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly mediaType: "photo" | "video";
  readonly duration: number | null;
}

export interface PhotoScanInsertRecord {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly mediaType: "photo" | "video";
  readonly duration: number | null;
}

export interface ProcessedPhotoScanAssets {
  readonly photos: PhotoScanInsertRecord[];
  readonly photosWithLocation: number;
  readonly skippedAssets: number;
}

function hasValidPhotoScanLocation(asset: PhotoScanAssetRecord): boolean {
  return (
    asset.latitude !== null &&
    asset.longitude !== null &&
    Number.isFinite(asset.latitude) &&
    Number.isFinite(asset.longitude) &&
    asset.latitude >= -90 &&
    asset.latitude <= 90 &&
    asset.longitude >= -180 &&
    asset.longitude <= 180
  );
}

/** Convert one native page with the same skip/location semantics used by full scans. */
export function processPhotoScanAssets(assets: readonly PhotoScanAssetRecord[]): ProcessedPhotoScanAssets {
  const photos: PhotoScanInsertRecord[] = [];
  let photosWithLocation = 0;
  let skippedAssets = 0;

  for (const asset of assets) {
    if (asset.creationTime === null || !Number.isFinite(asset.creationTime)) {
      skippedAssets++;
      continue;
    }

    const hasLocation = hasValidPhotoScanLocation(asset);
    if (hasLocation) {
      photosWithLocation++;
    }
    photos.push({
      id: asset.id,
      uri: asset.uri,
      creationTime: asset.creationTime,
      latitude: hasLocation ? asset.latitude : null,
      longitude: hasLocation ? asset.longitude : null,
      mediaType: asset.mediaType,
      duration: asset.mediaType === "video" ? asset.duration : null,
    });
  }

  return { photos, photosWithLocation, skippedAssets };
}
