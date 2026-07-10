import Foundation
import Testing

@testable import CalendarEventKitMutationProfilerSupport

@Suite("Real EventKit profiler lifecycle")
struct CalendarEventKitMutationProfilerLifecycleTests {
  private enum TestFailure: Error, LocalizedError {
    case activeCleanup
    case benchmark

    var errorDescription: String? {
      switch self {
      case .activeCleanup:
        return "active cleanup failed"
      case .benchmark:
        return "benchmark failed"
      }
    }
  }

  @Test("Source plan excludes invisible sources and prefers local then default")
  func sourcePlan() {
    let sources = [
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "disabled",
        isEligibleType: true,
        isLocal: false,
        hasVisibleWritableCalendar: false,
        isDefault: false
      ),
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "other",
        isEligibleType: true,
        isLocal: false,
        hasVisibleWritableCalendar: true,
        isDefault: false
      ),
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "default",
        isEligibleType: true,
        isLocal: false,
        hasVisibleWritableCalendar: true,
        isDefault: true
      ),
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "local",
        isEligibleType: true,
        isLocal: true,
        hasVisibleWritableCalendar: true,
        isDefault: false
      ),
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "default",
        isEligibleType: true,
        isLocal: false,
        hasVisibleWritableCalendar: true,
        isDefault: true
      ),
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: "subscribed",
        isEligibleType: false,
        isLocal: false,
        hasVisibleWritableCalendar: true,
        isDefault: false
      ),
    ]

    #expect(
      CalendarEventKitMutationProfilerSourcePlan.orderedIdentifiers(from: sources)
        == ["local", "default", "other"]
    )
  }

  @Test("Verified calendar cleanup supports best effort and rejects a successful no-op")
  func verifiedCalendarCleanup() throws {
    var persisted = true
    var resetCount = 0
    var removalCount = 0
    let cleanup = {
      try CalendarEventKitMutationProfilerVerifiedCalendarCleanup.run(
        identifier: "calendar-1",
        initialPresenceRequirement: .required,
        reset: { resetCount += 1 },
        removePersistedCalendarIfPresent: {
          guard persisted else {
            return
          }
          removalCount += 1
          persisted = false
        },
        persistedCalendarIsPresent: { persisted }
      )
    }

    try cleanup()
    try CalendarEventKitMutationProfilerVerifiedCalendarCleanup.run(
      identifier: "calendar-1",
      initialPresenceRequirement: .bestEffort,
      reset: { resetCount += 1 },
      removePersistedCalendarIfPresent: { removalCount += 1 },
      persistedCalendarIsPresent: { persisted }
    )
    #expect(resetCount == 3)
    #expect(removalCount == 1)

    persisted = true
    do {
      try CalendarEventKitMutationProfilerVerifiedCalendarCleanup.run(
        identifier: "calendar-no-op",
        initialPresenceRequirement: .required,
        reset: {},
        removePersistedCalendarIfPresent: {},
        persistedCalendarIsPresent: { persisted }
      )
      Issue.record("Expected cleanup verification to reject a successful no-op")
    } catch CalendarEventKitMutationProfilerError
      .temporaryCalendarCleanupVerificationFailed(let identifier)
    {
      #expect(identifier == "calendar-no-op")
    }
  }

  @Test("Required cleanup fails when a saved calendar cannot be resolved")
  func requiredCleanupLookup() {
    var removalAttempted = false
    do {
      try CalendarEventKitMutationProfilerVerifiedCalendarCleanup.run(
        identifier: "hidden-calendar",
        initialPresenceRequirement: .required,
        reset: {},
        removePersistedCalendarIfPresent: { removalAttempted = true },
        persistedCalendarIsPresent: { false }
      )
      Issue.record("Expected required cleanup to reject an unresolvable saved calendar")
    } catch CalendarEventKitMutationProfilerError.temporaryCalendarCleanupLookupFailed(
      let identifier
    ) {
      #expect(identifier == "hidden-calendar")
    } catch {
      Issue.record("Unexpected error: \(error)")
    }
    #expect(!removalAttempted)
  }

  @Test("Cleanup coordinator always runs both cleanup stages")
  @MainActor
  func cleanupCoordinator() {
    var cleanupOrder: [String] = []
    let benchmarkResult: Result<Int, Error> = .failure(TestFailure.benchmark)

    do {
      let _: Int = try CalendarEventKitMutationProfilerCleanupCoordinator.finish(
        benchmarkResult: benchmarkResult,
        cleanupActiveEvents: {
          cleanupOrder.append("events")
          throw TestFailure.activeCleanup
        },
        cleanupTemporaryCalendar: {
          cleanupOrder.append("calendar")
        }
      )
      Issue.record("Expected combined benchmark and cleanup failure")
    } catch CalendarEventKitMutationProfilerError.temporaryCalendarAndBenchmarkFailed(
      let benchmark,
      let cleanup
    ) {
      #expect(benchmark == "benchmark failed")
      #expect(cleanup.contains("active cleanup failed"))
    } catch {
      Issue.record("Unexpected error: \(error)")
    }

    #expect(cleanupOrder == ["events", "calendar"])
  }

  @Test("Active-event cleanup is idempotent after a partial sample")
  @MainActor
  func activeEventCleanup() throws {
    let events = CalendarEventKitMutationProfilerDataset.events(count: 1)
    let range = CalendarEventKitMutationProfilerDataset.queryRange(for: events)
    let store = InMemoryCalendarEventKitMutationProfilerStore()

    _ = try store.create(events: events, strategy: .legacy)
    #expect(try store.fetchEvents(in: range).count == 1)
    store.cleanupActiveEvents()
    store.cleanupActiveEvents()

    #expect(try store.fetchEvents(in: range).isEmpty)
    #expect(store.cleanupActiveEventsCallCount == 2)
  }
}
