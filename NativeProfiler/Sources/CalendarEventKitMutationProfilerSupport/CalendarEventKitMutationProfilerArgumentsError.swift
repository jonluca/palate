import Foundation

public enum CalendarEventKitMutationProfilerArgumentsError: Error, Equatable, LocalizedError {
  case duplicateOption(String)
  case invalidInteger(option: String, value: String)
  case missingValue(option: String)
  case nonPositiveValue(option: String)
  case optionAboveMaximum(option: String, maximum: Int)
  case optionBelowMinimum(option: String, minimum: Int)
  case unknownOption(String)

  public var errorDescription: String? {
    switch self {
    case .duplicateOption(let option):
      return "Option \(option) was provided more than once."
    case .invalidInteger(let option, let value):
      return "Option \(option) requires an integer, not \(value)."
    case .missingValue(let option):
      return "Option \(option) requires a value."
    case .nonPositiveValue(let option):
      return "Option \(option) must be greater than zero."
    case .optionAboveMaximum(let option, let maximum):
      return "Option \(option) must not exceed \(maximum)."
    case .optionBelowMinimum(let option, let minimum):
      return "Option \(option) must be at least \(minimum)."
    case .unknownOption(let option):
      return "Unknown option: \(option)."
    }
  }
}
