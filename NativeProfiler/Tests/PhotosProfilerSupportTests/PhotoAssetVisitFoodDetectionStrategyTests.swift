import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset visit food-detection strategy")
struct PhotoAssetVisitFoodDetectionStrategyTests {
  @Test("Environment key and promoted production default are stable")
  func stableContract() {
    #expect(
      PhotoAssetVisitFoodDetectionStrategy.environmentKey
        == "PALATE_VISIT_FOOD_DETECTION_STRATEGY"
    )
    #expect(PhotoAssetVisitFoodDetectionStrategy.defaultValue == .rank3BulkTailV1)
    #expect(PhotoAssetVisitFoodDetectionStrategy.resolve(environment: [:]) == .rank3BulkTailV1)
  }

  @Test(
    "Exact supported strategy values resolve",
    arguments: [
      ("full-plan-v1", PhotoAssetVisitFoodDetectionStrategy.fullPlanV1),
      ("rank3-bulk-tail-v1", PhotoAssetVisitFoodDetectionStrategy.rank3BulkTailV1),
    ]
  )
  func supportedStrategies(
    value: String,
    expected: PhotoAssetVisitFoodDetectionStrategy
  ) {
    #expect(
      PhotoAssetVisitFoodDetectionStrategy.resolve(environment: [
        PhotoAssetVisitFoodDetectionStrategy.environmentKey: value
      ]) == expected
    )
  }

  @Test(
    "Invalid values retain the full-plan fallback",
    arguments: [
      "", "FULL-PLAN-V1", " full-plan-v1", "full-plan-v1 ", "rank-3-bulk-tail-v1",
      "rank3-bulk-tail-v2", "1",
    ]
  )
  func invalidValues(value: String) {
    #expect(
      PhotoAssetVisitFoodDetectionStrategy.resolve(environment: [
        PhotoAssetVisitFoodDetectionStrategy.environmentKey: value
      ]) == .fullPlanV1
    )
  }
}
