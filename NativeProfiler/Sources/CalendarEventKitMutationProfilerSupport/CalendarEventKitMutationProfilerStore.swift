import Foundation

@MainActor
public protocol CalendarEventKitMutationProfilerStore: AnyObject {
  func create(
    events: [CalendarEventKitMutationProfilerSemanticEvent],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution

  func fetchEvents(in range: DateInterval) throws
    -> [CalendarEventKitMutationProfilerEventSnapshot]

  func delete(
    eventIdentifiers: [String],
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerMutationExecution

  func cleanupActiveEvents() throws
}
