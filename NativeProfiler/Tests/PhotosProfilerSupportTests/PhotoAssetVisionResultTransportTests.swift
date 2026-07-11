import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset Vision result transport")
struct PhotoAssetVisionResultTransportTests {
  @Test("Production default is legacy")
  func productionDefault() {
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: [:])
        .resultTransport == .legacy
    )
  }

  @Test(
    "Explicit supported transports are selected",
    arguments: [
      ("legacy", PhotoAssetClassificationRuntimeConfiguration.ResultTransport.legacy),
      ("packed-v1", PhotoAssetClassificationRuntimeConfiguration.ResultTransport.packedV1),
    ]
  )
  func supportedTransports(
    value: String,
    expected: PhotoAssetClassificationRuntimeConfiguration.ResultTransport
  ) {
    let environment = [
      PhotoAssetClassificationRuntimeConfiguration.resultTransportEnvironmentKey: value
    ]
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: environment)
        .resultTransport == expected
    )
  }

  @Test(
    "Invalid values retain the legacy fallback",
    arguments: ["", "PACKED-V1", " packed-v1", "packed-v1 ", "packed", "1"]
  )
  func invalidValues(value: String) {
    let environment = [
      PhotoAssetClassificationRuntimeConfiguration.resultTransportEnvironmentKey: value
    ]
    #expect(
      PhotoAssetClassificationRuntimeConfiguration.resolve(environment: environment)
        .resultTransport == .legacy
    )
  }
}
