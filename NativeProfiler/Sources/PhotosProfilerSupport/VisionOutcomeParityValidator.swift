import BatchAssetInfoCore

enum VisionOutcomeParityValidator {
  struct Accumulator {
    private(set) var mismatchCount = 0
    private(set) var comparedAssetCount = 0
    private(set) var comparisonRuns = 0

    mutating func compare(
      baseline: [PhotoAssetClassificationOutcome],
      pipeline: [PhotoAssetClassificationOutcome]
    ) {
      let comparison = VisionOutcomeParityValidator.compare(
        baseline: baseline,
        pipeline: pipeline
      )
      mismatchCount += comparison.mismatchCount
      comparedAssetCount += comparison.comparedAssetCount
      comparisonRuns += 1
    }

    var validation: ProfilerReport.Vision.Validation {
      ProfilerReport.Vision.Validation(
        exactOutcomeParity: mismatchCount == 0,
        mismatchCount: mismatchCount,
        comparedAssetCount: comparedAssetCount,
        comparisonRuns: comparisonRuns
      )
    }
  }

  static func validate(
    baseline: [PhotoAssetClassificationOutcome],
    pipeline: [PhotoAssetClassificationOutcome]
  ) -> ProfilerReport.Vision.Validation {
    var accumulator = Accumulator()
    accumulator.compare(baseline: baseline, pipeline: pipeline)
    return accumulator.validation
  }

  private static func compare(
    baseline: [PhotoAssetClassificationOutcome],
    pipeline: [PhotoAssetClassificationOutcome]
  ) -> (mismatchCount: Int, comparedAssetCount: Int) {
    let comparedAssetCount = min(baseline.count, pipeline.count)
    var mismatchCount = abs(baseline.count - pipeline.count)
    for index in 0..<comparedAssetCount where !exactlyEqual(baseline[index], pipeline[index]) {
      mismatchCount += 1
    }
    return (mismatchCount, comparedAssetCount)
  }

  private static func exactlyEqual(
    _ baseline: PhotoAssetClassificationOutcome,
    _ pipeline: PhotoAssetClassificationOutcome
  ) -> Bool {
    guard baseline.assetId == pipeline.assetId else {
      return false
    }
    switch (baseline, pipeline) {
    case (.failure(_, let firstMessage), .failure(_, let secondMessage)):
      return firstMessage == secondMessage
    case (.success(let first), .success(let second)):
      guard first.labels.count == second.labels.count else {
        return false
      }
      return zip(first.labels, second.labels).allSatisfy { firstLabel, secondLabel in
        firstLabel.identifier == secondLabel.identifier
          && firstLabel.confidence.bitPattern == secondLabel.confidence.bitPattern
      }
    default:
      return false
    }
  }
}
