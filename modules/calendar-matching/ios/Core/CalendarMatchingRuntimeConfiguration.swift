import Foundation

public struct CalendarMatchingRuntimeConfiguration: Equatable, Sendable {
  public static let queryStrategyEnvironmentKey = "PALATE_CALENDAR_QUERY_STRATEGY"
  public static let queryGapDaysEnvironmentKey = "PALATE_CALENDAR_QUERY_GAP_DAYS"
  public static let defaultQueryStrategy = CalendarEventQueryStrategy.broad
  public static let defaultSparseCoalescingGapDays = 7.0
  public static let maximumSparseCoalescingGapDays = 365.0

  public let queryStrategy: CalendarEventQueryStrategy
  public let sparseCoalescingGapDays: Double

  public var sparseCoalescingGapMilliseconds: Double {
    sparseCoalescingGapDays * 24 * 60 * 60 * 1_000
  }

  public static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> CalendarMatchingRuntimeConfiguration {
    let strategy =
      environment[queryStrategyEnvironmentKey]
      .flatMap(CalendarEventQueryStrategy.init(rawValue:)) ?? defaultQueryStrategy
    let gapDays = boundedGapDays(environment[queryGapDaysEnvironmentKey])
    return CalendarMatchingRuntimeConfiguration(
      queryStrategy: strategy,
      sparseCoalescingGapDays: gapDays
    )
  }

  private static func boundedGapDays(_ value: String?) -> Double {
    guard let value, let parsed = Double(value), parsed.isFinite,
      (0...maximumSparseCoalescingGapDays).contains(parsed)
    else {
      return defaultSparseCoalescingGapDays
    }
    return parsed
  }
}
