import { isValidVisitPhotoCoordinate, type VisitPhotoCoordinate } from "./visit-photo-proximity-core.ts";

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGENERATE_VECTOR_ULPS_PER_COORDINATE = 8;

export interface VisitPhotoCentroid {
  readonly latitude: number;
  readonly longitude: number;
}

function canonicalCrossingLongitude(longitude: number): number {
  if (longitude === 180) {
    return -180;
  }
  return Object.is(longitude, -0) ? 0 : longitude;
}

/**
 * Calculate an equal-weight centroid while preserving the former arithmetic result exactly for
 * ordinary groups. Latitude is always the arithmetic mean. Longitude also remains the literal
 * arithmetic mean unless the input range exceeds 180°, which identifies an antimeridian crossing.
 *
 * Crossing groups use a circular longitude mean so ±180° neighbors remain near the date line. If
 * their longitude vectors cancel, the first longitude is the deterministic fallback; photo order
 * is already stable by creation time and asset ID.
 */
export function calculateVisitPhotoCentroid(coordinates: readonly VisitPhotoCoordinate[]): VisitPhotoCentroid | null {
  const firstCoordinate = coordinates[0];
  if (!firstCoordinate) {
    return null;
  }

  let latitudeSum = 0;
  let longitudeSum = 0;
  let minimumLongitude = 180;
  let maximumLongitude = -180;
  for (const coordinate of coordinates) {
    if (!isValidVisitPhotoCoordinate(coordinate)) {
      return null;
    }

    latitudeSum += coordinate.latitude;
    longitudeSum += coordinate.longitude;
    minimumLongitude = Math.min(minimumLongitude, coordinate.longitude);
    maximumLongitude = Math.max(maximumLongitude, coordinate.longitude);
  }

  const latitude = latitudeSum / coordinates.length;
  if (maximumLongitude - minimumLongitude <= 180) {
    return { latitude, longitude: longitudeSum / coordinates.length };
  }

  let longitudeX = 0;
  let longitudeY = 0;
  for (const coordinate of coordinates) {
    const longitudeRadians = coordinate.longitude * DEGREES_TO_RADIANS;
    longitudeX += Math.cos(longitudeRadians);
    longitudeY += Math.sin(longitudeRadians);
  }

  const magnitude = Math.hypot(longitudeX, longitudeY);
  const degenerateThreshold = coordinates.length * DEGENERATE_VECTOR_ULPS_PER_COORDINATE * Number.EPSILON;
  if (magnitude <= degenerateThreshold) {
    return {
      latitude,
      longitude: canonicalCrossingLongitude(firstCoordinate.longitude),
    };
  }

  return {
    latitude,
    longitude: canonicalCrossingLongitude(Math.atan2(longitudeY, longitudeX) * RADIANS_TO_DEGREES),
  };
}
