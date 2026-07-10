import Foundation

public enum CalendarLibraryProfilerError: Error, Equatable, LocalizedError, Sendable {
  case calendarAccessUnavailable(status: String, requestAttempted: Bool)
  case eventSetChanged(
    strategy: String,
    expectedCount: Int,
    actualCount: Int,
    expectedDigest: String,
    actualDigest: String
  )
  case referenceParityMismatch(
    productionCount: Int,
    referenceCount: Int,
    productionDigest: String,
    referenceDigest: String
  )

  public var errorDescription: String? {
    switch self {
    case .calendarAccessUnavailable(let status, let requestAttempted):
      let requestDescription =
        requestAttempted
        ? "The explicit access request did not grant read access."
        : "No permission prompt was requested."
      return "Calendar read access is unavailable (status: \(status)). \(requestDescription)"
    case .eventSetChanged(
      let strategy,
      let expectedCount,
      let actualCount,
      let expectedDigest,
      let actualDigest
    ):
      return
        "Calendar event set changed during \(strategy): expected \(expectedCount) events (\(expectedDigest)), got \(actualCount) (\(actualDigest))"
    case .referenceParityMismatch(
      let productionCount,
      let referenceCount,
      let productionDigest,
      let referenceDigest
    ):
      return
        "Production/reference Calendar parity failed: \(productionCount) events (\(productionDigest)) versus \(referenceCount) (\(referenceDigest))"
    }
  }
}
