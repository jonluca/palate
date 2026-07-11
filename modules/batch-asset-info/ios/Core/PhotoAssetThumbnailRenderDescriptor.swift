@preconcurrency import Photos

public struct PhotoAssetThumbnailRenderDescriptor: Hashable, Sendable {
  public let target: PhotoAssetThumbnailTarget
  public let contentMode: PhotoAssetThumbnailContentMode

  public init(
    target: PhotoAssetThumbnailTarget,
    contentMode: PhotoAssetThumbnailContentMode
  ) {
    self.target = target
    self.contentMode = contentMode
  }

  /// PhotoKit requires every preheat option value to exactly match the later image request.
  /// Return a fresh mutable options object for each call while retaining one canonical value set.
  func makePhotoKitOptions() -> PHImageRequestOptions {
    let options = PHImageRequestOptions()
    options.isSynchronous = false
    options.version = .current
    options.deliveryMode = .opportunistic
    options.resizeMode = .exact
    options.normalizedCropRect = .zero
    options.isNetworkAccessAllowed = true
    return options
  }
}
