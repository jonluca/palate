import Foundation

public struct CalendarLibraryProfilerFailureReport: Encodable, Sendable {
  public let schemaVersion = 1
  public let status = "error"
  public let errorType: String
  public let message: String
  public let authorizationStatus: String?

  public init(errorType: String, message: String, authorizationStatus: String? = nil) {
    self.errorType = errorType
    self.message = message
    self.authorizationStatus = authorizationStatus
  }
}
