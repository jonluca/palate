public struct PhotoAssetThumbnailAssetFetchBatch: Equatable, Sendable {
  public let sequence: UInt64
  public let cacheGeneration: UInt64
  public let priority: PhotoAssetThumbnailAssetFetchPriority
  public let identifiers: [String]
}
