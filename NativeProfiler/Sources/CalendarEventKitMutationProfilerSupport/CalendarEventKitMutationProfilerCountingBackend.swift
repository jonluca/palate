import CalendarBatchMutationCore

final class CalendarEventKitMutationProfilerCountingBackend<
  Backend: CalendarBatchMutationBackend
>: CalendarBatchMutationBackend {
  private let backend: Backend

  private(set) var commitCallCount = 0
  private(set) var discardCallCount = 0
  private(set) var createdEventIdentifiers: [String] = []
  private(set) var createdEventIdentifiersAtCommit: [String]?
  private(set) var deletedEventIdentifiers: [String] = []
  private(set) var deletedEventIdentifiersAtCommit: [String]?

  init(backend: Backend) {
    self.backend = backend
  }

  func prepareCreateBatch(calendarID: String, timeZoneID: String) throws {
    try backend.prepareCreateBatch(calendarID: calendarID, timeZoneID: timeZoneID)
  }

  func prepareDeleteBatch() throws {
    try backend.prepareDeleteBatch()
  }

  func createExportEvent(_ request: CalendarExportMutation) throws -> String {
    let identifier = try backend.createExportEvent(request)
    createdEventIdentifiers.append(identifier)
    return identifier
  }

  func deleteEvent(_ request: CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome {
    let outcome = try backend.deleteEvent(request)
    if outcome == .deleted {
      deletedEventIdentifiers.append(request.eventID)
    }
    return outcome
  }

  func commitBatch() throws {
    commitCallCount += 1
    createdEventIdentifiersAtCommit = createdEventIdentifiers
    deletedEventIdentifiersAtCommit = deletedEventIdentifiers
    try backend.commitBatch()
  }

  func discardBatch() {
    discardCallCount += 1
    backend.discardBatch()
  }
}
