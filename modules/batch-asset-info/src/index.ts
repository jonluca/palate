import { requireNativeModule } from "expo";
import { Platform } from "react-native";
import { resolveVisionNativePageSize } from "../../../utils/food-detection-buffer-core";
import {
  resolveVisionPageOrchestrationStrategy,
  type VisionPageOrchestrationStrategy,
} from "../../../utils/vision-page-orchestration-core";
import {
  classifyWithVisionResultTransport,
  resolveVisionResultTransport,
  type PackedVisionClassificationPayload,
  type VisionClassificationLabel,
  type VisionClassificationResult,
  type VisionResultTransport,
} from "../../../utils/vision-classification-transport-core";
import { resolveVisitFoodDetectionStrategy, type VisitFoodDetectionStrategy } from "./visit-food-detection-strategy";
import {
  DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  preparePhotoAssetThumbnailPreheatBridgeRequest,
  resolvePhotoAssetThumbnailPreheatStrategy,
  WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  type PhotoAssetThumbnailPixelTarget,
  type PhotoAssetThumbnailPreheatStrategy,
} from "../../../utils/photo-asset-thumbnail-preheat-core";

export type { VisionPageOrchestrationStrategy } from "../../../utils/vision-page-orchestration-core";
export {
  DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
  type PhotoAssetThumbnailPixelTarget,
  type PhotoAssetThumbnailPreheatStrategy,
} from "../../../utils/photo-asset-thumbnail-preheat-core";
export {
  allowsAutomaticDeepScanFollowup,
  DEFAULT_VISIT_FOOD_DETECTION_STRATEGY,
  FULL_PLAN_VISIT_FOOD_DETECTION_STRATEGY,
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
  resolveVisitFoodDetectionStrategy,
  type VisitFoodDetectionStrategy,
} from "./visit-food-detection-strategy";

interface AssetLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  heading?: number;
}

export interface BatchAssetInfo {
  id: string;
  uri: string;
  creationTime: number;
  modificationTime: number;
  width: number;
  height: number;
  mediaType: "photo" | "video" | "audio" | "unknown";
  duration: number;
  location: AssetLocation | null;
}

/** Describes a retained asset scan created by {@link beginAssetScan}. */
export interface AssetScanSession {
  /** Opaque identifier used by {@link getAssetScanPage} and {@link endAssetScan}. */
  readonly sessionId: string;
  /** Number of assets in this session's pageable domain. */
  readonly totalCount: number;
  /** Largest page size accepted by {@link getAssetScanPage}. */
  readonly maxPageSize: number;
}

/** Retained scan whose pageable domain contains only assets absent from SQLite. */
export interface IncrementalAssetScanSession extends AssetScanSession {
  /** Number of visible image and video assets in the complete stable PhotoKit snapshot. */
  readonly libraryTotalCount: number;
  /** Existing database assets found in the visible PhotoKit snapshot. */
  readonly excludedVisibleCount: number;
  /** Excluded visible assets with a usable creation time and valid location. */
  readonly excludedPhotosWithLocation: number;
  /** Excluded visible assets whose creation time is missing or nonfinite. */
  readonly excludedSkippedAssets: number;
}

export type PhotoScanStrategy = "legacy" | "incremental";

/** Options for reading a page from an {@link AssetScanSession}. */
export interface AssetScanPageOptions {
  /** Zero-based index in the retained snapshot. */
  readonly offset: number;
  /** Number of assets to return; must not exceed the session's `maxPageSize`. */
  readonly limit: number;
}

/** Minimal photo-library metadata returned by {@link getAssetScanPage}. */
export interface AssetScanRecord {
  /** Stable local photo-library identifier. */
  readonly id: string;
  /** URI suitable for rendering the local photo-library asset. */
  readonly uri: string;
  /** Creation time in Unix milliseconds, or `null` when unavailable. */
  readonly creationTime: number | null;
  /** Valid latitude, including zero, or `null` when no valid location exists. */
  readonly latitude: number | null;
  /** Valid longitude, including zero, or `null` when no valid location exists. */
  readonly longitude: number | null;
  /** Media kind included in the scan. */
  readonly mediaType: "photo" | "video";
  /** Video duration in seconds, or `null` for photos. */
  readonly duration: number | null;
}

