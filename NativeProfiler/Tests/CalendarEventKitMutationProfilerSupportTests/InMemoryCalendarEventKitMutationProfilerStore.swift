import Foundation

@testable import CalendarEventKitMutationProfilerSupport

@MainActor
final class InMemoryCalendarEventKitMutationProfilerStore:
  CalendarEventKitMutationProfilerStore
{
  var candidateIdentifiersObservedBeforeCommit = true
  var cleanupActiveEventsCallCount = 0
  var corruptReadback = false
  var leaveFirstEventAfterDelete = false
  var rewriteReadbackIdentifiers = false

  private var eventsByIdentifier: [String: CalendarEventKitMutationProfilerSemanticEvent] = [:]
  private var generation = 0

  func create(
    events: [CalendarEventKitMutationProfilerSemanticEvent],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    generation += 1
    let identifiers = events.indices.map { "event-\(generation)-\($0)" }
    for (identifier, event) in zip(identifiers, events) {
      eventsByIdentifier[identifier] = event
    }
    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(events.count),
      commitCount: strategy == .legacy ? events.count : 1,
      eventIdentifiers: identifiers,
      identifiersObservedBeforeFinalCommit: strategy == .candidate
        && candidateIdentifiersObservedBeforeCommit
    )
  }

  func fetchEvents(
    in range: DateInterval
  ) throws -> [CalendarEventKitMutationProfilerEventSnapshot] {
    eventsByIdentifier.sorted { $0.key < $1.key }.enumerated().map { index, entry in
      let semanticEvent: CalendarEventKitMutationProfilerSemanticEvent
      if corruptReadback, index == 0 {
        semanticEvent = CalendarEventKitMutationProfilerSemanticEvent(
          title: entry.value.title + " changed",
          startMilliseconds: entry.value.startMilliseconds,
          endMilliseconds: entry.value.endMilliseconds,
          location: entry.value.location,
          notes: entry.value.notes,
          isAllDay: entry.value.isAllDay
        )
      } else {
        semanticEvent = entry.value
      }
      return CalendarEventKitMutationProfilerEventSnapshot(
        eventIdentifier: rewriteReadbackIdentifiers ? "rewritten-\(entry.key)" : entry.key,
        semanticEvent: semanticEvent
      )
    }
  }

  func delete(
    eventIdentifiers: [String],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    for (index, identifier) in eventIdentifiers.enumerated() {
      if leaveFirstEventAfterDelete, index == 0 {
        continue
      }
      eventsByIdentifier.removeValue(forKey: identifier)
    }
    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(eventIdentifiers.count) / 2,
      commitCount: strategy == .legacy ? eventIdentifiers.count : 1,
      eventIdentifiers: eventIdentifiers,
      identifiersObservedBeforeFinalCommit: false
    )
  }

  func cleanupActiveEvents() {
    cleanupActiveEventsCallCount += 1
    eventsByIdentifier.removeAll(keepingCapacity: true)
  }
}
