import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset Vision page orchestration strategy")
struct PhotoAssetVisionPageOrchestrationStrategyTests {
  @Test("Production default is lookahead")
  func productionDefault() {
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [:])
        .pageOrchestrationStrategy == .lookahead
    )
  }

  @Test(
    "Explicit supported strategies are selected",
    arguments: [
      ("serial", PhotoAssetClassificationRuntimeConfiguration.PageOrchestrationStrategy.serial),
      (
        "lookahead",
        PhotoAssetClassificationRuntimeConfiguration.PageOrchestrationStrategy.lookahead
      ),
    ]
  )
  func supportedStrategies(
    value: String,
    expected: PhotoAssetClassificationRuntimeConfiguration.PageOrchestrationStrategy
  ) {
    let environment = [
      PhotoAssetClassificationRuntimeConfiguration.pageOrchestrationStrategyEnvironmentKey: value
    ]
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: environment)
        .pageOrchestrationStrategy == expected
    )
  }

  @Test(
    "Invalid values retain the lookahead default",
    arguments: ["", "LOOKAHEAD", " lookahead", "lookahead ", "parallel", "1"]
  )
  func invalidValues(value: String) {
    let environment = [
      PhotoAssetClassificationRuntimeConfiguration.pageOrchestrationStrategyEnvironmentKey: value
    ]
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: environment)
        .pageOrchestrationStrategy == .lookahead
    )
  }
}
