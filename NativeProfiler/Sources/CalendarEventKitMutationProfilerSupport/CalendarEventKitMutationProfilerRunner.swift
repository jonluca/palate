@preconcurrency import EventKit
import Foundation

@MainActor
public struct CalendarEventKitMutationProfilerRunner {
  private struct Accumulator {
    var createMilliseconds: [Double] = []
    var deleteMilliseconds: [Double] = []
    var createCommitCounts: [Int] = []
    var deleteCommitCounts: [Int] = []

    mutating func append(_ sample: CalendarEventKitMutationProfilerSample) {
      createMilliseconds.append(sample.createMilliseconds)
      deleteMilliseconds.append(sample.deleteMilliseconds)
      createCommitCounts.append(sample.createCommitCount)
      deleteCommitCounts.append(sample.deleteCommitCount)
    }
  }

  public init() {}

  public func run(
    arguments: CalendarEventKitMutationProfilerArguments
  ) async throws -> CalendarEventKitMutationProfilerReport {
    let eventStore = EKEventStore()
    var authorizationStatus = CalendarEventKitMutationProfilerAuthorization.currentStatus()
    if arguments.requestAccess {
      authorizationStatus = try await CalendarEventKitMutationProfilerAuthorization.requestIfNeeded(
        eventStore: eventStore,
        currentStatus: authorizationStatus
      )
    }
    let authorizationName = CalendarEventKitMutationProfilerAuthorization.name(
      for: authorizationStatus
    )
    guard CalendarEventKitMutationProfilerAuthorization.permitsReadWrite(authorizationStatus) else {
      throw CalendarEventKitMutationProfilerError.calendarAccessUnavailable(
        status: authorizationName,
        requestAttempted: arguments.requestAccess
      )
    }

    let temporaryCalendar = try CalendarEventKitMutationProfilerTemporaryCalendar.create(
      eventStore: eventStore
    )
    let profilerStore = CalendarEventKitMutationProfilerEventStore(
      eventStore: eventStore,
      calendar: temporaryCalendar.calendar
    )

    let benchmarkResult: Result<[CalendarEventKitMutationProfilerReport.SizeResult], Error>
    do {
      benchmarkResult = .success(
        try runBenchmarks(arguments: arguments, store: profilerStore)
      )
    } catch {
      benchmarkResult = .failure(error)
    }

    let results = try CalendarEventKitMutationProfilerCleanupCoordinator.finish(
      benchmarkResult: benchmarkResult,
      cleanupActiveEvents: { try profilerStore.cleanupActiveEvents() },
      cleanupTemporaryCalendar: { try temporaryCalendar.remove() }
    )

    return CalendarEventKitMutationProfilerReport(
      schemaVersion: 1,
      status: "ok",
      mode: "real-eventkit-temporary-calendar",
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      authorizationStatus: authorizationName,
      configuration: CalendarEventKitMutationProfilerReport.Configuration(
        eventCounts: arguments.eventCounts,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations,
        requestAccess: arguments.requestAccess
      ),
      temporaryCalendar: CalendarEventKitMutationProfilerReport.TemporaryCalendar(
        uniqueNameUsed: true,
        sourceType: temporaryCalendar.sourceType,
        identifierWasNonempty: true,
        removedAfterBenchmark: true,
        calendarLifecycleCommitsExcludedFromMutationCounts: true
      ),
      correctness: CalendarEventKitMutationProfilerReport.Correctness(
        exactSemanticEventFieldParity: true,
        stableEventCounts: true,
        nonemptyUniqueEventIdentifiers: true,
        candidateIdentifiersObservedBeforeFinalCommit: true,
        candidateIdentifiersStableAfterCommit: true,
        zeroRemainingEventsAfterEveryDelete: true,
        strategyOrderAlternated: true,
        semanticFieldsCompared:
          CalendarEventKitMutationProfilerSemanticEvent.comparedFieldNames,
        semanticDigestExcludesEventKitIdentifiers: true,
        semanticDigests: results.map {
          CalendarEventKitMutationProfilerReport.DigestEntry(
            eventCount: $0.eventCount,
            semanticSHA256: $0.semanticSHA256
          )
        }
      ),
      commitCountingScope:
        "Counts EventKit API commit boundaries: each legacy save/remove with commit:true, or production CalendarEventKitMutationBackend.commitBatch() calls observed by a forwarding decorator. Temporary-calendar lifecycle commits are excluded.",
      measurementScope:
        "Legacy timing covers main-actor EventKit event construction and commit:true save/remove calls. Candidate timing covers CalendarBatchMutationExecutor validation/result mapping and the production CalendarEventKitMutationBackend prepare, event construction or identifier lookup, commit:false save/remove, and explicit commit calls in one newly created temporary calendar.",
      measurementExclusions: [
        "app launch and Calendar authorization/TCC prompt",
        "EKEventStore and temporary-calendar creation/removal",
        "post-commit semantic readback, digest calculation, identifier validation, and zero-count validation",
        "React Native, JavaScript, persistence, and sync-server latency outside EventKit calls",
      ],
      results: results
    )
  }

