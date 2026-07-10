import * as MediaLibrary from "expo-media-library/legacy";
import * as Device from "expo-device";
import pMap from "p-map";
import { insertPhotos, type PhotoRecord } from "@/utils/db";
import { getPhotoIngestionFlushCount } from "@/utils/db/photo-ingestion-core";
import { getValidatedAssetScanNextOffset, getValidatedMediaLibraryPageState } from "@/utils/photo-scan-core";
import {
  beginAssetScan,
  endAssetScan,
  getAssetInfoBatch,
  getAssetScanPage,
  isAssetScanAvailable,
  isBatchAssetInfoAvailable,
  type AssetScanRecord,
} from "@/modules/batch-asset-info";

type PhotoInsertRecord = Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence" | "allLabels">;

interface ProcessedAssetBatch {
  photos: PhotoInsertRecord[];
  photosWithLocation: number;
  skippedAssets: number;
}

export interface ScanProgress {
  totalAssets: number;
  processedAssets: number;
  newPhotosAdded: number;
  photosWithLocation: number;
  skippedAssets: number;
  isComplete: boolean;
  // Speed and ETA tracking
  elapsedMs: number;
  /** Overall metadata scan throughput; retained name for API compatibility. */
  newPhotosPerSecond: number;
  etaMs: number | null;
  // Performance info
  usingNativeBatch: boolean;
  deviceTier: "low" | "medium" | "high";
}

export interface ScanOptions {
  batchSize?: number;
  concurrency?: number;
  onProgress?: (progress: ScanProgress) => void;
}

// Device tier thresholds
const MEMORY_THRESHOLDS = { low: 2 * 1024 * 1024 * 1024, medium: 4 * 1024 * 1024 * 1024 };
const DEVICE_YEAR_THRESHOLDS = { low: 2018, medium: 2020 };

// Optimized settings per tier
const TIER_SETTINGS = {
  low: { tier: "low" as const, batchSize: 25, nativeBatchSize: 250, concurrency: 5 },
  medium: { tier: "medium" as const, batchSize: 50, nativeBatchSize: 500, concurrency: 10 },
  high: { tier: "high" as const, batchSize: 100, nativeBatchSize: 2000, concurrency: 20 },
};

type DeviceTier = (typeof TIER_SETTINGS)[keyof typeof TIER_SETTINGS];

/** Determine device tier based on memory and device year */
function getDeviceTier(): DeviceTier {
  const { totalMemory, deviceYearClass } = Device;

  let tier: keyof typeof TIER_SETTINGS = "high";
  if (totalMemory !== null) {
    if (totalMemory < MEMORY_THRESHOLDS.low) {
      tier = "low";
    } else if (totalMemory < MEMORY_THRESHOLDS.medium) {
      tier = "medium";
    }
  } else if (deviceYearClass !== null) {
    if (deviceYearClass <= DEVICE_YEAR_THRESHOLDS.low) {
      tier = "low";
    } else if (deviceYearClass <= DEVICE_YEAR_THRESHOLDS.medium) {
      tier = "medium";
    }
  }

  return TIER_SETTINGS[tier];
}

/** Request media library permissions */
export async function requestMediaLibraryPermission(): Promise<boolean> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  return status === "granted";
}

/** Check if media library permission is granted */
export async function hasMediaLibraryPermission(): Promise<boolean> {
  const { status } = await MediaLibrary.getPermissionsAsync();
  return status === "granted";
}

