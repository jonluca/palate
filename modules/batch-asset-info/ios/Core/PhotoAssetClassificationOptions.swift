public struct PhotoAssetClassificationOptions: Sendable {
  public let confidenceThreshold: Float
  public let maximumLabelCount: Int

  public init(confidenceThreshold: Float, maximumLabelCount: Int) throws {
    guard confidenceThreshold.isFinite, (0...1).contains(confidenceThreshold) else {
      throw PhotoAssetClassificationError.invalidConfidenceThreshold(confidenceThreshold)
    }
    guard (0...1_000).contains(maximumLabelCount) else {
      throw PhotoAssetClassificationError.invalidMaximumLabelCount(maximumLabelCount)
    }

    self.confidenceThreshold = confidenceThreshold
    self.maximumLabelCount = maximumLabelCount
  }
}
