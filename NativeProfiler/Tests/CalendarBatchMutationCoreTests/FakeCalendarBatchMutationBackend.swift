import CalendarBatchMutationCore

final class FakeCalendarBatchMutationBackend: CalendarBatchMutationBackend {
  var prepareCreateError: (any Error)?
  var prepareDeleteError: (any Error)?
  var commitError: (any Error)?
  var createHandler: (CalendarExportMutation) throws -> String = {
    "event-\($0.requestID)"
  }
  var deleteHandler: (CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome = { _ in
    .deleted
  }

  private(set) var prepareCreateCallCount = 0
  private(set) var prepareDeleteCallCount = 0
  private(set) var createCallCount = 0
  private(set) var deleteCallCount = 0
  private(set) var commitCallCount = 0
  private(set) var discardCallCount = 0
  private(set) var preparedCalendarID: String?
  private(set) var preparedTimeZoneID: String?
  private(set) var createdRequests: [CalendarExportMutation] = []
  private(set) var deletedRequests: [CalendarDeleteMutation] = []

  func prepareCreateBatch(calendarID: String, timeZoneID: String) throws {
    prepareCreateCallCount += 1
    preparedCalendarID = calendarID
    preparedTimeZoneID = timeZoneID
    if let prepareCreateError {
      throw prepareCreateError
    }
  }

  func prepareDeleteBatch() throws {
    prepareDeleteCallCount += 1
    if let prepareDeleteError {
      throw prepareDeleteError
    }
  }

  func createExportEvent(_ request: CalendarExportMutation) throws -> String {
    createCallCount += 1
    createdRequests.append(request)
    return try createHandler(request)
  }

  func deleteEvent(_ request: CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome {
    deleteCallCount += 1
    deletedRequests.append(request)
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
