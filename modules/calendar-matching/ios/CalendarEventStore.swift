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
    return try events(
      windows: CalendarEventQueryWindowPlanner.windows(
        startDateMs: startMs,
        endDateMs: endMs
      ),
      selectedCalendarIds: selectedCalendarIds
    )
  }

  func events(
    windows: [CalendarEventQueryWindow],
    selectedCalendarIds: [String]?
  ) throws -> [CalendarEventRecord] {
    guard
      windows.allSatisfy({ window in
        CalendarMatchingTimestamp.isSupported(window.startDateMs)
          && CalendarMatchingTimestamp.isSupported(window.endDateMs)
          && window.endDateMs >= window.startDateMs
      })
    else {
      let invalidWindow = windows.first { window in
        !CalendarMatchingTimestamp.isSupported(window.startDateMs)
          || !CalendarMatchingTimestamp.isSupported(window.endDateMs)
          || window.endDateMs < window.startDateMs
      }
      throw CalendarMatchingModuleError.invalidDateRange(
        startMs: invalidWindow?.startDateMs ?? .nan,
        endMs: invalidWindow?.endDateMs ?? .nan
      )
    }
    guard !windows.isEmpty else {
      return []
    }
    try requireCalendarReadAccess()

    let calendars = selectedCalendars(selectedCalendarIds)
    guard !calendars.isEmpty else {
      return []
    }

    var seenEvents: Set<EventIdentity> = []
    var records: [CalendarEventRecord] = []

    for window in windows {
      let predicate = eventStore.predicateForEvents(
        withStart: Date(timeIntervalSince1970: window.startDateMs / 1_000),
        end: Date(timeIntervalSince1970: window.endDateMs / 1_000),
        calendars: calendars
      )

      for event in eventStore.events(matching: predicate) {
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
        records.append(record)
      }
    }

    return
      records
      .sorted { lhs, rhs in
        if lhs.startDate != rhs.startDate {
          return lhs.startDate < rhs.startDate
        }
        if lhs.endDate != rhs.endDate {
          return lhs.endDate < rhs.endDate
        }
        return lhs.id < rhs.id
      }
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
