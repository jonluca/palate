import CalendarBatchMutationCore

final class FakeCalendarEventKitMutationBackend: CalendarBatchMutationBackend {
  var commitError: (any Error)?
  var createHandler: (CalendarExportMutation) throws -> String = {
    "event-\($0.requestID)"
  }
  var deleteHandler: (CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome = { _ in
    .deleted
  }

  private(set) var commitCallCount = 0
  private(set) var createRequests: [CalendarExportMutation] = []
  private(set) var deleteRequests: [CalendarDeleteMutation] = []
  private(set) var discardCallCount = 0
  private(set) var preparedCalendarIdentifier: String?
  private(set) var preparedTimeZoneIdentifier: String?

  func prepareCreateBatch(calendarID: String, timeZoneID: String) {
    preparedCalendarIdentifier = calendarID
    preparedTimeZoneIdentifier = timeZoneID
  }

  func prepareDeleteBatch() {}

  func createExportEvent(_ request: CalendarExportMutation) throws -> String {
    createRequests.append(request)
    return try createHandler(request)
  }

  func deleteEvent(_ request: CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome {
    deleteRequests.append(request)
    return try deleteHandler(request)
  }

  func commitBatch() throws {
    commitCallCount += 1
    if let commitError {
      throw commitError
    }
  }

  func discardBatch() {
    discardCallCount += 1
  }
}
