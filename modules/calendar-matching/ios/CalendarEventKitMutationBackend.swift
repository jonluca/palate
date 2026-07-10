import EventKit
import Foundation

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

public final class CalendarEventKitMutationBackend: CalendarBatchMutationBackend {
  private let eventStore: EKEventStore
  private var exportCalendar: EKCalendar?
  private var exportTimeZone: TimeZone?

  public init(eventStore: EKEventStore = EKEventStore()) {
    self.eventStore = eventStore
  }

  public func prepareCreateBatch(calendarID: String, timeZoneID: String) throws {
    try requireCalendarAccess()
    guard let calendar = eventStore.calendar(withIdentifier: calendarID) else {
      throw CalendarEventKitMutationError.calendarNotFound(calendarID)
    }
    guard !calendar.allowedEntityTypes.isDisjoint(with: .event) else {
      throw CalendarEventKitMutationError.invalidCalendarType(calendarID)
    }
    guard let timeZone = TimeZone(identifier: timeZoneID) else {
      throw CalendarEventKitMutationError.invalidTimeZone(timeZoneID)
    }
    guard calendar.allowsContentModifications else {
      throw CalendarEventKitMutationError.calendarNotWritable(calendarID)
    }

    exportCalendar = calendar
    exportTimeZone = timeZone
  }

  public func prepareDeleteBatch() throws {
    try requireCalendarAccess()
  }

  public func createExportEvent(_ request: CalendarExportMutation) throws -> String {
    guard let exportCalendar, let exportTimeZone else {
      throw CalendarEventKitMutationError.backendNotPrepared
    }

    let event = EKEvent(eventStore: eventStore)
    event.calendar = exportCalendar
    event.title = request.title
    event.startDate = Date(timeIntervalSince1970: request.startMs / 1_000)
    event.endDate = Date(timeIntervalSince1970: request.endMs / 1_000)
    event.location = request.location
    event.notes = request.notes
    event.timeZone = exportTimeZone
    event.isAllDay = false
    event.alarms = []
    event.recurrenceRules = nil
    event.availability = .notSupported

    do {
      try eventStore.save(event, span: .thisEvent, commit: false)
    } catch {
      throw CalendarEventKitMutationError.eventSaveFailed(error.localizedDescription)
    }
    return event.calendarItemIdentifier
  }

  public func deleteEvent(
    _ request: CalendarDeleteMutation
  ) throws -> CalendarDeleteMutationOutcome {
    guard
      let event = event(
        withIdentifier: request.eventID,
        instanceStartMs: request.instanceStartMs
      )
    else {
      return .alreadyAbsent
    }

    let span: EKSpan = request.futureEvents ? .futureEvents : .thisEvent
    do {
      try eventStore.remove(event, span: span, commit: false)
    } catch {
      throw CalendarEventKitMutationError.eventDeleteFailed(error.localizedDescription)
    }
    return .deleted
  }

  public func commitBatch() throws {
    do {
      try eventStore.commit()
    } catch {
      throw CalendarEventKitMutationError.batchCommitFailed(error.localizedDescription)
    }
  }

  public func discardBatch() {
    eventStore.reset()
  }

  private func requireCalendarAccess() throws {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(iOS 17.0, macOS 14.0, *) {
      guard status == .fullAccess else {
        throw CalendarEventKitMutationError.accessRequired(status: status.rawValue)
      }
    } else {
      guard status == .authorized else {
        throw CalendarEventKitMutationError.accessRequired(status: status.rawValue)
      }
    }
  }

  private func event(withIdentifier eventID: String, instanceStartMs: Double?) -> EKEvent? {
    guard let firstEvent = eventStore.calendarItem(withIdentifier: eventID) as? EKEvent else {
      return nil
    }
    guard let instanceStartMs else {
      return firstEvent
    }

    let instanceStart = Date(timeIntervalSince1970: instanceStartMs / 1_000)
    if firstEvent.startDate.compare(instanceStart) == .orderedSame {
      return firstEvent
    }

    let endDate = instanceStart.addingTimeInterval(2_592_000)
    let predicate = eventStore.predicateForEvents(
      withStart: instanceStart,
      end: endDate,
      calendars: [firstEvent.calendar]
    )
    return eventStore.events(matching: predicate).first { candidate in
      candidate.calendarItemIdentifier == firstEvent.calendarItemIdentifier
        && candidate.startDate.compare(instanceStart) == .orderedSame
    }
  }
}
