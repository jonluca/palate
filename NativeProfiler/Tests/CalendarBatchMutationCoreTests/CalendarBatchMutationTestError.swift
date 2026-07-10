import CalendarBatchMutationCore
import Foundation

enum CalendarBatchMutationTestError: CalendarMutationCodedError, Equatable, LocalizedError {
  case commitFailed
  case denied
  case invalidTimeZone
  case operationFailed

  var calendarMutationCode: String {
    switch self {
    case .commitFailed:
      return "TEST_COMMIT_FAILED"
    case .denied:
      return "TEST_ACCESS_DENIED"
    case .invalidTimeZone:
      return "TEST_INVALID_TIME_ZONE"
    case .operationFailed:
      return "TEST_OPERATION_FAILED"
    }
  }

  var errorDescription: String? {
    switch self {
    case .commitFailed:
      return "The test batch commit failed."
    case .denied:
      return "Calendar access is denied."
    case .invalidTimeZone:
      return "The test time zone is invalid."
    case .operationFailed:
      return "The requested test operation failed."
    }
  }
}
