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
  getAllPhotoIds,
  getSuggestedRestaurantsForVisits,
  batchUpdateVisitSuggestedRestaurants,
  recomputeSuggestedRestaurants,
  getLinkedCalendarEventIds,
  getDismissedCalendarEventIds,
  insertCalendarOnlyVisits,
  performDatabaseMaintenance,
  getConfirmedVisitsWithMichelinIds,
  type PhotoRecord,
  type VisitRecord,
  type VisitSuggestedRestaurant,
  type FoodLabel,
  type MichelinRestaurantRecord,
  type CalendarEventUpdate,
} from "@/utils/db";
import {
  hasCalendarPermission,
  requestCalendarPermission,
  batchFindEventsForVisits,
  cleanCalendarEventTitle,
  isFuzzyRestaurantMatch,
  getReservationEvents,
  normalizeForComparison,
  type CalendarEventInfo,
  stripComparisonAffixes,
} from "./calendar";
import { loadMichelinRestaurants, toMichelinRecords } from "./michelin";
import { searchNearbyRestaurants, isGoogleMapsConfigured, type PlaceResult } from "./places";
import { isBatchAssetInfoAvailable, detectFoodInImageBatch } from "@/modules/batch-asset-info";
import { scanCameraRoll, formatEta } from "./scanner";

/**
 * Find restaurants near a given location.
 * Optimized with bounding box pre-filtering before distance calculation.
 */
function findNearbyRestaurants(
  lat: number,
  lon: number,
  restaurants: MichelinRestaurantRecord[],
  maxDistanceMeters: number,
  limit: number,
): Array<MichelinRestaurantRecord & { distance: number }> {
  // Pre-compute bounding box for quick rejection
  // 1 degree latitude ≈ 111km, so for maxDistance meters:
  const latThreshold = maxDistanceMeters / 111000;
  // Longitude varies by latitude, use conservative estimate (at equator)
  const lonThreshold = maxDistanceMeters / 80000; // Conservative for mid-latitudes

  const nearby: Array<MichelinRestaurantRecord & { distance: number }> = [];

  for (const restaurant of restaurants) {
    // Quick bounding box rejection
    const latDiff = restaurant.latitude - lat;
    const lonDiff = restaurant.longitude - lon;
    if (latDiff > latThreshold || latDiff < -latThreshold || lonDiff > lonThreshold || lonDiff < -lonThreshold) {
      continue;
    }

    // Use fast distance for nearby candidates
    const distance = fastDistanceMeters(lat, lon, restaurant.latitude, restaurant.longitude);
    if (distance <= maxDistanceMeters) {
      nearby.push({ ...restaurant, distance });
    }
  }

  // Sort by distance and limit
  return nearby.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

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
  onProgress?: (progress: AnalyzingVisitsProgress) => void;
}

const DEFAULT_TIME_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_DISTANCE_THRESHOLD = 200; // 200 meters
const DEFAULT_RESTAURANT_MATCH_THRESHOLD = 100; // 100 meters

/**
 * Initialize Michelin restaurant reference data in the database
 * This is separate from user's confirmed restaurants
 */