  private func runBenchmarks(
    arguments: CalendarEventKitMutationProfilerArguments,
    store: any CalendarEventKitMutationProfilerStore
  ) throws -> [CalendarEventKitMutationProfilerReport.SizeResult] {
    let orchestrator = CalendarEventKitMutationProfilerOrchestrator()
    var accumulators: [Int: [CalendarEventKitMutationProfilerStrategy: Accumulator]] = [:]
    let expectedDigests = Dictionary(
      uniqueKeysWithValues: arguments.eventCounts.map { eventCount in
        let events = CalendarEventKitMutationProfilerDataset.events(count: eventCount)
        return (
          eventCount,
          CalendarEventKitMutationProfilerStableDigest.signature(for: events)
        )
      }
    )

    let totalIterations = arguments.warmupIterations + arguments.iterations
    for iteration in 0..<totalIterations {
      for (sizeIndex, eventCount) in arguments.eventCounts.enumerated() {
        let events = CalendarEventKitMutationProfilerDataset.events(count: eventCount)
        for strategy in orderedStrategies(iteration: iteration, sizeIndex: sizeIndex) {
          let sample = try orchestrator.runSample(
            events: events,
            strategy: strategy,
            store: store
          )
          let expectedDigest = expectedDigests[eventCount]!
          guard sample.semanticDigest == expectedDigest else {
            throw CalendarEventKitMutationProfilerError.unstableSample(
              eventCount: eventCount,
              strategy: strategy.rawValue,
              expectedDigest: expectedDigest,
              actualDigest: sample.semanticDigest
            )
          }
          if iteration >= arguments.warmupIterations {
            var byStrategy = accumulators[eventCount, default: [:]]
            var accumulator = byStrategy[strategy, default: Accumulator()]
            accumulator.append(sample)
            byStrategy[strategy] = accumulator
            accumulators[eventCount] = byStrategy
          }
        }
      }
    }

    return try arguments.eventCounts.map { eventCount in
      let byStrategy = accumulators[eventCount]!
      let legacyAccumulator = byStrategy[.legacy]!
      let candidateAccumulator = byStrategy[.candidate]!
      let legacy = try strategyResult(
        accumulator: legacyAccumulator,
        eventCount: eventCount,
        expectedCommitsPerSample: eventCount,
        iterations: arguments.iterations,
        strategy: .legacy
      )
      let candidate = try strategyResult(
        accumulator: candidateAccumulator,
        eventCount: eventCount,
        expectedCommitsPerSample: 1,
        iterations: arguments.iterations,
        strategy: .candidate
      )
      return CalendarEventKitMutationProfilerReport.SizeResult(
        eventCount: eventCount,
        semanticSHA256: expectedDigests[eventCount]!,
        legacy: legacy,
        candidate: candidate,
        candidateCreateMedianSpeedup: speedup(
          baselineMilliseconds: legacy.create.medianMilliseconds,
          candidateMilliseconds: candidate.create.medianMilliseconds
        ),
        candidateDeleteMedianSpeedup: speedup(
          baselineMilliseconds: legacy.delete.medianMilliseconds,
          candidateMilliseconds: candidate.delete.medianMilliseconds
        )
      )
    }
  }

  private func orderedStrategies(
    iteration: Int,
    sizeIndex: Int
  ) -> [CalendarEventKitMutationProfilerStrategy] {
    if (iteration + sizeIndex).isMultiple(of: 2) {
      return [.legacy, .candidate]
    }
    return [.candidate, .legacy]
  }

  private func strategyResult(
    accumulator: Accumulator,
    eventCount: Int,
    expectedCommitsPerSample: Int,
    iterations: Int,
    strategy: CalendarEventKitMutationProfilerStrategy
  ) throws -> CalendarEventKitMutationProfilerReport.StrategyResult {
    guard accumulator.createMilliseconds.count == iterations,
      accumulator.deleteMilliseconds.count == iterations,
      Set(accumulator.createCommitCounts) == [expectedCommitsPerSample],
      Set(accumulator.deleteCommitCounts) == [expectedCommitsPerSample]
    else {
      throw CalendarEventKitMutationProfilerError.unstableExecutionCounts(
        eventCount: eventCount,
        strategy: strategy.rawValue
      )
    }
    return CalendarEventKitMutationProfilerReport.StrategyResult(
      create: CalendarEventKitMutationProfilerBenchmarkSummary.calculate(
        milliseconds: accumulator.createMilliseconds,
        eventCount: eventCount
      ),
      delete: CalendarEventKitMutationProfilerBenchmarkSummary.calculate(
        milliseconds: accumulator.deleteMilliseconds,
        eventCount: eventCount
      ),
      createCommitsPerSample: expectedCommitsPerSample,
      deleteCommitsPerSample: expectedCommitsPerSample,
      totalMeasuredCreateCommits: expectedCommitsPerSample * iterations,
      totalMeasuredDeleteCommits: expectedCommitsPerSample * iterations
    )
  }

  private func speedup(
    baselineMilliseconds: Double,
    candidateMilliseconds: Double
  ) -> Double {
    guard candidateMilliseconds > 0 else {
      return 0
    }
    return baselineMilliseconds / candidateMilliseconds
  }
}