/** A stable, retryable page returned by {@link getAssetScanPage}. */
export interface AssetScanPage {
  /** Assets beginning at the requested offset. */
  readonly assets: AssetScanRecord[];
  /** Zero-based offset used to produce this page. */
  readonly offset: number;
  /** Offset for the next page, or `null` when this is the final page. */
  readonly nextOffset: number | null;
  /** Number of assets in this session's pageable domain. */
  readonly totalCount: number;
  /** Whether another page exists after this one. */
  readonly hasNextPage: boolean;
}

interface ClassificationOptions {
  /**
   * Minimum confidence threshold for classification (0-1).
   * Default is 0.1
   */
  confidenceThreshold?: number;
  /**
   * Maximum number of labels to return per image.
   * Default is 50
   */
  maxLabels?: number;
}

export interface FoodDetectionOptions extends ClassificationOptions {
  /**
   * Minimum confidence threshold specifically for food detection (0-1).
   * Default is 0.3
   */
  foodConfidenceThreshold?: number;
  /**
   * Custom list of food-related keywords to use for detection.
   * If not provided, uses the default FOOD_IDENTIFIERS set.
   */
  foodKeywords?: string[];
}

type ClassificationLabel = VisionClassificationLabel;
type ClassificationResult = VisionClassificationResult;

export type { VisionResultTransport } from "../../../utils/vision-classification-transport-core";

interface NativeBatchAssetInfoModule {
  readonly supportsPhotoAssetThumbnailView?: boolean;
  readonly supportsPhotoAssetThumbnailPreheat?: boolean;
  readonly resolvedPhotoAssetThumbnailPreheatStrategy?: string;
  readonly visionResultPageSize?: number;
  readonly resolvedVisionPageOrchestrationStrategy?: string;
  readonly resolvedVisionResultTransport?: string;
  readonly resolvedPhotoScanStrategy?: string;
  readonly resolvedVisitFoodDetectionStrategy?: string;
  isVisionVisitFoodValidationModeEnabled?(): boolean;
  getAssetInfoBatch(assetIds: string[]): Promise<BatchAssetInfo[]>;
  classifyImageBatch(assetIds: string[], options: Required<ClassificationOptions>): Promise<ClassificationResult[]>;
  classifyImageBatchPackedV1?(
    assetIds: string[],
    options: Required<ClassificationOptions>,
  ): Promise<PackedVisionClassificationPayload>;
  beginAssetScan(): Promise<AssetScanSession>;
  beginIncrementalAssetScan?(existingAssetIds: string[]): Promise<IncrementalAssetScanSession>;
  beginDatabaseBackedIncrementalAssetScan?(databasePath: string): Promise<IncrementalAssetScanSession>;
  getAssetScanPage(sessionId: string, offset: number, limit: number): Promise<AssetScanPage>;
  endAssetScan(sessionId: string): Promise<void>;
  clearPhotoAssetThumbnailCache?(): Promise<void>;
  updatePhotoAssetThumbnailPreheat?(scopeID: string, uris: string[], pixelWidth: number, pixelHeight: number): boolean;
  endPhotoAssetThumbnailPreheat?(scopeID: string): boolean;
}

export interface FoodDetectionResult {
  assetId: string;
  containsFood: boolean;
  /** Highest confidence score among food-related labels */
  foodConfidence: number;
  /** Food-related labels found in the image */
  foodLabels: ClassificationLabel[];
  /** All classification labels */
  labels: ClassificationLabel[];
  error?: string;
}

// Default food-related classification identifiers (used if no custom keywords provided)
const DEFAULT_FOOD_IDENTIFIERS = new Set([
  "food",
  "drink",
  "dish",
  "meal",
  "cuisine",
  "snack",
  "breakfast",
  "lunch",
  "dinner",
  "brunch",
  "appetizer",
  "dessert",
  "salad",
  "soup",
  "sandwich",
  "pizza",
  "pasta",
  "sushi",
  "burger",
  "steak",
  "chicken",
  "fish",
  "seafood",
  "meat",
  "vegetable",
  "fruit",
  "bread",
  "cake",
  "pie",
  "cookie",
  "ice_cream",
  "spoon",
  "cup",
  "chocolate",
  "candy",
  "beverage",
  "coffee",
  "tea",
  "wine",
  "beer",
  "cocktail",
  "juice",
  "smoothie",
  "menu",
  "plate",
  "bowl",
  "restaurant",
  "cafe",
  "dining",
  "table_setting",
  "cutlery",
]);

/**
 * Check if a label is food-related against a set of keywords
 */
function isFoodLabel(label: string, foodKeywords: Set<string>): boolean {
  const lowerLabel = label.trim().toLowerCase();
  return foodKeywords.has(lowerLabel);
}

