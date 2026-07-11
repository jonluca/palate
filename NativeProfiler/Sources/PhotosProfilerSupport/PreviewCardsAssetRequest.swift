import BatchAssetInfoCore
import Foundation

struct PreviewCardsAssetRequest: Sendable {
  let identifier: String
  let target: PhotoAssetThumbnailTarget
}
