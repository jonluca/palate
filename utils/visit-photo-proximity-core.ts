const DEGREES_TO_RADIANS = Math.PI / 180;
const EARTH_RADIUS_METERS = 6_371_000;
const MAXIMUM_GREAT_CIRCLE_DISTANCE_METERS = Math.PI * EARTH_RADIUS_METERS;
const HAVERSINE_BOUNDARY_ULPS = 16;
const NEAR_ANTIPODAL_HAVERSINE = 0.99;
const ORDINARY_MAXIMUM_ABSOLUTE_LATITUDE = 70;
const ORDINARY_MAXIMUM_THRESHOLD_METERS = 1_000;
const ORDINARY_MINIMUM_LATITUDE_COSINE = Math.cos(ORDINARY_MAXIMUM_ABSOLUTE_LATITUDE * DEGREES_TO_RADIANS);

/** Minimal coordinate shape needed when deciding whether adjacent photos belong to one visit. */
export interface VisitPhotoCoordinate {
  /** Latitude in degrees, inclusive of -90 and 90. */
  readonly latitude: number;
  /** Longitude in degrees, inclusive of -180 and 180. */
  readonly longitude: number;
}

/** Precomputed comparison state for a distance threshold reused across a photo scan. */
export interface PreparedVisitPhotoDistanceThreshold {
  readonly meters: number;
  readonly maximumLatitudeDeltaDegrees: number;
  readonly maximumHaversine: number;
  readonly includesWholeSphere: boolean;
  readonly ordinaryLongitudeRejectDegrees: number | null;
}

