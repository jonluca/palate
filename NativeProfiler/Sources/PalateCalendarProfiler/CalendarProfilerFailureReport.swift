import Foundation

struct CalendarProfilerFailureReport: Encodable, Sendable {
  let schemaVersion = 1
  let status = "error"
  let errorType: String
  let message: String
}
