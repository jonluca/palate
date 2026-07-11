import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset Vision visit-food validation mode")
struct PhotoAssetVisionVisitFoodValidationModeTests {
  @Test("Both validator environment values enable the isolated entry point")
  func enabled() {
    #expect(
      PhotoAssetVisionVisitFoodValidationMode.isEnabled(environment: [
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationRunIDEnvironmentKey: "vision-run",
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationAttestationPathEnvironmentKey: "/private/tmp/vision-attestation.json",
      ])
    )
  }

  @Test(
    "Missing or malformed validator environment stays on the production entry point",
    arguments: [
      [:],
      [
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationRunIDEnvironmentKey: "vision-run"
      ],
      [
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationAttestationPathEnvironmentKey: "/private/tmp/vision-attestation.json"
      ],
      [
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationRunIDEnvironmentKey: "",
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationAttestationPathEnvironmentKey: "/private/tmp/vision-attestation.json",
      ],
      [
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationRunIDEnvironmentKey: "vision-run",
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationAttestationPathEnvironmentKey: "relative-attestation.json",
      ],
    ]
  )
  func disabled(environment: [String: String]) {
    #expect(!PhotoAssetVisionVisitFoodValidationMode.isEnabled(environment: environment))
  }
}
