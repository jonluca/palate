import Testing

@testable import CalendarLibraryProfilerSupport

@Suite("Calendar library benchmark summaries")
struct CalendarLibraryBenchmarkSummaryTests {
  @Test("Median and nearest-rank p95 are deterministic")
  func summary() {
    let result = CalendarLibraryBenchmarkSummary.calculate(
      milliseconds: [40, 10, 30, 20],
      uniqueEventCount: 100
    )

    #expect(result.minimumMilliseconds == 10)
    #expect(result.medianMilliseconds == 25)
    #expect(result.p95Milliseconds == 40)
    #expect(result.maximumMilliseconds == 40)
    #expect(result.medianUniqueEventsPerSecond == 4_000)
  }
}
