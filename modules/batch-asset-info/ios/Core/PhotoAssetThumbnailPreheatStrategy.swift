import Foundation

enum PhotoAssetThumbnailPreheatStrategy: String, Equatable, Sendable {
  static let environmentKey = "PALATE_PHOTO_THUMBNAIL_PREHEAT_STRATEGY"

  case off
  case windowedV1 = "windowed-v1"

  static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> PhotoAssetThumbnailPreheatStrategy {
    guard
      let value = environment[environmentKey],
      let strategy = PhotoAssetThumbnailPreheatStrategy(rawValue: value)
    else {
      return .off
    }
    return strategy
  }
}
