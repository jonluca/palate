@preconcurrency import Photos

enum PhotoAssetThumbnailAssetFetchResult: @unchecked Sendable {
  case success([String: PHAsset])
  case failure(PhotoAssetThumbnailError)
}
