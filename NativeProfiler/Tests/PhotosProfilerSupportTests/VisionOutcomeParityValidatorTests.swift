import BatchAssetInfoCore
import Testing

@testable import PhotosProfilerSupport

@Suite("Vision outcome parity")
struct VisionOutcomeParityValidatorTests {
  @Test("Exact labels and confidence bit patterns pass")
  func exactParity() {
    let labels = [
      PhotoAssetClassificationLabel(identifier: "pizza, pizza", confidence: 0.75),
      PhotoAssetClassificationLabel(identifier: "café", confidence: 0.5),
    ]
    let baseline: [PhotoAssetClassificationOutcome] = [
      .success(PhotoAssetClassification(assetId: "asset-1", labels: labels)),
      .failure(assetId: "missing", message: "baseline error"),
    ]
    let pipeline: [PhotoAssetClassificationOutcome] = [
      .success(PhotoAssetClassification(assetId: "asset-1", labels: labels)),
      .failure(assetId: "missing", message: "baseline error"),
    ]

    let validation = VisionOutcomeParityValidator.validate(
      baseline: baseline,
      pipeline: pipeline
    )

    #expect(validation.exactOutcomeParity)
    #expect(validation.mismatchCount == 0)
    #expect(validation.comparedAssetCount == 2)
    #expect(validation.comparisonRuns == 1)
  }

  @Test("Order, outcome kind, labels, and confidence bits are all significant")
  func mismatches() {
    let baseline: [PhotoAssetClassificationOutcome] = [
      .success(
        PhotoAssetClassification(
          assetId: "asset-1",
          labels: [PhotoAssetClassificationLabel(identifier: "pizza", confidence: 0.5)]
        )
      ),
      .failure(assetId: "asset-2", message: "missing"),
      .success(PhotoAssetClassification(assetId: "asset-3", labels: [])),
      .failure(assetId: "asset-4", message: "cancelled"),
    ]
    let pipeline: [PhotoAssetClassificationOutcome] = [
      .success(
        PhotoAssetClassification(
          assetId: "asset-1",
          labels: [
            PhotoAssetClassificationLabel(
              identifier: "pizza",
              confidence: Float(bitPattern: Float(0.5).bitPattern + 1)
            )
          ]
        )
      ),
      .success(PhotoAssetClassification(assetId: "asset-2", labels: [])),
      .success(
        PhotoAssetClassification(
          assetId: "different-id",
          labels: []
        )
      ),
      .failure(assetId: "asset-4", message: "image unavailable"),
      .failure(assetId: "extra", message: "extra"),
    ]

    let validation = VisionOutcomeParityValidator.validate(
      baseline: baseline,
      pipeline: pipeline
    )

    #expect(!validation.exactOutcomeParity)
    #expect(validation.mismatchCount == 5)
    #expect(validation.comparedAssetCount == 4)
    #expect(validation.comparisonRuns == 1)
  }

  @Test("Accumulator compares every baseline/pipeline pair")
  func accumulatedParity() {
    let success = PhotoAssetClassificationOutcome.success(
      PhotoAssetClassification(assetId: "asset", labels: [])
    )
    let matchingFailure = PhotoAssetClassificationOutcome.failure(
      assetId: "missing",
      message: "unavailable"
    )
    var accumulator = VisionOutcomeParityValidator.Accumulator()

    accumulator.compare(
      baseline: [success, matchingFailure],
      pipeline: [success, matchingFailure]
    )
    accumulator.compare(
      baseline: [success],
      pipeline: [
        .failure(assetId: "asset", message: "classification failed"),
        .failure(assetId: "extra", message: "extra"),
      ]
    )

    let validation = accumulator.validation
    #expect(!validation.exactOutcomeParity)
    #expect(validation.mismatchCount == 2)
    #expect(validation.comparedAssetCount == 3)
    #expect(validation.comparisonRuns == 2)
  }
}
