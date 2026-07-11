import {
  getUnvisitedPhotos,
  getVisitablePhotoCounts,
  insertVisits,
  batchUpdatePhotoVisits,
  batchUpdateVisitPhotoCounts,
  syncAllVisitsFoodProbable,
  batchUpdatePhotosFoodDetected,
  batchUpdateVisitsCalendarEvents,
  getCalendarEnrichmentVisitSnapshot,
  getMichelinRestaurantsForCalendarNormalizedNames,
  insertMichelinRestaurants,
  importMichelinRestaurantsFromAttachedSource,
  getMichelinRestaurantCount,
  getMichelinImportResolution,
  getFoodDetectionVisitSamplePlan,
  insertVisitSuggestedRestaurants,
  getUnanalyzedPhotoIds,
  batchUpdateVisitSuggestedRestaurants,
  recomputeSuggestedRestaurantsIfNeeded,
  getLinkedCalendarEventIds,
  getDismissedCalendarEventIds,
  importCalendarSnapshotPlan,
  performDatabaseMaintenance,
  getConfirmedVisitsWithMichelinIds,
  getEnabledFoodKeywords,
  getDatabase,
  getImportedMichelinDatasetVersion,
  type UnvisitedPhotoRecord,
  type VisitRecord,
  type VisitSuggestedRestaurant,
  type FoodLabel,
  type MichelinRestaurantRecord,
  type CalendarEventUpdate,
} from "@/utils/db";
import {
  MICHELIN_IMPORT_ATTACH_STRATEGY,
  MichelinImportTerminalError,
  NO_VALID_MICHELIN_ROWS_MESSAGE,
} from "@/utils/db/michelin-import-core";
import {
  ensureRestaurantLocationIndex,
  MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
  MICHELIN_SUGGESTION_LIMIT,
  MICHELIN_SUGGESTION_RADIUS_METERS,
} from "@/utils/db/michelin-index";
import {
  hasCalendarPermission,
  requestCalendarPermission,
  batchFindCandidateEventsForVisits,
  isNativeCalendarMatchingAvailable,
  matchCalendarEventsForVisitsNatively,
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
  getReservationEvents,
  normalizeForComparison,
  type CalendarEventInfo,
  stripComparisonAffixes,
} from "./calendar";
import { getMichelinDatasetVersion, loadMichelinRestaurants, prepareMichelinImportSource } from "./michelin";
import { searchNearbyRestaurants, isGoogleMapsConfigured, type PlaceResult } from "./places";
import {
  RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY,
  detectFoodInImageBatch,
  getResolvedVisitFoodDetectionStrategy,
  getResolvedVisionPageOrchestrationStrategy,
  getVisionResultPageSize,
  isBatchAssetInfoAvailable,
  isVisionVisitFoodValidationModeEnabled,
  type FoodDetectionResult,
} from "@/modules/batch-asset-info";
import { scanCameraRoll, formatEta } from "./scanner";
import { DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE } from "@/utils/food-detection-buffer-core";
import { runBufferedResultPersistence } from "@/utils/food-detection-persistence-core";
import { createVisionResultPagePlan } from "@/utils/vision-result-page-plan";
import { runOrderedPagePipeline } from "@/utils/ordered-page-pipeline-core";
import {
  runRank3BulkTailVisitFoodDetection,
  type VisitFoodDetectionBatchProgress,
} from "@/utils/visit-food-detection-orchestration-core";
import type { AdaptiveVisitFoodOutcome, AdaptiveVisitFoodSample } from "@/utils/visit-food-adaptive-scan-core";
import { hasVisitPhotosForSpatialWork } from "@/utils/visit-photo-spatial-work";
import { calculateVisitPhotoCentroid } from "@/utils/visit-photo-centroid-core";
import {
  areVisitPhotosNearbyWithPreparedThreshold,
  prepareVisitPhotoDistanceThreshold,
} from "@/utils/visit-photo-proximity-core";
import {
  getCalendarGuideMatchesForEvent,
  loadCalendarGuideMatchingContext,
  type CalendarGuideNameTools,
} from "@/utils/calendar-guide-matching-core";
import { planCalendarImportFromSnapshots } from "@/utils/calendar-import-plan-core";
import type { CalendarImportTransactionResult } from "@/utils/db/calendar-import-transaction-core";

// ============================================================================
// PARALLEL PROCESSING UTILITIES
// ============================================================================

/** Yield to the event loop to prevent UI blocking */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Process items in chunks with event loop yielding */
async function processInChunks<T, R>(items: T[], processor: (item: T, idx: number) => R, chunkSize = 50): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    results.push(...items.slice(i, i + chunkSize).map((item, idx) => processor(item, i + idx)));
    if (i + chunkSize < items.length) {
      await yieldToEventLoop();
    }
  }
  return results;
}

// ============================================================================
// PROGRESS TRACKING UTILITIES
// ============================================================================

interface ProgressTracker {
  startTime: number;
  update(processed: number, total: number): { elapsedMs: number; perSecond: number; etaMs: number | null };
}

function createProgressTracker(): ProgressTracker {
  const startTime = Date.now();
  return {
    startTime,
    update(processed: number, total: number) {
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = elapsedMs / 1000;
      const perSecond = elapsedSec > 0 ? processed / elapsedSec : 0;
      const remaining = total - processed;
      const etaMs = perSecond > 0 && remaining > 0 ? (remaining / perSecond) * 1000 : remaining <= 0 ? 0 : null;
      return { elapsedMs, perSecond, etaMs };
    },
  };
}

// ============================================================================
// PROGRESS TYPES
// ============================================================================

interface AnalyzingVisitsProgress {
  totalPhotos: number;
  visitedPhotos: number;
  visitsCreated: number;
  isComplete: boolean;
  previouslyVisitedPhotos: number;
  isResuming: boolean;
  elapsedMs: number;
  visitsPerSecond: number;
  etaMs: number | null;
  phase: "grouping" | "saving-visits" | "complete";
}

interface FoodDetectionProgress {
  totalVisits: number;
  processedVisits: number;
  totalSamples: number;
  processedSamples: number;
  retryableFailures: number;
  foodPhotosFound: number;
  foodVisitsFound: number;
  isComplete: boolean;
  elapsedMs: number;
  samplesPerSecond: number;
  etaMs: number | null;
}

interface AnalyzingVisitsOptions {
  timeGapThreshold?: number;
  distanceThreshold?: number;
  restaurantMatchThreshold?: number;
  restaurantSearchRadius?: number;
  onProgress?: (progress: AnalyzingVisitsProgress) => void;
}

const DEFAULT_TIME_GAP_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_DISTANCE_THRESHOLD = 100;
let michelinInitializationPromise: Promise<{ loaded: number; skipped: boolean }> | null = null;
let michelinInitializationTerminalError: MichelinImportTerminalError | null = null;
const michelinInitializationProgressListeners = new Set<(message: string) => void>();

