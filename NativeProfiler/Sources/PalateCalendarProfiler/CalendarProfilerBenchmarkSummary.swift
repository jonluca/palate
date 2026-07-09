import Foundation

struct CalendarProfilerBenchmarkSummary: Encodable, Sendable {
  let sampleDurationsMilliseconds: [Double]
  let medianMilliseconds: Double
  let p95Milliseconds: Double

  init(samples: [Double]) {
    precondition(!samples.isEmpty)
    let sorted = samples.sorted()
    sampleDurationsMilliseconds = samples
    if sorted.count.isMultiple(of: 2) {
      let upper = sorted.count / 2
      medianMilliseconds = (sorted[upper - 1] + sorted[upper]) / 2
    } else {
      medianMilliseconds = sorted[sorted.count / 2]
    }
    let p95Index = min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * 0.95)) - 1))
    p95Milliseconds = sorted[p95Index]
  }
}
