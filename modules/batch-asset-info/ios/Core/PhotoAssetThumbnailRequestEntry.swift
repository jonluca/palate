import Photos

enum PhotoAssetThumbnailRequestPhase {
  case pending
  case waitingForAsset
  case requesting
}

struct PhotoAssetThumbnailRequestEntry {
  let id: UUID
  var subscribers: [UUID: PhotoAssetThumbnailSubscriber]
  var phase: PhotoAssetThumbnailRequestPhase
  var requestId: PHImageRequestID?
  var latestDegradedImage: PhotoAssetThumbnailImage?

  func acceptsImageResult(from entryId: UUID) -> Bool {
    id == entryId
  }
}
