import Foundation

public enum InitialImageBenchmarkError: Error, Equatable, Sendable {
  case sampleSizeOverflow
  case insufficientImageAssets(required: Int, available: Int)
  case duplicateAssetIdentifier
  case invalidMeasurement(strategy: InitialImageStrategy, iteration: Int, reason: String)
}

extension InitialImageBenchmarkError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .sampleSizeOverflow:
      return "The requested initial-image sample size is too large."
    case .insufficientImageAssets(let required, let available):
      return
        "The Photos library has \(available) image assets, but \(required) disjoint samples are required."
    case .duplicateAssetIdentifier:
      return "The initial-image sample contains a duplicate Photos asset identifier."
    case .invalidMeasurement(let strategy, let iteration, let reason):
      return
        "Initial-image measurement \(strategy.rawValue) iteration \(iteration) violated an invariant: \(reason)"
    }
  }
}
