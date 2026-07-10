import Foundation

public struct CalendarBatchMutationProfilerRunner {
  private enum Strategy: String {
    case currentJavaScriptOrchestration
    case nativeSingleCallOrchestration
  }

  private struct Execution {
    let semantics: CalendarBatchMutationProfilerSemanticResult
    let counts: CalendarBatchMutationProfilerExecutionCounts
    let elapsedMilliseconds: Double?
  }

  public init() {}

  public func run(
    arguments: CalendarBatchMutationProfilerArguments
  ) throws -> CalendarBatchMutationProfilerReport {
    let dataset = CalendarBatchMutationProfilerDataset.generate(itemCount: arguments.itemCount)

    // Establish exact parity before either strategy is warmed or timed.
    let currentValidation = execute(
      strategy: .currentJavaScriptOrchestration,
      dataset: dataset,
      measure: false
    )
    let nativeValidation = execute(
      strategy: .nativeSingleCallOrchestration,
      dataset: dataset,
      measure: false
    )
    try validateParity(current: currentValidation.semantics, native: nativeValidation.semantics)

    let expectedSemantics = currentValidation.semantics
    let expectedOutcomeDigest = CalendarBatchMutationProfilerStableDigest.outcomes(
      expectedSemantics.orderedOutcomes
    )
    let expectedFinalStateDigest = CalendarBatchMutationProfilerStableDigest.finalEvents(
      expectedSemantics.finalEvents
    )
    let operationModel = CalendarBatchMutationProfilerOperationModel.make(
      itemCount: arguments.itemCount,
      observedCreateCommits: currentValidation.counts.create.eventKitCommits,
      observedDeleteCommits: currentValidation.counts.delete.eventKitCommits
    )
    try validateCounts(
      currentValidation.counts,
      expected: operationModel.currentJavaScriptOrchestration,
      strategy: .currentJavaScriptOrchestration
    )
    try validateCounts(
      nativeValidation.counts,
      expected: operationModel.nativeSingleCallOrchestration,
      strategy: .nativeSingleCallOrchestration
    )

    for iteration in 0..<arguments.warmupIterations {
      for strategy in orderedStrategies(iteration: iteration) {
        let execution = execute(strategy: strategy, dataset: dataset, measure: false)
        try validateStable(
          execution,
          expected: expectedSemantics,
          expectedOutcomeDigest: expectedOutcomeDigest,
          expectedFinalStateDigest: expectedFinalStateDigest,
          operationModel: operationModel,
          strategy: strategy
        )
      }
    }

    var currentSamples: [Double] = []
    var nativeSamples: [Double] = []
    currentSamples.reserveCapacity(arguments.iterations)
    nativeSamples.reserveCapacity(arguments.iterations)
    for iteration in 0..<arguments.iterations {
      for strategy in orderedStrategies(iteration: iteration) {
        let execution = execute(strategy: strategy, dataset: dataset, measure: true)
        try validateStable(
          execution,
          expected: expectedSemantics,
          expectedOutcomeDigest: expectedOutcomeDigest,
          expectedFinalStateDigest: expectedFinalStateDigest,
          operationModel: operationModel,
          strategy: strategy
        )
        guard let elapsedMilliseconds = execution.elapsedMilliseconds else {
          preconditionFailure("Measured execution did not produce a duration")
        }
        switch strategy {
        case .currentJavaScriptOrchestration:
          currentSamples.append(elapsedMilliseconds)
        case .nativeSingleCallOrchestration:
          nativeSamples.append(elapsedMilliseconds)
        }
      }
    }

    let mutationItemsPerSample = dataset.createRequests.count + dataset.deleteRequests.count
    let currentSummary = CalendarBatchMutationProfilerBenchmarkSummary.calculate(
      samples: currentSamples,
      mutationItemCount: mutationItemsPerSample
    )
    let nativeSummary = CalendarBatchMutationProfilerBenchmarkSummary.calculate(
      samples: nativeSamples,
      mutationItemCount: mutationItemsPerSample
    )
    let medianRatio =
      nativeSummary.medianMilliseconds > 0
      ? currentSummary.medianMilliseconds / nativeSummary.medianMilliseconds : 0

    return CalendarBatchMutationProfilerReport(
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      measurementScope:
        "Measured timings cover deterministic Swift orchestration and in-memory mutations only; "
        + "they exclude JavaScript, the React Native bridge, EventKit, permissions, and Calendar I/O. "
        + "The native candidate models one commit per phase containing a successful mutation. "
        + "The CPU ratio is not an EventKit speedup.",
      configuration: CalendarBatchMutationProfilerReport.Configuration(
        itemCountPerPhase: arguments.itemCount,
        measuredMutationItemsPerSample: mutationItemsPerSample,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations
      ),
      dataset: CalendarBatchMutationProfilerReport.Dataset(
        seed: String(format: "0x%016llx", CalendarBatchMutationProfilerDataset.seed),
        createItems: dataset.createRequests.count,
        deleteItems: dataset.deleteRequests.count,
        initialEvents: dataset.initialEvents.count,
        syntheticCreateFailures: dataset.syntheticCreateFailureCount,
        syntheticDeleteFailures: dataset.syntheticDeleteFailureCount,
        syntheticAlreadyAbsentDeletes: dataset.syntheticAlreadyAbsentDeleteCount
      ),
      correctness: CalendarBatchMutationProfilerReport.Correctness(
        exactOrderedOutcomeParity: true,
        exactFinalStateParity: true,
        allWarmupAndMeasuredResultsStable: true,
        allWarmupAndMeasuredOperationCountsStable: true,
        orderedOutcomeSHA256: expectedOutcomeDigest,
        finalStateSHA256: expectedFinalStateDigest,
        orderedOutcomeCount: expectedSemantics.orderedOutcomes.count,
        finalEventCount: expectedSemantics.finalEvents.count
      ),
      operationModel: operationModel,
      timings: CalendarBatchMutationProfilerReport.Timings(
        currentJavaScriptOrchestration: currentSummary,
        nativeSingleCallOrchestration: nativeSummary,
        currentToNativeMedianSwiftCPURatio: medianRatio
      )
    )
  }

