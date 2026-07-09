import Foundation

enum CalendarProfilerArgumentsError: Error, LocalizedError {
  case invalidInteger(option: String, value: String, allowsZero: Bool)
  case missingValue(option: String)
  case unknownOption(String)

  var errorDescription: String? {
    switch self {
    case .invalidInteger(let option, let value, let allowsZero):
      let requirement = allowsZero ? "a non-negative integer" : "a positive integer"
      return "\(option) must be \(requirement); received \(value)."
    case .missingValue(let option):
      return "Missing value after \(option)."
    case .unknownOption(let option):
      return "Unknown option: \(option)."
    }
  }
}
