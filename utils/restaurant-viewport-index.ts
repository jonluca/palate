import KDBush from "kdbush";

const MAX_MERCATOR_LATITUDE = 85.05112878;

export const DEFAULT_MAX_RESTAURANTS_IN_VIEW = 500;

export interface RestaurantViewportPoint {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly award: string;
}

export interface RestaurantViewportEntry<T extends RestaurantViewportPoint> {
  readonly restaurant: T;
  readonly visited: boolean;
}

export interface RestaurantViewportCamera {
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
}

export interface RestaurantViewportQuery {
  readonly camera: RestaurantViewportCamera;
  readonly width: number;
  readonly height: number;
}

export interface RestaurantViewportSelection<T extends RestaurantViewportPoint> {
  readonly entries: RestaurantViewportEntry<T>[];
  readonly totalInView: number;
}

interface ViewportBounds {
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly wrapsDateLine: boolean;
}

interface IndexedEntry<T extends RestaurantViewportPoint> extends RestaurantViewportEntry<T> {
  readonly inputIndex: number;
  readonly awardPriority: number;
}

interface RankedCandidate<T extends RestaurantViewportPoint> extends IndexedEntry<T> {
  readonly centerDistanceScore: number;
}

export function clampRestaurantMapLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function normalizeRestaurantMapLongitude(longitude: number): number {
  let normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180) {
    normalized = 180;
  }
  return normalized;
}

function mercatorScale(zoom: number): number {
  return 256 * Math.pow(2, Math.max(0, zoom));
}

function longitudeToPixelX(longitude: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  return ((normalizeRestaurantMapLongitude(longitude) + 180) / 360) * scale;
}

function latitudeToPixelY(latitude: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const clamped = clampRestaurantMapLatitude(latitude);
  const sine = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale;
}

function pixelXToLongitude(pixelX: number, zoom: number): number {
  return normalizeRestaurantMapLongitude((pixelX / mercatorScale(zoom)) * 360 - 180);
}

function pixelYToLatitude(pixelY: number, zoom: number): number {
  const scale = mercatorScale(zoom);
  const n = Math.PI - (2 * Math.PI * pixelY) / scale;
  return clampRestaurantMapLatitude((180 / Math.PI) * Math.atan(Math.sinh(n)));
}

function getViewportBounds(query: RestaurantViewportQuery): ViewportBounds | null {
  if (!query.width || !query.height) {
    return null;
  }

  const zoom = Math.max(0, query.camera.zoom);
  const scale = mercatorScale(zoom);
  const centerX = longitudeToPixelX(query.camera.longitude, zoom);
  const centerY = latitudeToPixelY(query.camera.latitude, zoom);
  const minX = centerX - query.width / 2;
  const maxX = centerX + query.width / 2;
  const minY = centerY - query.height / 2;
  const maxY = centerY + query.height / 2;
  const latitudeCoversWholeWorld = query.height >= scale;
  const longitudeCoversWholeWorld = query.width >= scale;
  const latitudeA = latitudeCoversWholeWorld
    ? -MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, maxY)), zoom);
  const latitudeB = latitudeCoversWholeWorld
    ? MAX_MERCATOR_LATITUDE
    : pixelYToLatitude(Math.min(scale, Math.max(0, minY)), zoom);
  const minLongitude = longitudeCoversWholeWorld ? -180 : pixelXToLongitude(minX, zoom);
  const maxLongitude = longitudeCoversWholeWorld ? 180 : pixelXToLongitude(maxX, zoom);

  return {
    minLatitude: Math.min(latitudeA, latitudeB),
    maxLatitude: Math.max(latitudeA, latitudeB),
    minLongitude,
    maxLongitude,
    wrapsDateLine: !longitudeCoversWholeWorld && minLongitude > maxLongitude,
  };
}

function isValidCoordinate(restaurant: RestaurantViewportPoint): boolean {
  return (
    Number.isFinite(restaurant.latitude) &&
    Number.isFinite(restaurant.longitude) &&
    restaurant.latitude >= -90 &&
    restaurant.latitude <= 90 &&
    restaurant.longitude >= -180 &&
    restaurant.longitude <= 180
  );
}

function isInBounds(restaurant: RestaurantViewportPoint, bounds: ViewportBounds): boolean {
  if (restaurant.latitude < bounds.minLatitude || restaurant.latitude > bounds.maxLatitude) {
    return false;
  }
  return bounds.wrapsDateLine
    ? restaurant.longitude >= bounds.minLongitude || restaurant.longitude <= bounds.maxLongitude
    : restaurant.longitude >= bounds.minLongitude && restaurant.longitude <= bounds.maxLongitude;
}

function getAwardPriority(award: string): number {
  const lower = award.toLowerCase();
  let score =
    lower.includes("3 stars") || lower.includes("3 star")
      ? 300
      : lower.includes("2 stars") || lower.includes("2 star")
        ? 200
        : lower.includes("1 star")
          ? 100
          : lower.includes("bib gourmand")
            ? 60
            : lower.includes("selected")
              ? 30
              : 0;
  if (lower.includes("green star")) {
    score += 10;
  }
  return score;
}

