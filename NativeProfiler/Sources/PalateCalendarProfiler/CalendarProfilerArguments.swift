import Foundation

struct CalendarProfilerArguments: Equatable, Sendable {
  static let defaultVisitCount = 1_000
  static let defaultEventCount = 10_000
  static let defaultIterations = 5
  static let defaultWarmupIterations = 1

  let visitCount: Int
  let eventCount: Int
  let iterations: Int
  let warmupIterations: Int
  let showHelp: Bool

  init(commandLineArguments: [String]) throws {
    var visitCount = Self.defaultVisitCount
    var eventCount = Self.defaultEventCount
    var iterations = Self.defaultIterations
    var warmupIterations = Self.defaultWarmupIterations
    var showHelp = false
    var index = 0

    while index < commandLineArguments.count {
      let argument = commandLineArguments[index]
      if argument == "--help" || argument == "-h" {
        showHelp = true
        index += 1
        continue
      }

      let option: String
      let value: String
      if let separator = argument.firstIndex(of: "=") {
        option = String(argument[..<separator])
        value = String(argument[argument.index(after: separator)...])
      } else {
        option = argument
        let valueIndex = index + 1
        guard valueIndex < commandLineArguments.count else {
          throw CalendarProfilerArgumentsError.missingValue(option: option)
        }
        value = commandLineArguments[valueIndex]
        index = valueIndex
      }

      let parsedValue = try Self.positiveInteger(
        value, option: option, allowZero: option == "--warmup")
      switch option {
      case "--visits":
        visitCount = parsedValue
      case "--events":
        eventCount = parsedValue
      case "--iterations":
        iterations = parsedValue
      case "--warmup":
        warmupIterations = parsedValue
      default:
        throw CalendarProfilerArgumentsError.unknownOption(option)
      }
      index += 1
    }

    self.visitCount = visitCount
    self.eventCount = eventCount
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.showHelp = showHelp
  }

  static let usage = """
    Usage: PalateCalendarProfiler [options]

      --visits N       Synthetic visit count (default: \(defaultVisitCount))
      --events N       Synthetic event count (default: \(defaultEventCount))
      --iterations N   Measured iterations per strategy (default: \(defaultIterations))
      --warmup N       Unmeasured warmup iterations per strategy (default: \(defaultWarmupIterations))
      --help, -h       Print this help
    """

  private static func positiveInteger(
    _ value: String,
    option: String,
    allowZero: Bool
  ) throws -> Int {
    guard let parsed = Int(value), allowZero ? parsed >= 0 : parsed > 0 else {
      throw CalendarProfilerArgumentsError.invalidInteger(
        option: option,
        value: value,
        allowsZero: allowZero
      )
    }
    return parsed
  }
}
