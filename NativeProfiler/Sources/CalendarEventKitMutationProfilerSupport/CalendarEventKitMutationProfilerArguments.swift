import Foundation

public struct CalendarEventKitMutationProfilerArguments: Equatable, Sendable {
  public static let defaultMaximumEventCount = 100
  public static let defaultIterations = 3
  public static let defaultWarmupIterations = 1
  public static let minimumMaximumEventCount = 100
  public static let maximumEventCountLimit = 500
  public static let maximumIterations = 10
  public static let maximumWarmupIterations = 5

  public let maximumEventCount: Int
  public let iterations: Int
  public let warmupIterations: Int
  public let requestAccess: Bool
  public let showHelp: Bool

  public var eventCounts: [Int] {
    [1, 25, maximumEventCount]
  }

  public init(
    maximumEventCount: Int = Self.defaultMaximumEventCount,
    iterations: Int = Self.defaultIterations,
    warmupIterations: Int = Self.defaultWarmupIterations,
    requestAccess: Bool = false,
    showHelp: Bool = false
  ) throws {
    guard maximumEventCount >= Self.minimumMaximumEventCount else {
      throw CalendarEventKitMutationProfilerArgumentsError.optionBelowMinimum(
        option: "--items",
        minimum: Self.minimumMaximumEventCount
      )
    }
    guard maximumEventCount <= Self.maximumEventCountLimit else {
      throw CalendarEventKitMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--items",
        maximum: Self.maximumEventCountLimit
      )
    }
    guard iterations > 0 else {
      throw CalendarEventKitMutationProfilerArgumentsError.nonPositiveValue(
        option: "--iterations"
      )
    }
    guard iterations <= Self.maximumIterations else {
      throw CalendarEventKitMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--iterations",
        maximum: Self.maximumIterations
      )
    }
    guard warmupIterations >= 0 else {
      throw CalendarEventKitMutationProfilerArgumentsError.optionBelowMinimum(
        option: "--warmup",
        minimum: 0
      )
    }
    guard warmupIterations <= Self.maximumWarmupIterations else {
      throw CalendarEventKitMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--warmup",
        maximum: Self.maximumWarmupIterations
      )
    }

    self.maximumEventCount = maximumEventCount
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.requestAccess = requestAccess
    self.showHelp = showHelp
  }

  public init(commandLineArguments: [String]) throws {
    var maximumEventCount = Self.defaultMaximumEventCount
    var iterations = Self.defaultIterations
    var warmupIterations = Self.defaultWarmupIterations
    var requestAccess = false
    var showHelp = false
    var seenOptions = Set<String>()

    var index = 0
    while index < commandLineArguments.count {
      let option = commandLineArguments[index]
      guard seenOptions.insert(option).inserted else {
        throw CalendarEventKitMutationProfilerArgumentsError.duplicateOption(option)
      }

      switch option {
      case "--items":
        maximumEventCount = try Self.integerValue(
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
        throw CalendarEventKitMutationProfilerArgumentsError.unknownOption(option)
      }
      index += 1
    }

    try self.init(
      maximumEventCount: maximumEventCount,
      iterations: iterations,
      warmupIterations: warmupIterations,
      requestAccess: requestAccess,
      showHelp: showHelp
    )
  }

  public static let usage = """
    Usage: PalateCalendarEventKitMutationProfiler [options]

      --items N          Largest deterministic dataset (default: \(defaultMaximumEventCount); range: \(minimumMaximumEventCount)...\(maximumEventCountLimit))
      --iterations N     Measured alternating A/B iterations (default: \(defaultIterations); maximum: \(maximumIterations))
      --warmup N         Unmeasured alternating A/B iterations (default: \(defaultWarmupIterations); maximum: \(maximumWarmupIterations))
      --request-access   Explicitly request full Calendar access when status is notDetermined
      --help, -h         Print this help

    Every run measures deterministic datasets of 1, 25, and N events in a uniquely named
    temporary calendar. By default the profiler only checks Calendar authorization and never
    displays a permission prompt.
    """

  private static func integerValue(
    after option: String,
    at index: inout Int,
    in arguments: [String]
  ) throws -> Int {
    let valueIndex = index + 1
    guard valueIndex < arguments.count, !arguments[valueIndex].hasPrefix("--") else {
      throw CalendarEventKitMutationProfilerArgumentsError.missingValue(option: option)
    }
    let value = arguments[valueIndex]
    guard let result = Int(value) else {
      throw CalendarEventKitMutationProfilerArgumentsError.invalidInteger(
        option: option,
        value: value
      )
    }
    index = valueIndex
    return result
  }
}
