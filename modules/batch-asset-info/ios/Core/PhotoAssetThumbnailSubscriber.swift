import Foundation

struct PhotoAssetThumbnailSubscriber: @unchecked Sendable {
  let id: UUID
  let token: PhotoAssetThumbnailRequestToken
  let completion: @Sendable (PhotoAssetThumbnailEvent) -> Void
}
