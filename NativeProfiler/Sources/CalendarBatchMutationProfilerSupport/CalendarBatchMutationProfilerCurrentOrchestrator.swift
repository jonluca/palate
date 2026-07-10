import Foundation

struct CalendarBatchMutationProfilerCurrentOrchestrator {
  func run(
    dataset: CalendarBatchMutationProfilerDataset,
    store: inout CalendarBatchMutationProfilerInMemoryStore
  ) -> CalendarBatchMutationProfilerOrchestrationResult {
    var outcomes: [CalendarBatchMutationProfilerOutcome] = []
    outcomes.reserveCapacity(dataset.createRequests.count + dataset.deleteRequests.count)
    var counts = CalendarBatchMutationProfilerExecutionCounts()

    for request in dataset.createRequests {
      counts.create.mutationItems += 1
      // Existing JavaScript first checks permission, then calls expo-calendar. Both cross the
      // JS/native boundary and both perform an authorization check.
      counts.create.jsToNativeCalls += 2
      counts.create.authorizationChecks += 2
      let commitsBefore = store.committedMutationCount
      outcomes.append(store.create(request))
      counts.create.eventKitCommits += store.committedMutationCount - commitsBefore
    }

    for request in dataset.deleteRequests {
      counts.delete.mutationItems += 1
      counts.delete.jsToNativeCalls += 2
      counts.delete.authorizationChecks += 2
      let commitsBefore = store.committedMutationCount
      outcomes.append(store.delete(request))
      counts.delete.eventKitCommits += store.committedMutationCount - commitsBefore
    }

    return CalendarBatchMutationProfilerOrchestrationResult(
      orderedOutcomes: outcomes,
      counts: counts
    )
  }
}
