public enum PhotoAssetClassificationOutcome: Sendable {
  case success(PhotoAssetClassification)
  case failure(assetId: String, message: String)

  public var assetId: String {
    switch self {
    case .success(let classification):
      classification.assetId
    case .failure(let assetId, _):
      assetId
    }
  }
}
