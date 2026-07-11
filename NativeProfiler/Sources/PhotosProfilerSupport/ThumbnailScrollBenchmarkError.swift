import Foundation

public enum ThumbnailScrollBenchmarkError: Error, Equatable, Sendable {
  case invalidGrid
  case iterationsMustBeMultipleOfFour
  case sampleSizeOverflow
  case insufficientAssets(required: Int, available: Int)
  case duplicateAssetIdentifier
  case invalidMeasurement(arm: ThumbnailScrollBenchmarkArm, iteration: Int, reason: String)
  case residentMemoryUnavailable
}

extension ThumbnailScrollBenchmarkError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .invalidGrid:
      return "Thumbnail-scroll grid dimensions and window counts must be positive."
    case .iterationsMustBeMultipleOfFour:
      return "Thumbnail-scroll iterations must be a multiple of four for four-arm counterbalancing."
    case .sampleSizeOverflow:
      return "The requested thumbnail-scroll sample size is too large."
    case .insufficientAssets(let required, let available):
      return
        "The Photos library has \(available) eligible image/video assets, but \(required) disjoint samples are required."
    case .duplicateAssetIdentifier:
      return "The thumbnail-scroll sample contains a duplicate Photos asset identifier."
    case .invalidMeasurement(let arm, let iteration, let reason):
      return
        "Thumbnail-scroll measurement \(arm.rawValue) iteration \(iteration) violated an invariant: \(reason)"
    case .residentMemoryUnavailable:
      return "The profiler could not read its current resident-memory size."
    }
  }
}
