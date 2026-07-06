public enum PhotoAssetThumbnailEvent: @unchecked Sendable {
  case image(PhotoAssetThumbnailImage, isDegraded: Bool)
  case failure(PhotoAssetThumbnailError)
}
