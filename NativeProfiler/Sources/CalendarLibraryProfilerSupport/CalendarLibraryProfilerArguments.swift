import Foundation

public struct CalendarLibraryProfilerArguments: Equatable, Sendable {
  public static let defaultPastDays = 4 * 365
  public static let defaultFutureDays = 365
  public static let defaultReferenceWindowDays = 31
  public static let defaultIterations = 3
  public static let defaultWarmupIterations = 1
  public static let maximumRangeDays = 10 * 366
  public static let maximumReferenceWindowDays = 365
  public static let maximumIterations = 25
  public static let maximumWarmupIterations = 10

  public let pastDays: Int
  public let futureDays: Int
  public let referenceWindowDays: Int
  public let iterations: Int
  public let warmupIterations: Int
  public let requestAccess: Bool
  public let showHelp: Bool

  public init(
    pastDays: Int = Self.defaultPastDays,
    futureDays: Int = Self.defaultFutureDays,
    referenceWindowDays: Int = Self.defaultReferenceWindowDays,
    iterations: Int = Self.defaultIterations,
    warmupIterations: Int = Self.defaultWarmupIterations,
    requestAccess: Bool = false,
    showHelp: Bool = false
  ) throws {
    guard pastDays >= 0 else {
      throw CalendarLibraryProfilerArgumentsError.negativeValue(option: "--past-days")
    }
    guard futureDays >= 0 else {
      throw CalendarLibraryProfilerArgumentsError.negativeValue(option: "--future-days")
    }
    guard pastDays <= Self.maximumRangeDays else {
      throw CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--past-days",
        maximum: Self.maximumRangeDays
      )
    }
    guard futureDays <= Self.maximumRangeDays else {
      throw CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--future-days",
        maximum: Self.maximumRangeDays
      )
    }
    guard pastDays > 0 || futureDays > 0 else {
      throw CalendarLibraryProfilerArgumentsError.zeroLengthRange
    }
    guard pastDays + futureDays <= Self.maximumRangeDays else {
      throw CalendarLibraryProfilerArgumentsError.rangeAboveMaximum(
        maximumDays: Self.maximumRangeDays
      )
    }
    guard referenceWindowDays > 0 else {
      throw CalendarLibraryProfilerArgumentsError.nonPositiveValue(
        option: "--reference-window-days"
      )
    }
    guard referenceWindowDays <= Self.maximumReferenceWindowDays else {
      throw CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--reference-window-days",
        maximum: Self.maximumReferenceWindowDays
      )
    }
    guard iterations > 0 else {
      throw CalendarLibraryProfilerArgumentsError.nonPositiveValue(option: "--iterations")
    }
    guard iterations <= Self.maximumIterations else {
      throw CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--iterations",
        maximum: Self.maximumIterations
      )
    }
    guard warmupIterations >= 0 else {
      throw CalendarLibraryProfilerArgumentsError.negativeValue(option: "--warmup")
    }
    guard warmupIterations <= Self.maximumWarmupIterations else {
      throw CalendarLibraryProfilerArgumentsError.optionAboveMaximum(
        option: "--warmup",
        maximum: Self.maximumWarmupIterations
      )
    }

    self.pastDays = pastDays
    self.futureDays = futureDays
    self.referenceWindowDays = referenceWindowDays
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.requestAccess = requestAccess
    self.showHelp = showHelp
  }

  public init(commandLineArguments: [String]) throws {
    var pastDays = Self.defaultPastDays
    var futureDays = Self.defaultFutureDays
    var referenceWindowDays = Self.defaultReferenceWindowDays
    var iterations = Self.defaultIterations
    var warmupIterations = Self.defaultWarmupIterations
    var requestAccess = false
    var showHelp = false
    var seenOptions = Set<String>()

    var index = 0
    while index < commandLineArguments.count {
      let option = commandLineArguments[index]
      guard seenOptions.insert(option).inserted else {
        throw CalendarLibraryProfilerArgumentsError.duplicateOption(option)
      }

      switch option {
      case "--past-days":
        pastDays = try Self.integerValue(after: option, at: &index, in: commandLineArguments)
      case "--future-days":
        futureDays = try Self.integerValue(after: option, at: &index, in: commandLineArguments)
      case "--reference-window-days":
        referenceWindowDays = try Self.integerValue(
          after: option,
          at: &index,
          in: commandLineArguments
        )
      case "--iterations":
        iterations = try Self.integerValue(after: option, at: &index, in: commandLineArguments)
      case "--warmup":
        warmupIterations = try Self.integerValue(
          after: option,
          at: &index,
          in: commandLineArguments
        )
      case "--request-access":
        requestAccess = true
      case "--help", "-h":
        showHelp = true
      default:
        throw CalendarLibraryProfilerArgumentsError.unknownOption(option)
      }
      index += 1
    }

    try self.init(
      pastDays: pastDays,
      futureDays: futureDays,
      referenceWindowDays: referenceWindowDays,
      iterations: iterations,
      warmupIterations: warmupIterations,
      requestAccess: requestAccess,
      showHelp: showHelp
    )
  }

  public static let usage = """
    Usage: PalateCalendarLibraryProfiler [options]

      --past-days N              Include N days before launch (default: \(defaultPastDays))
      --future-days N            Include N days after launch (default: \(defaultFutureDays))
      --reference-window-days N  Independent EventKit window size (default: \(defaultReferenceWindowDays); maximum: \(maximumReferenceWindowDays))
      --iterations N             Measured A/B iterations (default: \(defaultIterations); maximum: \(maximumIterations))
      --warmup N                 Unmeasured A/B iterations (default: \(defaultWarmupIterations); maximum: \(maximumWarmupIterations))
      --request-access           Explicitly request Calendar access when status is notDetermined
      --help, -h                 Print this help

    The date range is capped at \(maximumRangeDays) total days. By default the profiler only
    checks current Calendar authorization and never displays a permission prompt.
    """

  private static func integerValue(
    after option: String,
    at index: inout Int,
    in arguments: [String]
  ) throws -> Int {
    let valueIndex = index + 1
    guard valueIndex < arguments.count, !arguments[valueIndex].hasPrefix("--") else {
      throw CalendarLibraryProfilerArgumentsError.missingValue(option: option)
    }
    let value = arguments[valueIndex]
    guard let result = Int(value) else {
      throw CalendarLibraryProfilerArgumentsError.invalidInteger(option: option, value: value)
    }
    index = valueIndex
    return result
  }
}
