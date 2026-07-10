struct PhotoAssetClassificationImageResult: @unchecked Sendable {
  let image: PhotoAssetThumbnailImage?
  let isDegraded: Bool
  let isCancelled: Bool
  let errorDescription: String?
}
