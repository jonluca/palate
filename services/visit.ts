import {
  getUnvisitedPhotos,
  getVisitablePhotoCounts,
  insertVisits,
  batchUpdatePhotoVisits,
  batchUpdateVisitPhotoCounts,
  syncAllVisitsFoodProbable,
  batchUpdatePhotosFoodDetected,
  batchUpdateVisitsCalendarEvents,
  getVisitsWithoutCalendarData,
  getAllMichelinRestaurants,
  insertMichelinRestaurants,
  getMichelinRestaurantCount,
  getVisitsNeedingFoodDetection,
  getVisitPhotoSamples,
  insertVisitSuggestedRestaurants,
  getUnanalyzedPhotoIds,
  getSuggestedRestaurantsForVisits,
  batchUpdateVisitSuggestedRestaurants,
  recomputeSuggestedRestaurantsIfNeeded,
  getLinkedCalendarEventIds,
  getDismissedCalendarEventIds,
  insertCalendarOnlyVisits,
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
  ensureRestaurantLocationIndex,
  MICHELIN_PRIMARY_MATCH_RADIUS_METERS,
  MICHELIN_SUGGESTION_LIMIT,
  MICHELIN_SUGGESTION_RADIUS_METERS,
} from "@/utils/db/michelin-index";
import {
  hasCalendarPermission,
  requestCalendarPermission,
  batchFindCandidateEventsForVisits,
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
  getReservationEvents,
  normalizeForComparison,
  type CalendarEventInfo,
  stripComparisonAffixes,
} from "./calendar";
import { getMichelinDatasetVersion, loadMichelinRestaurants } from "./michelin";
import { searchNearbyRestaurants, isGoogleMapsConfigured, type PlaceResult } from "./places";
import { isBatchAssetInfoAvailable, detectFoodInImageBatch } from "@/modules/batch-asset-info";
import { scanCameraRoll, formatEta } from "./scanner";

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

  const michelinData = await loadMichelinRestaurants((loaded, total) => {
    onProgress(`Parsing restaurants: ${loaded.toLocaleString()} / ${total.toLocaleString()}`);
  });

  if (michelinData.length === 0) {
    throw new Error("The bundled Michelin database did not contain any valid restaurant locations");
  }

  onProgress(
    `${existingCount > 100 ? "Refreshing" : "Saving"} ${michelinData.length.toLocaleString()} Michelin restaurants to database...`,
  );

  await insertMichelinRestaurants(michelinData, bundledDatasetVersion);

  console.log(`Initialized ${michelinData.length} Michelin restaurants`);
  return { loaded: michelinData.length, skipped: false };
}

/**
 * Initialize Michelin restaurant reference data in the database
 * This is separate from user's confirmed restaurants
 */
