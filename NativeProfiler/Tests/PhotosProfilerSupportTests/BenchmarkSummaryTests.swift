import Testing
@testable import PhotosProfilerSupport

@Suite("Benchmark summary")
struct BenchmarkSummaryTests {
  @Test("Median and p95 use sorted measurements")
  func percentiles() {
    let summary = BenchmarkSummary.calculate(milliseconds: [50, 10, 30, 20, 40], assetCount: 300)

    #expect(summary.minimumMilliseconds == 10)
    #expect(summary.medianMilliseconds == 30)
    #expect(summary.p95Milliseconds == 50)
    #expect(summary.maximumMilliseconds == 50)
    #expect(summary.medianAssetsPerSecond == 10_000)
  }

  @Test("Even measurement count averages the two center values")
  func evenMedian() {
    let summary = BenchmarkSummary.calculate(milliseconds: [40, 10, 30, 20], assetCount: 100)
    #expect(summary.medianMilliseconds == 25)
  }
}
