import CalendarEventKitMutationAdapter
@preconcurrency import EventKit
import Foundation

@MainActor
public final class CalendarEventKitMutationProfilerEventStore:
  CalendarEventKitMutationProfilerStore
{
  private let eventStore: EKEventStore
  private let calendarIdentifier: String
  private let productionCandidate:
    CalendarEventKitMutationProfilerProductionCandidate<CalendarEventKitMutationBackend>
  private var activeEventIdentifiers: [String] = []

  public init(eventStore: EKEventStore, calendar: EKCalendar) {
    let calendarIdentifier = calendar.calendarIdentifier
    self.eventStore = eventStore
    self.calendarIdentifier = calendarIdentifier
    productionCandidate = CalendarEventKitMutationProfilerProductionCandidate(
      calendarIdentifier: calendarIdentifier,
      makeBackend: {
        CalendarEventKitMutationBackend(eventStore: eventStore)
      }
    )
  }

  public func create(
    events: [CalendarEventKitMutationProfilerSemanticEvent],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    switch strategy {
    case .legacy:
      return try createLegacyEvents(events)
    case .candidate:
      let execution = try productionCandidate.create(events: events)
      if !execution.eventIdentifiers.isEmpty {
        try trackActiveEvents(in: CalendarEventKitMutationProfilerDataset.queryRange(for: events))
      }
      return execution
    }
  }

  public func fetchEvents(
    in range: DateInterval
  ) throws -> [CalendarEventKitMutationProfilerEventSnapshot] {
    let events = try persistedEvents(in: range)
    let identifiers = events.map(\.calendarItemIdentifier)
    let uniqueNonemptyIdentifiers = Set(identifiers.filter { !$0.isEmpty })
    guard uniqueNonemptyIdentifiers.count == events.count else {
      throw CalendarEventKitMutationProfilerError.invalidEventIdentifiers(
        phase: "EventKit readback",
        expectedCount: events.count,
        actualCount: uniqueNonemptyIdentifiers.count
      )
    }
    return events.map { event in
      CalendarEventKitMutationProfilerEventSnapshot(
        eventIdentifier: event.calendarItemIdentifier,
        semanticEvent: CalendarEventKitMutationProfilerSemanticEvent(
          title: event.title ?? "",
          startMilliseconds: milliseconds(for: event.startDate),
          endMilliseconds: milliseconds(for: event.endDate),
          location: event.location ?? "",
          notes: event.notes ?? "",
          isAllDay: event.isAllDay
        )
      )
    }
  }

  public func delete(
    eventIdentifiers: [String],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    let execution: CalendarEventKitMutationProfilerMutationExecution
    switch strategy {
    case .legacy:
      execution = try deleteLegacyEvents(eventIdentifiers)
    case .candidate:
      execution = try productionCandidate.delete(eventIdentifiers: eventIdentifiers)
      removeActiveEvents(identifiers: Set(execution.eventIdentifiers))
    }
    return execution
  }

  public func cleanupActiveEvents() throws {
    guard !activeEventIdentifiers.isEmpty else {
      return
    }

    let identifiersToRemove = activeEventIdentifiers
    var failedIdentifiers: [String] = []
    var failureMessages: [String] = []
    var stagedRemovalCount = 0
    for identifier in identifiersToRemove {
      guard !identifier.isEmpty else {
        failedIdentifiers.append(identifier)
        failureMessages.append("<unassigned>: missing EventKit identifier")
        continue
      }
      guard let event = eventStore.calendarItem(withIdentifier: identifier) as? EKEvent else {
        continue
      }
      do {
        try eventStore.remove(event, span: .thisEvent, commit: false)
        stagedRemovalCount += 1
      } catch {
        if eventStore.calendarItem(withIdentifier: identifier) == nil {
          continue
        }
        failedIdentifiers.append(identifier)
        failureMessages.append("\(identifier): \(error.localizedDescription)")
      }
    }

    if stagedRemovalCount > 0 {
      do {
        try eventStore.commit()
      } catch {
        eventStore.reset()
        throw CalendarEventKitMutationProfilerError.activeEventCleanupFailed(
          messages: ["commit: \(error.localizedDescription)"]
        )
      }
    }

    activeEventIdentifiers = failedIdentifiers
    guard failureMessages.isEmpty else {
      throw CalendarEventKitMutationProfilerError.activeEventCleanupFailed(
        messages: failureMessages
      )
    }
  }

  private func createLegacyEvents(
    _ events: [CalendarEventKitMutationProfilerSemanticEvent]
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    let calendar = try requiredCalendar()
    var identifiers: [String] = []
    identifiers.reserveCapacity(events.count)
    let start = DispatchTime.now().uptimeNanoseconds

    for semanticEvent in events {
      let event = makeEvent(from: semanticEvent, calendar: calendar)
      try eventStore.save(event, span: .thisEvent, commit: true)
      let identifier = event.calendarItemIdentifier
      activeEventIdentifiers.append(identifier)
      identifiers.append(identifier)
    }

    let end = DispatchTime.now().uptimeNanoseconds
    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(end - start) / 1_000_000,
      commitCount: events.count,
      eventIdentifiers: identifiers,
      identifiersObservedBeforeFinalCommit: false
    )
  }

  private func persistedEvents(in range: DateInterval) throws -> [EKEvent] {
    let calendar = try requiredCalendar()
    let predicate = eventStore.predicateForEvents(
      withStart: range.start,
      end: range.end,
      calendars: [calendar]
    )
    return eventStore.events(matching: predicate)
  }

  private func trackActiveEvents(in range: DateInterval) throws {
    let knownIdentifiers = Set(activeEventIdentifiers)
    activeEventIdentifiers.append(
      contentsOf: try persistedEvents(in: range).map(\.calendarItemIdentifier).filter {
        !knownIdentifiers.contains($0)
      }
    )
  }

  private func requiredCalendar() throws -> EKCalendar {
    guard let calendar = eventStore.calendar(withIdentifier: calendarIdentifier) else {
      throw CalendarEventKitMutationProfilerError.temporaryCalendarUnavailable(
        identifier: calendarIdentifier
      )
    }
    return calendar
  }

  private func deleteLegacyEvents(
    _ eventIdentifiers: [String]
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    let start = DispatchTime.now().uptimeNanoseconds
    for identifier in eventIdentifiers {
      guard let event = eventStore.calendarItem(withIdentifier: identifier) as? EKEvent else {
        throw CalendarEventKitMutationProfilerError.eventIdentifierLookupFailed(
          identifier: identifier
        )
      }
      try eventStore.remove(event, span: .thisEvent, commit: true)
      removeActiveEvent(identifier: identifier)
    }
    let end = DispatchTime.now().uptimeNanoseconds
    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(end - start) / 1_000_000,
      commitCount: eventIdentifiers.count,
      eventIdentifiers: eventIdentifiers,
      identifiersObservedBeforeFinalCommit: false
    )
  }

  private func makeEvent(
    from semanticEvent: CalendarEventKitMutationProfilerSemanticEvent,
    calendar: EKCalendar
  ) -> EKEvent {
    let event = EKEvent(eventStore: eventStore)
    event.calendar = calendar
    event.title = semanticEvent.title
    event.startDate = semanticEvent.startDate
    event.endDate = semanticEvent.endDate
    event.location = semanticEvent.location
    event.notes = semanticEvent.notes
    event.isAllDay = semanticEvent.isAllDay
    return event
  }

  private func milliseconds(for date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1_000).rounded())
  }

  private func removeActiveEvent(identifier: String) {
    activeEventIdentifiers.removeAll { $0 == identifier }
  }

  private func removeActiveEvents(identifiers: Set<String>) {
    activeEventIdentifiers.removeAll { identifiers.contains($0) }
  }
}
