import { requireNativeModule, Platform } from "expo-modules-core";

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

// Food-related classification identifiers
const FOOD_IDENTIFIERS = new Set([
  "food",
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
 * Check if a label is food-related
 */
function isFoodLabel(label: string): boolean {
  const lowerLabel = label.trim().toLowerCase();
  for (const foodId of FOOD_IDENTIFIERS) {
    if (lowerLabel === foodId) {
      return true;
    }
  }
  return false;
}

/**
 * Process classification results to detect food
 */
function processForFoodDetection(result: ClassificationResult, foodConfidenceThreshold: number): FoodDetectionResult {
  const foodLabels = result.labels.filter((l) => isFoodLabel(l.label) && l.confidence >= foodConfidenceThreshold);

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
const BatchAssetInfoModule = Platform.OS === "ios" ? requireNativeModule("BatchAssetInfo") : null;

/**
 * Check if batch asset info is available (iOS only)
 */
export function isBatchAssetInfoAvailable(): boolean {
  return BatchAssetInfoModule !== null;
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
 * @param options Optional detection options
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

  return classificationResults.map((result) => processForFoodDetection(result, foodConfidenceThreshold));
}
