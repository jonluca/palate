import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matching runtime configuration")
struct CalendarMatchingRuntimeConfigurationTests {
  @Test("Defaults retain the proven broad query strategy")
  func defaults() {
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: [:])

    #expect(configuration.queryStrategy == .broad)
    #expect(configuration.sparseCoalescingGapDays == 7)
    #expect(configuration.sparseCoalescingGapMilliseconds == 7 * 24 * 60 * 60 * 1_000)
  }

  @Test("Sparse strategy accepts bounded integral and fractional gaps")
  func sparseOverrides() {
    let integral = CalendarMatchingRuntimeConfiguration.resolve(environment: [
      CalendarMatchingRuntimeConfiguration.queryStrategyEnvironmentKey: "sparse",
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "14",
    ])
    let fractional = CalendarMatchingRuntimeConfiguration.resolve(environment: [
      CalendarMatchingRuntimeConfiguration.queryStrategyEnvironmentKey: "sparse",
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "0.5",
    ])

    #expect(integral.queryStrategy == .sparse)
    #expect(integral.sparseCoalescingGapDays == 14)
    #expect(fractional.sparseCoalescingGapDays == 0.5)
  }

  @Test(
    "Invalid strategy and gap values fall back independently",
    arguments: ["-1", "365.0001", "nan", "infinity", "not-a-number"]
  )
  func invalidOverrides(gap: String) {
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: [
      CalendarMatchingRuntimeConfiguration.queryStrategyEnvironmentKey: "other",
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: gap,
    ])

    #expect(configuration.queryStrategy == .broad)
    #expect(configuration.sparseCoalescingGapDays == 7)
  }

  @Test("The documented zero and maximum gaps are valid")
  func boundaryOverrides() {
    let zero = CalendarMatchingRuntimeConfiguration.resolve(environment: [
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "0"
    ])
    let maximum = CalendarMatchingRuntimeConfiguration.resolve(environment: [
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "365"
    ])

    #expect(zero.sparseCoalescingGapDays == 0)
    #expect(maximum.sparseCoalescingGapDays == 365)
  }
}
