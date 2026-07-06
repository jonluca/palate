public struct PhotoAssetClassification: Sendable {
  public let assetId: String
  public let labels: [PhotoAssetClassificationLabel]

  public init(assetId: String, labels: [PhotoAssetClassificationLabel]) {
    self.assetId = assetId
    self.labels = labels
  }
}
