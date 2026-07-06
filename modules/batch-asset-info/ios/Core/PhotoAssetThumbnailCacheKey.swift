import Foundation

final class PhotoAssetThumbnailCacheKey: NSObject {
  let requestKey: PhotoAssetThumbnailRequestKey

  init(_ requestKey: PhotoAssetThumbnailRequestKey) {
    self.requestKey = requestKey
  }

  override var hash: Int {
    requestKey.hashValue
  }

  override func isEqual(_ object: Any?) -> Bool {
    guard let other = object as? PhotoAssetThumbnailCacheKey else {
      return false
    }
    return requestKey == other.requestKey
  }
}
