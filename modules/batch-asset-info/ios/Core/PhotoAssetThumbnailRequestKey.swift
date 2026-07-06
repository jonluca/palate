public struct PhotoAssetThumbnailRequestKey: Hashable, Sendable {
  public let assetIdentifier: String
  public let target: PhotoAssetThumbnailTarget
  public let contentMode: PhotoAssetThumbnailContentMode

  public init(
    assetIdentifier: String,
    target: PhotoAssetThumbnailTarget,
    contentMode: PhotoAssetThumbnailContentMode = .aspectFill
  ) throws {
    guard !assetIdentifier.isEmpty else {
      throw PhotoAssetThumbnailError.invalidAssetIdentifier
    }

    self.assetIdentifier = assetIdentifier
    self.target = target
    self.contentMode = contentMode
  }
}
