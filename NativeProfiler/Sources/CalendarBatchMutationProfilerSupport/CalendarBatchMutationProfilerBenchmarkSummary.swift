import Foundation

public struct CalendarBatchMutationProfilerBenchmarkSummary: Encodable, Equatable, Sendable {
  public let sampleDurationsMilliseconds: [Double]
  public let minimumMilliseconds: Double
  public let medianMilliseconds: Double
  public let p95Milliseconds: Double
  public let maximumMilliseconds: Double
  public let medianMutationItemsPerSecond: Double

  public static func calculate(
    samples: [Double],
    mutationItemCount: Int
  ) -> CalendarBatchMutationProfilerBenchmarkSummary {
    precondition(!samples.isEmpty)
    precondition(mutationItemCount >= 0)
    let sorted = samples.sorted()
    let median: Double
    if sorted.count.isMultiple(of: 2) {
      let upper = sorted.count / 2
      median = (sorted[upper - 1] + sorted[upper]) / 2
    } else {
      median = sorted[sorted.count / 2]
    }
    let p95Index = min(sorted.count - 1, Int(ceil(Double(sorted.count) * 0.95)) - 1)
    let throughput = median > 0 ? Double(mutationItemCount) / (median / 1_000) : 0

    return CalendarBatchMutationProfilerBenchmarkSummary(
      sampleDurationsMilliseconds: samples,
      minimumMilliseconds: sorted[0],
      medianMilliseconds: median,
      p95Milliseconds: sorted[p95Index],
      maximumMilliseconds: sorted[sorted.count - 1],
      medianMutationItemsPerSecond: throughput
    )
  }
}
