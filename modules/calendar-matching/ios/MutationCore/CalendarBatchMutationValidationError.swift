import Foundation

public enum CalendarBatchMutationValidationError: CalendarMutationCodedError,
  Equatable, LocalizedError, Sendable
{
  case duplicateRequestID(String)
  case invalidDateRange(requestID: String, startMs: Double, endMs: Double)
  case invalidInstanceStart(requestID: String, value: Double)
  case missingEventID(requestID: String)

  public var calendarMutationCode: String {
    switch self {
    case .duplicateRequestID:
      return "ERR_CALENDAR_DUPLICATE_REQUEST_ID"
    case .invalidDateRange:
      return "ERR_CALENDAR_INVALID_DATE_RANGE"
    case .invalidInstanceStart:
      return "ERR_CALENDAR_INVALID_INSTANCE_DATE"
    case .missingEventID:
      return "ERR_CALENDAR_EVENT_ID_REQUIRED"
    }
  }

  public var errorDescription: String? {
    switch self {
    case .duplicateRequestID(let requestID):
      return "Calendar mutation request IDs must be unique; received duplicate \(requestID)."
    case .invalidDateRange(let requestID, let startMs, let endMs):
      return
        "Calendar export request \(requestID) must contain finite supported dates with start <= end; "
        + "received \(startMs)...\(endMs)."
    case .invalidInstanceStart(let requestID, let value):
      return
        "Calendar deletion request \(requestID) must contain a finite supported instance start; "
        + "received \(value)."
    case .missingEventID(let requestID):
      return "Calendar deletion request \(requestID) must contain a non-empty event ID."
    }
  }
}
