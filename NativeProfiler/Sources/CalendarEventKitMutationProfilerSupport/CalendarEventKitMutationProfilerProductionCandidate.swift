import CalendarBatchMutationCore
import Foundation

@MainActor
final class CalendarEventKitMutationProfilerProductionCandidate<
  Backend: CalendarBatchMutationBackend
> {
  private let calendarIdentifier: String
  private let timeZoneIdentifier: String
  private let makeBackend: () -> Backend

  init(
    calendarIdentifier: String,
    timeZoneIdentifier: String = "UTC",
    makeBackend: @escaping () -> Backend
  ) {
    self.calendarIdentifier = calendarIdentifier
    self.timeZoneIdentifier = timeZoneIdentifier
    self.makeBackend = makeBackend
  }

  func create(
    events: [CalendarEventKitMutationProfilerSemanticEvent]
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    let requests = events.enumerated().map { index, event in
      CalendarExportMutation(
        requestID: "eventkit-profiler-create-\(index)",
        title: event.title,
        startMs: Double(event.startMilliseconds),
        endMs: Double(event.endMilliseconds),
        location: event.location,
        notes: event.notes
      )
    }
    var countingBackend: CalendarEventKitMutationProfilerCountingBackend<Backend>?
    let executor = CalendarBatchMutationExecutor {
      let backend = CalendarEventKitMutationProfilerCountingBackend(
        backend: self.makeBackend()
      )
      countingBackend = backend
      return backend
    }

    let start = DispatchTime.now().uptimeNanoseconds
    let results = try executor.createExportEvents(
      calendarID: calendarIdentifier,
      timeZoneID: timeZoneIdentifier,
      requests: requests
    )
    let end = DispatchTime.now().uptimeNanoseconds
    let identifiers = results.compactMap { result in
      result.status == .created ? result.eventID : nil
    }
    let identifiersAtCommit = countingBackend?.createdEventIdentifiersAtCommit

    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(end - start) / 1_000_000,
      commitCount: countingBackend?.commitCallCount ?? 0,
      eventIdentifiers: identifiers,
      identifiersObservedBeforeFinalCommit: identifiersAtCommit == identifiers
        && identifiers.count == events.count
    )
  }

  func delete(
    eventIdentifiers: [String]
  ) throws -> CalendarEventKitMutationProfilerMutationExecution {
    let requests = eventIdentifiers.enumerated().map { index, identifier in
      CalendarDeleteMutation(
        requestID: "eventkit-profiler-delete-\(index)",
        eventID: identifier,
        instanceStartMs: nil,
        futureEvents: false
      )
    }
    var countingBackend: CalendarEventKitMutationProfilerCountingBackend<Backend>?
    let executor = CalendarBatchMutationExecutor {
      let backend = CalendarEventKitMutationProfilerCountingBackend(
        backend: self.makeBackend()
      )
      countingBackend = backend
      return backend
    }

    let start = DispatchTime.now().uptimeNanoseconds
    let results = try executor.deleteEvents(requests: requests)
    let end = DispatchTime.now().uptimeNanoseconds
    let deletedIdentifiers = results.compactMap { result in
      result.status == .deleted ? result.eventID : nil
    }

    return CalendarEventKitMutationProfilerMutationExecution(
      elapsedMilliseconds: Double(end - start) / 1_000_000,
      commitCount: countingBackend?.commitCallCount ?? 0,
      eventIdentifiers: deletedIdentifiers,
      identifiersObservedBeforeFinalCommit: false
    )
  }
}
