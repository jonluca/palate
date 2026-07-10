import Foundation

@MainActor
public struct CalendarEventKitMutationProfilerOrchestrator {
  public init() {}

  public func runSample(
    events: [CalendarEventKitMutationProfilerSemanticEvent],
    strategy: CalendarEventKitMutationProfilerStrategy,
    store: any CalendarEventKitMutationProfilerStore
  ) throws -> CalendarEventKitMutationProfilerSample {
    let range = CalendarEventKitMutationProfilerDataset.queryRange(for: events)
    let initialEvents = try store.fetchEvents(in: range)
    guard initialEvents.isEmpty else {
      throw CalendarEventKitMutationProfilerError.calendarNotEmptyBeforeSample(
        eventCount: initialEvents.count
      )
    }

    let createExecution = try store.create(events: events, strategy: strategy)
    try validateIdentifiers(
      createExecution.eventIdentifiers,
      expectedCount: events.count,
      phase: "create"
    )
    if strategy == .candidate {
      guard createExecution.identifiersObservedBeforeFinalCommit else {
        throw CalendarEventKitMutationProfilerError
          .candidateIdentifiersNotObservedBeforeCommit
      }
    }
    try validateCommitCount(
      createExecution.commitCount,
      eventCount: events.count,
      strategy: strategy,
      phase: "create"
    )

    let fetchedEvents = try store.fetchEvents(in: range)
    let fetchedIdentifiers = fetchedEvents.map(\.eventIdentifier)
    try validateIdentifiers(
      fetchedIdentifiers,
      expectedCount: events.count,
      phase: "readback"
    )
    guard Set(createExecution.eventIdentifiers) == Set(fetchedIdentifiers) else {
      throw CalendarEventKitMutationProfilerError.eventIdentifiersChangedAfterCommit(
        created: createExecution.eventIdentifiers,
        readBack: fetchedIdentifiers
      )
    }
    let expectedDigest = CalendarEventKitMutationProfilerStableDigest.signature(for: events)
    let actualSemantics = fetchedEvents.map(\.semanticEvent)
    let actualDigest = CalendarEventKitMutationProfilerStableDigest.signature(
      for: actualSemantics
    )
    guard events.count == fetchedEvents.count, Set(events) == Set(actualSemantics) else {
      throw CalendarEventKitMutationProfilerError.semanticParityMismatch(
        expectedCount: events.count,
        actualCount: fetchedEvents.count,
        expectedDigest: expectedDigest,
        actualDigest: actualDigest
      )
    }

    let deleteExecution = try store.delete(
      eventIdentifiers: fetchedIdentifiers,
      strategy: strategy
    )
    try validateIdentifiers(
      deleteExecution.eventIdentifiers,
      expectedCount: events.count,
      phase: "delete"
    )
    try validateCommitCount(
      deleteExecution.commitCount,
      eventCount: events.count,
      strategy: strategy,
      phase: "delete"
    )

    let remainingEvents = try store.fetchEvents(in: range)
    guard remainingEvents.isEmpty else {
      throw CalendarEventKitMutationProfilerError.eventsRemainAfterDelete(
        count: remainingEvents.count
      )
    }

    return CalendarEventKitMutationProfilerSample(
      eventCount: events.count,
      strategy: strategy,
      semanticDigest: actualDigest,
      createMilliseconds: createExecution.elapsedMilliseconds,
      deleteMilliseconds: deleteExecution.elapsedMilliseconds,
      createCommitCount: createExecution.commitCount,
      deleteCommitCount: deleteExecution.commitCount
    )
  }

  private func validateIdentifiers(
    _ identifiers: [String],
    expectedCount: Int,
    phase: String
  ) throws {
    let nonemptyIdentifiers = identifiers.filter { !$0.isEmpty }
    let uniqueIdentifiers = Set(nonemptyIdentifiers)
    guard identifiers.count == expectedCount,
      nonemptyIdentifiers.count == expectedCount,
      uniqueIdentifiers.count == expectedCount
    else {
      throw CalendarEventKitMutationProfilerError.invalidEventIdentifiers(
        phase: phase,
        expectedCount: expectedCount,
        actualCount: uniqueIdentifiers.count
      )
    }
  }

  private func validateCommitCount(
    _ actual: Int,
    eventCount: Int,
    strategy: CalendarEventKitMutationProfilerStrategy,
    phase: String
  ) throws {
    let expected = strategy == .legacy ? eventCount : 1
    guard actual == expected else {
      throw CalendarEventKitMutationProfilerError.unexpectedCommitCount(
        strategy: strategy.rawValue,
        phase: phase,
        expected: expected,
        actual: actual
      )
    }
  }
}
