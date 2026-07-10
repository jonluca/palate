import Foundation

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

enum CalendarEventKitMutationError: CalendarMutationCodedError, LocalizedError {
  case accessRequired(status: Int)
  case backendNotPrepared
  case batchCommitFailed(String)
  case calendarNotFound(String)
  case calendarNotWritable(String)
  case eventDeleteFailed(String)
  case eventSaveFailed(String)
  case invalidCalendarType(String)
  case invalidTimeZone(String)

  var calendarMutationCode: String {
    switch self {
    case .accessRequired:
      return "ERR_CALENDAR_ACCESS_REQUIRED"
    case .backendNotPrepared:
      return "ERR_CALENDAR_MUTATION_BACKEND_NOT_PREPARED"
    case .batchCommitFailed:
      return "ERR_CALENDAR_BATCH_COMMIT_FAILED"
    case .calendarNotFound:
      return "ERR_CALENDAR_NOT_FOUND"
    case .calendarNotWritable:
      return "ERR_CALENDAR_NOT_WRITABLE"
    case .eventDeleteFailed:
      return "ERR_CALENDAR_EVENT_DELETE_FAILED"
    case .eventSaveFailed:
      return "ERR_CALENDAR_EVENT_SAVE_FAILED"
    case .invalidCalendarType:
      return "ERR_CALENDAR_INVALID_TYPE"
    case .invalidTimeZone:
      return "ERR_CALENDAR_INVALID_TIME_ZONE"
    }
  }

  var errorDescription: String? {
    switch self {
    case .accessRequired(let status):
      return "Full calendar access is required (authorization status: \(status))."
    case .backendNotPrepared:
      return "The calendar mutation backend was used before its batch preflight completed."
    case .batchCommitFailed(let message):
      return "The calendar event batch could not be committed: \(message)"
    case .calendarNotFound(let calendarID):
      return "Calendar \(calendarID) could not be found."
    case .calendarNotWritable(let calendarID):
      return "Calendar \(calendarID) does not allow event modifications."
    case .eventDeleteFailed(let message):
      return "The calendar event could not be deleted: \(message)"
    case .eventSaveFailed(let message):
      return "The calendar event could not be saved: \(message)"
    case .invalidCalendarType(let calendarID):
      return "Calendar \(calendarID) does not support events."
    case .invalidTimeZone(let identifier):
      return "Invalid calendar event time zone: \(identifier)."
    }
  }
}
