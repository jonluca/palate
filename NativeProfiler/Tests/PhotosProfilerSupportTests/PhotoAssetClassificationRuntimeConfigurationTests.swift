import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification runtime configuration")
struct PhotoAssetClassificationRuntimeConfigurationTests {
  @Test("Defaults match the production classifier and pipeline")
  func defaults() {
    let configuration = PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [:])

    #expect(configuration.visionConcurrency == PhotoAssetClassifier.recommendedConcurrency)
    #expect(
      configuration.pipelineMaximumInFlight
        == PhotoAssetClassificationPipeline.defaultMaximumInFlight
    )
    #expect(
      configuration.resultPageSize
        == PhotoAssetClassificationRuntimeConfiguration.defaultResultPageSize
    )
  }

  @Test("Valid environment overrides are accepted")
  func validOverrides() {
    let configuration = PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [
      PhotoAssetClassificationRuntimeConfiguration.visionConcurrencyEnvironmentKey: "3",
      PhotoAssetClassificationRuntimeConfiguration.pipelineDepthEnvironmentKey: "8",
      PhotoAssetClassificationRuntimeConfiguration.resultPageSizeEnvironmentKey: "1000",
    ])

    #expect(configuration.visionConcurrency == 3)
    #expect(configuration.pipelineMaximumInFlight == 8)
    #expect(configuration.resultPageSize == 1_000)
  }

  @Test(
    "Invalid and out-of-range overrides fall back",
    arguments: ["", "0", "-1", "not-an-integer", "9999"]
  )
  func invalidOverrides(value: String) {
    let configuration = PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [
      PhotoAssetClassificationRuntimeConfiguration.visionConcurrencyEnvironmentKey: value,
      PhotoAssetClassificationRuntimeConfiguration.pipelineDepthEnvironmentKey: value,
      PhotoAssetClassificationRuntimeConfiguration.resultPageSizeEnvironmentKey: value,
    ])

    #expect(configuration.visionConcurrency == PhotoAssetClassifier.recommendedConcurrency)
    #expect(
      configuration.pipelineMaximumInFlight
        == PhotoAssetClassificationPipeline.defaultMaximumInFlight
    )
    #expect(
      configuration.resultPageSize
        == PhotoAssetClassificationRuntimeConfiguration.defaultResultPageSize
    )
  }

  @Test("Maximum supported overrides are accepted")
  func maximumOverrides() {
    let configuration = PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [
      PhotoAssetClassificationRuntimeConfiguration.visionConcurrencyEnvironmentKey: String(
        PhotoAssetClassificationRuntimeConfiguration.maximumVisionConcurrency
      ),
      PhotoAssetClassificationRuntimeConfiguration.pipelineDepthEnvironmentKey: String(
        PhotoAssetClassificationRuntimeConfiguration.maximumPipelineDepth
      ),
      PhotoAssetClassificationRuntimeConfiguration.resultPageSizeEnvironmentKey: String(
        PhotoAssetClassificationRuntimeConfiguration.maximumResultPageSize
      ),
    ])

    #expect(
      configuration.visionConcurrency
        == PhotoAssetClassificationRuntimeConfiguration.maximumVisionConcurrency
    )
    #expect(
      configuration.pipelineMaximumInFlight
        == PhotoAssetClassificationRuntimeConfiguration.maximumPipelineDepth
    )
    #expect(
      configuration.resultPageSize
        == PhotoAssetClassificationRuntimeConfiguration.maximumResultPageSize
    )
  }
}
