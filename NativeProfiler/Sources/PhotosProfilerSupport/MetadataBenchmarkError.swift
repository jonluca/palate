import Foundation

public enum MetadataBenchmarkError: Error, Equatable, Sendable {
  case emptyPageBeforeEnd(offset: Int, totalCount: Int)
  case missingNextOffset(offset: Int, totalCount: Int)
  case nonAdvancingPage(offset: Int, nextOffset: Int)
  case validationFailed(batchSize: Int, strategy: String, expected: String, actual: String)
}

extension MetadataBenchmarkError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .emptyPageBeforeEnd(let offset, let totalCount):
      return "The retained Photos snapshot returned an empty page at offset \(offset) before \(totalCount) assets"
    case .missingNextOffset(let offset, let totalCount):
      return "The retained Photos snapshot omitted nextOffset at \(offset) before \(totalCount) assets"
    case .nonAdvancingPage(let offset, let nextOffset):
      return "The retained Photos snapshot did not advance: \(offset) -> \(nextOffset)"
    case .validationFailed(let batchSize, let strategy, let expected, let actual):
      return "Validation failed for \(strategy) at batch size \(batchSize): expected \(expected), got \(actual)"
    }
  }
}