async function initializeMichelinDataInternal(
  onProgress: (message: string) => void,
): Promise<{ loaded: number; skipped: boolean }> {
  const bundledDatasetVersion = getMichelinDatasetVersion();
  const [existingCount, importedDatasetVersion] = await Promise.all([
    getMichelinRestaurantCount(bundledDatasetVersion),
    getImportedMichelinDatasetVersion(),
  ]);

  if (existingCount > 100 && importedDatasetVersion === bundledDatasetVersion) {
    return { loaded: 0, skipped: true };
  }

  onProgress(
    existingCount > 100
      ? "Refreshing Michelin restaurant data with latest award years..."
      : "Loading Michelin restaurant data...",
  );

  const resolution = await getMichelinImportResolution();
  if (resolution.resolvedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY) {
    onProgress("Importing Michelin guide directly in SQLite...");
    let source;
    try {
      source = await prepareMichelinImportSource();
      if (source.datasetVersion !== bundledDatasetVersion) {
        throw new Error("Prepared Michelin guide version did not match the bundled asset");
      }
    } catch (error) {
      throw new MichelinImportTerminalError("Set-based Michelin source preparation failed", error);
    }
    const result = await importMichelinRestaurantsFromAttachedSource(source, resolution);
    console.log(`Initialized ${result.importedRows} Michelin restaurants with ${result.strategy}`);
    return { loaded: result.importedRows, skipped: false };
  }

  let sourceRows = 0;
  const michelinData = await loadMichelinRestaurants((loaded, total) => {
    sourceRows = total;
    onProgress(`Parsing restaurants: ${loaded.toLocaleString()} / ${total.toLocaleString()}`);
  });

  if (michelinData.length === 0) {
    throw new Error(NO_VALID_MICHELIN_ROWS_MESSAGE);
  }

  onProgress(
    `${existingCount > 100 ? "Refreshing" : "Saving"} ${michelinData.length.toLocaleString()} Michelin restaurants to database...`,
  );

  const result = await insertMichelinRestaurants(michelinData, bundledDatasetVersion, resolution, sourceRows);

  console.log(`Initialized ${result.importedRows} Michelin restaurants with ${result.strategy}`);
  return { loaded: result.importedRows, skipped: false };
}

/**
 * Initialize Michelin restaurant reference data in the database
 * This is separate from user's confirmed restaurants
 */
export async function initializeMichelinData(
  onProgress?: (message: string) => void,
): Promise<{ loaded: number; skipped: boolean }> {
  if (michelinInitializationTerminalError) {
    throw michelinInitializationTerminalError;
  }
  if (onProgress) {
    michelinInitializationProgressListeners.add(onProgress);
  }

  if (!michelinInitializationPromise) {
    const emitProgress = (message: string) => {
      for (const listener of michelinInitializationProgressListeners) {
        listener(message);
      }
    };
    const initialization = initializeMichelinDataInternal(emitProgress).catch((error: unknown) => {
      if (error instanceof MichelinImportTerminalError) {
        michelinInitializationTerminalError = error;
      }
      throw error;
    });
    const trackedInitialization = initialization.finally(() => {
      if (michelinInitializationPromise === trackedInitialization) {
        michelinInitializationPromise = null;
      }
    });
    michelinInitializationPromise = trackedInitialization;
  }

  try {
    return await michelinInitializationPromise!;
  } finally {
    if (onProgress) {
      michelinInitializationProgressListeners.delete(onProgress);
    }
  }
}

/**
 * Generate a deterministic hash for a visit based on time and location
 */
function generateVisitHash(startTime: number, endTime: number, centerLat: number, centerLon: number): string {
  // Round coordinates to ~100m precision for deterministic hashing
  const latRounded = Math.round(centerLat * 1000) / 1000;
  const lonRounded = Math.round(centerLon * 1000) / 1000;
  // Round time to nearest hour
  const timeRounded = Math.floor(startTime / (60 * 60 * 1000));

  const input = `${timeRounded}-${latRounded}-${lonRounded}`;

  return input;
}

// Visit group structure for batch processing
interface VisitGroup {
  photos: UnvisitedPhotoRecord[];
  centroid: { lat: number; lon: number };
  startTime: number;
  endTime: number;
  hash: string;
  suggestedRestaurantId: string | null;
  suggestedRestaurants: Array<{ id: string; distance: number }>;
}

// Keep the native acquisition/Vision pipeline busy while bounding one bridge result page.
const FOOD_DETECTION_BATCH_SIZE = getVisionResultPageSize();

/**
 * Main analyzing-visits algorithm:
 * Groups photos by time proximity and location, then suggests Michelin restaurants.
 *
 * Algorithm:
 * 1. Sort photos by creation time
 * 2. Group consecutive photos that are:
 *    - Within time threshold of each other (default 2 hour gap breaks visit)
 *    - Within distance threshold of each other
 * 3. Calculate centroid for each visit
 * 4. Suggest nearest Michelin restaurant (if within threshold) - does NOT auto-confirm
 * 5. Generate deterministic hash and save to database
 *
 * OPTIMIZED IMPLEMENTATION using chunking and spatial indexing:
 * - Uses a shared spatial index for geodesic restaurant lookups instead of O(n) scans
 * - Processes visit groups in bounded chunks
 * - Keeps SQLite writes sequential to avoid statement finalization lock errors
 * - Yields to event loop to prevent UI blocking
 */
