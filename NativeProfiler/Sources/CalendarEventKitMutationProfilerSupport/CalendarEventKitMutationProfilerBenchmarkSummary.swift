import Foundation

public struct CalendarEventKitMutationProfilerBenchmarkSummary: Codable, Equatable, Sendable {
  public let samplesMilliseconds: [Double]
  public let minimumMilliseconds: Double
  public let medianMilliseconds: Double
  public let p95Milliseconds: Double
  public let maximumMilliseconds: Double
  public let medianEventsPerSecond: Double

  public static func calculate(
    milliseconds: [Double],
    eventCount: Int
  ) -> CalendarEventKitMutationProfilerBenchmarkSummary {
    precondition(!milliseconds.isEmpty)
    precondition(eventCount > 0)
    let sorted = milliseconds.sorted()
    let median: Double
    if sorted.count.isMultiple(of: 2) {
      let upper = sorted.count / 2
      median = (sorted[upper - 1] + sorted[upper]) / 2
    } else {
      median = sorted[sorted.count / 2]
    }
    let p95Index = max(0, Int(ceil(Double(sorted.count) * 0.95)) - 1)
    let eventsPerSecond = median > 0 ? Double(eventCount) / (median / 1_000) : 0
    return CalendarEventKitMutationProfilerBenchmarkSummary(
      samplesMilliseconds: milliseconds,
      minimumMilliseconds: sorted[0],
      medianMilliseconds: median,
      p95Milliseconds: sorted[p95Index],
      maximumMilliseconds: sorted[sorted.count - 1],
      medianEventsPerSecond: eventsPerSecond
    )
  }
}
