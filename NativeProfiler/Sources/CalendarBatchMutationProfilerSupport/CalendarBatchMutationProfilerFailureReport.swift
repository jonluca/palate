import Foundation

public struct CalendarBatchMutationProfilerFailureReport: Encodable, Sendable {
  public let schemaVersion = 1
  public let status = "error"
  public let mode = "synthetic-permission-free"
  public let errorType: String
  public let message: String

  public init(errorType: String, message: String) {
    self.errorType = errorType
    self.message = message
  }
}
