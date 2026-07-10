import CalendarBatchMutationCore
import Testing

@testable import CalendarEventKitMutationProfilerSupport

@Suite("Production EventKit mutation profiler candidate")
struct CalendarEventKitMutationProfilerProductionCandidateTests {
  @Test("Create maps exact fields and observes identifiers before one commit")
  @MainActor
  func createMappingAndCommitBoundary() throws {
    let backend = FakeCalendarEventKitMutationBackend()
    let candidate = CalendarEventKitMutationProfilerProductionCandidate(
      calendarIdentifier: "temporary-calendar",
      timeZoneIdentifier: "America/Los_Angeles",
      makeBackend: { backend }
    )
    let events = [
      CalendarEventKitMutationProfilerSemanticEvent(
        title: "Dîner at 雪's table 🍜",
        startMilliseconds: 1_785_585_600_000,
        endMilliseconds: 1_785_589_200_000,
        location: "1 Main St",
        notes: "予約\n\n[Palate Export]",
        isAllDay: false
      ),
      CalendarEventKitMutationProfilerSemanticEvent(
        title: "Second",
        startMilliseconds: 1_785_592_800_000,
        endMilliseconds: 1_785_598_200_000,
        location: "",
        notes: "No location",
        isAllDay: false
      ),
    ]

    let execution = try candidate.create(events: events)

    #expect(backend.preparedCalendarIdentifier == "temporary-calendar")
    #expect(backend.preparedTimeZoneIdentifier == "America/Los_Angeles")
    #expect(backend.commitCallCount == 1)
    #expect(backend.discardCallCount == 0)
    #expect(
      backend.createRequests.map(\.requestID) == [
        "eventkit-profiler-create-0", "eventkit-profiler-create-1",
      ])
    #expect(backend.createRequests.map(\.title) == events.map(\.title))
    #expect(backend.createRequests.map(\.startMs) == events.map { Double($0.startMilliseconds) })
    #expect(backend.createRequests.map(\.endMs) == events.map { Double($0.endMilliseconds) })
    #expect(backend.createRequests.map(\.location) == events.map { Optional($0.location) })
    #expect(backend.createRequests.map(\.notes) == events.map(\.notes))
    #expect(execution.commitCount == 1)
    #expect(
      execution.eventIdentifiers == [
        "event-eventkit-profiler-create-0", "event-eventkit-profiler-create-1",
      ])
    #expect(execution.identifiersObservedBeforeFinalCommit)
  }

  @Test("Delete maps ordered identifiers and reports only committed deletions")
  @MainActor
  func deleteMappingAndOutcomes() throws {
    let backend = FakeCalendarEventKitMutationBackend()
    backend.deleteHandler = { request in
      request.eventID == "missing" ? .alreadyAbsent : .deleted
    }
    let candidate = CalendarEventKitMutationProfilerProductionCandidate(
      calendarIdentifier: "temporary-calendar",
      makeBackend: { backend }
    )

    let execution = try candidate.delete(eventIdentifiers: ["first", "missing", "last"])

    #expect(
      backend.deleteRequests.map(\.requestID) == [
        "eventkit-profiler-delete-0",
        "eventkit-profiler-delete-1",
        "eventkit-profiler-delete-2",
      ])
    #expect(backend.deleteRequests.map(\.eventID) == ["first", "missing", "last"])
    #expect(backend.deleteRequests.allSatisfy { $0.instanceStartMs == nil })
    #expect(backend.deleteRequests.allSatisfy { !$0.futureEvents })
    #expect(backend.commitCallCount == 1)
    #expect(execution.commitCount == 1)
    #expect(execution.eventIdentifiers == ["first", "last"])
  }

  @Test("Commit failure discards pending production work and reports no created identifiers")
  @MainActor
  func commitFailure() throws {
    let backend = FakeCalendarEventKitMutationBackend()
    backend.commitError = CalendarEventKitMutationProfilerTestError.commitFailed
    let candidate = CalendarEventKitMutationProfilerProductionCandidate(
      calendarIdentifier: "temporary-calendar",
      makeBackend: { backend }
    )

    let execution = try candidate.create(
      events: CalendarEventKitMutationProfilerDataset.events(count: 2)
    )

    #expect(backend.commitCallCount == 1)
    #expect(backend.discardCallCount == 1)
    #expect(execution.commitCount == 1)
    #expect(execution.eventIdentifiers.isEmpty)
    #expect(!execution.identifiersObservedBeforeFinalCommit)
  }
}