  private func orderedStrategies(iteration: Int) -> [Strategy] {
    if iteration.isMultiple(of: 2) {
      return [.currentJavaScriptOrchestration, .nativeSingleCallOrchestration]
    }
    return [.nativeSingleCallOrchestration, .currentJavaScriptOrchestration]
  }

  private func execute(
    strategy: Strategy,
    dataset: CalendarBatchMutationProfilerDataset,
    measure: Bool
  ) -> Execution {
    var store = CalendarBatchMutationProfilerInMemoryStore(
      initialEvents: dataset.initialEvents
    )
    let clock = ContinuousClock()
    let startedAt = clock.now
    let orchestration: CalendarBatchMutationProfilerOrchestrationResult
    switch strategy {
    case .currentJavaScriptOrchestration:
      orchestration = CalendarBatchMutationProfilerCurrentOrchestrator().run(
        dataset: dataset,
        store: &store
      )
    case .nativeSingleCallOrchestration:
      orchestration = CalendarBatchMutationProfilerNativeOrchestrator().run(
        dataset: dataset,
        store: &store
      )
    }
    let duration = startedAt.duration(to: clock.now)

    // Final-state sorting and all digest/parity checks deliberately happen outside the timer.
    let semantics = CalendarBatchMutationProfilerSemanticResult(
      orderedOutcomes: orchestration.orderedOutcomes,
      finalEvents: store.sortedEvents()
    )
    return Execution(
      semantics: semantics,
      counts: orchestration.counts,
      elapsedMilliseconds: measure ? milliseconds(duration) : nil
    )
  }

  private func milliseconds(_ duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) * 1_000
      + Double(components.attoseconds) / 1_000_000_000_000_000
  }

  private func validateParity(
    current: CalendarBatchMutationProfilerSemanticResult,
    native: CalendarBatchMutationProfilerSemanticResult
  ) throws {
    guard current == native else {
      throw CalendarBatchMutationProfilerError.semanticParityMismatch(
        currentOutcomeDigest: CalendarBatchMutationProfilerStableDigest.outcomes(
          current.orderedOutcomes
        ),
        nativeOutcomeDigest: CalendarBatchMutationProfilerStableDigest.outcomes(
          native.orderedOutcomes
        ),
        currentFinalStateDigest: CalendarBatchMutationProfilerStableDigest.finalEvents(
          current.finalEvents
        ),
        nativeFinalStateDigest: CalendarBatchMutationProfilerStableDigest.finalEvents(
          native.finalEvents
        )
      )
    }
  }

  private func validateStable(
    _ execution: Execution,
    expected: CalendarBatchMutationProfilerSemanticResult,
    expectedOutcomeDigest: String,
    expectedFinalStateDigest: String,
    operationModel: CalendarBatchMutationProfilerOperationModel,
    strategy: Strategy
  ) throws {
    let actualOutcomeDigest = CalendarBatchMutationProfilerStableDigest.outcomes(
      execution.semantics.orderedOutcomes
    )
    let actualFinalStateDigest = CalendarBatchMutationProfilerStableDigest.finalEvents(
      execution.semantics.finalEvents
    )
    guard execution.semantics == expected else {
      throw CalendarBatchMutationProfilerError.timedResultChanged(
        strategy: strategy.rawValue,
        expectedOutcomeDigest: expectedOutcomeDigest,
        actualOutcomeDigest: actualOutcomeDigest,
        expectedFinalStateDigest: expectedFinalStateDigest,
        actualFinalStateDigest: actualFinalStateDigest
      )
    }
    let expectedCounts: CalendarBatchMutationProfilerOperationModel.Strategy
    switch strategy {
    case .currentJavaScriptOrchestration:
      expectedCounts = operationModel.currentJavaScriptOrchestration
    case .nativeSingleCallOrchestration:
      expectedCounts = operationModel.nativeSingleCallOrchestration
    }
    try validateCounts(execution.counts, expected: expectedCounts, strategy: strategy)
  }

  private func validateCounts(
    _ actual: CalendarBatchMutationProfilerExecutionCounts,
    expected: CalendarBatchMutationProfilerOperationModel.Strategy,
    strategy: Strategy
  ) throws {
    guard phaseMatches(actual.create, expected.create) else {
      throw CalendarBatchMutationProfilerError.operationModelMismatch(
        strategy: strategy.rawValue,
        phase: "create"
      )
    }
    guard phaseMatches(actual.delete, expected.delete) else {
      throw CalendarBatchMutationProfilerError.operationModelMismatch(
        strategy: strategy.rawValue,
        phase: "delete"
      )
    }
  }

  private func phaseMatches(
    _ actual: CalendarBatchMutationProfilerExecutionCounts.Phase,
    _ expected: CalendarBatchMutationProfilerOperationModel.Phase
  ) -> Bool {
    actual.mutationItems == expected.mutationItems
      && actual.jsToNativeCalls == expected.jsToNativeCalls
      && actual.authorizationChecks == expected.authorizationChecks
      && actual.eventKitCommits == expected.observedSyntheticEventKitCommits
  }
}
