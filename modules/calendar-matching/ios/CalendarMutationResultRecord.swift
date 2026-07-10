import ExpoModulesCore

#if SWIFT_PACKAGE
  import CalendarBatchMutationCore
#endif

struct CalendarMutationResultRecord: Record {
  @Field var inputIndex: Int = 0
  @Field var requestId: String = ""
  @Field var status: String = CalendarMutationStatus.failed.rawValue
  @Field var eventId: String?
  @Field var errorCode: String?
  @Field var errorMessage: String?

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
