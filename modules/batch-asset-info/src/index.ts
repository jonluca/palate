import { requireNativeModule } from "expo";
import { Platform } from "react-native";
import { resolveVisionNativePageSize } from "../../../utils/food-detection-buffer-core";

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
  /** Number of image and video assets in the stable scan snapshot. */
  readonly totalCount: number;
  /** Largest page size accepted by {@link getAssetScanPage}. */
  readonly maxPageSize: number;
}

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
  /** Number of assets in the retained snapshot. */
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

interface ClassificationLabel {
  label: string;
  confidence: number;
}

interface ClassificationResult {
  assetId: string;
  labels: ClassificationLabel[];
  error?: string;
}

interface NativeBatchAssetInfoModule {
  readonly supportsPhotoAssetThumbnailView?: boolean;
  readonly visionResultPageSize?: number;
  getAssetInfoBatch(assetIds: string[]): Promise<BatchAssetInfo[]>;
  classifyImageBatch(assetIds: string[], options: Required<ClassificationOptions>): Promise<ClassificationResult[]>;
  beginAssetScan(): Promise<AssetScanSession>;
  getAssetScanPage(sessionId: string, offset: number, limit: number): Promise<AssetScanPage>;
  endAssetScan(sessionId: string): Promise<void>;
  clearPhotoAssetThumbnailCache?(): Promise<void>;
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

/** Whether this native binary includes the native PhotoKit thumbnail view. */
export function isPhotoAssetThumbnailAvailable(): boolean {
  return BatchAssetInfoModule?.supportsPhotoAssetThumbnailView === true;
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

  return BatchAssetInfoModule.classifyImageBatch(assetIds, opts);
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
