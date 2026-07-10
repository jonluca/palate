import Foundation

public enum CalendarLibraryProfilerArgumentsError: Error, Equatable, LocalizedError, Sendable {
  case duplicateOption(String)
  case invalidInteger(option: String, value: String)
  case missingValue(option: String)
  case negativeValue(option: String)
  case nonPositiveValue(option: String)
  case optionAboveMaximum(option: String, maximum: Int)
  case rangeAboveMaximum(maximumDays: Int)
  case unknownOption(String)
  case zeroLengthRange
  public var errorDescription: String? {
    switch self {
    case .duplicateOption(let option):
      return "Option may only be provided once: \(option)"
    case .invalidInteger(let option, let value):
      return "Invalid integer for \(option): \(value)"
    case .missingValue(let option):
      return "Missing value after \(option)"
    case .negativeValue(let option):
      return "\(option) cannot be negative"
    case .nonPositiveValue(let option):
      return "\(option) must be greater than zero"
    case .optionAboveMaximum(let option, let maximum):
      return "\(option) cannot exceed \(maximum)"
    case .rangeAboveMaximum(let maximumDays):
      return "The requested Calendar range cannot exceed \(maximumDays) days"
    case .unknownOption(let option):
      return "Unknown option: \(option)"
    case .zeroLengthRange:
      return "At least one of --past-days or --future-days must be greater than zero"
    }
  }
}
