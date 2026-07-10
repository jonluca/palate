public struct CalendarMutationResult: Equatable, Sendable {
  public let inputIndex: Int
  public let requestID: String
  public let status: CalendarMutationStatus
  public let eventID: String?
  public let errorCode: String?
  public let errorMessage: String?

  public init(
    inputIndex: Int,
    requestID: String,
    status: CalendarMutationStatus,
    eventID: String?,
    errorCode: String?,
    errorMessage: String?
  ) {
    self.inputIndex = inputIndex
    self.requestID = requestID
    self.status = status
    self.eventID = eventID
    self.errorCode = errorCode
    self.errorMessage = errorMessage
  }
}
