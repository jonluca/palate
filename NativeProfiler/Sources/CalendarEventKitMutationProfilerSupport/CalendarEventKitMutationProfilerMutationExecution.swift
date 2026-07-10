import Foundation

public struct CalendarEventKitMutationProfilerMutationExecution: Equatable, Sendable {
  public let elapsedMilliseconds: Double
  public let commitCount: Int
  public let eventIdentifiers: [String]
  public let identifiersObservedBeforeFinalCommit: Bool

  public init(
    elapsedMilliseconds: Double,
    commitCount: Int,
    eventIdentifiers: [String],
    identifiersObservedBeforeFinalCommit: Bool
  ) {
    self.elapsedMilliseconds = elapsedMilliseconds
    self.commitCount = commitCount
    self.eventIdentifiers = eventIdentifiers
    self.identifiersObservedBeforeFinalCommit = identifiersObservedBeforeFinalCommit
  }
}