async function initializeMichelinData(
  onProgress?: (message: string) => void,
): Promise<{ loaded: number; skipped: boolean }> {
  const existingCount = await getMichelinRestaurantCount();

  // Skip if we already have Michelin data loaded
  if (existingCount > 100) {
    return { loaded: existingCount, skipped: true };
  }

  onProgress?.("Loading Michelin restaurant data...");

  const michelinData = await loadMichelinRestaurants((loaded, total) => {
    onProgress?.(`Parsing restaurants: ${loaded.toLocaleString()} / ${total.toLocaleString()}`);
  });

  if (michelinData.length === 0) {
    console.warn("No Michelin data loaded");
    return { loaded: 0, skipped: false };
  }

  onProgress?.(`Saving ${michelinData.length.toLocaleString()} Michelin restaurants to database...`);

  // Convert to MichelinRestaurantRecords and insert
  const records = toMichelinRecords(michelinData);
  await insertMichelinRestaurants(records);

  console.log(`Initialized ${records.length} Michelin restaurants`);
  return { loaded: records.length, skipped: false };
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
function calculateCentroid(photos: PhotoRecord[]): { lat: number; lon: number } {
  const validPhotos = photos.filter((p) => p.latitude !== null && p.longitude !== null);

  if (validPhotos.length === 0) {
    return { lat: 0, lon: 0 };
  }

  const sumLat = validPhotos.reduce((sum, p) => sum + (p.latitude ?? 0), 0);
  const sumLon = validPhotos.reduce((sum, p) => sum + (p.longitude ?? 0), 0);

  return {
    lat: sumLat / validPhotos.length,
    lon: sumLon / validPhotos.length,
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
function arePhotosNearby(photo1: PhotoRecord, photo2: PhotoRecord, threshold: number): boolean {
  const lat1 = photo1.latitude;
  const lon1 = photo1.longitude;
  const lat2 = photo2.latitude;
  const lon2 = photo2.longitude;

  // Null check
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
    return false;
  }

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
  photos: PhotoRecord[];
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
 * OPTIMIZED IMPLEMENTATION using parallelization and spatial indexing:
 * - Uses spatial index for O(1) restaurant lookups instead of O(n)
 * - Processes visit groups in parallel chunks
 * - Runs independent DB operations concurrently
 * - Yields to event loop to prevent UI blocking
 */
async function visitPhotos(options: AnalyzingVisitsOptions = {}): Promise<AnalyzingVisitsProgress> {
  const {
    timeGapThreshold = DEFAULT_TIME_GAP_MS,
    distanceThreshold = DEFAULT_DISTANCE_THRESHOLD,
    restaurantMatchThreshold = DEFAULT_RESTAURANT_MATCH_THRESHOLD,
    onProgress,
  } = options;

  const startTime = Date.now();

  await initializeMichelinData();
  // Initialize Michelin reference data if needed (runs in parallel with photo fetch)
  const [photoCounts, photos, michelinRestaurants] = await Promise.all([
    getVisitablePhotoCounts(),
    getUnvisitedPhotos(),
    getAllMichelinRestaurants(),
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
  const photoGroups: PhotoRecord[][] = [];
  let currentGroup: PhotoRecord[] = [photos[0]];

  const GROUPING_CHUNK_SIZE = 1000; // Yield every 1000 photos

  for (let i = 1; i < photos.length; i++) {
    const prevPhoto = photos[i - 1];
    const currentPhoto = photos[i];

    const timeDiff = currentPhoto.creationTime - prevPhoto.creationTime;

    // OPTIMIZATION: Short-circuit evaluation - only compute distance if time check passes
    // This avoids expensive distance calculations for photos already separated by time
    if (timeDiff > timeGapThreshold || !arePhotosNearby(prevPhoto, currentPhoto, distanceThreshold)) {
      if (currentGroup.length >= 2) {
        photoGroups.push(currentGroup);
      }
      currentGroup = [currentPhoto];
    } else {
      currentGroup.push(currentPhoto);
    }

    // Yield to event loop periodically to prevent UI blocking
    if (i % GROUPING_CHUNK_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  if (currentGroup.length >= 2) {
    photoGroups.push(currentGroup);
  }

  if (photoGroups.length === 0) {
    progress.isComplete = true;
    progress.phase = "complete";
    progress.elapsedMs = Date.now() - startTime;
    onProgress?.(progress);
    return progress;
  }

  // Phase 2: Process visits in parallel batches with progress reporting
  progress.phase = "saving-visits";
  progress.elapsedMs = Date.now() - startTime;
  onProgress?.(progress);

  const totalGroups = photoGroups.length;
  const VISIT_BATCH_SIZE = 200; // Increased batch size for better throughput
  const PARALLEL_CHUNK_SIZE = 50; // Process 50 groups in parallel within each batch

  for (let batchStart = 0; batchStart < totalGroups; batchStart += VISIT_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + VISIT_BATCH_SIZE, totalGroups);
    const batchPhotoGroups = photoGroups.slice(batchStart, batchEnd);

    // Process visit groups in parallel chunks using spatial index for fast lookups
    const batchVisitGroups = await processInChunks(
      batchPhotoGroups,
      (groupPhotos) => {
        const centroid = calculateCentroid(groupPhotos);
        const visitStartTime = groupPhotos[0].creationTime;
        const visitEndTime = groupPhotos[groupPhotos.length - 1].creationTime;

        // Find nearby restaurants
        const nearbyRestaurants = findNearbyRestaurants(
          centroid.lat,
          centroid.lon,
          michelinRestaurants,
          restaurantMatchThreshold * 2, // 200m for multiple matches
          5, // limit to 5 suggestions
        );

        // Generate hash
        const hash = generateVisitHash(visitStartTime, visitEndTime, centroid.lat, centroid.lon);

        // The closest restaurant within the stricter threshold becomes the primary suggestion
        const primarySuggestion = nearbyRestaurants.find((r) => r.distance <= restaurantMatchThreshold);

        return {
          photos: groupPhotos,
          centroid,
          startTime: visitStartTime,
          endTime: visitEndTime,
          hash,
          suggestedRestaurantId: primarySuggestion?.id ?? null,
          suggestedRestaurants: nearbyRestaurants.map((r) => ({ id: r.id, distance: r.distance })),
        } as VisitGroup;
      },
      PARALLEL_CHUNK_SIZE,
    );

    // Prepare all data structures in parallel
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

    // Assign photos to visits (and insert suggested restaurants in parallel)
    await Promise.all([
      allSuggestedRestaurants.length > 0 ? insertVisitSuggestedRestaurants(allSuggestedRestaurants) : Promise.resolve(),
      batchUpdatePhotoVisits(photoVisitUpdates),
    ]);

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
  const { samplePercentage = 0.1, confidenceThreshold = 0.3, onProgress } = options;

  const progress: FoodDetectionProgress = {
    totalVisits: 0,
    processedVisits: 0,
    totalSamples: 0,
    processedSamples: 0,
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
    (processed) => {
      progress.processedSamples = processed;
      progress.foodVisitsFound = visitFoodResults.size;
      const stats = tracker.update(processed, allSamples.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.samplesPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      progress.processedVisits = new Set(allSamples.slice(0, processed).map((s) => s.visitId)).size;
      onProgress?.(progress);
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
  onProgress?.(progress);

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
}

/** Generic batch food detection processor - shared by all food detection functions */
async function processFoodDetectionBatches<T extends FoodBatchItem>(
  items: T[],
  confidenceThreshold: number,
  onBatchComplete?: (processed: number, foodFound: number) => void,
): Promise<{ results: FoodBatchResult[]; foodFoundCount: number }> {
  const results: FoodBatchResult[] = [];
  let foodFoundCount = 0;

  for (let i = 0; i < items.length; i += FOOD_DETECTION_BATCH_SIZE) {
    const batch = items.slice(i, i + FOOD_DETECTION_BATCH_SIZE);
    const itemMap = new Map(batch.map((item) => [item.id, item]));

    try {
      const detectionResults = await detectFoodInImageBatch(
        batch.map((b) => b.id),
        { confidenceThreshold },
      );

      for (const result of detectionResults) {
        if (!itemMap.has(result.assetId)) {
          continue;
        }
        results.push({
          photoId: result.assetId,
          foodDetected: result.containsFood,
          foodLabels: result.foodLabels as FoodLabel[],
          foodConfidence: result.foodConfidence,
        });
        if (result.containsFood) {
          foodFoundCount++;
        }
      }
    } catch (error) {
      console.warn("Food detection batch failed:", error);
    }

    onBatchComplete?.(Math.min(i + FOOD_DETECTION_BATCH_SIZE, items.length), foodFoundCount);
  }

  return { results, foodFoundCount };
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

  let hasPermission = await hasCalendarPermission();
  if (!hasPermission) {
    hasPermission = await requestCalendarPermission();
  }

  if (!hasPermission) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  const visitsToProcess = await getVisitsWithoutCalendarData();
  progress.totalVisits = visitsToProcess.length;

  if (visitsToProcess.length === 0) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  onProgress?.(progress);
  const tracker = createProgressTracker();
  const BATCH_SIZE = 300;
  const calendarUpdates: CalendarEventUpdate[] = [];
  const restaurantSuggestionUpdates: { visitId: string; suggestedRestaurantId: string }[] = [];

  for (let i = 0; i < visitsToProcess.length; i += BATCH_SIZE) {
    const batch = visitsToProcess.slice(i, i + BATCH_SIZE);
    const batchVisitIds = batch.map((v) => v.id);

    const [eventMap, suggestedRestaurantsMap] = await Promise.all([
      batchFindEventsForVisits(batch),
      getSuggestedRestaurantsForVisits(batchVisitIds),
    ]);

    for (const visit of batch) {
      const event = eventMap.get(visit.id);
      if (!event) {
        continue;
      }

      calendarUpdates.push({
        visitId: visit.id,
        calendarEventId: event.id,
        calendarEventTitle: event.title,
        calendarEventLocation: event.location,
        calendarEventIsAllDay: event.isAllDay,
      });
      progress.visitsWithEvents++;

      // Try to match calendar title to a nearby restaurant
      const cleanedTitle = cleanCalendarEventTitle(event.title);
      if (cleanedTitle.length >= 3) {
        const matchedRestaurant = (suggestedRestaurantsMap.get(visit.id) ?? []).find((r) =>
          isFuzzyRestaurantMatch(cleanedTitle, r.name),
        );
        if (matchedRestaurant) {
          restaurantSuggestionUpdates.push({ visitId: visit.id, suggestedRestaurantId: matchedRestaurant.id });
        }
      }
    }

    progress.processedVisits = Math.min(i + BATCH_SIZE, visitsToProcess.length);
    const stats = tracker.update(progress.processedVisits, progress.totalVisits);
    progress.elapsedMs = stats.elapsedMs;
    progress.visitsPerSecond = stats.perSecond;
    progress.etaMs = stats.etaMs;
    onProgress?.(progress);
  }

  await Promise.all([
    calendarUpdates.length > 0 ? batchUpdateVisitsCalendarEvents(calendarUpdates) : Promise.resolve(),
    restaurantSuggestionUpdates.length > 0
      ? batchUpdateVisitSuggestedRestaurants(restaurantSuggestionUpdates)
      : Promise.resolve(),
  ]);

  progress.isComplete = true;
  progress.etaMs = 0;
  onProgress?.(progress);

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
 * When multiple Michelin restaurants share the exact same normalized name, prefer the one whose
 * location/address best matches the event location. This is NOT fuzzy name matching; it's only
 * a disambiguation step after an exact-name match.
 */
function pickBestRestaurantForEventLocation(
  matches: MichelinRestaurantRecord[],
  eventLocation: string | null,
): MichelinRestaurantRecord {
  if (matches.length === 1 || !eventLocation) {
    return matches[0];
  }

  const eventLocNorm = normalizeForComparison(eventLocation);
  let best = matches[0];
  let bestScore = -1;

  for (const r of matches) {
    const locNorm = normalizeForComparison(r.location);
    const addrNorm = normalizeForComparison(r.address);

    let score = 0;
    if (eventLocNorm.includes(addrNorm) || addrNorm.includes(eventLocNorm)) {
      score += 2;
    }
    if (eventLocNorm.includes(locNorm) || locNorm.includes(eventLocNorm)) {
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
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
  const { lookbackDays = 1000, lookforwardDays = 30 } = options;

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

    const bestMatch = pickBestRestaurantForEventLocation(matches, event.location);

    // Skip if there's already a confirmed visit to this restaurant within ±1 day
    if (hasNearbyConfirmedVisit(bestMatch.id, event.startDate)) {
      continue;
    }

    importableEvents.push({
      calendarEventId: event.id,
      calendarEventTitle: event.title,
      calendarEventLocation: event.location,
      startDate: event.startDate,
      endDate: event.endDate,
      matchedRestaurant: bestMatch,
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
 * Import specific calendar events as visits.
 * Takes an array of calendar event IDs to import.
 * The matched restaurant is auto-confirmed on the created visit.
 */
export async function importCalendarEvents(calendarEventIds: string[]): Promise<number> {
  if (calendarEventIds.length === 0) {
    return 0;
  }

  // Get all importable events
  const importableEvents = await getImportableCalendarEvents();

  // Filter to only the requested events
  const eventsToImport = importableEvents.filter((e) => calendarEventIds.includes(e.calendarEventId));

  if (eventsToImport.length === 0) {
    return 0;
  }

  const visitsToCreate = eventsToImport.map((event) => ({
    id: generateCalendarVisitHash(event.calendarEventId, event.startDate),
    calendarEventId: event.calendarEventId,
    calendarEventTitle: event.calendarEventTitle,
    calendarEventLocation: event.calendarEventLocation,
    startTime: event.startDate,
    endTime: event.endDate,
    centerLat: event.matchedRestaurant.latitude,
    centerLon: event.matchedRestaurant.longitude,
    // Pass full restaurant data for auto-confirmation
    matchedRestaurant: {
      id: event.matchedRestaurant.id,
      name: event.matchedRestaurant.name,
      latitude: event.matchedRestaurant.latitude,
      longitude: event.matchedRestaurant.longitude,
      address: event.matchedRestaurant.address,
      cuisine: event.matchedRestaurant.cuisine,
    },
  }));

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
  isComplete: boolean;
  // Speed and ETA tracking
  elapsedMs: number;
  photosPerSecond: number;
  etaMs: number | null;
}

export interface DeepScanOptions {
  confidenceThreshold?: number;
  onProgress?: (progress: DeepScanProgress) => void;
}

/**
 * Deep scan ALL photos for food detection.
 * Scans every photo in the library (not just samples).
 */
export async function deepScanAllPhotosForFood(options: DeepScanOptions = {}): Promise<DeepScanProgress> {
  const { confidenceThreshold = 0.3, onProgress } = options;

  const progress: DeepScanProgress = {
    totalPhotos: 0,
    processedPhotos: 0,
    foodPhotosFound: 0,
    isComplete: false,
    elapsedMs: 0,
    photosPerSecond: 0,
    etaMs: null,
  };

  if (!isBatchAssetInfoAvailable()) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  const allPhotos = await getAllPhotoIds();
  progress.totalPhotos = allPhotos.length;

  if (allPhotos.length === 0) {
    progress.isComplete = true;
    onProgress?.(progress);
    return progress;
  }

  onProgress?.(progress);

  const tracker = createProgressTracker();

  const { results, foodFoundCount } = await processFoodDetectionBatches(
    allPhotos,
    confidenceThreshold,
    async (processed, foodFound) => {
      progress.processedPhotos = processed;
      progress.foodPhotosFound = foodFound;
      const stats = tracker.update(processed, allPhotos.length);
      progress.elapsedMs = stats.elapsedMs;
      progress.photosPerSecond = stats.perSecond;
      progress.etaMs = stats.etaMs;
      onProgress?.(progress);
    },
  );

  // Batch update all results
  await batchUpdatePhotosFoodDetected(results);
  await syncAllVisitsFoodProbable();

  progress.foodPhotosFound = foodFoundCount;
  progress.isComplete = true;
  progress.etaMs = 0;
  onProgress?.(progress);

  return progress;
}

export interface VisitFoodScanProgress {
  totalPhotos: number;
  processedPhotos: number;
  foodPhotosFound: number;
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

  const { results, foodFoundCount } = await processFoodDetectionBatches(photos, confidenceThreshold, (processed) => {
    progress.processedPhotos = processed;
    const stats = tracker.update(processed, photos.length);
    progress.elapsedMs = stats.elapsedMs;
    progress.photosPerSecond = stats.perSecond;
    onProgress?.(progress);
  });

  if (results.length > 0) {
    await batchUpdatePhotosFoodDetected(results);
  }
  await syncAllVisitsFoodProbable();

  progress.foodPhotosFound = foodFoundCount;
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

/**
 * Run scanning, grouping visits, calendar enrichment, calendar-only visits, and food detection in sequence.
 * Note: Restaurant confirmation is now a separate user-driven process.
 */
export async function processPhotos(
  scanProgress?: (progress: {
    phase:
      | "scanning"
      | "grouping-visits"
      | "calendar-events"
      | "detecting-food"
      | "recomputing-suggested-restaurants"
      | "optimizing-database";
    detail: string;
    photosPerSecond?: number;
    eta?: string;
  }) => void,
): Promise<{
  visitsCreated: number;
  photosProcessed: number;
  foodVisitsFound: number;
  visitsWithCalendarEvents: number;
}> {
  // Import scanner dynamically to avoid circular deps

  // Phase 1: Scan photos
  scanProgress?.({ phase: "scanning", detail: "Scanning camera roll..." });

  const scanResult = await scanCameraRoll({
    onProgress: (p) => {
      scanProgress?.({
        phase: "scanning",
        detail: `Scanned ${p.processedAssets.toLocaleString()} of ${p.totalAssets.toLocaleString()} photos`,
        photosPerSecond: p.newPhotosPerSecond,
        eta: formatEta(p.etaMs),
      });
    },
  });

  // Phase 2: Group photos into visits (with Michelin suggestions)
  scanProgress?.({ phase: "grouping-visits", detail: "Grouping photos by location and time..." });

  const visitResult = await visitPhotos({
    onProgress: (p) => {
      scanProgress?.({
        phase: "grouping-visits",
        detail: `Grouped ${p.visitedPhotos.toLocaleString()} of ${p.totalPhotos.toLocaleString()}`,
        photosPerSecond: p.visitsPerSecond,
        eta: formatEta(p.etaMs),
      });
    },
  });

  // Phase 3: Enrich visits with calendar events
  scanProgress?.({ phase: "calendar-events", detail: "Matching calendar events..." });

  const calendarResult = await enrichVisitsWithCalendarEvents({
    onProgress: (p) => {
      if (!p.totalVisits) {
        return;
      }
      scanProgress?.({
        phase: "calendar-events",
        detail: `Matched ${p.visitsWithEvents.toLocaleString()} events for ${p.processedVisits.toLocaleString()} visits`,
        photosPerSecond: p.visitsPerSecond,
        eta: formatEta(p.etaMs),
      });
    },
  });

  // Phase 4: Detect food in visit photos
  scanProgress?.({ phase: "detecting-food", detail: "Analyzing photos for food..." });

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
      });
    },
  });

  scanProgress?.({ phase: "recomputing-suggested-restaurants", detail: "Recomputing suggested restaurants..." });

  await recomputeSuggestedRestaurants();

  // Phase 6: Database maintenance (VACUUM, ANALYZE, WAL checkpoint)
  scanProgress?.({ phase: "optimizing-database", detail: "Optimizing database..." });

  await performDatabaseMaintenance();

  return {
    visitsCreated: visitResult.visitsCreated,
    photosProcessed: scanResult.newPhotosAdded,
    foodVisitsFound: foodResult.foodVisitsFound,
    visitsWithCalendarEvents: calendarResult.visitsWithEvents,
  };
}
