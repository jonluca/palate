import * as MediaLibrary from "expo-media-library";
import * as Device from "expo-device";
import pMap from "p-map";
import { insertPhotos, type PhotoRecord } from "@/utils/db";
import { isBatchAssetInfoAvailable, getAssetInfoBatch } from "@/modules/batch-asset-info";

export interface ScanProgress {
  totalAssets: number;
  processedAssets: number;
  newPhotosAdded: number;
  photosWithLocation: number;
  isComplete: boolean;
  // Speed and ETA tracking
  elapsedMs: number;
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

/**
 * Process assets using native batch API (iOS only)
 * Returns photo records ready for database insertion.
 * Gracefully handles deleted photos by only returning records for existing assets.
 *
 * Note: This function should only be called after checking isBatchAssetInfoAvailable().
 * On Android, this will throw an error.
 */
async function processWithNativeBatch(
  assetIds: string[],
  onPhotosWithLocation: (count: number) => void,
): Promise<Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence">[]> {
  try {
    const batchInfo = await getAssetInfoBatch(assetIds);

    const photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence">[] = [];
    let locCount = 0;

    // Note: batchInfo may have fewer items than assetIds if some photos were deleted
    // The native module only returns info for photos that still exist
    for (const asset of batchInfo) {
      const hasLocation = asset.location && asset.location.latitude !== 0 && asset.location.longitude !== 0;

      if (hasLocation) {
        locCount++;
      }

      photos.push({
        id: asset.id,
        uri: asset.uri,
        creationTime: asset.creationTime,
        latitude: hasLocation ? asset.location!.latitude : null,
        longitude: hasLocation ? asset.location!.longitude : null,
      });
    }

    onPhotosWithLocation(locCount);
    return photos;
  } catch (error) {
    console.warn("Native batch processing failed, some photos may have been deleted:", error);
    // Return empty array on error - caller will handle gracefully
    return [];
  }
}

/**
 * Process assets using JS-based pMap (fallback for Android)
 */
async function processWithPMap(
  assets: MediaLibrary.Asset[],
  concurrency: number,
  onPhotosWithLocation: (count: number) => void,
): Promise<Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence">[]> {
  const assetsWithInfo = await pMap(
    assets,
    async (asset) => {
      try {
        return await MediaLibrary.getAssetInfoAsync(asset);
      } catch (error) {
        console.warn(`Failed to get info for asset ${asset.id}:`, error);
        return null;
      }
    },
    { concurrency },
  );

  const photos: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence">[] = [];
  let locCount = 0;

  for (const asset of assetsWithInfo) {
    if (!asset) {
      continue;
    }

    const hasLocation = asset.location && asset.location.latitude !== 0 && asset.location.longitude !== 0;

    if (hasLocation) {
      locCount++;
    }

    photos.push({
      id: asset.id,
      uri: asset.uri,
      creationTime: asset.creationTime,
      latitude: hasLocation ? asset.location!.latitude : null,
      longitude: hasLocation ? asset.location!.longitude : null,
    });
  }

  onPhotosWithLocation(locCount);
  return photos;
}

/**
 * Scan camera roll and import photos into the database.
 * Uses native batch processing on iOS for maximum performance.
 * Falls back to pMap-based processing on Android.
 * Automatically adjusts batch sizes based on device capabilities.
 */
export async function scanCameraRoll(options: ScanOptions = {}): Promise<ScanProgress> {
  const useNativeBatch = isNativeBatchAvailable();
  const deviceTier = getDeviceTier();

  const {
    batchSize = useNativeBatch ? deviceTier.nativeBatchSize : deviceTier.batchSize,
    concurrency = deviceTier.concurrency,
    onProgress,
  } = options;

  // First, get the total count
  const totalAssetsResponse = await MediaLibrary.getAssetsAsync({
    first: 1,
    mediaType: MediaLibrary.MediaType.photo,
  });

  const totalAssets = totalAssetsResponse.totalCount;

  const progress: ScanProgress = {
    totalAssets,
    processedAssets: 0,
    newPhotosAdded: 0,
    photosWithLocation: 0,
    isComplete: false,
    elapsedMs: 0,
    newPhotosPerSecond: 0,
    etaMs: null,
    usingNativeBatch: useNativeBatch,
    deviceTier: deviceTier.tier,
  };

  // Report initial progress
  onProgress?.(progress);

  let hasNextPage = true;
  let endCursor: string | undefined;
  const startTime = Date.now();

  while (hasNextPage) {
    // Fetch batch of assets (just metadata, not full info)
    const response = await MediaLibrary.getAssetsAsync({
      first: batchSize,
      after: endCursor,
      mediaType: MediaLibrary.MediaType.photo,
      sortBy: [MediaLibrary.SortBy.creationTime],
    });

    if (response.assets.length > 0) {
      let photosToInsert: Omit<PhotoRecord, "visitId" | "foodDetected" | "foodLabels" | "foodConfidence">[];

      if (useNativeBatch) {
        // Use native batch API (iOS) - much faster!
        const assetIds = response.assets.map((a) => a.id);
        photosToInsert = await processWithNativeBatch(assetIds, (count) => {
          progress.photosWithLocation += count;
        });
      } else {
        // Fallback to pMap-based processing (Android)
        photosToInsert = await processWithPMap(response.assets, concurrency, (count) => {
          progress.photosWithLocation += count;
        });
      }

      // Bulk insert into database
      if (photosToInsert.length > 0) {
        await insertPhotos(photosToInsert);
        progress.newPhotosAdded += photosToInsert.length;
      }
    }

    progress.processedAssets += response.assets.length;
    hasNextPage = response.hasNextPage;
    endCursor = response.endCursor;

    // Calculate speed and ETA based on total elapsed time (including fetching batches)
    progress.elapsedMs = Date.now() - startTime;

    const elapsedSeconds = progress.elapsedMs / 1000;

    // Only calculate rate after we have enough data (at least 2 seconds of processing)
    // to avoid wildly inaccurate early estimates from fast first batches
    const MIN_SECONDS_FOR_ESTIMATE = 2;
    const remainingPhotos = totalAssets - progress.newPhotosAdded;

    if (elapsedSeconds >= MIN_SECONDS_FOR_ESTIMATE && progress.newPhotosAdded > 0) {
      progress.newPhotosPerSecond = Math.round(progress.newPhotosAdded / elapsedSeconds);

      // ETA: calculate based on remaining photos
      if (remainingPhotos > 0) {
        progress.etaMs = (remainingPhotos / progress.newPhotosPerSecond) * 1000;
      } else {
        progress.etaMs = 0;
      }
    } else if (remainingPhotos <= 0) {
      // Already done
      progress.newPhotosPerSecond = elapsedSeconds > 0 ? Math.round(progress.newPhotosAdded / elapsedSeconds) : 0;
      progress.etaMs = 0;
    } else {
      // Not enough data yet - show "calculating..."
      progress.newPhotosPerSecond = 0;
      progress.etaMs = null;
    }

    // Report progress after each batch
    onProgress?.(progress);
  }

  progress.isComplete = true;
  progress.elapsedMs = Date.now() - startTime;
  progress.etaMs = 0;
  onProgress?.(progress);

  return progress;
}

/**
 * Get a quick estimate of photos in camera roll
 */
export async function getPhotoCount(): Promise<number> {
  const response = await MediaLibrary.getAssetsAsync({
    first: 1,
    mediaType: MediaLibrary.MediaType.photo,
  });
  return response.totalCount;
}
