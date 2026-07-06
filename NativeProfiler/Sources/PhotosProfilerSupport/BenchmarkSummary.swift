import Foundation

public struct BenchmarkSummary: Encodable, Equatable, Sendable {
  public let minimumMilliseconds: Double
  public let medianMilliseconds: Double
  public let p95Milliseconds: Double
  public let maximumMilliseconds: Double
  public let medianAssetsPerSecond: Double

  public static func calculate(milliseconds: [Double], assetCount: Int) -> BenchmarkSummary {
    precondition(!milliseconds.isEmpty)
    let sorted = milliseconds.sorted()
    let median: Double
    if sorted.count.isMultiple(of: 2) {
      let upper = sorted.count / 2
      median = (sorted[upper - 1] + sorted[upper]) / 2
    } else {
      median = sorted[sorted.count / 2]
    }

    let p95Index = min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * 0.95)) - 1))
    let assetsPerSecond = median > 0 ? Double(assetCount) / (median / 1_000) : 0

    return BenchmarkSummary(
      minimumMilliseconds: sorted[0],
      medianMilliseconds: median,
      p95Milliseconds: sorted[p95Index],
      maximumMilliseconds: sorted[sorted.count - 1],
      medianAssetsPerSecond: assetsPerSecond
    )
  }
}