/** Format milliseconds as human readable string */
export function formatEta(ms: number | null): string {
  if (ms === null || ms <= 0) {
    return "calculating...";
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds.toLocaleString()}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes.toLocaleString()}m ${remainingSeconds.toLocaleString()}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours.toLocaleString()}h ${remainingMinutes.toLocaleString()}m`;
}

/** Check if native batch processing is available (iOS only) */
const isNativeBatchAvailable = () => isBatchAssetInfoAvailable();

function isValidLocation(location: { latitude: number; longitude: number } | null | undefined): boolean {
  return (
    location !== null &&
    location !== undefined &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function processNativeScanPage(assets: AssetScanRecord[]): ProcessedAssetBatch {
  const photos: PhotoInsertRecord[] = [];
  let photosWithLocation = 0;
  let skippedAssets = 0;

  for (const asset of assets) {
    if (asset.creationTime === null || !Number.isFinite(asset.creationTime)) {
      skippedAssets++;
      continue;
    }

    const location =
      asset.latitude === null || asset.longitude === null
        ? null
        : { latitude: asset.latitude, longitude: asset.longitude };
    const hasLocation = isValidLocation(location);
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

/**
 * Process assets using native batch API (iOS only)
 * Returns photo records ready for database insertion.
 * Gracefully handles deleted photos by only returning records for existing assets.
 *
 * Note: This function should only be called after checking isBatchAssetInfoAvailable().
 * On Android, this will throw an error.
 */
async function processWithNativeBatch(assetIds: string[]): Promise<ProcessedAssetBatch> {
  const batchInfo = await getAssetInfoBatch(assetIds);

  const photos: PhotoInsertRecord[] = [];
  let photosWithLocation = 0;

  // batchInfo may have fewer items than assetIds if an asset was deleted
  // between the MediaLibrary page and this legacy native refetch.
  for (const asset of batchInfo) {
    const hasLocation = isValidLocation(asset.location);

    if (hasLocation) {
      photosWithLocation++;
    }

    photos.push({
      id: asset.id,
      uri: asset.uri,
      creationTime: asset.creationTime,
      latitude: hasLocation ? asset.location!.latitude : null,
      longitude: hasLocation ? asset.location!.longitude : null,
      mediaType: asset.mediaType === "video" ? "video" : "photo",
      duration: asset.mediaType === "video" ? asset.duration : null,
    });
  }

  return {
    photos,
    photosWithLocation,
    skippedAssets: Math.max(0, assetIds.length - batchInfo.length),
  };
}

/**
 * Process assets using JS-based pMap (fallback for Android)
 */
async function processWithPMap(assets: MediaLibrary.Asset[], concurrency: number): Promise<ProcessedAssetBatch> {
  const assetsWithInfo = await pMap(
    assets,
    async (asset) => {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset);
        return { ...info, originalAsset: asset };
      } catch (error) {
        console.warn(`Failed to get info for asset ${asset.id}:`, error);
        return null;
      }
    },
    { concurrency },
  );

  const photos: PhotoInsertRecord[] = [];
  let photosWithLocation = 0;

  for (const asset of assetsWithInfo) {
    if (!asset) {
      continue;
    }

    const hasLocation = isValidLocation(asset.location);

    if (hasLocation) {
      photosWithLocation++;
    }

    const isVideo = asset.originalAsset.mediaType === MediaLibrary.MediaType.video;
    photos.push({
      id: asset.id,
      uri: asset.uri,
      creationTime: asset.creationTime,
      latitude: hasLocation ? asset.location!.latitude : null,
      longitude: hasLocation ? asset.location!.longitude : null,
      mediaType: isVideo ? "video" : "photo",
      duration: isVideo ? asset.originalAsset.duration : null,
    });
  }

  return {
    photos,
    photosWithLocation,
    skippedAssets: Math.max(0, assets.length - photos.length),
  };
}

/**
 * Scan camera roll and import photos into the database.
 * Uses one retained native PhotoKit snapshot on current iOS builds.
 * Older iOS binaries retain the legacy ID-refetch path for OTA compatibility.
 * Falls back to pMap-based processing on Android.
 * Automatically adjusts batch sizes based on device capabilities.
 */
export async function scanCameraRoll(options: ScanOptions = {}): Promise<ScanProgress> {
  const useNativeBatch = isNativeBatchAvailable();
  const useNativeScanSession = isAssetScanAvailable();
  const deviceTier = getDeviceTier();

  const {
    batchSize = useNativeBatch ? deviceTier.nativeBatchSize : deviceTier.batchSize,
    concurrency = deviceTier.concurrency,
    onProgress,
  } = options;

  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`Scan batch size must be a positive safe integer; received ${batchSize}`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError(`Scan concurrency must be a positive safe integer; received ${concurrency}`);
  }

  const nativeSession = useNativeScanSession ? await beginAssetScan() : null;
  const totalAssets = nativeSession
    ? nativeSession.totalCount
    : (
        await MediaLibrary.getAssetsAsync({
          first: 1,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        })
      ).totalCount;

  const progress: ScanProgress = {
    totalAssets,
    processedAssets: 0,
    newPhotosAdded: 0,
    photosWithLocation: 0,
    skippedAssets: 0,
    isComplete: false,
    elapsedMs: 0,
    newPhotosPerSecond: 0,
    etaMs: null,
    usingNativeBatch: useNativeBatch,
    deviceTier: deviceTier.tier,
  };

  const startTime = Date.now();
  let scanError: unknown | null = null;

  const updateProgress = () => {
    progress.elapsedMs = Date.now() - startTime;
    const elapsedSeconds = progress.elapsedMs / 1000;
    const remainingAssets = Math.max(0, progress.totalAssets - progress.processedAssets);
    const hasStableEstimate = elapsedSeconds >= 2 || remainingAssets === 0;

    if (hasStableEstimate && progress.processedAssets > 0 && elapsedSeconds > 0) {
      progress.newPhotosPerSecond = Math.round(progress.processedAssets / elapsedSeconds);
      progress.etaMs =
        remainingAssets > 0 && progress.newPhotosPerSecond > 0
          ? (remainingAssets / progress.newPhotosPerSecond) * 1000
          : 0;
    } else {
      progress.newPhotosPerSecond = 0;
      progress.etaMs = null;
    }

    onProgress?.({ ...progress });
  };

  const pendingPhotos: PhotoInsertRecord[] = [];
  let pendingInsertFailed = false;

  const flushPendingPhotos = async (force: boolean) => {
    let flushCount = getPhotoIngestionFlushCount(pendingPhotos.length, force);
    while (flushCount > 0) {
      const photos = pendingPhotos.slice(0, flushCount);
      try {
        progress.newPhotosAdded += await insertPhotos(photos);
      } catch (error) {
        pendingInsertFailed = true;
        throw error;
      }
      pendingPhotos.splice(0, flushCount);
      flushCount = getPhotoIngestionFlushCount(pendingPhotos.length, force);
    }
  };

  const persistBatch = async (batch: ProcessedAssetBatch) => {
    progress.photosWithLocation += batch.photosWithLocation;
    progress.skippedAssets += batch.skippedAssets;
    if (batch.photos.length > 0) {
      pendingPhotos.push(...batch.photos);
      await flushPendingPhotos(false);
    }
  };

  try {
    onProgress?.({ ...progress });

    if (nativeSession) {
      const nativePageSize = Math.min(batchSize, nativeSession.maxPageSize);
      let offset = 0;

      while (offset < nativeSession.totalCount) {
        const page = await getAssetScanPage(nativeSession.sessionId, { offset, limit: nativePageSize });
        const nextOffset = getValidatedAssetScanNextOffset(offset, nativeSession.totalCount, {
          offset: page.offset,
          assetCount: page.assets.length,
          nextOffset: page.nextOffset,
          totalCount: page.totalCount,
          hasNextPage: page.hasNextPage,
        });

        await persistBatch(processNativeScanPage(page.assets));
        progress.processedAssets += page.assets.length;
        offset = nextOffset;
        updateProgress();
      }
    } else {
      let hasNextPage = true;
      let endCursor: string | undefined;

      while (hasNextPage) {
        const response = await MediaLibrary.getAssetsAsync({
          first: batchSize,
          after: endCursor,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [MediaLibrary.SortBy.creationTime],
        });
        const pageState = getValidatedMediaLibraryPageState(endCursor, progress.processedAssets, progress.totalAssets, {
          assetCount: response.assets.length,
          endCursor: response.endCursor,
          totalCount: response.totalCount,
          hasNextPage: response.hasNextPage,
        });

        if (response.assets.length > 0) {
          const processedBatch = useNativeBatch
            ? await processWithNativeBatch(response.assets.map((asset) => asset.id))
            : await processWithPMap(response.assets, concurrency);
          await persistBatch(processedBatch);
        }

        progress.processedAssets = pageState.processedAssets;
        progress.totalAssets = pageState.totalAssets;
        hasNextPage = response.hasNextPage;
        endCursor = pageState.nextCursor;
        updateProgress();
      }
    }
  } catch (error) {
    scanError = error;
  }

  // Preserve successfully fetched pages on a later PhotoKit failure, while
  // avoiding an automatic retry when SQLite itself rejected the flush.
  if (!pendingInsertFailed && pendingPhotos.length > 0) {
    try {
      await flushPendingPhotos(true);
    } catch (flushError) {
      if (scanError === null) {
        scanError = flushError;
      } else {
        console.error("Failed to persist the final photo scan buffer after an earlier scan error:", flushError);
      }
    }
  }

  if (nativeSession) {
    try {
      await endAssetScan(nativeSession.sessionId);
    } catch (cleanupError) {
      if (scanError === null) {
        scanError = cleanupError;
      } else {
        console.error("Failed to release native asset scan after a scan error:", cleanupError);
      }
    }
  }

  if (scanError !== null) {
    throw scanError;
  }

  progress.isComplete = true;
  progress.elapsedMs = Date.now() - startTime;
  progress.etaMs = 0;
  const finalElapsedSeconds = progress.elapsedMs / 1000;
  progress.newPhotosPerSecond =
    progress.processedAssets > 0 && finalElapsedSeconds > 0
      ? Math.round(progress.processedAssets / finalElapsedSeconds)
      : 0;
  if (progress.skippedAssets > 0) {
    console.warn(`Skipped ${progress.skippedAssets} inaccessible assets or assets without a creation date.`);
  }
  onProgress?.({ ...progress });

  return progress;
}

/**
 * Get a quick estimate of photos and videos in camera roll
 */
export async function getPhotoCount(): Promise<number> {
  const response = await MediaLibrary.getAssetsAsync({
    first: 1,
    mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
  });
  return response.totalCount;
}

export interface CreateAlbumResult {
  success: boolean;
  albumName: string;
  photoCount: number;
  error?: string;
}

/**
 * Create a photo album with the given photos.
 * If an album with the same name exists, adds photos to it.
 */
export async function createAlbumWithPhotos(albumName: string, assetIds: string[]): Promise<CreateAlbumResult> {
  if (assetIds.length === 0) {
    return { success: false, albumName, photoCount: 0, error: "No photos to add" };
  }

  try {
    // Get the assets from their IDs (both photos and videos)
    const assets = await MediaLibrary.getAssetsAsync({
      first: assetIds.length,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    });

    // Filter to only include assets that match our IDs
    const matchingAssets = assets.assets.filter((asset) => assetIds.includes(asset.id));

    if (matchingAssets.length === 0) {
      // If we couldn't find assets by listing, try to get them directly
      // This can happen if the assets are older and not in the first batch
      const directAssets: MediaLibrary.Asset[] = [];
      for (const id of assetIds) {
        try {
          const asset = await MediaLibrary.getAssetInfoAsync(id);
          if (asset) {
            directAssets.push(asset);
          }
        } catch {
          // Asset may have been deleted, skip it
        }
      }

      if (directAssets.length === 0) {
        return { success: false, albumName, photoCount: 0, error: "Could not find any of the photos" };
      }

      return createOrUpdateAlbum(albumName, directAssets);
    }

    return createOrUpdateAlbum(albumName, matchingAssets);
  } catch (error) {
    console.error("Error creating album:", error);
    return {
      success: false,
      albumName,
      photoCount: 0,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

async function createOrUpdateAlbum(albumName: string, assets: MediaLibrary.Asset[]): Promise<CreateAlbumResult> {
  // Check if album already exists
  const existingAlbum = await MediaLibrary.getAlbumAsync(albumName);

  if (existingAlbum) {
    // Add photos to existing album (don't copy, just reference)
    await MediaLibrary.addAssetsToAlbumAsync(assets, existingAlbum, false);
    return { success: true, albumName, photoCount: assets.length };
  }

  // Create new album with the first asset, then add the rest
  const [firstAsset, ...restAssets] = assets;
  const album = await MediaLibrary.createAlbumAsync(albumName, firstAsset, false);

  if (restAssets.length > 0) {
    await MediaLibrary.addAssetsToAlbumAsync(restAssets, album, false);
  }

  return { success: true, albumName, photoCount: assets.length };
}
