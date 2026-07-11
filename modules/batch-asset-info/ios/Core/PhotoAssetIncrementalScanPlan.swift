import Foundation

struct PhotoAssetIncrementalScanPlan: Equatable, Sendable {
  let unknownAssetIndexes: [Int]
  let excludedVisibleCount: Int
  let excludedPhotosWithLocation: Int
  let excludedSkippedAssets: Int

  init(
    assetCount: Int,
    existingAssetIdentifiers: [String],
    assetAt: (Int) -> (
      identifier: String,
      excludedMetrics: () -> PhotoAssetScanStoredMetrics
    )
  ) {
    precondition(assetCount >= 0, "Photo asset count cannot be negative")

    let existingIdentifiers = Set(existingAssetIdentifiers)
    self.init(
      assetCount: assetCount,
      estimatedExistingCount: existingIdentifiers.count,
      existingMetricsAt: { index in
        let asset = assetAt(index)
        guard existingIdentifiers.contains(asset.identifier) else {
          return nil
        }
        return asset.excludedMetrics()
      }
    )
  }

  init(
    assetCount: Int,
    storedMetricsByIdentifier: [String: PhotoAssetScanStoredMetrics],
    identifierAt: (Int) -> String
  ) {
    precondition(assetCount >= 0, "Photo asset count cannot be negative")

    self.init(
      assetCount: assetCount,
      estimatedExistingCount: storedMetricsByIdentifier.count,
      existingMetricsAt: { index in
        storedMetricsByIdentifier[identifierAt(index)]
      }
    )
  }

  private init(
    assetCount: Int,
    estimatedExistingCount: Int,
    existingMetricsAt: (Int) -> PhotoAssetScanStoredMetrics?
  ) {
    var unknownIndexes: [Int] = []
    unknownIndexes.reserveCapacity(max(0, assetCount - estimatedExistingCount))
    var visibleCount = 0
    var photosWithLocation = 0
    var skippedAssets = 0

    for index in 0..<assetCount {
      guard let metrics = existingMetricsAt(index) else {
        unknownIndexes.append(index)
        continue
      }

      visibleCount += 1
      if !metrics.hasUsableCreationTime {
        skippedAssets += 1
      } else if metrics.hasValidLocation {
        photosWithLocation += 1
      }
    }

    unknownAssetIndexes = unknownIndexes
    excludedVisibleCount = visibleCount
    excludedPhotosWithLocation = photosWithLocation
    excludedSkippedAssets = skippedAssets
  }
}
