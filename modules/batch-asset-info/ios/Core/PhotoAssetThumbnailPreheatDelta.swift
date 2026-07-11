public struct PhotoAssetThumbnailPreheatDelta: Equatable, Sendable {
  public let requestedGeneration: UInt64
  public let activeGeneration: UInt64
  public let transition: PhotoAssetThumbnailPreheatTransition
  public let starts: [PhotoAssetThumbnailRequestKey]
  public let stops: [PhotoAssetThumbnailRequestKey]
  public let retained: [PhotoAssetThumbnailRequestKey]
  public let activeKeys: [PhotoAssetThumbnailRequestKey]
  public let activePixelCount: UInt64
  public let activeEstimatedByteCount: UInt64
}
