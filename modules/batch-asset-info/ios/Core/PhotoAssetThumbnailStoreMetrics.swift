public struct PhotoAssetThumbnailStoreMetrics: Equatable, Sendable {
  public let assetFetchBatchCount: Int
  public let assetFetchIdentifierCount: Int
  public let imageRequestCount: Int
  public let assetFetchScheduler: PhotoAssetThumbnailAssetFetchSchedulerMetrics
  public let preheat: PhotoAssetThumbnailPreheatRuntimeMetrics

  public init(
    assetFetchBatchCount: Int,
    assetFetchIdentifierCount: Int,
    imageRequestCount: Int,
    assetFetchScheduler: PhotoAssetThumbnailAssetFetchSchedulerMetrics = .zero,
    preheat: PhotoAssetThumbnailPreheatRuntimeMetrics
  ) {
    self.assetFetchBatchCount = assetFetchBatchCount
    self.assetFetchIdentifierCount = assetFetchIdentifierCount
    self.imageRequestCount = imageRequestCount
    self.assetFetchScheduler = assetFetchScheduler
    self.preheat = preheat
  }
}
