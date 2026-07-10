public struct CalendarDeleteMutation: Equatable, Sendable {
  public let requestID: String
  public let eventID: String
  public let instanceStartMs: Double?
  public let futureEvents: Bool

  public init(
    requestID: String,
    eventID: String,
    instanceStartMs: Double?,
    futureEvents: Bool
  ) {
    self.requestID = requestID
    self.eventID = eventID
    self.instanceStartMs = instanceStartMs
    self.futureEvents = futureEvents
  }

  public func validate() throws {
    guard !eventID.isEmpty else {
      throw CalendarBatchMutationValidationError.missingEventID(requestID: requestID)
    }
    guard let instanceStartMs else {
      return
    }
    guard instanceStartMs.isFinite,
      abs(instanceStartMs) <= CalendarExportMutation.maximumAbsoluteTimestampMilliseconds
    else {
      throw CalendarBatchMutationValidationError.invalidInstanceStart(
        requestID: requestID,
        value: instanceStartMs
      )
    }
  }
}