/**
 * Process classification results to detect food
 */
function processForFoodDetection(
  result: ClassificationResult,
  foodConfidenceThreshold: number,
  foodKeywords: Set<string>,
): FoodDetectionResult {
  const foodLabels = result.labels.filter(
    (l) => isFoodLabel(l.label, foodKeywords) && l.confidence >= foodConfidenceThreshold,
  );

  const maxFoodConfidence = foodLabels.length > 0 ? Math.max(...foodLabels.map((l) => l.confidence)) : 0;

  return {
    assetId: result.assetId,
    containsFood: foodLabels.length > 0,
    foodConfidence: maxFoodConfidence,
    foodLabels,
    labels: result.labels,
    error: result.error,
  };
}

// Only available on iOS
const BatchAssetInfoModule =
  Platform.OS === "ios" ? requireNativeModule<NativeBatchAssetInfoModule>("BatchAssetInfo") : null;

function requireBatchAssetInfoModule(): NativeBatchAssetInfoModule {
  if (!BatchAssetInfoModule) {
    throw new Error("BatchAssetInfo module is only available on iOS");
  }
  return BatchAssetInfoModule;
}

function assertSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0) {
    throw new TypeError("Asset scan session ID must be a non-empty string");
  }
}

function assertPageOptions(options: AssetScanPageOptions): void {
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw new RangeError("Asset scan offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new RangeError("Asset scan limit must be a positive safe integer");
  }
}

/**
 * Check if batch asset info is available (iOS only)
 */
export function isBatchAssetInfoAvailable(): boolean {
  return BatchAssetInfoModule !== null;
}

/**
 * Returns the bounded result page size advertised by this native binary.
 * Older binaries omit the constant and use the JavaScript default.
 */
export function getVisionResultPageSize(): number {
  return resolveVisionNativePageSize(BatchAssetInfoModule?.visionResultPageSize);
}

/** Returns the native-selected Vision page orchestration strategy. */
export function getResolvedVisionPageOrchestrationStrategy(): VisionPageOrchestrationStrategy {
  return resolveVisionPageOrchestrationStrategy(BatchAssetInfoModule?.resolvedVisionPageOrchestrationStrategy);
}

/** Returns the selected result transport, falling back for older native binaries. */
export function getResolvedVisionResultTransport(): VisionResultTransport {
  return resolveVisionResultTransport(
    typeof BatchAssetInfoModule?.classifyImageBatchPackedV1 === "function",
    BatchAssetInfoModule?.resolvedVisionResultTransport,
  );
}

/** Returns the native-selected visit food-detection strategy, defaulting for older binaries. */
export function getResolvedVisitFoodDetectionStrategy(): VisitFoodDetectionStrategy {
  return resolveVisitFoodDetectionStrategy(BatchAssetInfoModule?.resolvedVisitFoodDetectionStrategy);
}

/**
 * Whether the guarded macOS validator requested its isolated visit-food entry
 * point. Older binaries do not expose the native proof and safely return false.
 */
export function isVisionVisitFoodValidationModeEnabled(): boolean {
  return BatchAssetInfoModule?.isVisionVisitFoodValidationModeEnabled?.() === true;
}

/**
 * Whether this native binary includes the retained PhotoKit scan-session API.
 * This separate capability check keeps OTA updates compatible with older app binaries.
 */
export function isAssetScanAvailable(): boolean {
  return (
    typeof BatchAssetInfoModule?.beginAssetScan === "function" &&
    typeof BatchAssetInfoModule.getAssetScanPage === "function" &&
    typeof BatchAssetInfoModule.endAssetScan === "function"
  );
}

/** Returns the native process's resolved PhotoKit scan strategy. */
export function getResolvedPhotoScanStrategy(): PhotoScanStrategy {
  return BatchAssetInfoModule?.resolvedPhotoScanStrategy === "legacy" ? "legacy" : "incremental";
}

/** Whether the installed binary exposes and enables native incremental PhotoKit scans. */
export function isIncrementalAssetScanAvailable(): boolean {
  return (
    isAssetScanAvailable() &&
    getResolvedPhotoScanStrategy() === "incremental" &&
    typeof BatchAssetInfoModule?.beginIncrementalAssetScan === "function"
  );
}

