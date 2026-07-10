import CalendarMatchingCore
@preconcurrency import EventKit
import Foundation

@MainActor
public struct CalendarLibraryProfilerRunner {
  public init() {}

  public func run(
    arguments: CalendarLibraryProfilerArguments,
    anchorDate: Date = Date()
  ) async throws -> CalendarLibraryProfilerReport {
    let eventStore = EKEventStore()
    var authorizationStatus = CalendarLibraryAuthorization.currentStatus()
    if arguments.requestAccess {
      authorizationStatus = try await CalendarLibraryAuthorization.requestIfNeeded(
        eventStore: eventStore,
        currentStatus: authorizationStatus
      )
    }
    let authorizationName = CalendarLibraryAuthorization.name(for: authorizationStatus)
    guard CalendarLibraryAuthorization.permitsReading(authorizationStatus) else {
      throw CalendarLibraryProfilerError.calendarAccessUnavailable(
        status: authorizationName,
        requestAttempted: arguments.requestAccess
      )
    }

    let range = CalendarLibraryDateRange(
      anchorDate: anchorDate,
      pastDays: arguments.pastDays,
      futureDays: arguments.futureDays
    )
    let library = CalendarLibraryEventStore(eventStore: eventStore)
    let productionStrategy = CalendarLibraryFetchStrategy.production
    let referenceStrategy = CalendarLibraryFetchStrategy.reference(
      windowDays: arguments.referenceWindowDays
    )

    let (initialProduction, initialProductionMilliseconds) = measure {
      library.fetch(range: range, strategy: productionStrategy)
    }
    let (initialReference, initialReferenceMilliseconds) = measure {
      library.fetch(range: range, strategy: referenceStrategy)
    }
    try validateReferenceParity(
      production: initialProduction.uniqueEventIdentities,
      reference: initialReference.uniqueEventIdentities
    )
    let expectedIdentities = initialProduction.uniqueEventIdentities

    for iteration in 0..<arguments.warmupIterations {
      for strategy in orderedStrategies(
        iteration: iteration,
        referenceStrategy: referenceStrategy
      ) {
        let result = library.fetch(range: range, strategy: strategy)
        try validateStableEvents(
          result.uniqueEventIdentities,
          expected: expectedIdentities,
          strategy: name(for: strategy)
        )
      }
    }

    var productionSamples: [Double] = []
    var referenceSamples: [Double] = []
    productionSamples.reserveCapacity(arguments.iterations)
    referenceSamples.reserveCapacity(arguments.iterations)
    for iteration in 0..<arguments.iterations {
      for strategy in orderedStrategies(
        iteration: iteration,
        referenceStrategy: referenceStrategy
      ) {
        let (result, elapsedMilliseconds) = measure {
          library.fetch(range: range, strategy: strategy)
        }
        try validateStableEvents(
          result.uniqueEventIdentities,
          expected: expectedIdentities,
          strategy: name(for: strategy)
        )
        switch strategy {
        case .production:
          productionSamples.append(elapsedMilliseconds)
        case .reference:
          referenceSamples.append(elapsedMilliseconds)
        }
      }
    }

    let uniqueEventCount = expectedIdentities.count
    let productionDuplicateCount = initialProduction.rawEventCount - uniqueEventCount
    let referenceDuplicateCount = initialReference.rawEventCount - uniqueEventCount
    let productionMaximumWindowDays = Int(
      CalendarEventQueryWindowPlanner.maximumWindowMilliseconds
        / 1_000 / CalendarLibraryDateRange.secondsPerDay
    )
    return CalendarLibraryProfilerReport(
      schemaVersion: 1,
      status: "ok",
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      authorizationStatus: authorizationName,
      readableCalendarCount: library.calendarCount,
      configuration: CalendarLibraryProfilerReport.Configuration(
        pastDays: arguments.pastDays,
        futureDays: arguments.futureDays,
        totalRangeDays: range.durationDays,
        referenceWindowDays: arguments.referenceWindowDays,
        productionMaximumWindowDays: productionMaximumWindowDays,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations,
        requestAccess: arguments.requestAccess
      ),
      correctness: CalendarLibraryProfilerReport.Correctness(
        exactUniqueEventParity: true,
        stableDigest: CalendarLibraryStableDigest.signature(for: expectedIdentities),
        uniqueEventCount: uniqueEventCount,
        productionWindowCount: initialProduction.windowCount,
        productionRawEventCount: initialProduction.rawEventCount,
        productionDuplicateCount: productionDuplicateCount,
        referenceWindowCount: initialReference.windowCount,
        referenceRawEventCount: initialReference.rawEventCount,
        referenceDuplicateCount: referenceDuplicateCount
      ),
      timings: CalendarLibraryProfilerReport.Timings(
        initialProductionMilliseconds: initialProductionMilliseconds,
        initialReferenceMilliseconds: initialReferenceMilliseconds,
        productionSamplesMilliseconds: productionSamples,
        referenceSamplesMilliseconds: referenceSamples,
        production: CalendarLibraryBenchmarkSummary.calculate(
          milliseconds: productionSamples,
          uniqueEventCount: uniqueEventCount
        ),
        reference: CalendarLibraryBenchmarkSummary.calculate(
          milliseconds: referenceSamples,
          uniqueEventCount: uniqueEventCount
        )
      )
    )
  }

  private func orderedStrategies(
    iteration: Int,
    referenceStrategy: CalendarLibraryFetchStrategy
  ) -> [CalendarLibraryFetchStrategy] {
    if iteration.isMultiple(of: 2) {
      return [.production, referenceStrategy]
    }
    return [referenceStrategy, .production]
  }

  private func name(for strategy: CalendarLibraryFetchStrategy) -> String {
    switch strategy {
    case .production:
      return "production"
    case .reference:
      return "reference"
    }
  }

  private func measure<T>(_ operation: () -> T) -> (result: T, milliseconds: Double) {
    let start = DispatchTime.now().uptimeNanoseconds
    let result = operation()
    let end = DispatchTime.now().uptimeNanoseconds
    return (result, Double(end - start) / 1_000_000)
  }

  private func validateReferenceParity(
    production: Set<CalendarLibraryEventIdentity>,
    reference: Set<CalendarLibraryEventIdentity>
  ) throws {
    guard production == reference else {
      throw CalendarLibraryProfilerError.referenceParityMismatch(
        productionCount: production.count,
        referenceCount: reference.count,
        productionDigest: CalendarLibraryStableDigest.signature(for: production),
        referenceDigest: CalendarLibraryStableDigest.signature(for: reference)
      )
    }
  }

  private func validateStableEvents(
    _ actual: Set<CalendarLibraryEventIdentity>,
    expected: Set<CalendarLibraryEventIdentity>,
    strategy: String
  ) throws {
    guard actual == expected else {
      throw CalendarLibraryProfilerError.eventSetChanged(
        strategy: strategy,
        expectedCount: expected.count,
        actualCount: actual.count,
        expectedDigest: CalendarLibraryStableDigest.signature(for: expected),
        actualDigest: CalendarLibraryStableDigest.signature(for: actual)
      )
    }
  }
}
