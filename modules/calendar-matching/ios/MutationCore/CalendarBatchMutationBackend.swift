public protocol CalendarBatchMutationBackend: AnyObject {
  func prepareCreateBatch(calendarID: String, timeZoneID: String) throws
  func prepareDeleteBatch() throws
  func createExportEvent(_ request: CalendarExportMutation) throws -> String
  func deleteEvent(_ request: CalendarDeleteMutation) throws -> CalendarDeleteMutationOutcome
  func commitBatch() throws
  func discardBatch()
}
