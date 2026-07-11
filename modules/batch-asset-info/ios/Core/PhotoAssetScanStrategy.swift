import Foundation

enum PhotoAssetScanStrategy: String, Equatable, Sendable {
  static let environmentKey = "PALATE_PHOTO_SCAN_STRATEGY"

  case legacy
  case incremental

  static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> PhotoAssetScanStrategy {
    guard
      let value = environment[environmentKey],
      let strategy = PhotoAssetScanStrategy(rawValue: value)
    else {
      return .incremental
    }
    return strategy
  }
}
