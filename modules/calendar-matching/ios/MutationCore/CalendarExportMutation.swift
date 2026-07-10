public struct CalendarExportMutation: Equatable, Sendable {
  public static let maximumAbsoluteTimestampMilliseconds = 8_640_000_000_000_000.0

  public let requestID: String
  public let title: String
  public let startMs: Double
  public let endMs: Double
  public let location: String?
  public let notes: String

  public init(
    requestID: String,
    title: String,
    startMs: Double,
    endMs: Double,
    location: String?,
    notes: String
  ) {
    self.requestID = requestID
    self.title = title
    self.startMs = startMs
    self.endMs = endMs
    self.location = location
    self.notes = notes
  }

  public func validate() throws {
    guard startMs.isFinite,
      endMs.isFinite,
      abs(startMs) <= Self.maximumAbsoluteTimestampMilliseconds,
      abs(endMs) <= Self.maximumAbsoluteTimestampMilliseconds,
      endMs >= startMs
    else {
      throw CalendarBatchMutationValidationError.invalidDateRange(
        requestID: requestID,
        startMs: startMs,
        endMs: endMs
      )
    }
  }
}
