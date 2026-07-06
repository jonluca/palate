final class PhotoAssetThumbnailCachedImage: @unchecked Sendable {
  let image: PhotoAssetThumbnailImage
  let cost: Int

  init(_ image: PhotoAssetThumbnailImage) {
    self.image = image
    cost = photoAssetThumbnailImageCost(image)
  }
}
