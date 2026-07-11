import Foundation

enum PhotoAssetVisitFoodDetectionStrategy: String, Equatable, Sendable {
  static let environmentKey = "PALATE_VISIT_FOOD_DETECTION_STRATEGY"
  static let defaultValue = PhotoAssetVisitFoodDetectionStrategy.rank3BulkTailV1

  case fullPlanV1 = "full-plan-v1"
  case rank3BulkTailV1 = "rank3-bulk-tail-v1"

  static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> PhotoAssetVisitFoodDetectionStrategy {
    guard let value = environment[environmentKey] else {
      return defaultValue
    }
    return PhotoAssetVisitFoodDetectionStrategy(rawValue: value) ?? .fullPlanV1
  }
}
