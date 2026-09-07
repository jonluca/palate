interface DeepScanResult {
  processedPhotos: number;
  foodPhotosFound: number;
  retryableFailures: number;
}

export function getDeepScanSummary(result: DeepScanResult): {
  type: "success" | "info" | "error";
  message: string;
} {
  const analyzedPhotos = Math.max(0, result.processedPhotos - result.retryableFailures);
  const failedPhotos = result.retryableFailures;
  const photoCount = (count: number) => `${count.toLocaleString()} photo${count === 1 ? "" : "s"}`;

  if (analyzedPhotos === 0) {
    return failedPhotos > 0
      ? { type: "error", message: `Could not analyze ${photoCount(failedPhotos)}.` }
      : { type: "info", message: "No photos available to deep scan." };
  }

  const message = `Found ${result.foodPhotosFound.toLocaleString()} food photo${result.foodPhotosFound === 1 ? "" : "s"} in ${analyzedPhotos.toLocaleString()} analyzed photo${analyzedPhotos === 1 ? "" : "s"}`;
  return failedPhotos > 0
    ? { type: "info", message: `${message}; ${photoCount(failedPhotos)} could not be analyzed` }
    : { type: "success", message };
}