function compareCandidates<T extends RestaurantViewportPoint>(
  left: RankedCandidate<T>,
  right: RankedCandidate<T>,
): number {
  const distanceDifference = left.centerDistanceScore - right.centerDistanceScore;
  if (distanceDifference !== 0) {
    return distanceDifference;
  }
  const awardDifference = right.awardPriority - left.awardPriority;
  if (awardDifference !== 0) {
    return awardDifference;
  }
  const visitedDifference = Number(right.visited) - Number(left.visited);
  if (visitedDifference !== 0) {
    return visitedDifference;
  }
  const nameDifference = left.restaurant.name.localeCompare(right.restaurant.name);
  return nameDifference !== 0 ? nameDifference : left.inputIndex - right.inputIndex;
}

function siftWorstCandidateUp<T extends RestaurantViewportPoint>(heap: RankedCandidate<T>[], startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (compareCandidates(heap[parentIndex], heap[index]) >= 0) {
      return;
    }
    [heap[parentIndex], heap[index]] = [heap[index], heap[parentIndex]];
    index = parentIndex;
  }
}

function siftWorstCandidateDown<T extends RestaurantViewportPoint>(
  heap: RankedCandidate<T>[],
  startIndex: number,
): void {
  let index = startIndex;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) {
      return;
    }
    const rightIndex = leftIndex + 1;
    let worseChildIndex = leftIndex;
    if (rightIndex < heap.length && compareCandidates(heap[rightIndex], heap[leftIndex]) > 0) {
      worseChildIndex = rightIndex;
    }
    if (compareCandidates(heap[index], heap[worseChildIndex]) >= 0) {
      return;
    }
    [heap[index], heap[worseChildIndex]] = [heap[worseChildIndex], heap[index]];
    index = worseChildIndex;
  }
}

function retainBoundedCandidate<T extends RestaurantViewportPoint>(
  heap: RankedCandidate<T>[],
  candidate: RankedCandidate<T>,
  maximumResults: number,
): void {
  if (heap.length < maximumResults) {
    heap.push(candidate);
    siftWorstCandidateUp(heap, heap.length - 1);
    return;
  }
  if (maximumResults > 0 && compareCandidates(candidate, heap[0]) < 0) {
    heap[0] = candidate;
    siftWorstCandidateDown(heap, 0);
  }
}

/**
 * Immutable rectangular spatial index for the restaurant map viewport.
 *
 * The index is intended to be rebuilt only when the filtered restaurant set
 * changes. Camera moves then query KDBush and retain only the best bounded
 * results instead of scanning and sorting the full set on every event.
 */
export class RestaurantViewportIndex<T extends RestaurantViewportPoint> {
  readonly size: number;

  private readonly indexedEntries: readonly IndexedEntry<T>[];
  private readonly maximumResults: number;
  private readonly spatialIndex: KDBush | null;

  constructor(entries: readonly RestaurantViewportEntry<T>[], maximumResults = DEFAULT_MAX_RESTAURANTS_IN_VIEW) {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 0) {
      throw new RangeError(`maximumResults must be a non-negative integer; received ${maximumResults}`);
    }

    this.maximumResults = maximumResults;
    this.indexedEntries = entries.flatMap((entry, inputIndex) =>
      isValidCoordinate(entry.restaurant)
        ? [{ ...entry, inputIndex, awardPriority: getAwardPriority(entry.restaurant.award) }]
        : [],
    );
    this.size = this.indexedEntries.length;

    if (this.size === 0) {
      this.spatialIndex = null;
      return;
    }

    const spatialIndex = new KDBush(this.size);
    for (const entry of this.indexedEntries) {
      spatialIndex.add(entry.restaurant.longitude, entry.restaurant.latitude);
    }
    spatialIndex.finish();
    this.spatialIndex = spatialIndex;
  }

  select(query: RestaurantViewportQuery): RestaurantViewportSelection<T> {
    const bounds = getViewportBounds(query);
    if (!bounds || !this.spatialIndex) {
      return { entries: [], totalInView: 0 };
    }

    const candidateIndexGroups = bounds.wrapsDateLine
      ? [
          this.spatialIndex.range(bounds.minLongitude, bounds.minLatitude, 180, bounds.maxLatitude),
          this.spatialIndex.range(-180, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude),
        ]
      : [this.spatialIndex.range(bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude)];

    const zoom = Math.max(0, query.camera.zoom);
    const scale = mercatorScale(zoom);
    const centerX = longitudeToPixelX(query.camera.longitude, zoom);
    const centerY = latitudeToPixelY(query.camera.latitude, zoom);
    const topCandidates: RankedCandidate<T>[] = [];
    let totalInView = 0;

    for (const candidateIndexes of candidateIndexGroups) {
      for (const inputIndex of candidateIndexes) {
        const indexedEntry = this.indexedEntries[inputIndex];
        if (!indexedEntry || !isInBounds(indexedEntry.restaurant, bounds)) {
          continue;
        }
        totalInView += 1;
        if (this.maximumResults === 0) {
          continue;
        }

        const restaurantX = longitudeToPixelX(indexedEntry.restaurant.longitude, zoom);
        const restaurantY = latitudeToPixelY(indexedEntry.restaurant.latitude, zoom);
        let deltaX = Math.abs(restaurantX - centerX);
        deltaX = Math.min(deltaX, scale - deltaX);
        const deltaY = restaurantY - centerY;
        retainBoundedCandidate(
          topCandidates,
          {
            ...indexedEntry,
            centerDistanceScore: deltaX * deltaX + deltaY * deltaY,
          },
          this.maximumResults,
        );
      }
    }

    topCandidates.sort(compareCandidates);
    return {
      entries: topCandidates,
      totalInView,
    };
  }
}
