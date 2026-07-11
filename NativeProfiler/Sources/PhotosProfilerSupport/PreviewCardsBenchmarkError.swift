import Foundation

public enum PreviewCardsBenchmarkError: Error, Equatable, Sendable {
  case sampleSizeOverflow
  case insufficientAssets(required: Int, available: Int)
  case duplicateAssetIdentifier
  case invalidVisibleCardCount
  case invalidCardArity(Int)
  case iterationsMustBeMultipleOfTwelve
  case invalidMeasurement(
    strategy: PreviewCardsBenchmarkStrategy,
    iteration: Int,
    reason: String
  )
  case residentMemoryUnavailable
  case invalidReport(reason: String)
}

extension PreviewCardsBenchmarkError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .sampleSizeOverflow:
      return "The requested preview-card sample size is too large."
    case .insufficientAssets(let required, let available):
      return
        "The Photos library has \(available) eligible assets, but \(required) globally disjoint preview-card samples are required."
    case .duplicateAssetIdentifier:
      return "The preview-card sample contains a duplicate Photos asset identifier."
    case .invalidVisibleCardCount:
      return "The preview-card benchmark requires at least one visible card."
    case .invalidCardArity(let arity):
      return "Unsupported preview-card asset count: \(arity). Expected 1, 2, or 3."
    case .iterationsMustBeMultipleOfTwelve:
      return
        "Preview-card iterations must be a multiple of twelve so recency, execution order, and 1/2/3-photo card geometry are independently counterbalanced."
    case .invalidMeasurement(let strategy, let iteration, let reason):
      return
        "Preview-card measurement \(strategy.rawValue) iteration \(iteration) violated an invariant: \(reason)"
    case .residentMemoryUnavailable:
      return "The preview-card benchmark could not read resident memory."
    case .invalidReport(let reason):
      return "The preview-card report violated an invariant: \(reason)"
    }
  }
}
