/**
 * Gate only the per-scan process-local Michelin index build. Guide import and
 * versioned pending-suggestion refresh intentionally happen before this check.
 */
export function hasVisitPhotosForSpatialWork(unvisitedPhotoCount: number): boolean {
  if (!Number.isSafeInteger(unvisitedPhotoCount) || unvisitedPhotoCount < 0) {
    throw new RangeError(`Unvisited photo count must be a non-negative safe integer; received ${unvisitedPhotoCount}.`);
  }
  return unvisitedPhotoCount > 0;
}
