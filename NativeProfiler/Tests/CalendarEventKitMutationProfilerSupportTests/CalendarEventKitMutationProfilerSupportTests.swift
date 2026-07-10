import Testing

@testable import CalendarEventKitMutationProfilerSupport

@Suite("Real EventKit mutation profiler support")
struct CalendarEventKitMutationProfilerSupportTests {
  @Test("Defaults are bounded, cover 1/25/100, and never request access")
  func argumentDefaults() throws {
    let arguments = try CalendarEventKitMutationProfilerArguments(commandLineArguments: [])

    #expect(arguments.eventCounts == [1, 25, 100])
    #expect(arguments.iterations == 3)
    #expect(arguments.warmupIterations == 1)
    #expect(!arguments.requestAccess)
  }

  @Test("Custom bounded work and explicit access request parse")
  func customArguments() throws {
    let arguments = try CalendarEventKitMutationProfilerArguments(commandLineArguments: [
      "--items", "250",
      "--iterations", "5",
      "--warmup", "0",
      "--request-access",
    ])

    #expect(arguments.eventCounts == [1, 25, 250])
    #expect(arguments.iterations == 5)
    #expect(arguments.warmupIterations == 0)
    #expect(arguments.requestAccess)
  }

  @Test("Malformed and unbounded work fails before EventKit access")
  func invalidArguments() {
    #expect(
      throws: CalendarEventKitMutationProfilerArgumentsError.optionBelowMinimum(
        option: "--items",
        minimum: CalendarEventKitMutationProfilerArguments.minimumMaximumEventCount
      )
    ) {
      try CalendarEventKitMutationProfilerArguments(maximumEventCount: 99)
    }
    #expect(
      throws: CalendarEventKitMutationProfilerArgumentsError.optionAboveMaximum(
        option: "--items",
        maximum: CalendarEventKitMutationProfilerArguments.maximumEventCountLimit
      )
    ) {
      try CalendarEventKitMutationProfilerArguments(maximumEventCount: 501)
    }
    #expect(
      throws: CalendarEventKitMutationProfilerArgumentsError.duplicateOption("--items")
    ) {
      try CalendarEventKitMutationProfilerArguments(commandLineArguments: [
        "--items", "100", "--items", "200",
      ])
    }
    #expect(
      throws: CalendarEventKitMutationProfilerArgumentsError.missingValue(
        option: "--iterations"
      )
    ) {
      try CalendarEventKitMutationProfilerArguments(commandLineArguments: ["--iterations"])
    }
  }

  @Test("Dataset and semantic digest are deterministic and field-sensitive")
  func datasetAndDigest() {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 25)
    let repeated = CalendarEventKitMutationProfilerDataset.events(count: 25)
    let reversed = Array(events.reversed())
    let changed =
      [
        CalendarEventKitMutationProfilerSemanticEvent(
          title: events[0].title + " changed",
          startMilliseconds: events[0].startMilliseconds,
          endMilliseconds: events[0].endMilliseconds,
          location: events[0].location,
          notes: events[0].notes,
          isAllDay: events[0].isAllDay
        )
      ] + events.dropFirst()

    #expect(events == repeated)
    #expect(Set(events.map(\.title)).count == 25)
    #expect(
      CalendarEventKitMutationProfilerSemanticEvent.comparedFieldNames == [
        "title", "startMilliseconds", "endMilliseconds", "location", "notes", "isAllDay",
      ]
    )
    #expect(
      CalendarEventKitMutationProfilerStableDigest.signature(for: events)
        == CalendarEventKitMutationProfilerStableDigest.signature(for: reversed)
    )
    #expect(
      CalendarEventKitMutationProfilerStableDigest.signature(for: events)
        != CalendarEventKitMutationProfilerStableDigest.signature(for: changed)
    )
  }

  @Test("Summary reports median, nearest-rank p95, and throughput")
  func summary() {
    let summary = CalendarEventKitMutationProfilerBenchmarkSummary.calculate(
      milliseconds: [40, 10, 30, 20],
      eventCount: 100
    )

    #expect(summary.samplesMilliseconds == [40, 10, 30, 20])
    #expect(summary.minimumMilliseconds == 10)
    #expect(summary.medianMilliseconds == 25)
    #expect(summary.p95Milliseconds == 40)
    #expect(summary.maximumMilliseconds == 40)
    #expect(summary.medianEventsPerSecond == 4_000)
  }

  @Test("Legacy and candidate preserve exact semantics with their expected commits")
  @MainActor
  func exactSemanticsAndCommitCounts() throws {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 25)
    let store = InMemoryCalendarEventKitMutationProfilerStore()
    let orchestrator = CalendarEventKitMutationProfilerOrchestrator()

    let legacy = try orchestrator.runSample(
      events: events,
      strategy: .legacy,
      store: store
    )
    let candidate = try orchestrator.runSample(
      events: events,
      strategy: .candidate,
      store: store
    )

    #expect(legacy.semanticDigest == candidate.semanticDigest)
    #expect(legacy.createCommitCount == 25)
    #expect(legacy.deleteCommitCount == 25)
    #expect(candidate.createCommitCount == 1)
    #expect(candidate.deleteCommitCount == 1)
    #expect(
      try store.fetchEvents(in: CalendarEventKitMutationProfilerDataset.queryRange(for: events))
        .isEmpty)
  }

  @Test("Candidate must expose unique identifiers before its final commit")
  @MainActor
  func candidatePrecommitIdentifiers() throws {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 1)
    let store = InMemoryCalendarEventKitMutationProfilerStore()
    store.candidateIdentifiersObservedBeforeCommit = false

    do {
      _ = try CalendarEventKitMutationProfilerOrchestrator().runSample(
        events: events,
        strategy: .candidate,
        store: store
      )
      Issue.record("Expected candidate pre-commit identifier validation to fail")
    } catch CalendarEventKitMutationProfilerError.candidateIdentifiersNotObservedBeforeCommit {
      // Expected.
    }
  }

  @Test("Created identifiers must remain stable after commit")
  @MainActor
  func postcommitIdentifierStability() throws {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 1)
    let store = InMemoryCalendarEventKitMutationProfilerStore()
    store.rewriteReadbackIdentifiers = true

    do {
      _ = try CalendarEventKitMutationProfilerOrchestrator().runSample(
        events: events,
        strategy: .candidate,
        store: store
      )
      Issue.record("Expected post-commit identifier stability validation to fail")
    } catch CalendarEventKitMutationProfilerError.eventIdentifiersChangedAfterCommit(
      let created,
      let readBack
    ) {
      #expect(created == ["event-1-0"])
      #expect(readBack == ["rewritten-event-1-0"])
    }
  }

  @Test("Semantic drift and incomplete deletion fail validation")
  @MainActor
  func validationFailures() throws {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 1)
    let corruptStore = InMemoryCalendarEventKitMutationProfilerStore()
    corruptStore.corruptReadback = true
    do {
      _ = try CalendarEventKitMutationProfilerOrchestrator().runSample(
        events: events,
        strategy: .legacy,
        store: corruptStore
      )
      Issue.record("Expected semantic parity validation to fail")
    } catch CalendarEventKitMutationProfilerError.semanticParityMismatch {
      // Expected.
    }

    let incompleteDeleteStore = InMemoryCalendarEventKitMutationProfilerStore()
    incompleteDeleteStore.leaveFirstEventAfterDelete = true
    do {
      _ = try CalendarEventKitMutationProfilerOrchestrator().runSample(
        events: events,
        strategy: .legacy,
        store: incompleteDeleteStore
      )
      Issue.record("Expected zero-remaining validation to fail")
    } catch CalendarEventKitMutationProfilerError.eventsRemainAfterDelete(let count) {
      #expect(count == 1)
    }
  }
}