export async function initializeMichelinData(
  onProgress?: (message: string) => void,
): Promise<{ loaded: number; skipped: boolean }> {
  if (onProgress) {
    michelinInitializationProgressListeners.add(onProgress);
  }

  if (!michelinInitializationPromise) {
    const emitProgress = (message: string) => {
      for (const listener of michelinInitializationProgressListeners) {
        listener(message);
      }
    };
    const initialization = initializeMichelinDataInternal(emitProgress);
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

/**
 * Calculate the centroid (center point) of a group of photos
 */
function calculateCentroid(photos: UnvisitedPhotoRecord[]): {
  lat: number;
  lon: number;
} {
  if (photos.length === 0) {
    return { lat: 0, lon: 0 };
  }

  const sumLat = photos.reduce((sum, photo) => sum + photo.latitude, 0);
  const sumLon = photos.reduce((sum, photo) => sum + photo.longitude, 0);

  return {
    lat: sumLat / photos.length,
    lon: sumLon / photos.length,
  };
}

// ============================================================================
// FAST DISTANCE CALCULATIONS FOR GROUPING
// ============================================================================

// Pre-computed constants for distance approximation
const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_METERS = 6371000;

// Quick rejection thresholds in degrees
// For 200m threshold: max lat diff ≈ 0.0018°, we use 0.003° (~333m) for safety margin
// Longitude varies by latitude but 0.006° is safe for latitudes up to 70°
const QUICK_REJECT_LAT_DEG = 0.003;
const QUICK_REJECT_LON_DEG = 0.006;

/**
 * Fast distance calculation using equirectangular approximation.
 * Accurate to within 0.5% for distances under 1km - perfect for our 200m threshold.
 * ~10x faster than Haversine by avoiding most trig functions.
 */
function fastDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  // Use average latitude for longitude scaling
  const avgLatRad = ((lat1 + lat2) / 2) * DEG_TO_RAD;
  const x = dLon * Math.cos(avgLatRad);
  return EARTH_RADIUS_METERS * Math.sqrt(x * x + dLat * dLat);
}

/**
 * Check if two photos are within the distance threshold.
 * Optimized with quick bounding box rejection before computing distance.
 */
function arePhotosNearby(photo1: UnvisitedPhotoRecord, photo2: UnvisitedPhotoRecord, threshold: number): boolean {
  const lat1 = photo1.latitude;
  const lon1 = photo1.longitude;
  const lat2 = photo2.latitude;
  const lon2 = photo2.longitude;

  // Quick bounding box rejection - very fast, catches most far-apart photos
  const latDiff = lat2 - lat1;
  const lonDiff = lon2 - lon1;
  if (
    latDiff > QUICK_REJECT_LAT_DEG ||
    latDiff < -QUICK_REJECT_LAT_DEG ||
    lonDiff > QUICK_REJECT_LON_DEG ||
    lonDiff < -QUICK_REJECT_LON_DEG
  ) {
    return false;
  }

  // Fast equirectangular distance for nearby photos
  return fastDistanceMeters(lat1, lon1, lat2, lon2) <= threshold;
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

// Batch size for food detection (smaller for image processing)
const FOOD_DETECTION_BATCH_SIZE = 50;

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
  const database = await getDatabase();
  const [photoCounts, photos, restaurantLocationIndex] = await Promise.all([
    getVisitablePhotoCounts(),
    getUnvisitedPhotos(),
    ensureRestaurantLocationIndex(database, __DEV__),
  ]);

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

  if (photos.length === 0) {
    progress.isComplete = true;
    progress.phase = "complete";
    onProgress?.(progress);
    return progress;
  }

  // Phase 1: Group photos into visits with chunked processing
  // This is inherently sequential (comparing consecutive photos) but we yield periodically
  onProgress?.(progress);
  const photoGroups: UnvisitedPhotoRecord[][] = [];
  let currentGroup: UnvisitedPhotoRecord[] = [photos[0]];

  const GROUPING_CHUNK_SIZE = 1000; // Yield every 1000 photos

  for (let i = 1; i < photos.length; i++) {
    const prevPhoto = photos[i - 1];
    const currentPhoto = photos[i];

    const timeDiff = currentPhoto.creationTime - prevPhoto.creationTime;

    // OPTIMIZATION: Short-circuit evaluation - only compute distance if time check passes
    // This avoids expensive distance calculations for photos already separated by time
    if (timeDiff > timeGapThreshold || !arePhotosNearby(prevPhoto, currentPhoto, distanceThreshold)) {
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
        const centroid = calculateCentroid(groupPhotos);
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

  const visitsToProcess = await getVisitsNeedingFoodDetection();
  progress.totalVisits = visitsToProcess.length;

  if (visitsToProcess.length === 0) {
    progress.isComplete = true;
    await syncAllVisitsFoodProbable();
    onProgress?.(progress);
    return progress;
  }

  const allSamples = await getVisitPhotoSamples(
    visitsToProcess.map((v) => v.id),
    samplePercentage,
  );
  progress.totalSamples = allSamples.length;
  onProgress?.(progress);

  const tracker = createProgressTracker();
  const visitFoodResults = new Set<string>();

  const { results } = await processFoodDetectionBatches(
    allSamples.map((s) => ({ id: s.photoId, visitId: s.visitId })),
    confidenceThreshold,
    (processed, _foodFound, retryableFailures) => {
      progress.processedSamples = processed;
      progress.retryableFailures = retryableFailures;
      progress.foodVisitsFound = visitFoodResults.size;
      const stats = tracker.update(processed, allSamples.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.samplesPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      progress.processedVisits = new Set(allSamples.slice(0, processed).map((s) => s.visitId)).size;
      onProgress?.({ ...progress });
    },
  );

  // Track which visits had food
  const sampleMap = new Map(allSamples.map((s) => [s.photoId, s.visitId]));
  for (const r of results) {
    if (r.foodDetected && sampleMap.has(r.photoId)) {
      visitFoodResults.add(sampleMap.get(r.photoId)!);
    }
  }

  await batchUpdatePhotosFoodDetected(results);
  await syncAllVisitsFoodProbable();

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

/** Generic batch food detection processor - shared by all food detection functions */
async function processFoodDetectionBatches<T extends FoodBatchItem>(
  items: T[],
  confidenceThreshold: number,
  onBatchComplete?: (processed: number, foodFound: number, retryableFailures: number) => void,
  foodKeywords?: string[],
  onBatchResults?: (batchResults: FoodBatchResult[]) => void | Promise<void>,
  collectResults: boolean = true,
): Promise<{ results: FoodBatchResult[]; foodFoundCount: number; failedCount: number }> {
  const results: FoodBatchResult[] = [];
  let foodFoundCount = 0;
  let failedCount = 0;

  // Fetch enabled food keywords from database if not provided
  const keywords = foodKeywords ?? (await getEnabledFoodKeywords());

  for (let i = 0; i < items.length; i += FOOD_DETECTION_BATCH_SIZE) {
    const batch = items.slice(i, i + FOOD_DETECTION_BATCH_SIZE);
    const itemMap = new Map(batch.map((item) => [item.id, item]));

    const detectionResults = await detectFoodInImageBatch(
      batch.map((item) => item.id),
      { confidenceThreshold, foodKeywords: keywords },
    );

    const batchResults: FoodBatchResult[] = [];
    const returnedAssetIds = new Set<string>();
    for (const result of detectionResults) {
      // Never turn a PhotoKit/Vision failure into a permanent "not food" result.
      // Failed or missing assets remain unanalyzed and can be retried later.
      if (!itemMap.has(result.assetId)) {
        continue;
      }
      returnedAssetIds.add(result.assetId);
      if (result.error) {
        failedCount++;
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
    }

    for (const item of batch) {
      if (!returnedAssetIds.has(item.id)) {
        failedCount++;
      }
    }

    if (batchResults.length > 0) {
      // Persistence errors must abort the scan. Continuing would report completion
      // while silently leaving a processed batch unsaved.
      await onBatchResults?.(batchResults);
    }

    onBatchComplete?.(Math.min(i + FOOD_DETECTION_BATCH_SIZE, items.length), foodFoundCount, failedCount);
  }

  return { results, foodFoundCount, failedCount };
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

  const visitsToProcess = await getVisitsWithoutCalendarData();
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

  for (let i = 0; i < visitsToProcess.length; i += BATCH_SIZE) {
    const batch = visitsToProcess.slice(i, i + BATCH_SIZE);
    const batchVisitIds = batch.map((v) => v.id);

    const [candidateEventMap, suggestedRestaurantsMap] = await Promise.all([
      batchFindCandidateEventsForVisits(batch),
      getSuggestedRestaurantsForVisits(batchVisitIds),
    ]);

    for (const visit of batch) {
      const candidateEvents = candidateEventMap.get(visit.id) ?? [];
      if (candidateEvents.length === 0) {
        continue;
      }

      const suggestedRestaurants = suggestedRestaurantsMap.get(visit.id) ?? [];
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
              (r) =>
                compareRestaurantAndCalendarTitle(candidate.title, r.name) ||
                (useFuzzyMatching && isFuzzyRestaurantMatch(cleanedTitle, r.name)),
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

      calendarUpdates.push({
        visitId: visit.id,
        calendarEventId: event.id,
        calendarEventTitle: event.title,
        calendarEventLocation: event.location,
        calendarEventIsAllDay: event.isAllDay,
      });
      progress.visitsWithEvents++;

      if (matchedRestaurant) {
        restaurantSuggestionUpdates.push({
          visitId: visit.id,
          suggestedRestaurantId: matchedRestaurant.id,
        });
      }
    }

    progress.processedVisits = Math.min(i + BATCH_SIZE, visitsToProcess.length);
    const stats = tracker.update(progress.processedVisits, progress.totalVisits);
    progress.elapsedMs = stats.elapsedMs;
    progress.visitsPerSecond = stats.perSecond;
    progress.etaMs = stats.etaMs;
    emitProgress();
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
 * Generate a deterministic hash for a calendar-only visit
 */
function generateCalendarVisitHash(calendarEventId: string, startTime: number): string {
  // Round time to nearest hour for some stability
  const timeRounded = Math.floor(startTime / (60 * 60 * 1000));
  return `cal-${calendarEventId}-${timeRounded}`;
}

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

type RestaurantsByNormalizedName = Map<string, MichelinRestaurantRecord[]>;

function buildRestaurantsByNormalizedName(restaurants: MichelinRestaurantRecord[]): RestaurantsByNormalizedName {
  const map: RestaurantsByNormalizedName = new Map();
  for (const r of restaurants) {
    const key = normalizeForComparison(stripComparisonAffixes(r.name));
    if (!key) {
      continue;
    }
    const existing = map.get(key);
    if (existing) {
      existing.push(r);
    } else {
      map.set(key, [r]);
    }
  }
  return map;
}

/**
 * Calculate a location relevance score for a restaurant based on how well it matches the event location.
 */
function calculateLocationRelevanceScore(restaurant: MichelinRestaurantRecord, eventLocation: string | null): number {
  if (!eventLocation) {
    return 0;
  }

  const eventLocNorm = normalizeForComparison(eventLocation);
  const locNorm = normalizeForComparison(restaurant.location);
  const addrNorm = normalizeForComparison(restaurant.address);

  let score = 0;
  if (eventLocNorm.includes(addrNorm) || addrNorm.includes(eventLocNorm)) {
    score += 2;
  }
  if (eventLocNorm.includes(locNorm) || locNorm.includes(eventLocNorm)) {
    score += 1;
  }

  return score;
}

/**
 * Sort restaurants by location relevance - best match first.
 * Used when multiple Michelin restaurants share the exact same normalized name.
 */
function sortRestaurantsByLocationRelevance(
  matches: MichelinRestaurantRecord[],
  eventLocation: string | null,
): MichelinRestaurantRecord[] {
  if (matches.length <= 1) {
    return matches;
  }

  // Calculate scores and sort
  return [...matches].sort((a, b) => {
    const scoreA = calculateLocationRelevanceScore(a, eventLocation);
    const scoreB = calculateLocationRelevanceScore(b, eventLocation);
    return scoreB - scoreA; // Higher score first
  });
}

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

  // Get all Michelin restaurants and build an exact-name lookup map
  const michelinRestaurants = await getAllMichelinRestaurants();
  const restaurantsByName = buildRestaurantsByNormalizedName(michelinRestaurants);

  // Yield after map building (can still be expensive on slower devices)
  await yieldToEventLoop();

  const importableEvents: ImportableCalendarEvent[] = [];
  const BATCH_SIZE = 50; // Process events in batches to yield periodically

  for (let i = 0; i < dedupedEvents.length; i++) {
    const event = dedupedEvents[i];
    const cleanedTitle = stripComparisonAffixes(cleanCalendarEventTitle(event.title));

    if (cleanedTitle.length < 3) {
      continue;
    }

    // Exact normalized-name match only
    const queryNorm = normalizeForComparison(cleanedTitle);
    const matches = restaurantsByName.get(queryNorm);
    if (!matches || matches.length === 0) {
      continue;
    }

    // Sort all matches by location relevance (best match first)
    const sortedMatches = sortRestaurantsByLocationRelevance(matches, event.location);

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
  restaurantOverrides?: Map<string, string>;
}

/**
 * Import specific calendar events as visits.
 * Takes an array of calendar event IDs to import.
 * The matched restaurant is auto-confirmed on the created visit.
 *
 * @param calendarEventIds - Array of calendar event IDs to import
 * @param options - Optional configuration including restaurant overrides
 */
export async function importCalendarEvents(
  calendarEventIds: string[],
  options: ImportCalendarEventOptions = {},
): Promise<number> {
  const { restaurantOverrides } = options;

  if (calendarEventIds.length === 0) {
    return 0;
  }

  // Get all importable events
  const importableEvents = await getImportableCalendarEvents();

  // Filter to only the requested events
  const eventsToImport = importableEvents.filter((e) => calendarEventIds.includes(e.calendarEventId));
  const pastEventsToImport = eventsToImport.filter((event) => event.startDate <= Date.now());

  if (pastEventsToImport.length === 0) {
    return 0;
  }

  const visitsToCreate = pastEventsToImport.map((event) => {
    // Check if there's an override for this event's restaurant
    const overrideRestaurantId = restaurantOverrides?.get(event.calendarEventId);
    let restaurant = event.matchedRestaurant;

    // If override provided, find the restaurant in matchedRestaurants
    if (overrideRestaurantId) {
      const overrideRestaurant = event.matchedRestaurants.find((r) => r.id === overrideRestaurantId);
      if (overrideRestaurant) {
        restaurant = overrideRestaurant;
      }
    }

    return {
      id: generateCalendarVisitHash(event.calendarEventId, event.startDate),
      calendarEventId: event.calendarEventId,
      calendarEventTitle: event.calendarEventTitle,
      calendarEventLocation: event.calendarEventLocation,
      startTime: event.startDate,
      endTime: event.endDate,
      centerLat: restaurant.latitude,
      centerLon: restaurant.longitude,
      // Pass full restaurant data for auto-confirmation
      matchedRestaurant: {
        id: restaurant.id,
        name: restaurant.name,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        address: restaurant.address,
        cuisine: restaurant.cuisine,
      },
    };
  });

  // Insert visits with auto-confirmation
  await insertCalendarOnlyVisits(visitsToCreate);

  // Also insert into suggested restaurants for tracking/UI purposes
  const suggestedRestaurantsToInsert: VisitSuggestedRestaurant[] = visitsToCreate.map((v) => ({
    visitId: v.id,
    restaurantId: v.matchedRestaurant.id,
    distance: 0,
  }));
  await insertVisitSuggestedRestaurants(suggestedRestaurantsToInsert);

  return visitsToCreate.length;
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

/**
 * Deep scan photos for food detection.
 * Scans the provided photos, or every unanalyzed photo when none are specified.
 * Photos are processed in deterministic order (by creationTime, then id).
 */
export async function deepScanAllPhotosForFood(options: DeepScanOptions = {}): Promise<DeepScanProgress> {
  const { confidenceThreshold = 0.3, onProgress, photos } = options;

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

  const { foodFoundCount, failedCount } = await processFoodDetectionBatches(
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
    undefined,
    async (batchResults) => {
      await batchUpdatePhotosFoodDetected(batchResults);
    },
    false,
  );

  await syncAllVisitsFoodProbable();

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

  const { results, foodFoundCount, failedCount } = await processFoodDetectionBatches(
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

  if (results.length > 0) {
    await batchUpdatePhotosFoodDetected(results);
  }
  await syncAllVisitsFoodProbable();

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