async function visitPhotos(options: AnalyzingVisitsOptions = {}): Promise<AnalyzingVisitsProgress> {
  const {
    timeGapThreshold = DEFAULT_TIME_GAP_MS,
    distanceThreshold = DEFAULT_DISTANCE_THRESHOLD,
    restaurantMatchThreshold = MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
    restaurantSearchRadius = MICHELIN_SUGGESTION_RADIUS_METERS,
    onProgress,
  } = options;

  const startTime = Date.now();

  await initializeMichelinData();
  await recomputeSuggestedRestaurantsIfNeeded(getMichelinDatasetVersion());
  const [photoCounts, photos] = await Promise.all([getVisitablePhotoCounts(), getUnvisitedPhotos()]);

  const previouslyVisitedPhotos = photoCounts.visited;
  const isResuming = previouslyVisitedPhotos > 0;

  const progress: AnalyzingVisitsProgress = {
    totalPhotos: photoCounts.total,
    visitedPhotos: previouslyVisitedPhotos,
    visitsCreated: 0,
    isComplete: false,
    previouslyVisitedPhotos,
    isResuming,
    elapsedMs: 0,
    visitsPerSecond: 0,
    etaMs: null,
    phase: "grouping",
  };

  if (!hasVisitPhotosForSpatialWork(photos.length)) {
    progress.isComplete = true;
    progress.phase = "complete";
    onProgress?.(progress);
    return progress;
  }

  const database = await getDatabase();
  const restaurantLocationIndex = await ensureRestaurantLocationIndex(database, __DEV__);

  // Phase 1: Group photos into visits with chunked processing
  // This is inherently sequential (comparing consecutive photos) but we yield periodically
  onProgress?.(progress);
  const photoGroups: UnvisitedPhotoRecord[][] = [];
  let currentGroup: UnvisitedPhotoRecord[] = [photos[0]];
  const preparedDistanceThreshold = prepareVisitPhotoDistanceThreshold(distanceThreshold);

  const GROUPING_CHUNK_SIZE = 1000; // Yield every 1000 photos

  for (let i = 1; i < photos.length; i++) {
    const prevPhoto = photos[i - 1];
    const currentPhoto = photos[i];

    const timeDiff = currentPhoto.creationTime - prevPhoto.creationTime;

    // OPTIMIZATION: Short-circuit evaluation - only compute distance if time check passes
    // This avoids expensive distance calculations for photos already separated by time
    if (
      timeDiff > timeGapThreshold ||
      preparedDistanceThreshold === null ||
      !areVisitPhotosNearbyWithPreparedThreshold(prevPhoto, currentPhoto, preparedDistanceThreshold)
    ) {
      photoGroups.push(currentGroup);
      currentGroup = [currentPhoto];
    } else {
      currentGroup.push(currentPhoto);
    }

    // Yield to event loop periodically to prevent UI blocking
    if (i % GROUPING_CHUNK_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  photoGroups.push(currentGroup);

  if (photoGroups.length === 0) {
    progress.isComplete = true;
    progress.phase = "complete";
    progress.elapsedMs = Date.now() - startTime;
    onProgress?.(progress);
    return progress;
  }

  // Phase 2: Process visits in batches with progress reporting
  progress.phase = "saving-visits";
  progress.elapsedMs = Date.now() - startTime;
  onProgress?.(progress);

  const totalGroups = photoGroups.length;
  const VISIT_BATCH_SIZE = 200; // Increased batch size for better throughput
  const GROUP_PROCESSING_CHUNK_SIZE = 50;

  for (let batchStart = 0; batchStart < totalGroups; batchStart += VISIT_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + VISIT_BATCH_SIZE, totalGroups);
    const batchPhotoGroups = photoGroups.slice(batchStart, batchEnd);

    // Process visit groups in chunks using the shared spatial index for fast lookups
    const batchVisitGroups = await processInChunks(
      batchPhotoGroups,
      (groupPhotos) => {
        const centroidCoordinate = calculateVisitPhotoCentroid(groupPhotos);
        if (!centroidCoordinate) {
          throw new Error("Cannot calculate a visit centroid from invalid photo coordinates.");
        }
        const centroid = { lat: centroidCoordinate.latitude, lon: centroidCoordinate.longitude };
        const visitStartTime = groupPhotos[0].creationTime;
        const visitEndTime = groupPhotos[groupPhotos.length - 1].creationTime;

        const nearbyRestaurants =
          restaurantLocationIndex?.findNearby({
            latitude: centroid.lat,
            longitude: centroid.lon,
            radiusMeters: Math.max(restaurantMatchThreshold, restaurantSearchRadius),
            limit: MICHELIN_SUGGESTION_LIMIT,
          }) ?? [];

        // Generate hash
        const hash = generateVisitHash(visitStartTime, visitEndTime, centroid.lat, centroid.lon);

        // The closest restaurant within the stricter threshold becomes the primary suggestion
        const primarySuggestion = nearbyRestaurants.find(
          ({ distanceMeters }) => distanceMeters <= restaurantMatchThreshold,
        );

        return {
          photos: groupPhotos,
          centroid,
          startTime: visitStartTime,
          endTime: visitEndTime,
          hash,
          suggestedRestaurantId: primarySuggestion?.restaurant.id ?? null,
          suggestedRestaurants: nearbyRestaurants.map(({ restaurant, distanceMeters }) => ({
            id: restaurant.id,
            distance: distanceMeters,
          })),
        } as VisitGroup;
      },
      GROUP_PROCESSING_CHUNK_SIZE,
    );

    // Prepare the batch's data structures
    const visitRecords: Omit<VisitRecord, "photoCount" | "foodProbable">[] = batchVisitGroups.map((group) => ({
      id: group.hash,
      restaurantId: null,
      suggestedRestaurantId: group.suggestedRestaurantId,
      status: "pending" as const,
      startTime: group.startTime,
      endTime: group.endTime,
      centerLat: group.centroid.lat,
      centerLon: group.centroid.lon,
      // Calendar event fields - will be populated in a separate pass
      calendarEventId: null,
      calendarEventTitle: null,
      calendarEventLocation: null,
      calendarEventIsAllDay: null,
      // Exported calendar event tracking
      exportedToCalendarId: null,
      // User notes - empty by default
      notes: null,
      updatedAt: null,
      // Historical award - set when visit is confirmed
      awardAtVisit: null,
    }));

    // Build suggested restaurants list (pre-allocate for better memory performance)
    const allSuggestedRestaurants: VisitSuggestedRestaurant[] = [];
    for (const group of batchVisitGroups) {
      for (const suggestion of group.suggestedRestaurants) {
        allSuggestedRestaurants.push({
          visitId: group.hash,
          restaurantId: suggestion.id,
          distance: suggestion.distance,
        });
      }
    }

    const photoVisitUpdates = batchVisitGroups.map((group) => ({
      photoIds: group.photos.map((p) => p.id),
      visitId: group.hash,
    }));

    // Run DB operations - insertVisits must complete first
    await insertVisits(visitRecords);

    if (allSuggestedRestaurants.length > 0) {
      await insertVisitSuggestedRestaurants(allSuggestedRestaurants);
    }
    await batchUpdatePhotoVisits(photoVisitUpdates);

    // Update progress after each batch
    progress.visitsCreated += batchVisitGroups.length;
    progress.visitedPhotos += batchPhotoGroups.reduce((sum, g) => sum + g.length, 0);
    progress.elapsedMs = Date.now() - startTime;
    const elapsedSec = progress.elapsedMs / 1000;
    progress.visitsPerSecond = elapsedSec > 0 ? progress.visitsCreated / elapsedSec : 0;
    const remaining = totalGroups - batchEnd;
    progress.etaMs = progress.visitsPerSecond > 0 && remaining > 0 ? (remaining / progress.visitsPerSecond) * 1000 : 0;
    onProgress?.(progress);
  }
  await batchUpdateVisitPhotoCounts();
  progress.isComplete = true;
  progress.phase = "complete";
  progress.etaMs = 0;
  onProgress?.(progress);

  return progress;
}

interface DetectFoodOptions {
  samplePercentage?: number;
  confidenceThreshold?: number;
  onProgress?: (progress: FoodDetectionProgress) => void;
}

/**
 * Detect food in visit photos using Apple Vision ML.
 * Samples photos from visits and runs batch food detection.
 */
async function detectFoodInVisits(options: DetectFoodOptions = {}): Promise<FoodDetectionProgress> {
  const { samplePercentage = 0.2, confidenceThreshold = 0.3, onProgress } = options;

  const progress: FoodDetectionProgress = {
    totalVisits: 0,
    processedVisits: 0,
    totalSamples: 0,
    processedSamples: 0,
    retryableFailures: 0,
    foodPhotosFound: 0,
    foodVisitsFound: 0,
    isComplete: false,
    elapsedMs: 0,
    samplesPerSecond: 0,
    etaMs: null,
  };

  if (!isBatchAssetInfoAvailable()) {
    progress.isComplete = true;
    await syncAllVisitsFoodProbable();
    onProgress?.(progress);
    return progress;
  }

  const samplePlan = await getFoodDetectionVisitSamplePlan(samplePercentage);
  progress.totalVisits = samplePlan.totalVisits;

  if (samplePlan.totalVisits === 0) {
    progress.isComplete = true;
    await syncAllVisitsFoodProbable();
    onProgress?.(progress);
    return progress;
  }

  const allSamples = samplePlan.samples;
  progress.totalSamples = allSamples.length;
  onProgress?.(progress);

  const tracker = createProgressTracker();

  if (getResolvedVisitFoodDetectionStrategy() === RANK3_BULK_TAIL_VISIT_FOOD_DETECTION_STRATEGY) {
    return processRank3BulkTailVisitFoodDetection(allSamples, confidenceThreshold, progress, tracker, onProgress);
  }

  const visitFoodResults = new Set<string>();
  const processedVisitIds = new Set<string>();
  const sampleVisitByPhotoId = new Map(allSamples.map((sample) => [sample.photoId, sample.visitId]));
  let accountedSampleCount = 0;

  await processFoodDetectionBatchesWithBufferedPersistence(
    allSamples.map((s) => ({ id: s.photoId, visitId: s.visitId })),
    confidenceThreshold,
    (processed, foodFound, retryableFailures) => {
      progress.processedSamples = processed;
      progress.retryableFailures = retryableFailures;
      progress.foodPhotosFound = foodFound;
      progress.foodVisitsFound = visitFoodResults.size;
      const stats = tracker.update(processed, allSamples.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.samplesPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      while (accountedSampleCount < processed) {
        processedVisitIds.add(allSamples[accountedSampleCount].visitId);
        accountedSampleCount += 1;
      }
      progress.processedVisits = processedVisitIds.size;
      onProgress?.({ ...progress });
    },
    undefined,
    async (batchResults) => {
      for (const result of batchResults) {
        const visitId = sampleVisitByPhotoId.get(result.photoId);
        if (result.foodDetected && visitId) {
          visitFoodResults.add(visitId);
        }
      }
    },
  );

  progress.processedVisits = progress.totalVisits;
  progress.foodVisitsFound = visitFoodResults.size;
  progress.isComplete = true;
  progress.etaMs = 0;
  onProgress?.({ ...progress });

  return progress;
}

interface CalendarEnrichmentProgress {
  totalVisits: number;
  processedVisits: number;
  visitsWithEvents: number;
  isComplete: boolean;
  elapsedMs: number;
  visitsPerSecond: number;
  etaMs: number | null;
}

interface CalendarEnrichmentOptions {
  onProgress?: (progress: CalendarEnrichmentProgress) => void;
}

// ============================================================================
// FOOD DETECTION BATCH PROCESSOR
// ============================================================================

interface FoodBatchItem {
  id: string;
  visitId?: string;
}

interface FoodBatchResult {
  photoId: string;
  foodDetected: boolean;
  foodLabels?: FoodLabel[];
  foodConfidence?: number;
  allLabels?: FoodLabel[];
}

interface ProducedFoodDetectionPage<T extends FoodBatchItem> {
  readonly items: T[];
  readonly detectionResults: FoodDetectionResult[];
}

/** Generic batch food detection processor - shared by all food detection functions */
async function processFoodDetectionBatches<T extends FoodBatchItem>(
  items: T[],
  confidenceThreshold: number,
  onBatchComplete?: (processed: number, foodFound: number, retryableFailures: number) => void,
  foodKeywords?: string[],
  onBatchResults?: (batchResults: FoodBatchResult[]) => void | Promise<void>,
  collectResults: boolean = true,
  collectOutcomes: boolean = false,
): Promise<{
  results: FoodBatchResult[];
  foodFoundCount: number;
  failedCount: number;
  outcomes: AdaptiveVisitFoodOutcome[];
}> {
  const results: FoodBatchResult[] = [];
  const outcomes: AdaptiveVisitFoodOutcome[] = [];
  let foodFoundCount = 0;
  let failedCount = 0;

  // Fetch enabled food keywords from database if not provided
  const keywords = foodKeywords ?? (await getEnabledFoodKeywords());
  const pages = createVisionResultPagePlan(items.length, FOOD_DETECTION_BATCH_SIZE);

  await runOrderedPagePipeline({
    pages,
    strategy: getResolvedVisionPageOrchestrationStrategy(),
    produce: async (page): Promise<ProducedFoodDetectionPage<T>> => {
      const pageItems = items.slice(page.offset, page.endOffset);
      const detectionResults = await detectFoodInImageBatch(
        pageItems.map((item) => item.id),
        { confidenceThreshold, foodKeywords: keywords },
      );
      return { items: pageItems, detectionResults };
    },
    consume: async ({ items: pageItems, detectionResults }, page) => {
      const itemMap = new Map(pageItems.map((item) => [item.id, item]));
      const batchResults: FoodBatchResult[] = [];
      const returnedAssetIds = new Set<string>();
      for (const result of detectionResults) {
        // Never turn a PhotoKit/Vision failure into a permanent "not food" result.
        // Failed or missing assets remain unanalyzed and can be retried later.
        if (!itemMap.has(result.assetId)) {
          continue;
        }
        returnedAssetIds.add(result.assetId);
        if (result.error !== undefined) {
          failedCount++;
          if (collectOutcomes) {
            outcomes.push({ photoId: result.assetId, status: "failure" });
          }
          continue;
        }

        const record: FoodBatchResult = {
          photoId: result.assetId,
          foodDetected: result.containsFood,
          foodLabels: result.foodLabels as FoodLabel[],
          foodConfidence: result.foodConfidence,
          allLabels: result.labels as FoodLabel[], // Store all labels from classifier
        };

        if (collectResults) {
          results.push(record);
        }
        batchResults.push(record);
        if (result.containsFood) {
          foodFoundCount++;
        }
        if (collectOutcomes) {
          outcomes.push({
            photoId: result.assetId,
            status: "success",
            containsFood: result.containsFood,
          });
        }
      }

      for (const item of pageItems) {
        if (!returnedAssetIds.has(item.id)) {
          failedCount++;
        }
      }

      if (batchResults.length > 0) {
        // Persistence errors must abort the scan. Continuing would report completion
        // while silently leaving a processed batch unsaved.
        await onBatchResults?.(batchResults);
      }

      onBatchComplete?.(page.endOffset, foodFoundCount, failedCount);
    },
  });

  return { results, foodFoundCount, failedCount, outcomes };
}

/**
 * Persist successful Vision pages in larger transactions without discarding a
 * pending successful prefix when later Vision or progress work throws.
 */
async function processFoodDetectionBatchesWithBufferedPersistence<T extends FoodBatchItem>(
  items: T[],
  confidenceThreshold: number,
  onBatchComplete?: (processed: number, foodFound: number, retryableFailures: number) => void,
  foodKeywords?: string[],
  onBatchResults?: (batchResults: FoodBatchResult[]) => void | Promise<void>,
): Promise<{ foodFoundCount: number; failedCount: number }> {
  let deferredTerminalProgress: [processed: number, foodFound: number, retryableFailures: number] | undefined;

  return runBufferedResultPersistence<FoodBatchResult, { foodFoundCount: number; failedCount: number }>({
    maximumPageSize: FOOD_DETECTION_BATCH_SIZE,
    persistenceFlushSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    persist: batchUpdatePhotosFoodDetected,
    synchronize: syncAllVisitsFoodProbable,
    process: async (appendResults) => {
      const { foodFoundCount, failedCount } = await processFoodDetectionBatches(
        items,
        confidenceThreshold,
        (processed, foodFound, retryableFailures) => {
          if (processed >= items.length) {
            deferredTerminalProgress = [processed, foodFound, retryableFailures];
            return;
          }
          onBatchComplete?.(processed, foodFound, retryableFailures);
        },
        foodKeywords,
        async (batchResults) => {
          await appendResults(batchResults);
          await onBatchResults?.(batchResults);
        },
        false,
      );
      return { foodFoundCount, failedCount };
    },
    onComplete: () => {
      if (deferredTerminalProgress) {
        onBatchComplete?.(...deferredTerminalProgress);
      }
    },
  });
}

async function processRank3BulkTailVisitFoodDetection(
  samples: readonly AdaptiveVisitFoodSample[],
  confidenceThreshold: number,
  progress: FoodDetectionProgress,
  tracker: ProgressTracker,
  onProgress: ((progress: FoodDetectionProgress) => void) | undefined,
): Promise<FoodDetectionProgress> {
  const foodKeywords = await getEnabledFoodKeywords();
  const positiveVisitIds = new Set<string>();
  const processedVisitIds = new Set<string>();

  const summary = await runRank3BulkTailVisitFoodDetection<FoodBatchResult>({
    samples,
    maximumPageSize: FOOD_DETECTION_BATCH_SIZE,
    persistenceFlushSize: DEFAULT_VISION_PERSISTENCE_FLUSH_SIZE,
    persist: batchUpdatePhotosFoodDetected,
    synchronize: syncAllVisitsFoodProbable,
    processBatch: async (batchSamples, context) => {
      let accountedSamples = 0;
      const visitIdByPhotoId = new Map(batchSamples.map((sample) => [sample.photoId, sample.visitId]));
      const { outcomes } = await processFoodDetectionBatches(
        batchSamples.map((sample) => ({ id: sample.photoId, visitId: sample.visitId })),
        confidenceThreshold,
        (processed, foodFound, retryableFailures) => {
          while (accountedSamples < processed) {
            const sample = batchSamples[accountedSamples];
            if (!sample) {
              throw new Error("Visit food-detection progress exceeded its adaptive batch.");
            }
            processedVisitIds.add(sample.visitId);
            accountedSamples += 1;
          }
          const batchProgress: VisitFoodDetectionBatchProgress = {
            processedSamples: processed,
            foodFoundSamples: foodFound,
            retryableFailures,
          };
          context.onProgress(batchProgress);
        },
        foodKeywords,
        async (batchResults) => {
          await context.appendResults(batchResults);
          for (const result of batchResults) {
            if (!result.foodDetected) {
              continue;
            }
            const visitId = visitIdByPhotoId.get(result.photoId);
            if (visitId) {
              positiveVisitIds.add(visitId);
            }
          }
        },
        false,
        true,
      );
      return { outcomes };
    },
    onProgress: (orchestrationProgress) => {
      progress.processedSamples = orchestrationProgress.processedSamples;
      progress.retryableFailures = orchestrationProgress.retryableFailures;
      progress.foodPhotosFound = orchestrationProgress.foodFoundSamples;
      progress.foodVisitsFound = positiveVisitIds.size;
      progress.processedVisits = processedVisitIds.size;
      const stats = tracker.update(orchestrationProgress.processedSamples, progress.totalSamples);
      progress.elapsedMs = stats.elapsedMs;
      progress.samplesPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      onProgress?.({ ...progress });
    },
  });

  progress.totalSamples = summary.attemptedSamples;
  progress.processedSamples = summary.attemptedSamples;
  progress.processedVisits = progress.totalVisits;
  progress.retryableFailures = summary.retryableFailures;
  progress.foodPhotosFound = summary.foodFoundSamples;
  progress.foodVisitsFound = summary.positiveVisitIds.length;
  const finalStats = tracker.update(summary.attemptedSamples, summary.attemptedSamples);
  progress.elapsedMs = finalStats.elapsedMs;
  progress.samplesPerSecond = finalStats.perSecond;
  progress.etaMs = 0;
  progress.isComplete = true;
  onProgress?.({ ...progress });
  return progress;
}

/**
 * Enrich visits with calendar event data.
 * Finds calendar events that overlap with each visit's time range.
 */
async function enrichVisitsWithCalendarEvents(
  options: CalendarEnrichmentOptions = {},
): Promise<CalendarEnrichmentProgress> {
  const { onProgress } = options;

  const progress: CalendarEnrichmentProgress = {
    totalVisits: 0,
    processedVisits: 0,
    visitsWithEvents: 0,
    isComplete: false,
    elapsedMs: 0,
    visitsPerSecond: 0,
    etaMs: null,
  };

  const emitProgress = () => {
    onProgress?.({ ...progress });
  };

  let hasPermission = await hasCalendarPermission();
  if (!hasPermission) {
    hasPermission = await requestCalendarPermission();
  }

  if (!hasPermission) {
    progress.isComplete = true;
    emitProgress();
    return progress;
  }

  const visitsToProcess = await getCalendarEnrichmentVisitSnapshot();
  progress.totalVisits = visitsToProcess.length;

  if (visitsToProcess.length === 0) {
    progress.isComplete = true;
    emitProgress();
    return progress;
  }

  emitProgress();
  const tracker = createProgressTracker();
  const BATCH_SIZE = 300;
  const calendarUpdates: CalendarEventUpdate[] = [];
  const restaurantSuggestionUpdates: {
    visitId: string;
    suggestedRestaurantId: string;
  }[] = [];

  const recordMatch = (visitId: string, event: CalendarEventInfo, suggestedRestaurantId: string | null | undefined) => {
    calendarUpdates.push({
      visitId,
      calendarEventId: event.id,
      calendarEventTitle: event.title,
      calendarEventLocation: event.location,
      calendarEventIsAllDay: event.isAllDay,
    });
    progress.visitsWithEvents++;

    if (suggestedRestaurantId) {
      restaurantSuggestionUpdates.push({ visitId, suggestedRestaurantId });
    }
  };

  const updateProgress = (processedVisits: number) => {
    progress.processedVisits = Math.min(processedVisits, visitsToProcess.length);
    const stats = tracker.update(progress.processedVisits, progress.totalVisits);
    progress.elapsedMs = stats.elapsedMs;
    progress.visitsPerSecond = stats.perSecond;
    progress.etaMs = stats.etaMs;
    emitProgress();
  };

  let nativeMatches: Awaited<ReturnType<typeof matchCalendarEventsForVisitsNatively>> = null;

  if (isNativeCalendarMatchingAvailable()) {
    nativeMatches = await matchCalendarEventsForVisitsNatively(visitsToProcess);
  }

  if (nativeMatches !== null) {
    const nativeMatchesByVisitId = new Map(nativeMatches.map((match) => [match.visitId, match]));

    for (let i = 0; i < visitsToProcess.length; i += BATCH_SIZE) {
      const batch = visitsToProcess.slice(i, i + BATCH_SIZE);
      for (const visit of batch) {
        const match = nativeMatchesByVisitId.get(visit.id);
        if (match) {
          recordMatch(visit.id, match, match.suggestedRestaurantId);
        }
      }

      updateProgress(i + BATCH_SIZE);
    }
  } else {
    for (let i = 0; i < visitsToProcess.length; i += BATCH_SIZE) {
      const batch = visitsToProcess.slice(i, i + BATCH_SIZE);
      const candidateEventMap = await batchFindCandidateEventsForVisits(batch);

      for (const visit of batch) {
        const candidateEvents = candidateEventMap.get(visit.id) ?? [];
        if (candidateEvents.length === 0) {
          continue;
        }

        const suggestedRestaurants = visit.suggestedRestaurants;
        let matchedRestaurant: (typeof suggestedRestaurants)[number] | undefined;
        let event = candidateEvents[0]!;

        if (suggestedRestaurants.length > 0) {
          for (const useFuzzyMatching of [false, true]) {
            for (const candidate of candidateEvents) {
              const cleanedTitle = cleanCalendarEventTitle(candidate.title);
              if (cleanedTitle.length < 3) {
                continue;
              }

              const match = suggestedRestaurants.find(
                (restaurant) =>
                  compareRestaurantAndCalendarTitle(candidate.title, restaurant.name) ||
                  (useFuzzyMatching && isFuzzyRestaurantMatch(cleanedTitle, restaurant.name)),
              );
              if (match) {
                event = candidate;
                matchedRestaurant = match;
                break;
              }
            }

            if (matchedRestaurant) {
              break;
            }
          }
        }

        recordMatch(visit.id, event, matchedRestaurant?.id);
      }

      updateProgress(i + BATCH_SIZE);
    }
  }

  if (calendarUpdates.length > 0) {
    await batchUpdateVisitsCalendarEvents(calendarUpdates);
  }
  if (restaurantSuggestionUpdates.length > 0) {
    await batchUpdateVisitSuggestedRestaurants(restaurantSuggestionUpdates);
  }

  progress.isComplete = true;
  progress.etaMs = 0;
  emitProgress();

  return progress;
}

// ============================================================================
// CALENDAR-ONLY VISITS
// ============================================================================

/**
 * Represents a calendar event that can be imported as a visit
 */
export interface ImportableCalendarEvent {
  calendarEventId: string;
  calendarEventTitle: string;
  calendarEventLocation: string | null;
  startDate: number;
  endDate: number;
  /** All matching restaurants - sorted by best match first (using location disambiguation) */
  matchedRestaurants: MichelinRestaurantRecord[];
  /** Convenience getter for the best match (first in the list) - for backward compatibility */
  matchedRestaurant: MichelinRestaurantRecord;
}

/**
 * Deduplicate calendar events by name and overlapping time.
 * Events with the same normalized title that overlap in time (within buffer) are considered duplicates.
 * Keeps the event with more complete information (location, notes, etc.)
 */
function dedupeCalendarEvents(
  events: CalendarEventInfo[],
  timeBufferMs: number = 2 * 60 * 60 * 1000,
): CalendarEventInfo[] {
  if (events.length <= 1) {
    return events;
  }

  // Sort by start date
  const sorted = [...events].sort((a, b) => a.startDate - b.startDate);

  const deduped: CalendarEventInfo[] = [];
  const seen = new Map<string, CalendarEventInfo>(); // normalized title -> best event

  for (const event of sorted) {
    const normalizedTitle = normalizeForComparison(cleanCalendarEventTitle(event.title));

    if (normalizedTitle.length < 3) {
      // Too short to dedupe, include as-is
      deduped.push(event);
      continue;
    }

    // Check if we've seen a similar event
    const existingEvent = seen.get(normalizedTitle);

    if (!existingEvent) {
      // First time seeing this title
      seen.set(normalizedTitle, event);
      continue;
    }

    // Check if times overlap (within buffer)
    const timesOverlap =
      existingEvent.startDate <= event.endDate + timeBufferMs &&
      existingEvent.endDate >= event.startDate - timeBufferMs;

    if (!timesOverlap) {
      // Different time, add the existing one and start tracking this one
      deduped.push(existingEvent);
      seen.set(normalizedTitle, event);
      continue;
    }

    // Events overlap - keep the one with more information
    const existingScore = (existingEvent.location ? 1 : 0) + (existingEvent.notes ? 1 : 0);
    const eventScore = (event.location ? 1 : 0) + (event.notes ? 1 : 0);

    if (eventScore > existingScore) {
      seen.set(normalizedTitle, event);
    }
    // Otherwise keep existing (it has more or equal info)
  }

  // Add remaining events from the map
  for (const event of seen.values()) {
    deduped.push(event);
  }

  return deduped;
}

// ============================================================================
// RESTAURANT LOOKUP FOR EXACT MATCHING (CALENDAR IMPORT)
// ============================================================================

const CALENDAR_GUIDE_NAME_TOOLS: CalendarGuideNameTools = {
  cleanCalendarEventTitle,
  normalizeForComparison,
  stripComparisonAffixes,
};

/**
 * Get calendar events that can be imported as visits.
 * Returns events that look like restaurant reservations and match a Michelin restaurant,
 * but don't already have a linked visit.
 *
 * Features:
 * - Pre-computes restaurant index for fast matching (O(1) word lookups instead of O(n) scanning)
 * - Deduplicates overlapping events with the same restaurant name
 * - Uses location/address disambiguation when multiple restaurants share the exact same name
 * - Yields to event loop to prevent UI blocking
 * - Filters out events where there's already a confirmed visit to that restaurant within ±1 day
 * - Requires exact restaurant name match only (no fuzzy matching)
 */
export async function getImportableCalendarEvents(
  options: { lookbackDays?: number; lookforwardDays?: number } = {},
): Promise<ImportableCalendarEvent[]> {
  const { lookbackDays = 1000, lookforwardDays = 1 } = options;

  // Check calendar permission
  const hasPermission = await hasCalendarPermission();
  if (!hasPermission) {
    return [];
  }

  // Define search range
  const now = Date.now();
  const startDate = now - lookbackDays * 24 * 60 * 60 * 1000;
  const endDate = now + lookforwardDays * 24 * 60 * 60 * 1000;

  // Get reservation-like calendar events
  const reservationEvents = await getReservationEvents(startDate, endDate);

  if (reservationEvents.length === 0) {
    return [];
  }

  // Get calendar events already linked to visits and dismissed events
  const [linkedEventIds, dismissedEventIds] = await Promise.all([
    getLinkedCalendarEventIds(),
    getDismissedCalendarEventIds(),
  ]);

  // Filter to unlinked and non-dismissed events only
  const unlinkedEvents = reservationEvents.filter(
    (event) => !linkedEventIds.has(event.id) && !dismissedEventIds.has(event.id),
  );

  if (unlinkedEvents.length === 0) {
    return [];
  }

  // Get confirmed visits with their Michelin restaurant IDs for filtering
  const confirmedVisits = await getConfirmedVisitsWithMichelinIds();

  // Build a map of restaurant ID -> array of visit times for fast lookup
  const confirmedVisitsByRestaurant = new Map<string, number[]>();
  for (const visit of confirmedVisits) {
    const existing = confirmedVisitsByRestaurant.get(visit.michelinRestaurantId) ?? [];
    existing.push(visit.startTime);
    confirmedVisitsByRestaurant.set(visit.michelinRestaurantId, existing);
  }

  // Helper to check if there's a confirmed visit to this restaurant within ±1 day
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const hasNearbyConfirmedVisit = (restaurantId: string, eventTime: number): boolean => {
    const visitTimes = confirmedVisitsByRestaurant.get(restaurantId);
    if (!visitTimes) {
      return false;
    }
    return visitTimes.some((visitTime) => Math.abs(visitTime - eventTime) <= ONE_DAY_MS);
  };

  // Deduplicate events by name and overlapping time
  const dedupedEvents = dedupeCalendarEvents(unlinkedEvents);

  // Transfer only guide names first, then hydrate the exact normalized-name
  // groups requested by these events inside the same SQLite read snapshot.
  const { restaurantsByName } = await loadCalendarGuideMatchingContext(
    dedupedEvents,
    CALENDAR_GUIDE_NAME_TOOLS,
    getMichelinRestaurantsForCalendarNormalizedNames,
  );

  // Yield after map building (can still be expensive on slower devices)
  await yieldToEventLoop();

  const importableEvents: ImportableCalendarEvent[] = [];
  const BATCH_SIZE = 50; // Process events in batches to yield periodically

  for (let i = 0; i < dedupedEvents.length; i++) {
    const event = dedupedEvents[i];
    const sortedMatches = getCalendarGuideMatchesForEvent(
      event.title,
      event.location,
      restaurantsByName,
      CALENDAR_GUIDE_NAME_TOOLS,
    );
    if (sortedMatches.length === 0) {
      continue;
    }

    // Filter out restaurants that already have a confirmed visit within ±1 day
    const hasSimilarVisit = sortedMatches.some((r) => hasNearbyConfirmedVisit(r.id, event.startDate));

    // Skip if no matches remain after filtering
    if (hasSimilarVisit) {
      continue;
    }

    importableEvents.push({
      calendarEventId: event.id,
      calendarEventTitle: event.title,
      calendarEventLocation: event.location,
      startDate: event.startDate,
      endDate: event.endDate,
      matchedRestaurants: sortedMatches,
      matchedRestaurant: sortedMatches[0], // Best match for backward compatibility
    });

    // Yield to event loop periodically
    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < dedupedEvents.length) {
      await yieldToEventLoop();
    }
  }

  // Deduplicate final results by matched restaurant + similar time
  // (in case different calendar events matched to the same restaurant)
  const finalDeduped = dedupeImportableEvents(importableEvents);

  // Sort by date descending (most recent first)
  return finalDeduped.sort((a, b) => b.startDate - a.startDate);
}

/**
 * Deduplicate importable events by restaurant and overlapping time.
 * If multiple events match the same restaurant at similar times, keep one.
 */
function dedupeImportableEvents(
  events: ImportableCalendarEvent[],
  timeBufferMs: number = 2 * 60 * 60 * 1000,
): ImportableCalendarEvent[] {
  if (events.length <= 1) {
    return events;
  }

  // Group by restaurant ID
  const byRestaurant = new Map<string, ImportableCalendarEvent[]>();
  for (const event of events) {
    const key = event.matchedRestaurant.id;
    const existing = byRestaurant.get(key) ?? [];
    existing.push(event);
    byRestaurant.set(key, existing);
  }

  const deduped: ImportableCalendarEvent[] = [];

  for (const [, restaurantEvents] of byRestaurant) {
    if (restaurantEvents.length === 1) {
      deduped.push(restaurantEvents[0]);
      continue;
    }

    // Sort by start date
    restaurantEvents.sort((a, b) => a.startDate - b.startDate);

    // Merge overlapping events
    const merged: ImportableCalendarEvent[] = [restaurantEvents[0]];

    for (let i = 1; i < restaurantEvents.length; i++) {
      const current = restaurantEvents[i];
      const last = merged[merged.length - 1];

      // Check if times overlap
      const timesOverlap =
        last.startDate <= current.endDate + timeBufferMs && last.endDate >= current.startDate - timeBufferMs;

      if (!timesOverlap) {
        // Different time slot, add as new entry
        merged.push(current);
      }
      // Otherwise skip (it's a duplicate for the same restaurant at same time)
    }

    deduped.push(...merged);
  }

  return deduped;
}

/**
 * Options for importing calendar events.
 */
export interface ImportCalendarEventOptions {
  /** Map of calendarEventId -> restaurantId to use instead of the default matched restaurant */
  restaurantOverrides?: ReadonlyMap<string, string>;
}

/**
 * Import the exact Calendar event snapshots that the user reviewed. One SQLite
 * transaction rechecks linked/dismissed IDs and every original restaurant's
 * ±1-day confirmed-visit conflict before inserting visits and suggestions,
 * without repeating the 1,000-day EventKit and Michelin discovery pipeline.
 *
 * @param events - Rendered import candidates to persist
 * @param options - Optional configuration including restaurant overrides
 */
export async function importCalendarEvents(
  events: readonly ImportableCalendarEvent[],
  options: ImportCalendarEventOptions = {},
): Promise<CalendarImportTransactionResult> {
  const { restaurantOverrides } = options;

  if (events.length === 0) {
    return {
      requestedCalendarEventIds: [],
      insertedCalendarEventIds: [],
      unavailableCalendarEventIds: [],
      nearbyConfirmedCalendarEventIds: [],
      insertConflictCalendarEventIds: [],
      insertedCount: 0,
    };
  }

  const now = Date.now();
  const plannedImport = planCalendarImportFromSnapshots(events, {
    now,
    restaurantOverrides,
  });
  if (plannedImport.visitsToCreate.length === 0) {
    return {
      requestedCalendarEventIds: [],
      insertedCalendarEventIds: [],
      unavailableCalendarEventIds: [],
      nearbyConfirmedCalendarEventIds: [],
      insertConflictCalendarEventIds: [],
      insertedCount: 0,
    };
  }

  return importCalendarSnapshotPlan(plannedImport, now);
}

/**
 * Dismiss calendar events so they won't appear in the importable list.
 */
export { dismissCalendarEvents } from "@/utils/db";

export interface DeepScanProgress {
  totalPhotos: number;
  processedPhotos: number;
  foodPhotosFound: number;
  retryableFailures: number;
  isComplete: boolean;
  // Speed and ETA tracking
  elapsedMs: number;
  photosPerSecond: number;
  etaMs: number | null;
}

export interface DeepScanOptions {
  confidenceThreshold?: number;
  onProgress?: (progress: DeepScanProgress) => void;
  photos?: Array<{ id: string }>;
}

function adaptVisitFoodProgressToDeepScan(progress: FoodDetectionProgress): DeepScanProgress {
  return {
    totalPhotos: progress.totalSamples,
    processedPhotos: progress.processedSamples,
    foodPhotosFound: progress.foodPhotosFound,
    retryableFailures: progress.retryableFailures,
    isComplete: progress.isComplete,
    elapsedMs: progress.elapsedMs,
    photosPerSecond: progress.samplesPerSecond,
    etaMs: progress.etaMs,
  };
}

/**
 * Deep scan photos for food detection.
 * Scans the provided photos, or every unanalyzed photo when none are specified.
 * Photos are processed in deterministic order (by creationTime, then id).
 */
export async function deepScanAllPhotosForFood(options: DeepScanOptions = {}): Promise<DeepScanProgress> {
  const { confidenceThreshold = 0.3, onProgress, photos } = options;

  if (isVisionVisitFoodValidationModeEnabled()) {
    const visitFoodProgress = await detectFoodInVisits({
      confidenceThreshold,
      onProgress: (progress) => onProgress?.(adaptVisitFoodProgressToDeepScan(progress)),
    });
    return adaptVisitFoodProgressToDeepScan(visitFoodProgress);
  }

  const progress: DeepScanProgress = {
    totalPhotos: 0,
    processedPhotos: 0,
    foodPhotosFound: 0,
    retryableFailures: 0,
    isComplete: false,
    elapsedMs: 0,
    photosPerSecond: 0,
    etaMs: null,
  };

  if (!isBatchAssetInfoAvailable()) {
    progress.isComplete = true;
    onProgress?.({ ...progress });
    return progress;
  }

  const photosToScan = photos ?? (await getUnanalyzedPhotoIds());
  progress.totalPhotos = photosToScan.length;

  if (photosToScan.length === 0) {
    progress.isComplete = true;
    onProgress?.({ ...progress });
    return progress;
  }

  onProgress?.({ ...progress });

  const tracker = createProgressTracker();

  const { foodFoundCount, failedCount } = await processFoodDetectionBatchesWithBufferedPersistence(
    photosToScan,
    confidenceThreshold,
    (processed, foodFound, retryableFailures) => {
      progress.processedPhotos = processed;
      progress.foodPhotosFound = foodFound;
      progress.retryableFailures = retryableFailures;
      const stats = tracker.update(processed, photosToScan.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.photosPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      // Spread to create new object reference so React detects the change
      onProgress?.({ ...progress });
    },
  );

  progress.foodPhotosFound = foodFoundCount;
  progress.retryableFailures = failedCount;
  progress.isComplete = true;
  progress.etaMs = 0;
  onProgress?.({ ...progress });

  return progress;
}

export interface VisitFoodScanProgress {
  totalPhotos: number;
  processedPhotos: number;
  foodPhotosFound: number;
  retryableFailures: number;
  isComplete: boolean;
  elapsedMs: number;
  photosPerSecond: number;
}

export interface VisitFoodScanOptions {
  confidenceThreshold?: number;
  onProgress?: (progress: VisitFoodScanProgress) => void;
}

/**
 * Scan all photos for a specific visit for food detection.
 */
export async function scanVisitPhotosForFood(
  visitId: string,
  photos: Array<{ id: string }>,
  options: VisitFoodScanOptions = {},
): Promise<VisitFoodScanProgress> {
  const { confidenceThreshold = 0.3, onProgress } = options;

  const progress: VisitFoodScanProgress = {
    totalPhotos: photos.length,
    processedPhotos: 0,
    foodPhotosFound: 0,
    retryableFailures: 0,
    isComplete: false,
    elapsedMs: 0,
    photosPerSecond: 0,
  };

  if (!isBatchAssetInfoAvailable() || photos.length === 0) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  onProgress?.(progress);
  const tracker = createProgressTracker();

  const { foodFoundCount, failedCount } = await processFoodDetectionBatchesWithBufferedPersistence(
    photos,
    confidenceThreshold,
    (processed, _foodFound, retryableFailures) => {
      progress.processedPhotos = processed;
      progress.retryableFailures = retryableFailures;
      const stats = tracker.update(processed, photos.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.photosPerSecond = stats.perSecond;
      onProgress?.(progress);
    },
  );

  progress.foodPhotosFound = foodFoundCount;
  progress.retryableFailures = failedCount;
  progress.isComplete = true;
  onProgress?.(progress);

  return progress;
}

/**
 * Search for restaurants near a visit location using Google Places API.
 * Returns suggestions for user to select from - does NOT auto-link.
 */
export async function searchRestaurantsForVisit(
  centerLat: number,
  centerLon: number,
  radiusMeters: number = 100,
): Promise<PlaceResult[]> {
  if (!isGoogleMapsConfigured()) {
    console.warn("Google Maps API not configured");
    return [];
  }

  return searchNearbyRestaurants(centerLat, centerLon, radiusMeters);
}

interface ProcessPhotosProgress {
  phase: "scanning" | "grouping-visits" | "calendar-events" | "detecting-food" | "optimizing-database";
  detail: string;
  photosPerSecond?: number;
  eta?: string;
  /** Progress value 0-1 for the current phase */
  progress?: number;
}

interface ProcessPhotosResult {
  visitsCreated: number;
  photosProcessed: number;
  foodVisitsFound: number;
  visitsWithCalendarEvents: number;
}

let processPhotosPromise: Promise<ProcessPhotosResult> | null = null;

/**
 * Run scanning, grouping visits, calendar enrichment, calendar-only visits, and food detection in sequence.
 * Note: Restaurant confirmation is now a separate user-driven process.
 */
export async function processPhotos(
  scanProgress?: (progress: ProcessPhotosProgress) => void,
): Promise<ProcessPhotosResult> {
  if (processPhotosPromise) {
    return processPhotosPromise;
  }

  processPhotosPromise = runProcessPhotos(scanProgress).finally(() => {
    processPhotosPromise = null;
  });

  return processPhotosPromise;
}

async function runProcessPhotos(
  scanProgress?: (progress: ProcessPhotosProgress) => void,
): Promise<ProcessPhotosResult> {
  // Phase 1: Scan photos
  scanProgress?.({ phase: "scanning", detail: "Scanning camera roll..." });

  const scanResult = await scanCameraRoll({
    onProgress: (p) => {
      scanProgress?.({
        phase: "scanning",
        detail: `Scanned ${p.processedAssets.toLocaleString()} of ${p.totalAssets.toLocaleString()} photos`,
        photosPerSecond: p.newPhotosPerSecond,
        eta: formatEta(p.etaMs),
        progress: p.totalAssets > 0 ? p.processedAssets / p.totalAssets : 0,
      });
    },
  });

  // Phase 2: Group photos into visits (with Michelin suggestions)
  scanProgress?.({
    phase: "grouping-visits",
    detail: "Grouping photos by location and time...",
  });

  const visitResult = await visitPhotos({
    onProgress: (p) => {
      scanProgress?.({
        phase: "grouping-visits",
        detail: `Grouped ${p.visitedPhotos.toLocaleString()} of ${p.totalPhotos.toLocaleString()}`,
        photosPerSecond: p.visitsPerSecond,
        eta: formatEta(p.etaMs),
        progress: p.totalPhotos > 0 ? p.visitedPhotos / p.totalPhotos : 0,
      });
    },
  });

  // Phase 3: Enrich visits with calendar events
  scanProgress?.({
    phase: "calendar-events",
    detail: "Matching calendar events...",
  });

  const calendarResult = await enrichVisitsWithCalendarEvents({
    onProgress: (p) => {
      if (!p.totalVisits) {
        return;
      }
      const totalVisits = p.totalVisits.toLocaleString();
      const matchedEvents = p.visitsWithEvents.toLocaleString();

      const detail =
        p.processedVisits === 0 || p.visitsWithEvents === 0
          ? `Matching calendar events for visits`
          : `Matched ${matchedEvents} events for ${totalVisits} visits`;

      scanProgress?.({
        phase: "calendar-events",
        detail,
        photosPerSecond: p.visitsPerSecond,
        eta: formatEta(p.etaMs),
        progress: p.totalVisits > 0 ? p.processedVisits / p.totalVisits : 0,
      });
    },
  });

  // Let the UI paint the final calendar match count before the next phase updates the status.
  await yieldToEventLoop();

  // Phase 4: Detect food in visit photos
  scanProgress?.({
    phase: "detecting-food",
    detail: "Analyzing photos for food...",
  });

  const foodResult = await detectFoodInVisits({
    onProgress: (p) => {
      if (!p.totalSamples) {
        return;
      }
      scanProgress?.({
        phase: "detecting-food",
        detail: `Analyzed ${p.processedSamples.toLocaleString()} of ${p.totalSamples.toLocaleString()} pics for food`,
        photosPerSecond: p.samplesPerSecond,
        eta: formatEta(p.etaMs),
        progress: p.totalSamples > 0 ? p.processedSamples / p.totalSamples : 0,
      });
    },
  });

  // Phase 5: Database maintenance (ANALYZE and WAL checkpoint)
  scanProgress?.({
    phase: "optimizing-database",
    detail: "Optimizing database...",
  });

  await performDatabaseMaintenance();

  return {
    visitsCreated: visitResult.visitsCreated,
    photosProcessed: scanResult.newPhotosAdded,
    foodVisitsFound: foodResult.foodVisitsFound,
    visitsWithCalendarEvents: calendarResult.visitsWithEvents,
  };
}
