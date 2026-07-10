import CalendarBatchMutationCore
import Foundation

enum CalendarEventKitMutationProfilerTestError: CalendarMutationCodedError, LocalizedError {
  case commitFailed

  var calendarMutationCode: String {
    "TEST_COMMIT_FAILED"
  }

  var errorDescription: String? {
    "The test commit failed."
  }
}
