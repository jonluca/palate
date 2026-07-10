import ExpoModulesCore
import Foundation

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

public final class CalendarMatchingModule: Module {
  private let calendarQueue = DispatchQueue(
    label: "com.jonluca.palate.calendar-matching",
    qos: .userInitiated
  )
  private let calendarEventStore = CalendarEventStore()
  private let runtimeConfiguration: CalendarMatchingRuntimeConfiguration = {
    let environment = ProcessInfo.processInfo.environment
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: environment)
    CalendarMatchingRuntimeAttestation.writeIfRequested(
      configuration: configuration,
      environment: environment
    )
    return configuration
  }()
  private let calendarMutationExecutor = CalendarBatchMutationExecutor(
    makeBackend: { CalendarEventKitMutationBackend() }
  )

  public func definition() -> ModuleDefinition {
    Name("CalendarMatching")

    Constant("calendarQueryStrategy") {
      self.runtimeConfiguration.queryStrategy.rawValue
    }

    Constant("calendarQueryGapDays") {
      self.runtimeConfiguration.sparseCoalescingGapDays
    }

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
        windows: request.eventQueryWindows(configuration: self.runtimeConfiguration),
        selectedCalendarIds: selectedCalendarIds
      )
      return CalendarMatcher.matchEligibleEvents(
        visits: request.visits,
        events: events.map(\.coreEvent),
        bufferMilliseconds: request.bufferMilliseconds
      ).map(CalendarVisitMatchRecord.init)
    }.runOnQueue(calendarQueue)

    AsyncFunction("batchCreateExportEvents") {
      (calendarId: String, timeZone: String, requests: [CalendarExportEventMutationRecord]) throws
        -> [CalendarMutationResultRecord] in
      try self.calendarMutationExecutor.createExportEvents(
        calendarID: calendarId,
        timeZoneID: timeZone,
        requests: requests.map(\.coreMutation)
      ).map { CalendarMutationResultRecord(result: $0) }
    }.runOnQueue(calendarQueue)

    AsyncFunction("batchDeleteEvents") {
      (requests: [CalendarDeleteEventMutationRecord]) throws -> [CalendarMutationResultRecord] in
      try self.calendarMutationExecutor.deleteEvents(
        requests: requests.map(\.coreMutation)
      ).map { CalendarMutationResultRecord(result: $0) }
    }.runOnQueue(calendarQueue)
  }
}
