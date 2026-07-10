import Testing

@testable import CalendarBatchMutationProfilerSupport

@Suite("Calendar batch mutation synthetic profiler")
struct CalendarBatchMutationProfilerSupportTests {
  @Test("Defaults model 4,000 creates and deletes without EventKit")
  func argumentDefaults() throws {
    let arguments = try CalendarBatchMutationProfilerArguments(commandLineArguments: [])

    #expect(arguments.itemCount == 4_000)
    #expect(arguments.iterations == 7)
    #expect(arguments.warmupIterations == 2)
    #expect(!arguments.showHelp)
  }

  @Test("Separated and inline options parse deterministically")
  func customArguments() throws {
    let arguments = try CalendarBatchMutationProfilerArguments(commandLineArguments: [
      "--items=123",
      "--iterations", "5",
      "--warmup=0",
    ])

    #expect(arguments.itemCount == 123)
    #expect(arguments.iterations == 5)
    #expect(arguments.warmupIterations == 0)
  }

  @Test("Malformed and unbounded configurations fail before profiling")
  func invalidArguments() {
    #expect(
      throws: CalendarBatchMutationProfilerArgumentsError.duplicateOption("--items")
    ) {
      try CalendarBatchMutationProfilerArguments(commandLineArguments: [
        "--items", "2", "--items=3",
      ])
    }
    #expect(
      throws: CalendarBatchMutationProfilerArgumentsError.missingValue(option: "--iterations")
    ) {
      try CalendarBatchMutationProfilerArguments(commandLineArguments: ["--iterations"])
    }
    #expect(
      throws: CalendarBatchMutationProfilerArgumentsError.nonPositiveValue(option: "--items")
    ) {
      try CalendarBatchMutationProfilerArguments(itemCount: 0)
    }
    #expect(
      throws: CalendarBatchMutationProfilerArgumentsError.negativeValue(option: "--warmup")
    ) {
      try CalendarBatchMutationProfilerArguments(warmupIterations: -1)
    }
    #expect(
      throws: CalendarBatchMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--items",
        maximum: CalendarBatchMutationProfilerArguments.maximumItemCount
      )
    ) {
      try CalendarBatchMutationProfilerArguments(
        itemCount: CalendarBatchMutationProfilerArguments.maximumItemCount + 1
      )
    }
  }

  @Test("Summary uses deterministic median, nearest-rank p95, and throughput")
  func benchmarkSummary() {
    let summary = CalendarBatchMutationProfilerBenchmarkSummary.calculate(
      samples: [40, 10, 30, 20],
      mutationItemCount: 8_000
    )

    #expect(summary.sampleDurationsMilliseconds == [40, 10, 30, 20])
    #expect(summary.minimumMilliseconds == 10)
    #expect(summary.medianMilliseconds == 25)
    #expect(summary.p95Milliseconds == 40)
    #expect(summary.maximumMilliseconds == 40)
    #expect(summary.medianMutationItemsPerSecond == 320_000)
  }

  @Test("Outcome digest is ordered while final-state digest is order-independent")
  func stableDigests() {
    let firstOutcome = CalendarBatchMutationProfilerOutcome(
      phase: .create,
      requestIdentifier: "visit-one",
      eventIdentifier: "event-one",
      status: .created
    )
    let secondOutcome = CalendarBatchMutationProfilerOutcome(
      phase: .delete,
      requestIdentifier: "delete-two",
      eventIdentifier: "event-two",
      status: .deleted
    )
    let firstEvent = CalendarBatchMutationProfilerDataset.Event(
      identifier: "event-one",
      title: "L'Atelier",
      startMilliseconds: 1_000,
      endMilliseconds: 2_000,
      location: nil,
      notes: "雪"
    )
    let secondEvent = CalendarBatchMutationProfilerDataset.Event(
      identifier: "event-two",
      title: "Café",
      startMilliseconds: 3_000,
      endMilliseconds: 4_000,
      location: "Somewhere",
      notes: nil
    )

    let forwardOutcomes = CalendarBatchMutationProfilerStableDigest.outcomes([
      firstOutcome, secondOutcome,
    ])
    let reverseOutcomes = CalendarBatchMutationProfilerStableDigest.outcomes([
      secondOutcome, firstOutcome,
    ])
    let forwardEvents = CalendarBatchMutationProfilerStableDigest.finalEvents([
      firstEvent, secondEvent,
    ])
    let reverseEvents = CalendarBatchMutationProfilerStableDigest.finalEvents([
      secondEvent, firstEvent,
    ])
    let changedEvents = CalendarBatchMutationProfilerStableDigest.finalEvents([
      CalendarBatchMutationProfilerDataset.Event(
        identifier: firstEvent.identifier,
        title: firstEvent.title,
        startMilliseconds: firstEvent.startMilliseconds + 1,
        endMilliseconds: firstEvent.endMilliseconds,
        location: firstEvent.location,
        notes: firstEvent.notes
      ),
      secondEvent,
    ])

    #expect(forwardOutcomes.count == 64)
    #expect(forwardOutcomes != reverseOutcomes)
    #expect(forwardEvents == reverseEvents)
    #expect(forwardEvents != changedEvents)
  }

  @Test("Structural model handles empty, single-item, and production-scale boundaries")
  func operationModelBoundaries() {
    let empty = CalendarBatchMutationProfilerOperationModel.make(
      itemCount: 0,
      observedCreateCommits: 0,
      observedDeleteCommits: 0
    )
    #expect(empty.currentJavaScriptOrchestration.combined.jsToNativeCalls == 0)
    #expect(empty.nativeSingleCallOrchestration.combined.jsToNativeCalls == 0)

    let single = CalendarBatchMutationProfilerOperationModel.make(
      itemCount: 1,
      observedCreateCommits: 1,
      observedDeleteCommits: 1
    )
    #expect(single.currentJavaScriptOrchestration.create.jsToNativeCalls == 2)
    #expect(single.currentJavaScriptOrchestration.create.authorizationChecks == 2)
    #expect(single.nativeSingleCallOrchestration.create.jsToNativeCalls == 1)
    #expect(single.nativeSingleCallOrchestration.create.authorizationChecks == 1)
    #expect(single.currentJavaScriptOrchestration.create.eventKitCommitUpperBound == 1)
    #expect(single.nativeSingleCallOrchestration.create.eventKitCommitUpperBound == 1)
    #expect(single.nativeSingleCallOrchestration.create.observedSyntheticEventKitCommits == 1)

    let scaled = CalendarBatchMutationProfilerOperationModel.make(
      itemCount: 4_000,
      observedCreateCommits: 3_996,
      observedDeleteCommits: 3_992
    )
    #expect(scaled.currentJavaScriptOrchestration.create.jsToNativeCalls == 8_000)
    #expect(scaled.currentJavaScriptOrchestration.create.authorizationChecks == 8_000)
    #expect(scaled.nativeSingleCallOrchestration.create.jsToNativeCalls == 1)
    #expect(scaled.nativeSingleCallOrchestration.create.authorizationChecks == 1)
    #expect(scaled.currentJavaScriptOrchestration.combined.jsToNativeCalls == 16_000)
    #expect(scaled.nativeSingleCallOrchestration.combined.jsToNativeCalls == 2)
    #expect(scaled.currentJavaScriptOrchestration.combined.eventKitCommitUpperBound == 8_000)
    #expect(scaled.nativeSingleCallOrchestration.combined.eventKitCommitUpperBound == 2)
    #expect(
      scaled.currentJavaScriptOrchestration.combined.observedSyntheticEventKitCommits == 7_988
    )
    #expect(scaled.nativeSingleCallOrchestration.combined.observedSyntheticEventKitCommits == 2)
    #expect(scaled.eventKitCommitUpperBoundReduction == 7_998)
  }

  @Test("Batched-commit candidate preserves failures, missing deletes, order, and final state")
  func exactSemanticParity() {
    let dataset = CalendarBatchMutationProfilerDataset.generate(itemCount: 1_000)
    var currentStore = CalendarBatchMutationProfilerInMemoryStore(
      initialEvents: dataset.initialEvents
    )
    var nativeStore = CalendarBatchMutationProfilerInMemoryStore(
      initialEvents: dataset.initialEvents
    )
    let current = CalendarBatchMutationProfilerCurrentOrchestrator().run(
      dataset: dataset,
      store: &currentStore
    )
    let native = CalendarBatchMutationProfilerNativeOrchestrator().run(
      dataset: dataset,
      store: &nativeStore
    )

    #expect(current.orderedOutcomes == native.orderedOutcomes)
    #expect(currentStore.sortedEvents() == nativeStore.sortedEvents())
    #expect(current.orderedOutcomes.count == 2_000)
    #expect(current.orderedOutcomes.filter { $0.status == .failed }.count == 2)
    #expect(current.orderedOutcomes.filter { $0.status == .alreadyAbsent }.count == 1)
    #expect(current.counts.create.jsToNativeCalls == 2_000)
    #expect(native.counts.create.jsToNativeCalls == 1)
    #expect(current.counts.create.eventKitCommits == 999)
    #expect(current.counts.delete.eventKitCommits == 998)
    #expect(native.counts.create.eventKitCommits == 1)
    #expect(native.counts.delete.eventKitCommits == 1)
    #expect(currentStore.committedMutationCount == 1_997)
    #expect(nativeStore.committedMutationCount == 2)
  }

  @Test("Nonempty phases without successful mutations do not commit")
  func unsuccessfulPhasesDoNotCommit() {
    let existingEvent = CalendarBatchMutationProfilerDataset.Event(
      identifier: "existing-event",
      title: "Existing",
      startMilliseconds: 1_000,
      endMilliseconds: 2_000,
      location: nil,
      notes: nil
    )
    let dataset = CalendarBatchMutationProfilerDataset(
      createRequests: [
        CalendarBatchMutationProfilerDataset.CreateRequest(
          clientIdentifier: "failing-create",
          title: "Failure",
          startMilliseconds: 3_000,
          endMilliseconds: 4_000,
          location: nil,
          notes: nil,
          shouldFail: true
        )
      ],
      deleteRequests: [
        CalendarBatchMutationProfilerDataset.DeleteRequest(
          requestIdentifier: "missing-delete",
          eventIdentifier: "missing-event",
          shouldFail: false
        ),
        CalendarBatchMutationProfilerDataset.DeleteRequest(
          requestIdentifier: "failing-delete",
          eventIdentifier: existingEvent.identifier,
          shouldFail: true
        ),
      ],
      initialEvents: [existingEvent],
      syntheticCreateFailureCount: 1,
      syntheticDeleteFailureCount: 1,
      syntheticAlreadyAbsentDeleteCount: 1
    )
    var currentStore = CalendarBatchMutationProfilerInMemoryStore(
      initialEvents: dataset.initialEvents
    )
    var nativeStore = CalendarBatchMutationProfilerInMemoryStore(
      initialEvents: dataset.initialEvents
    )

    let current = CalendarBatchMutationProfilerCurrentOrchestrator().run(
      dataset: dataset,
      store: &currentStore
    )
    let native = CalendarBatchMutationProfilerNativeOrchestrator().run(
      dataset: dataset,
      store: &nativeStore
    )

    #expect(current.orderedOutcomes == native.orderedOutcomes)
    #expect(currentStore.sortedEvents() == [existingEvent])
    #expect(nativeStore.sortedEvents() == [existingEvent])
    #expect(native.counts.create.jsToNativeCalls == 1)
    #expect(native.counts.delete.jsToNativeCalls == 1)
    #expect(native.counts.create.eventKitCommits == 0)
    #expect(native.counts.delete.eventKitCommits == 0)
    #expect(nativeStore.committedMutationCount == 0)
  }

  @Test("Runner validates every sample and labels CPU timing honestly")
  func runner() throws {
    let arguments = try CalendarBatchMutationProfilerArguments(
      itemCount: 50,
      iterations: 2,
      warmupIterations: 1
    )
    let report = try CalendarBatchMutationProfilerRunner().run(arguments: arguments)

    #expect(report.correctness.exactOrderedOutcomeParity)
    #expect(report.correctness.exactFinalStateParity)
    #expect(report.correctness.allWarmupAndMeasuredResultsStable)
    #expect(report.correctness.allWarmupAndMeasuredOperationCountsStable)
    #expect(report.correctness.orderedOutcomeCount == 100)
    #expect(report.operationModel.eventKitCommitUpperBoundReduction == 98)
    #expect(
      report.operationModel.nativeSingleCallOrchestration.combined
        .observedSyntheticEventKitCommits == 2
    )
    #expect(report.timings.currentJavaScriptOrchestration.sampleDurationsMilliseconds.count == 2)
    #expect(report.timings.nativeSingleCallOrchestration.sampleDurationsMilliseconds.count == 2)
    #expect(report.measurementScope.contains("not an EventKit speedup"))
    #expect(report.measurementScope.contains("one commit per phase"))
  }
}
