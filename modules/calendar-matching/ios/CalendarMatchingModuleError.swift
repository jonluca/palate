import ExpoModulesCore
import Foundation

enum CalendarMatchingModuleError: CodedError, LocalizedError {
  case calendarAccessRequired(status: Int)
  case invalidDateRange(startMs: Double, endMs: Double)
  case invalidVisitRange(id: String, startMs: Double, endMs: Double)
  case invalidBufferMinutes(Double)

  var code: String {
    switch self {
    case .calendarAccessRequired:
      return "ERR_CALENDAR_ACCESS_REQUIRED"
    case .invalidDateRange:
      return "ERR_CALENDAR_INVALID_DATE_RANGE"
    case .invalidVisitRange:
      return "ERR_CALENDAR_INVALID_VISIT_RANGE"
    case .invalidBufferMinutes:
      return "ERR_CALENDAR_INVALID_BUFFER"
    }
  }

  var errorDescription: String? {
    switch self {
    case .calendarAccessRequired(let status):
      return "Full calendar read access is required (authorization status: \(status))."
    case .invalidDateRange(let startMs, let endMs):
      return
        "Calendar date range must contain finite values with start <= end; "
        + "received \(startMs)...\(endMs)."
    case .invalidVisitRange(let id, let startMs, let endMs):
      return
        "Visit \(id) must contain finite values with start <= end; "
        + "received \(startMs)...\(endMs)."
    case .invalidBufferMinutes(let value):
      return
        "Calendar matching buffer must be a finite non-negative number of minutes; "
        + "received \(value)."
    }
  }
}
