import Foundation

public struct CalendarEventKitMutationProfilerSample: Equatable, Sendable {
  public let eventCount: Int
  public let strategy: CalendarEventKitMutationProfilerStrategy
  public let semanticDigest: String
  public let createMilliseconds: Double
  public let deleteMilliseconds: Double
  public let createCommitCount: Int
  public let deleteCommitCount: Int

  public init(
    eventCount: Int,
    strategy: CalendarEventKitMutationProfilerStrategy,
    semanticDigest: String,
    createMilliseconds: Double,
    deleteMilliseconds: Double,
    createCommitCount: Int,
    deleteCommitCount: Int
  ) {
    self.eventCount = eventCount
    self.strategy = strategy
    self.semanticDigest = semanticDigest
    self.createMilliseconds = createMilliseconds
    self.deleteMilliseconds = deleteMilliseconds
    self.createCommitCount = createCommitCount
    self.deleteCommitCount = deleteCommitCount
  }
}
