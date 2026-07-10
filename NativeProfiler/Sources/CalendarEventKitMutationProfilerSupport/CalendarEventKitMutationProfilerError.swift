import Foundation

public enum CalendarEventKitMutationProfilerError: Error, LocalizedError {
  case activeEventCleanupFailed(messages: [String])
  case calendarAccessUnavailable(status: String, requestAttempted: Bool)
  case calendarNotEmptyBeforeSample(eventCount: Int)
  case candidateIdentifiersNotObservedBeforeCommit
  case eventIdentifierLookupFailed(identifier: String)
  case eventIdentifiersChangedAfterCommit(created: [String], readBack: [String])
  case eventsRemainAfterDelete(count: Int)
  case invalidEventIdentifiers(phase: String, expectedCount: Int, actualCount: Int)
  case noWritableCalendarSource(attemptedSourceCount: Int)
  case semanticParityMismatch(
    expectedCount: Int,
    actualCount: Int,
    expectedDigest: String,
    actualDigest: String
  )
  case temporaryCalendarAndBenchmarkFailed(benchmark: String, cleanup: String)
  case temporaryCalendarCleanupFailed(String)
  case temporaryCalendarCleanupLookupFailed(identifier: String)
  case temporaryCalendarCleanupVerificationFailed(identifier: String)
  case temporaryCalendarIdentifierUnavailable
  case temporaryCalendarUnavailable(identifier: String)
  case unexpectedCommitCount(
    strategy: String,
    phase: String,
    expected: Int,
    actual: Int
  )
  case unstableExecutionCounts(eventCount: Int, strategy: String)
  case unstableSample(
    eventCount: Int,
    strategy: String,
    expectedDigest: String,
    actualDigest: String
  )

  public var errorDescription: String? {
    switch self {
    case .activeEventCleanupFailed(let messages):
      return "Failed to remove active profiler events: \(messages.joined(separator: "; "))."
    case .calendarAccessUnavailable(let status, let requestAttempted):
      let hint =
        requestAttempted
        ? "Grant full Calendar access in System Settings and retry."
        : "Retry with --request-access to explicitly request full Calendar access."
      return "Calendar access is \(status). \(hint)"
    case .calendarNotEmptyBeforeSample(let eventCount):
      return "The temporary profiler calendar contained \(eventCount) event(s) before a sample."
    case .candidateIdentifiersNotObservedBeforeCommit:
      return
        "The candidate path did not expose nonempty, unique event identifiers before its final commit."
    case .eventIdentifierLookupFailed(let identifier):
      return "The staged EventKit event \(identifier) was unavailable for deletion."
    case .eventIdentifiersChangedAfterCommit(let created, let readBack):
      return
        "EventKit changed the created identifier set after commit (created: \(created.count), read back: \(readBack.count))."
    case .eventsRemainAfterDelete(let count):
      return "The temporary profiler calendar retained \(count) event(s) after deletion."
    case .invalidEventIdentifiers(let phase, let expectedCount, let actualCount):
      return
        "The \(phase) phase produced \(actualCount) nonempty, unique identifiers; expected \(expectedCount)."
    case .noWritableCalendarSource(let attemptedSourceCount):
      return
        "No writable EventKit source accepted a temporary profiler calendar (attempted \(attemptedSourceCount))."
    case .semanticParityMismatch(
      let expectedCount,
      let actualCount,
      let expectedDigest,
      let actualDigest
    ):
      return
        "EventKit semantic parity failed: expected \(expectedCount) events (\(expectedDigest)), received \(actualCount) (\(actualDigest))."
    case .temporaryCalendarAndBenchmarkFailed(let benchmark, let cleanup):
      return
        "Benchmark failed (\(benchmark)); profiler cleanup also failed (\(cleanup))."
    case .temporaryCalendarCleanupFailed(let message):
      return "Profiler cleanup failed: \(message)"
    case .temporaryCalendarCleanupLookupFailed(let identifier):
      return
        "EventKit cannot resolve saved temporary calendar \(identifier) for verified removal."
    case .temporaryCalendarCleanupVerificationFailed(let identifier):
      return
        "EventKit still resolves temporary calendar \(identifier) after committed removal."
    case .temporaryCalendarIdentifierUnavailable:
      return "EventKit saved the temporary profiler calendar without a nonempty identifier."
    case .temporaryCalendarUnavailable(let identifier):
      return "EventKit cannot resolve temporary profiler calendar \(identifier)."
    case .unexpectedCommitCount(let strategy, let phase, let expected, let actual):
      return "The \(strategy) \(phase) path made \(actual) commits; expected \(expected)."
    case .unstableExecutionCounts(let eventCount, let strategy):
      return
        "The \(strategy) measurements for \(eventCount) events had unstable sample or commit counts."
    case .unstableSample(
      let eventCount,
      let strategy,
      let expectedDigest,
      let actualDigest
    ):
      return
        "The \(strategy) sample for \(eventCount) events changed semantic digest from \(expectedDigest) to \(actualDigest)."
    }
  }
}
