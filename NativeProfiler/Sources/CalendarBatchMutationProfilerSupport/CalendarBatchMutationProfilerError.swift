import Foundation

public enum CalendarBatchMutationProfilerError: Error, Equatable, LocalizedError, Sendable {
  case operationModelMismatch(strategy: String, phase: String)
  case semanticParityMismatch(
    currentOutcomeDigest: String,
    nativeOutcomeDigest: String,
    currentFinalStateDigest: String,
    nativeFinalStateDigest: String
  )
  case timedResultChanged(
    strategy: String,
    expectedOutcomeDigest: String,
    actualOutcomeDigest: String,
    expectedFinalStateDigest: String,
    actualFinalStateDigest: String
  )

  public var errorDescription: String? {
    switch self {
    case .operationModelMismatch(let strategy, let phase):
      return "Synthetic operation counts diverged from the \(strategy) \(phase) model."
    case .semanticParityMismatch(
      let currentOutcomeDigest,
      let nativeOutcomeDigest,
      let currentFinalStateDigest,
      let nativeFinalStateDigest
    ):
      return
        "Current/native semantic parity failed: outcomes \(currentOutcomeDigest) versus "
        + "\(nativeOutcomeDigest); final states \(currentFinalStateDigest) versus "
        + "\(nativeFinalStateDigest)."
    case .timedResultChanged(
      let strategy,
      let expectedOutcomeDigest,
      let actualOutcomeDigest,
      let expectedFinalStateDigest,
      let actualFinalStateDigest
    ):
      return
        "\(strategy) changed during measurement: outcomes \(expectedOutcomeDigest) versus "
        + "\(actualOutcomeDigest); final states \(expectedFinalStateDigest) versus "
        + "\(actualFinalStateDigest)."
    }
  }
}
