import Foundation

public struct CalendarEventKitMutationProfilerFailureReport: Codable, Sendable {
  public let schemaVersion: Int
  public let status: String
  public let errorType: String
  public let message: String
  public let authorizationStatus: String?

  public init(
    errorType: String,
    message: String,
    authorizationStatus: String?
  ) {
    schemaVersion = 1
    status = "error"
    self.errorType = errorType
    self.message = message
    self.authorizationStatus = authorizationStatus
  }
}
