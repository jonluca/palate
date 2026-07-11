import Foundation

public enum ProfilerArgumentsError: Error, Equatable, Sendable {
  case unknownOption(String)
  case missingValue(option: String)
  case invalidInteger(option: String, value: String)
  case invalidMode(String)
  case invalidBatchSizes(String)
  case emptyBatchSizes
  case batchSizeOutOfRange(maximum: Int)
  case invalidImageCounts(String)
  case emptyImageCounts
  case imageCountOutOfRange(maximum: Int)
  case imageDimensionOutOfRange(maximum: Int)
  case imageIterationsMustBeEven
  case imagePreheatIterationsMustBeMultipleOfFour
  case thumbnailScrollIterationsMustBeMultipleOfFour
  case previewCardIterationsMustBeMultipleOfTwelve
  case valueOutOfRange(option: String, maximum: Int)
  case visionIterationsMustBeEven
  case authorizationTimeoutOutOfRange(maximumMilliseconds: Int)
  case nonPositiveValue(option: String)
  case negativeValue(option: String)
}

extension ProfilerArgumentsError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unknownOption(let option):
      return "Unknown option: \(option)"
    case .missingValue(let option):
      return "Missing value after \(option)"
    case .invalidInteger(let option, let value):
      return "Invalid integer for \(option): \(value)"
    case .invalidMode(let value):
      return
        "Invalid profiler mode: \(value). Expected photos, vision, initial-images, initial-image-preheat, thumbnail-scroll, or preview-cards."
    case .invalidBatchSizes(let value):
      return "Invalid comma-separated batch sizes: \(value)"
    case .emptyBatchSizes:
      return "At least one batch size is required"
    case .batchSizeOutOfRange(let maximum):
      return "Batch sizes must be between 1 and \(maximum)"
    case .invalidImageCounts(let value):
      return "Invalid comma-separated image counts: \(value)"
    case .emptyImageCounts:
      return "At least one initial-image count is required"
    case .imageCountOutOfRange(let maximum):
      return "Initial-image counts must be between 1 and \(maximum)"
    case .imageDimensionOutOfRange(let maximum):
      return "Initial-image target dimensions must be between 1 and \(maximum) pixels"
    case .imageIterationsMustBeEven:
      return
        "--image-iterations must be even so baseline and candidate sample positions are counterbalanced"
    case .imagePreheatIterationsMustBeMultipleOfFour:
      return
        "--image-iterations must be a multiple of four in initial-image-preheat mode so recency and execution order are counterbalanced"
    case .thumbnailScrollIterationsMustBeMultipleOfFour:
      return
        "--scroll-iterations must be a multiple of four so all four arms are counterbalanced"
    case .previewCardIterationsMustBeMultipleOfTwelve:
      return
        "--preview-iterations must be a multiple of twelve so recency, execution order, and 1/2/3-photo card geometry are independently counterbalanced"
    case .valueOutOfRange(let option, let maximum):
      return "\(option) must be between 1 and \(maximum)"
    case .visionIterationsMustBeEven:
      return
        "--iterations must be even when --vision-sample is enabled so baseline and pipeline execution order is counterbalanced"
    case .authorizationTimeoutOutOfRange(let maximumMilliseconds):
      return "--authorization-timeout-ms cannot exceed \(maximumMilliseconds)"
    case .nonPositiveValue(let option):
      return "\(option) must be greater than zero"
    case .negativeValue(let option):
      return "\(option) cannot be negative"
    }
  }
}