function isValidCoordinateValues(latitude: number, longitude: number): boolean {
  return (
    typeof latitude === "number" &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Runtime validation for coordinates read from the local database or a native boundary. */
export function isValidVisitPhotoCoordinate(coordinate: VisitPhotoCoordinate): boolean {
  return isValidCoordinateValues(coordinate.latitude, coordinate.longitude);
}

/**
 * Returns the signed shortest longitude delta in the inclusive-input range [-180, 180].
 *
 * Both inputs must already be valid longitudes. A single adjustment is sufficient because
 * their raw difference is necessarily within [-360, 360].
 */
function shortestLongitudeDeltaDegrees(longitude1: number, longitude2: number): number {
  const delta = longitude2 - longitude1;
  if (delta > 180) {
    return delta - 360;
  }
  if (delta < -180) {
    return delta + 360;
  }
  return delta;
}

function clampedHaversine(
  latitude1: number,
  latitude2: number,
  latitudeDeltaRadians: number,
  longitudeDeltaRadians: number,
): number {
  if (latitudeDeltaRadians === 0 && (longitudeDeltaRadians === 0 || latitude1 === 90 || latitude1 === -90)) {
    return 0;
  }

  const latitudeHalfSine = Math.sin(latitudeDeltaRadians / 2);
  const longitudeHalfSine = Math.sin(longitudeDeltaRadians / 2);
  const longitudeHaversine =
    Math.cos(latitude1 * DEGREES_TO_RADIANS) *
    Math.cos(latitude2 * DEGREES_TO_RADIANS) *
    longitudeHalfSine *
    longitudeHalfSine;
  const haversine = latitudeHalfSine * latitudeHalfSine + longitudeHaversine;
  return Math.max(0, Math.min(1, haversine));
}

function distanceMetersForHaversine(haversine: number): number {
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
}

function nearAntipodalDistanceMeters(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const latitude1Radians = latitude1 * DEGREES_TO_RADIANS;
  const latitude2Radians = latitude2 * DEGREES_TO_RADIANS;
  const longitude1Radians = longitude1 * DEGREES_TO_RADIANS;
  const longitude2Radians = longitude2 * DEGREES_TO_RADIANS;
  const latitude1Scale = Math.cos(latitude1Radians);
  const latitude2Scale = Math.cos(latitude2Radians);
  const coordinate1X = latitude1Scale * Math.cos(longitude1Radians);
  const coordinate1Y = latitude1Scale * Math.sin(longitude1Radians);
  const coordinate1Z = Math.sin(latitude1Radians);
  const coordinate2X = latitude2Scale * Math.cos(longitude2Radians);
  const coordinate2Y = latitude2Scale * Math.sin(longitude2Radians);
  const coordinate2Z = Math.sin(latitude2Radians);
  const crossX = coordinate1Y * coordinate2Z - coordinate1Z * coordinate2Y;
  const crossY = coordinate1Z * coordinate2X - coordinate1X * coordinate2Z;
  const crossZ = coordinate1X * coordinate2Y - coordinate1Y * coordinate2X;
  const sine = Math.hypot(crossX, crossY, crossZ);
  const cosine = Math.max(
    -1,
    Math.min(1, coordinate1X * coordinate2X + coordinate1Y * coordinate2Y + coordinate1Z * coordinate2Z),
  );
  return EARTH_RADIUS_METERS * Math.atan2(sine, cosine);
}

/** Validate and precompute a threshold once before an adjacent-photo grouping loop. */
export function prepareVisitPhotoDistanceThreshold(
  thresholdMeters: number,
): PreparedVisitPhotoDistanceThreshold | null {
  if (!Number.isFinite(thresholdMeters) || thresholdMeters < 0) {
    return null;
  }

  if (thresholdMeters >= MAXIMUM_GREAT_CIRCLE_DISTANCE_METERS) {
    return {
      meters: thresholdMeters,
      maximumLatitudeDeltaDegrees: 180,
      maximumHaversine: 1,
      includesWholeSphere: true,
      ordinaryLongitudeRejectDegrees: null,
    };
  }

  const thresholdHalfSine = Math.sin(thresholdMeters / (2 * EARTH_RADIUS_METERS));
  const maximumHaversine = thresholdHalfSine * thresholdHalfSine;
  const ordinaryLongitudeRejectDegrees =
    thresholdMeters <= ORDINARY_MAXIMUM_THRESHOLD_METERS
      ? (2 * Math.asin(Math.sqrt(maximumHaversine) / ORDINARY_MINIMUM_LATITUDE_COSINE)) / DEGREES_TO_RADIANS
      : null;
  return {
    meters: thresholdMeters,
    maximumLatitudeDeltaDegrees: thresholdMeters / (EARTH_RADIUS_METERS * DEGREES_TO_RADIANS),
    maximumHaversine,
    includesWholeSphere: false,
    ordinaryLongitudeRejectDegrees,
  };
}

/**
 * Calculates the spherical great-circle distance used for adjacent-photo grouping.
 *
 * The Haversine formulation stays stable at short distances, across the antimeridian, and near
 * either pole. Invalid coordinates return `null` so a corrupt row cannot be grouped by accident.
 */
export function calculateVisitPhotoDistanceMeters(
  coordinate1: VisitPhotoCoordinate,
  coordinate2: VisitPhotoCoordinate,
): number | null {
  if (!isValidVisitPhotoCoordinate(coordinate1) || !isValidVisitPhotoCoordinate(coordinate2)) {
    return null;
  }

  const latitudeDeltaRadians = (coordinate2.latitude - coordinate1.latitude) * DEGREES_TO_RADIANS;
  const longitudeDeltaRadians =
    shortestLongitudeDeltaDegrees(coordinate1.longitude, coordinate2.longitude) * DEGREES_TO_RADIANS;
  const haversine = clampedHaversine(
    coordinate1.latitude,
    coordinate2.latitude,
    latitudeDeltaRadians,
    longitudeDeltaRadians,
  );
  if (haversine > NEAR_ANTIPODAL_HAVERSINE) {
    return nearAntipodalDistanceMeters(
      coordinate1.latitude,
      coordinate1.longitude,
      coordinate2.latitude,
      coordinate2.longitude,
    );
  }
  return distanceMetersForHaversine(haversine);
}

/** Compare two coordinates using threshold state prepared once for the surrounding scan. */
export function areVisitPhotosNearbyWithPreparedThreshold(
  coordinate1: VisitPhotoCoordinate,
  coordinate2: VisitPhotoCoordinate,
  threshold: PreparedVisitPhotoDistanceThreshold,
): boolean {
  const latitude1 = coordinate1.latitude;
  const longitude1 = coordinate1.longitude;
  const latitude2 = coordinate2.latitude;
  const longitude2 = coordinate2.longitude;
  if (!isValidCoordinateValues(latitude1, longitude1) || !isValidCoordinateValues(latitude2, longitude2)) {
    return false;
  }

  if (threshold.includesWholeSphere) {
    return true;
  }

  const latitudeDeltaDegrees = latitude2 - latitude1;
  // Great-circle distance cannot be shorter than the absolute latitude difference.
  if (Math.abs(latitudeDeltaDegrees) > threshold.maximumLatitudeDeltaDegrees) {
    return false;
  }

  const latitudeDeltaRadians = latitudeDeltaDegrees * DEGREES_TO_RADIANS;
  const longitudeDeltaDegrees = shortestLongitudeDeltaDegrees(longitude1, longitude2);
  const longitudeDeltaRadians = longitudeDeltaDegrees * DEGREES_TO_RADIANS;
  if (
    threshold.ordinaryLongitudeRejectDegrees !== null &&
    Math.abs(latitude1) <= ORDINARY_MAXIMUM_ABSOLUTE_LATITUDE &&
    Math.abs(latitude2) <= ORDINARY_MAXIMUM_ABSOLUTE_LATITUDE
  ) {
    // Within this latitude band, cos(latitude1) * cos(latitude2) is at least cos(70°)^2.
    // The precomputed longitude limit is therefore a true lower-bound rejection, not a planar
    // approximation. Remaining small deltas can usually be decided from rigorous sin² bounds
    // using one cosine; only values at the threshold fall through to exact Haversine trig.
    if (Math.abs(longitudeDeltaDegrees) > threshold.ordinaryLongitudeRejectDegrees) {
      return false;
    }

    const latitudeHalfDelta = latitudeDeltaRadians / 2;
    const longitudeHalfDelta = longitudeDeltaRadians / 2;
    const latitudeHalfDeltaSquared = latitudeHalfDelta * latitudeHalfDelta;
    const longitudeHalfDeltaSquared = longitudeHalfDelta * longitudeHalfDelta;
    const latitudeLowerSineSquared = latitudeHalfDeltaSquared * (1 - latitudeHalfDeltaSquared / 3);
    const longitudeLowerSineSquared = longitudeHalfDeltaSquared * (1 - longitudeHalfDeltaSquared / 3);
    const averageLatitudeCosine = Math.cos(((latitude1 + latitude2) / 2) * DEGREES_TO_RADIANS);
    const averageLatitudeCosineSquared = averageLatitudeCosine * averageLatitudeCosine;
    const lowerHaversine =
      latitudeLowerSineSquared +
      averageLatitudeCosineSquared * longitudeLowerSineSquared -
      latitudeLowerSineSquared * longitudeLowerSineSquared;
    const upperHaversine =
      latitudeHalfDeltaSquared +
      averageLatitudeCosineSquared * longitudeHalfDeltaSquared -
      latitudeHalfDeltaSquared * longitudeHalfDeltaSquared;
    if (upperHaversine <= threshold.maximumHaversine) {
      return true;
    }
    if (lowerHaversine > threshold.maximumHaversine) {
      return false;
    }
  }

  const haversine = clampedHaversine(latitude1, latitude2, latitudeDeltaRadians, longitudeDeltaRadians);
  if (haversine > NEAR_ANTIPODAL_HAVERSINE && threshold.maximumHaversine > NEAR_ANTIPODAL_HAVERSINE) {
    return nearAntipodalDistanceMeters(latitude1, longitude1, latitude2, longitude2) <= threshold.meters;
  }
  const difference = haversine - threshold.maximumHaversine;
  const boundaryTolerance =
    HAVERSINE_BOUNDARY_ULPS * Number.EPSILON * Math.max(haversine, threshold.maximumHaversine, Number.MIN_VALUE);

  if (Math.abs(difference) > boundaryTolerance) {
    return difference < 0;
  }

  // Resolve exact and near-exact boundaries with the same stable inverse used by the public
  // distance function. Ordinary comparisons avoid this relatively expensive conversion.
  return distanceMetersForHaversine(haversine) <= threshold.meters;
}

/** Returns whether two valid photo coordinates are within an inclusive distance threshold. */
export function areVisitPhotosNearby(
  coordinate1: VisitPhotoCoordinate,
  coordinate2: VisitPhotoCoordinate,
  thresholdMeters: number,
): boolean {
  const threshold = prepareVisitPhotoDistanceThreshold(thresholdMeters);
  return threshold !== null && areVisitPhotosNearbyWithPreparedThreshold(coordinate1, coordinate2, threshold);
}
