import Foundation

public struct CalendarBatchMutationProfilerArguments: Equatable, Sendable {
  public static let defaultItemCount = 4_000
  public static let defaultIterations = 7
  public static let defaultWarmupIterations = 2
  public static let maximumItemCount = 100_000
  public static let maximumIterations = 25
  public static let maximumWarmupIterations = 10

  public let itemCount: Int
  public let iterations: Int
  public let warmupIterations: Int
  public let showHelp: Bool

  public init(
    itemCount: Int = Self.defaultItemCount,
    iterations: Int = Self.defaultIterations,
    warmupIterations: Int = Self.defaultWarmupIterations,
    showHelp: Bool = false
  ) throws {
    guard itemCount > 0 else {
      throw CalendarBatchMutationProfilerArgumentsError.nonPositiveValue(option: "--items")
    }
    guard itemCount <= Self.maximumItemCount else {
      throw CalendarBatchMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--items",
        maximum: Self.maximumItemCount
      )
    }
    guard iterations > 0 else {
      throw CalendarBatchMutationProfilerArgumentsError.nonPositiveValue(option: "--iterations")
    }
    guard iterations <= Self.maximumIterations else {
      throw CalendarBatchMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--iterations",
        maximum: Self.maximumIterations
      )
    }
    guard warmupIterations >= 0 else {
      throw CalendarBatchMutationProfilerArgumentsError.negativeValue(option: "--warmup")
    }
    guard warmupIterations <= Self.maximumWarmupIterations else {
      throw CalendarBatchMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--warmup",
        maximum: Self.maximumWarmupIterations
      )
    }

    self.itemCount = itemCount
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.showHelp = showHelp
  }

  public init(commandLineArguments: [String]) throws {
    var itemCount = Self.defaultItemCount
    var iterations = Self.defaultIterations
    var warmupIterations = Self.defaultWarmupIterations
    var showHelp = false
    var seenOptions = Set<String>()
    var index = 0

    while index < commandLineArguments.count {
      let rawArgument = commandLineArguments[index]
      let option: String
      let inlineValue: String?
      if let separator = rawArgument.firstIndex(of: "=") {
        option = String(rawArgument[..<separator])
        inlineValue = String(rawArgument[rawArgument.index(after: separator)...])
      } else {
        option = rawArgument
        inlineValue = nil
      }

      let canonicalOption = option == "-h" ? "--help" : option
      guard seenOptions.insert(canonicalOption).inserted else {
        throw CalendarBatchMutationProfilerArgumentsError.duplicateOption(canonicalOption)
      }

      switch canonicalOption {
      case "--items":
        itemCount = try Self.integerValue(
          for: canonicalOption,
          inlineValue: inlineValue,
          at: &index,
          in: commandLineArguments
        )
      case "--iterations":
        iterations = try Self.integerValue(
          for: canonicalOption,
          inlineValue: inlineValue,
          at: &index,
          in: commandLineArguments
        )
      case "--warmup":
        warmupIterations = try Self.integerValue(
          for: canonicalOption,
          inlineValue: inlineValue,
          at: &index,
          in: commandLineArguments
        )
      case "--help":
        guard inlineValue == nil else {
          throw CalendarBatchMutationProfilerArgumentsError.unknownOption(rawArgument)
        }
        showHelp = true
      default:
        throw CalendarBatchMutationProfilerArgumentsError.unknownOption(option)
      }
      index += 1
    }

    try self.init(
      itemCount: itemCount,
      iterations: iterations,
      warmupIterations: warmupIterations,
      showHelp: showHelp
    )
  }

  public static let usage = """
    Usage: PalateCalendarBatchMutationProfiler [options]

      --items N       Synthetic create items and delete items (default: \(defaultItemCount); maximum: \(maximumItemCount))
      --iterations N  Measured A/B samples per strategy (default: \(defaultIterations); maximum: \(maximumIterations))
      --warmup N      Unmeasured A/B samples per strategy (default: \(defaultWarmupIterations); maximum: \(maximumWarmupIterations))
      --help, -h      Print this help

    This profiler is synthetic and permission-free. It never imports EventKit or reads Calendar data.
    """

  private static func integerValue(
    for option: String,
    inlineValue: String?,
    at index: inout Int,
    in arguments: [String]
  ) throws -> Int {
    let value: String
    if let inlineValue {
      guard !inlineValue.isEmpty else {
        throw CalendarBatchMutationProfilerArgumentsError.missingValue(option: option)
      }
      value = inlineValue
    } else {
      let valueIndex = index + 1
      guard valueIndex < arguments.count, !arguments[valueIndex].hasPrefix("--") else {
        throw CalendarBatchMutationProfilerArgumentsError.missingValue(option: option)
      }
      value = arguments[valueIndex]
      index = valueIndex
    }

    guard let parsed = Int(value) else {
      throw CalendarBatchMutationProfilerArgumentsError.invalidInteger(
        option: option,
        value: value
      )
    }
    return parsed
  }
}