/** Whether this binary can read the existing-photo index directly from SQLite. */
export function isDatabaseBackedIncrementalAssetScanAvailable(): boolean {
  return (
    isAssetScanAvailable() &&
    getResolvedPhotoScanStrategy() === "incremental" &&
    typeof BatchAssetInfoModule?.beginDatabaseBackedIncrementalAssetScan === "function"
  );
}

/** Whether this native binary includes the native PhotoKit thumbnail view. */
export function isPhotoAssetThumbnailAvailable(): boolean {
  return BatchAssetInfoModule?.supportsPhotoAssetThumbnailView === true;
}

/** Returns the guarded native preheat strategy, disabled for older or incompatible binaries. */
export function getResolvedPhotoAssetThumbnailPreheatStrategy(): PhotoAssetThumbnailPreheatStrategy {
  return resolvePhotoAssetThumbnailPreheatStrategy({
    nativeValue: BatchAssetInfoModule?.resolvedPhotoAssetThumbnailPreheatStrategy,
    nativeMethodAvailable:
      BatchAssetInfoModule?.supportsPhotoAssetThumbnailPreheat === true &&
      typeof BatchAssetInfoModule.updatePhotoAssetThumbnailPreheat === "function",
  });
}

/** Whether the installed binary exposes the explicitly enabled windowed preheat path. */
export function isPhotoAssetThumbnailPreheatAvailable(): boolean {
  return getResolvedPhotoAssetThumbnailPreheatStrategy() === WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY;
}

/** Enqueues one bounded preheat window without waiting for PhotoKit I/O. */
export function updatePhotoAssetThumbnailPreheat(
  scopeID: string,
  uris: readonly string[],
  target: PhotoAssetThumbnailPixelTarget,
): boolean {
  const request = preparePhotoAssetThumbnailPreheatBridgeRequest(scopeID, uris, target);
  if (
    !request ||
    getResolvedPhotoAssetThumbnailPreheatStrategy() === DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY ||
    typeof BatchAssetInfoModule?.updatePhotoAssetThumbnailPreheat !== "function"
  ) {
    return false;
  }
  return BatchAssetInfoModule.updatePhotoAssetThumbnailPreheat(
    request.scopeID,
    [...request.uris],
    request.target.pixelWidth,
    request.target.pixelHeight,
  );
}

/** Ends only this mount's native preheat lease; repeated or stale scope cleanup is harmless. */
export function endPhotoAssetThumbnailPreheat(scopeID: string): boolean {
  if (scopeID.length === 0 || typeof BatchAssetInfoModule?.endPhotoAssetThumbnailPreheat !== "function") {
    return false;
  }
  return BatchAssetInfoModule.endPhotoAssetThumbnailPreheat(scopeID);
}

/** Clears the bounded native PhotoKit thumbnail and PHAsset caches when available. */
export async function clearPhotoAssetThumbnailCache(): Promise<boolean> {
  if (typeof BatchAssetInfoModule?.clearPhotoAssetThumbnailCache !== "function") {
    return false;
  }
  await BatchAssetInfoModule.clearPhotoAssetThumbnailCache();
  return true;
}

/**
 * Creates a stable snapshot of image and video assets for offset-based paging.
 * Call {@link endAssetScan} in a `finally` block after consuming the snapshot.
 *
 * @throws When photo-library access is unavailable.
 * @platform ios
 */
export async function beginAssetScan(): Promise<AssetScanSession> {
  return requireBatchAssetInfoModule().beginAssetScan();
}

/**
 * Creates a retained PhotoKit snapshot paged over assets absent from `existingAssetIds`.
 * The installed native strategy must be incremental; callers should feature-detect first.
 *
 * @throws When incremental scanning is unavailable, disabled, or Photos access is unavailable.
 * @platform ios
 */
export async function beginIncrementalAssetScan(existingAssetIds: string[]): Promise<IncrementalAssetScanSession> {
  const nativeModule = requireBatchAssetInfoModule();
  if (!isIncrementalAssetScanAvailable() || typeof nativeModule.beginIncrementalAssetScan !== "function") {
    throw new Error("Incremental asset scanning is unavailable in this native binary");
  }
  return nativeModule.beginIncrementalAssetScan(existingAssetIds);
}

/**
 * Creates an incremental PhotoKit snapshot using the existing-photo index read
 * directly from SQLite by native code, avoiding a full identifier bridge payload.
 */
