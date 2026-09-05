import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

@Record
struct CalendarMutationResultRecord {
  var inputIndex: Int = 0
  var requestId: String = ""
  var status: String = CalendarMutationStatus.failed.rawValue
  var eventId: String?
  var errorCode: String?
  var errorMessage: String?

  init() {}

  init(result: CalendarMutationResult) {
    inputIndex = result.inputIndex
    requestId = result.requestID
    status = result.status.rawValue
    eventId = result.eventID
    errorCode = result.errorCode
    errorMessage = result.errorMessage
  }
}
