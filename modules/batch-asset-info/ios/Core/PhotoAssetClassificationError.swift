import Foundation

public enum PhotoAssetClassificationError: LocalizedError, Sendable {
  case invalidConfidenceThreshold(Float)
  case invalidMaximumLabelCount(Int)
  case imageRequestCancelled(assetId: String)
  case imageUnavailable(assetId: String)
  case noClassificationResults(assetId: String)

  public var errorDescription: String? {
    switch self {
    case .invalidConfidenceThreshold(let threshold):
      return "Classification confidence threshold must be between 0 and 1; received \(threshold)."
    case .invalidMaximumLabelCount(let count):
      return "Maximum classification label count must be between 0 and 1,000; received \(count)."
    case .imageRequestCancelled(let assetId):
      return "PhotoKit cancelled the image request for asset \(assetId)."
    case .imageUnavailable(let assetId):
      return "PhotoKit did not return a usable image for asset \(assetId)."
    case .noClassificationResults(let assetId):
      return "Vision returned no classification results for asset \(assetId)."
    }
  }
}
