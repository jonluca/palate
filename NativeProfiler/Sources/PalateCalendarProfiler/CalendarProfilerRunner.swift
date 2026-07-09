import CalendarMatchingCore
import Foundation

struct CalendarProfilerRunner {
  private typealias MatchingOperation = () -> [CalendarVisitMatch]

  func run(arguments: CalendarProfilerArguments) throws -> CalendarProfilerReport {
    let dataset = CalendarProfilerDataset.generate(
      visitCount: arguments.visitCount,
      eventCount: arguments.eventCount
    )
    let optimizedOperation: MatchingOperation = {
      CalendarMatcher.match(
        visits: dataset.visits,
        events: dataset.events,
        bufferMilliseconds: CalendarProfilerDataset.bufferMilliseconds
      )
    }
    let exhaustiveOperation: MatchingOperation = {
      ExhaustiveCalendarMatcher.match(
        visits: dataset.visits,
        events: dataset.events,
        bufferMilliseconds: CalendarProfilerDataset.bufferMilliseconds
      )
    }

    let optimizedValidation = optimizedOperation()
    let exhaustiveValidation = exhaustiveOperation()
    let optimizedChecksum = CalendarMatchChecksum.calculate(optimizedValidation)
    let exhaustiveChecksum = CalendarMatchChecksum.calculate(exhaustiveValidation)
    guard optimizedValidation == exhaustiveValidation else {
      throw CalendarProfilerError.parityMismatch(
        optimizedChecksum: optimizedChecksum.signature,
        exhaustiveChecksum: exhaustiveChecksum.signature,
        firstDifference: firstDifference(
          optimized: optimizedValidation,
          exhaustive: exhaustiveValidation
        )
      )
    }

    for _ in 0..<arguments.warmupIterations {
      try validate(
        operation: optimizedOperation, expectedChecksum: optimizedChecksum, strategy: "optimized")
      try validate(
        operation: exhaustiveOperation, expectedChecksum: exhaustiveChecksum, strategy: "exhaustive"
      )
    }

    var optimizedSamples: [Double] = []
    var exhaustiveSamples: [Double] = []
    optimizedSamples.reserveCapacity(arguments.iterations)
    exhaustiveSamples.reserveCapacity(arguments.iterations)
    for iteration in 0..<arguments.iterations {
      if iteration.isMultiple(of: 2) {
        optimizedSamples.append(
          try measure(
            operation: optimizedOperation, expectedChecksum: optimizedChecksum,
            strategy: "optimized")
        )
        exhaustiveSamples.append(
          try measure(
            operation: exhaustiveOperation, expectedChecksum: exhaustiveChecksum,
            strategy: "exhaustive")
        )
      } else {
        exhaustiveSamples.append(
          try measure(
            operation: exhaustiveOperation, expectedChecksum: exhaustiveChecksum,
            strategy: "exhaustive")
        )
        optimizedSamples.append(
          try measure(
            operation: optimizedOperation, expectedChecksum: optimizedChecksum,
            strategy: "optimized")
        )
      }
    }

    let optimizedSummary = CalendarProfilerBenchmarkSummary(samples: optimizedSamples)
    let exhaustiveSummary = CalendarProfilerBenchmarkSummary(samples: exhaustiveSamples)
    return CalendarProfilerReport(
      configuration: CalendarProfilerReport.Configuration(
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations,
        bufferMilliseconds: CalendarProfilerDataset.bufferMilliseconds
      ),
      dataset: CalendarProfilerReport.Dataset(
        seed: String(format: "0x%016llx", CalendarProfilerDataset.seed),
        visits: dataset.visits.count,
        events: dataset.events.count,
        restaurants: dataset.restaurantCount,
        matches: optimizedValidation.count,
        coverageCases: dataset.coverageCases
      ),
      validation: CalendarProfilerReport.Validation(
        optimizedMatchesExhaustive: true,
        checksum: optimizedChecksum.signature
      ),
      optimized: optimizedSummary,
      exhaustive: exhaustiveSummary,
      speedup: exhaustiveSummary.medianMilliseconds / optimizedSummary.medianMilliseconds
    )
  }

  private func validate(
    operation: MatchingOperation,
    expectedChecksum: CalendarMatchChecksum,
    strategy: String
  ) throws {
    let actual = CalendarMatchChecksum.calculate(operation())
    guard actual == expectedChecksum else {
      throw CalendarProfilerError.checksumChanged(
        strategy: strategy,
        expected: expectedChecksum.signature,
        actual: actual.signature
      )
    }
  }

  private func firstDifference(
    optimized: [CalendarVisitMatch],
    exhaustive: [CalendarVisitMatch]
  ) -> String {
    for index in 0..<min(optimized.count, exhaustive.count)
    where optimized[index] != exhaustive[index] {
      let optimizedMatch = optimized[index]
      let exhaustiveMatch = exhaustive[index]
      return
        "First difference at index \(index): optimized=(\(optimizedMatch.visitId), "
        + "\(optimizedMatch.event.id), \(optimizedMatch.suggestedRestaurantId ?? "nil")); "
        + "exhaustive=(\(exhaustiveMatch.visitId), \(exhaustiveMatch.event.id), "
        + "\(exhaustiveMatch.suggestedRestaurantId ?? "nil"))."
    }
    return "Result counts differ: optimized=\(optimized.count), exhaustive=\(exhaustive.count)."
  }

  private func measure(
    operation: MatchingOperation,
    expectedChecksum: CalendarMatchChecksum,
    strategy: String
  ) throws -> Double {
    let clock = ContinuousClock()
    let startedAt = clock.now
    let matches = operation()
    let duration = startedAt.duration(to: clock.now)
    let actualChecksum = CalendarMatchChecksum.calculate(matches)
    guard actualChecksum == expectedChecksum else {
      throw CalendarProfilerError.checksumChanged(
        strategy: strategy,
        expected: expectedChecksum.signature,
        actual: actualChecksum.signature
      )
    }
    let components = duration.components
    return Double(components.seconds) * 1_000 + Double(components.attoseconds)
      / 1_000_000_000_000_000
  }
}
