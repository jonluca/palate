public struct PhotoAssetThumbnailPreheatAssetBinding<Asset> {
  public let key: PhotoAssetThumbnailRequestKey
  public let asset: Asset

  public init(key: PhotoAssetThumbnailRequestKey, asset: Asset) {
    self.key = key
    self.asset = asset
  }
}
