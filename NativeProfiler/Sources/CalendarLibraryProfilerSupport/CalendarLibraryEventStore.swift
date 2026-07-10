import CalendarMatchingCore
@preconcurrency import EventKit
import Foundation

@MainActor
final class CalendarLibraryEventStore {
  private let eventStore: EKEventStore
  private let calendars: [EKCalendar]

  init(eventStore: EKEventStore) {
    self.eventStore = eventStore
    calendars = eventStore.calendars(for: .event).filter { calendar in
      calendar.type != .birthday && calendar.source.sourceType != .birthdays
    }
  }

  var calendarCount: Int {
    calendars.count
  }

  func fetch(
    range: CalendarLibraryDateRange,
    strategy: CalendarLibraryFetchStrategy
  ) -> CalendarLibraryFetchResult {
    guard !calendars.isEmpty else {
      return CalendarLibraryFetchResult(
        windowCount: 0,
        rawEventCount: 0,
        uniqueEventIdentities: []
      )
    }

    let windows = windows(for: range, strategy: strategy)
    var rawEventCount = 0
    var identities = Set<CalendarLibraryEventIdentity>()
    for window in windows {
      let predicate = eventStore.predicateForEvents(
        withStart: window.start,
        end: window.end,
        calendars: calendars
      )
      let events = eventStore.events(matching: predicate)
      rawEventCount += events.count
      for event in events {
        identities.insert(
          CalendarLibraryEventIdentity(
            calendarItemIdentifier: event.calendarItemIdentifier,
            startDateMilliseconds: Self.milliseconds(event.startDate),
            endDateMilliseconds: Self.milliseconds(event.endDate)
          )
        )
      }
    }

    return CalendarLibraryFetchResult(
      windowCount: windows.count,
      rawEventCount: rawEventCount,
      uniqueEventIdentities: identities
    )
  }

  private func windows(
    for range: CalendarLibraryDateRange,
    strategy: CalendarLibraryFetchStrategy
  ) -> [DateInterval] {
    switch strategy {
    case .production:
      return CalendarEventQueryWindowPlanner.windows(
        startDateMs: range.startDate.timeIntervalSince1970 * 1_000,
        endDateMs: range.endDate.timeIntervalSince1970 * 1_000
      ).map { window in
        DateInterval(
          start: Date(timeIntervalSince1970: window.startDateMs / 1_000),
          end: Date(timeIntervalSince1970: window.endDateMs / 1_000)
        )
      }
    case .reference(let windowDays):
      return CalendarLibraryReferenceWindowPlanner.windows(
        startDate: range.startDate,
        endDate: range.endDate,
        maximumWindowDays: windowDays
      )
    }
  }

  private static func milliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1_000).rounded())
  }
}
