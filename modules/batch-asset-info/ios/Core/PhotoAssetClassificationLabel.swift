public struct PhotoAssetClassificationLabel: Sendable {
  public let identifier: String
  public let confidence: Float

  public init(identifier: String, confidence: Float) {
    self.identifier = identifier
    self.confidence = confidence
  }
}
