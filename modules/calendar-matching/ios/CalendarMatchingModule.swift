import ExpoModulesCore
import Foundation

public final class CalendarMatchingModule: Module {
  private let calendarQueue = DispatchQueue(
    label: "com.jonluca.palate.calendar-matching",
    qos: .userInitiated
  )
  private let calendarEventStore = CalendarEventStore()

  public func definition() -> ModuleDefinition {
    Name("CalendarMatching")

    AsyncFunction("getEvents") {
      (startMs: Double, endMs: Double, selectedCalendarIds: [String]?) -> [CalendarEventRecord] in
      try self.calendarEventStore.events(
        startMs: startMs,
        endMs: endMs,
        selectedCalendarIds: selectedCalendarIds
      )
    }.runOnQueue(calendarQueue)

    AsyncFunction("matchVisits") {
      (visits: [CalendarVisitRecord], selectedCalendarIds: [String]?, bufferMinutes: Double)
        throws -> [CalendarVisitMatchRecord] in
      let request = try CalendarVisitMatchRequest(
        visits: visits,
        bufferMinutes: bufferMinutes
      )
      guard !request.visits.isEmpty else {
        return []
      }

      let events = try self.calendarEventStore.events(
        startMs: request.searchStartMs,
        endMs: request.searchEndMs,
        selectedCalendarIds: selectedCalendarIds
      )
      return CalendarMatcher.matchEligibleEvents(
        visits: request.visits,
        events: events.map(\.coreEvent),
        bufferMilliseconds: request.bufferMilliseconds
      ).map(CalendarVisitMatchRecord.init)
    }.runOnQueue(calendarQueue)
  }
}
