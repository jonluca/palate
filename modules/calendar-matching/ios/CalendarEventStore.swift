import EventKit
import Foundation

final class CalendarEventStore {
  private struct EventIdentity: Hashable {
    let id: String
    let startDate: Double
    let endDate: Double
  }

  private let eventStore = EKEventStore()

  func events(
    startMs: Double,
    endMs: Double,
    selectedCalendarIds: [String]?
  ) throws -> [CalendarEventRecord] {
    guard CalendarMatchingTimestamp.isSupported(startMs),
      CalendarMatchingTimestamp.isSupported(endMs),
      endMs >= startMs
    else {
      throw CalendarMatchingModuleError.invalidDateRange(startMs: startMs, endMs: endMs)
    }
    try requireCalendarReadAccess()

    let calendars = selectedCalendars(selectedCalendarIds)
    guard !calendars.isEmpty else {
      return []
    }

    var seenEvents: Set<EventIdentity> = []
    var indexedRecords: [(record: CalendarEventRecord, originalIndex: Int)] = []
    var originalIndex = 0

    for window in CalendarEventQueryWindowPlanner.windows(
      startDateMs: startMs,
      endDateMs: endMs
    ) {
      let predicate = eventStore.predicateForEvents(
        withStart: Date(timeIntervalSince1970: window.startDateMs / 1_000),
        end: Date(timeIntervalSince1970: window.endDateMs / 1_000),
        calendars: calendars
      )

      for event in eventStore.events(matching: predicate) {
        defer { originalIndex += 1 }
        guard let record = CalendarEventRecord.initIfEligible(event: event) else {
          continue
        }
        let identity = EventIdentity(
          id: record.id,
          startDate: record.startDate,
          endDate: record.endDate
        )
        guard seenEvents.insert(identity).inserted else {
          continue
        }
        indexedRecords.append((record, originalIndex))
      }
    }

    return
      indexedRecords
      .sorted { lhs, rhs in
        if lhs.record.startDate != rhs.record.startDate {
          return lhs.record.startDate < rhs.record.startDate
        }
        if lhs.record.endDate != rhs.record.endDate {
          return lhs.record.endDate < rhs.record.endDate
        }
        return lhs.originalIndex < rhs.originalIndex
      }
      .map(\.record)
  }

  private func requireCalendarReadAccess() throws {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(iOS 17.0, *) {
      guard status == .fullAccess else {
        throw CalendarMatchingModuleError.calendarAccessRequired(status: status.rawValue)
      }
    } else {
      guard status == .authorized else {
        throw CalendarMatchingModuleError.calendarAccessRequired(status: status.rawValue)
      }
    }
  }

  private func selectedCalendars(_ selectedCalendarIds: [String]?) -> [EKCalendar] {
    let calendars = eventStore.calendars(for: .event).filter { calendar in
      calendar.type != .birthday && calendar.source.sourceType != .birthdays
    }
    guard let selectedCalendarIds else {
      return calendars
    }
    guard !selectedCalendarIds.isEmpty else {
      return []
    }

    let selectedIds = Set(selectedCalendarIds)
    return calendars.filter { selectedIds.contains($0.calendarIdentifier) }
  }
}
