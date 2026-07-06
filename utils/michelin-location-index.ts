import * as geokdbush from "geokdbush";
import KDBush from "kdbush";

const EARTH_RADIUS_METERS = 6_371_000;
const MIN_RADIUS_BOUNDARY_TOLERANCE_METERS = 1e-7;

/** A Michelin restaurant coordinate that can be stored in {@link MichelinLocationIndex}. */
export interface MichelinLocation {
  /** Stable identifier used to break equal-distance ties deterministically. */
  readonly id: string;
  /** Latitude in degrees, inclusive of -90 and 90. */
  readonly latitude: number;
  /** Longitude in degrees, inclusive of -180 and 180. */
  readonly longitude: number;
}

/** Options for {@link MichelinLocationIndex.findNearby}. */
export interface MichelinLocationSearchOptions {
  /** Search-center latitude in degrees. */
  readonly latitude: number;
  /** Search-center longitude in degrees. */
  readonly longitude: number;
  /** Inclusive great-circle search radius in meters. */
  readonly radiusMeters: number;
  /** Maximum number of matches to return. Defaults to all matches in the radius. */
  readonly limit?: number;
}

/** A distance-sorted result returned by {@link MichelinLocationIndex.findNearby}. */
export interface MichelinLocationMatch<T extends MichelinLocation> {
  /** The indexed restaurant. */
  readonly restaurant: T;
  /** Great-circle distance from the search center in meters. */
  readonly distanceMeters: number;
}

interface IndexedMatch<T extends MichelinLocation> extends MichelinLocationMatch<T> {
  readonly inputIndex: number;
}

function assertCoordinate(name: "latitude" | "longitude", value: number): void {
  const limit = name === "latitude" ? 90 : 180;
  if (!Number.isFinite(value) || value < -limit || value > limit) {
    throw new RangeError(`${name} must be a finite number between ${-limit} and ${limit}; received ${value}`);
  }
}

function compareStringsByCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function radiusBoundaryToleranceMeters(radiusMeters: number): number {
  if (radiusMeters === 0) {
    return 0;
  }
  return Math.max(MIN_RADIUS_BOUNDARY_TOLERANCE_METERS, radiusMeters * 1e-12);
}

/**
 * Calculates the shortest great-circle distance between two WGS84-style coordinates on a spherical Earth.
 *
 * Longitudes wrap across the antimeridian, and zero-valued coordinates are valid.
 */
export function calculateGeodesicDistanceMeters(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  assertCoordinate("latitude", latitude1);
  assertCoordinate("longitude", longitude1);
  assertCoordinate("latitude", latitude2);
  assertCoordinate("longitude", longitude2);

  const degreesToRadians = Math.PI / 180;
  const latitude1Radians = latitude1 * degreesToRadians;
  const latitude2Radians = latitude2 * degreesToRadians;
  const latitudeDelta = (latitude2 - latitude1) * degreesToRadians;
  const wrappedLongitudeDelta = ((((longitude2 - longitude1 + 180) % 360) + 360) % 360) - 180;
  const longitudeDelta = wrappedLongitudeDelta * degreesToRadians;
  const latitudeSine = Math.sin(latitudeDelta / 2);
  const longitudeSine = Math.sin(longitudeDelta / 2);
  const haversine =
    latitudeSine * latitudeSine +
    Math.cos(latitude1Radians) * Math.cos(latitude2Radians) * longitudeSine * longitudeSine;
  const clampedHaversine = Math.min(1, Math.max(0, haversine));
  const centralAngle = 2 * Math.atan2(Math.sqrt(clampedHaversine), Math.sqrt(1 - clampedHaversine));
  const distanceMeters = EARTH_RADIUS_METERS * centralAngle;

  return distanceMeters < 1e-9 ? 0 : distanceMeters;
}

/**
 * Immutable spatial index for deterministic Michelin restaurant proximity searches.
 *
 * Search results use inclusive great-circle radius semantics and are ordered by distance,
 * then restaurant ID, then original input order.
 */
export class MichelinLocationIndex<T extends MichelinLocation> {
  readonly size: number;

  private readonly restaurants: readonly T[];
  private readonly spatialIndex: KDBush;

  constructor(restaurants: readonly T[]) {
    this.restaurants = restaurants.slice();
    this.size = this.restaurants.length;
    this.spatialIndex = new KDBush(this.size);

    for (const restaurant of this.restaurants) {
      assertCoordinate("latitude", restaurant.latitude);
      assertCoordinate("longitude", restaurant.longitude);
      this.spatialIndex.add(restaurant.longitude, restaurant.latitude);
    }

    this.spatialIndex.finish();
  }

  /**
   * Finds restaurants within an inclusive geodesic radius.
   *
   * @throws {RangeError} When coordinates, radius, or limit are outside their documented ranges.
   */
  findNearby(options: MichelinLocationSearchOptions): MichelinLocationMatch<T>[] {
    assertCoordinate("latitude", options.latitude);
    assertCoordinate("longitude", options.longitude);

    if (!Number.isFinite(options.radiusMeters) || options.radiusMeters < 0) {
      throw new RangeError(`radiusMeters must be a finite non-negative number; received ${options.radiusMeters}`);
    }

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError(`limit must be a non-negative integer or Infinity; received ${limit}`);
    }
    if (limit === 0 || this.size === 0) {
      return [];
    }

    const boundaryToleranceMeters = radiusBoundaryToleranceMeters(options.radiusMeters);
    const candidateIndexes = geokdbush.around(
      this.spatialIndex,
      options.longitude,
      options.latitude,
      Number.POSITIVE_INFINITY,
      (options.radiusMeters + boundaryToleranceMeters) / 1000,
    );
    const matches: IndexedMatch<T>[] = [];

    for (const inputIndex of candidateIndexes) {
      const restaurant = this.restaurants[inputIndex];
      const distanceMeters = calculateGeodesicDistanceMeters(
        options.latitude,
        options.longitude,
        restaurant.latitude,
        restaurant.longitude,
      );
      if (distanceMeters <= options.radiusMeters + boundaryToleranceMeters) {
        matches.push({ restaurant, distanceMeters, inputIndex });
      }
    }

    matches.sort((left, right) => {
      const distanceDifference = left.distanceMeters - right.distanceMeters;
      if (distanceDifference !== 0) {
        return distanceDifference;
      }

      const idDifference = compareStringsByCodeUnit(left.restaurant.id, right.restaurant.id);
      return idDifference !== 0 ? idDifference : left.inputIndex - right.inputIndex;
    });

    return matches.slice(0, limit).map(({ restaurant, distanceMeters }) => ({ restaurant, distanceMeters }));
  }
}
