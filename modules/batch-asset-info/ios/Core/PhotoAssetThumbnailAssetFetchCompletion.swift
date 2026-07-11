public struct PhotoAssetThumbnailAssetFetchCompletion: Equatable, Sendable {
  /// Whether the completed batch's results belong to the current cache generation. An invalidated
  /// physical worker can return `false` together with the next current-generation batch to start.
  public let accepted: Bool
  public let nextBatch: PhotoAssetThumbnailAssetFetchBatch?
}