export async function beginDatabaseBackedIncrementalAssetScan(
  databasePath: string,
): Promise<IncrementalAssetScanSession> {
  if (typeof databasePath !== "string" || databasePath.trim().length === 0) {
    throw new TypeError("Incremental photo scan database path must be a non-empty string");
  }
  const nativeModule = requireBatchAssetInfoModule();
  if (
    !isDatabaseBackedIncrementalAssetScanAvailable() ||
    typeof nativeModule.beginDatabaseBackedIncrementalAssetScan !== "function"
  ) {
    throw new Error("Database-backed incremental asset scanning is unavailable in this native binary");
  }
  return nativeModule.beginDatabaseBackedIncrementalAssetScan(databasePath);
}

/**
 * Reads an idempotent page from a retained scan snapshot.
 * Retrying the same session ID and offset returns the same slice while the session remains active.
 *
 * @throws When the session has ended or the requested bounds are invalid.
 * @platform ios
 */
export async function getAssetScanPage(sessionId: string, options: AssetScanPageOptions): Promise<AssetScanPage> {
  assertSessionId(sessionId);
  assertPageOptions(options);
  return requireBatchAssetInfoModule().getAssetScanPage(sessionId, options.offset, options.limit);
}

/**
 * Releases a retained scan snapshot. Calling this with an unknown or already-ended session rejects.
 *
 * @throws When the session does not exist or has already ended.
 * @platform ios
 */
export async function endAssetScan(sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  await requireBatchAssetInfoModule().endAssetScan(sessionId);
}

/**
 * Get asset info for multiple assets in a single native call.
 * This is significantly faster than calling getAssetInfoAsync individually.
 *
 * @param assetIds Array of asset local identifiers
 * @returns Array of asset info objects
 */
export async function getAssetInfoBatch(assetIds: string[]): Promise<BatchAssetInfo[]> {
  if (!BatchAssetInfoModule) {
    throw new Error("BatchAssetInfo module is only available on iOS");
  }

  if (assetIds.length === 0) {
    return [];
  }

  return BatchAssetInfoModule.getAssetInfoBatch(assetIds);
}

/**
 * Classify multiple images in a batch using Apple Vision.
 * Returns all classification labels above the confidence threshold.
 *
 * @param assetIds Array of asset local identifiers
 * @param options Optional classification options
 * @returns Array of classification results
 */
async function classifyImageBatch(
  assetIds: string[],
  options: ClassificationOptions = {},
): Promise<ClassificationResult[]> {
  if (!BatchAssetInfoModule) {
    throw new Error("BatchAssetInfo module is only available on iOS");
  }

  if (assetIds.length === 0) {
    return [];
  }

  const opts = {
    confidenceThreshold: options.confidenceThreshold ?? 0.1,
    maxLabels: options.maxLabels ?? 50,
  };

  return classifyWithVisionResultTransport(assetIds, {
    resolvedTransport: BatchAssetInfoModule.resolvedVisionResultTransport,
    classifyLegacy: () => BatchAssetInfoModule.classifyImageBatch(assetIds, opts),
    classifyPackedV1:
      typeof BatchAssetInfoModule.classifyImageBatchPackedV1 === "function"
        ? () => BatchAssetInfoModule.classifyImageBatchPackedV1!(assetIds, opts)
        : undefined,
  });
}

/**
 * Detect food in multiple images in a batch.
 * Uses image classification and filters for food-related labels.
 *
 * @param assetIds Array of asset local identifiers
 * @param options Optional detection options (including custom food keywords)
 * @returns Array of food detection results
 */
export async function detectFoodInImageBatch(
  assetIds: string[],
  options: FoodDetectionOptions = {},
): Promise<FoodDetectionResult[]> {
  if (!BatchAssetInfoModule) {
    throw new Error("BatchAssetInfo module is only available on iOS");
  }

  if (assetIds.length === 0) {
    return [];
  }

  // Use lower threshold for classification to capture all potential labels
  // Food filtering uses its own threshold
  const classificationResults = await classifyImageBatch(assetIds, {
    confidenceThreshold: options.confidenceThreshold ?? 0.1,
    maxLabels: options.maxLabels ?? 50,
  });

  const foodConfidenceThreshold = options.foodConfidenceThreshold ?? 0.3;

  // Use custom keywords if provided, otherwise use defaults
  const foodKeywords = options.foodKeywords
    ? new Set(options.foodKeywords.map((k) => k.trim().toLowerCase()))
    : DEFAULT_FOOD_IDENTIFIERS;

  return classificationResults.map((result) => processForFoodDetection(result, foodConfidenceThreshold, foodKeywords));
}
