import Foundation

struct CalendarBatchMutationProfilerNativeOrchestrator {
  func run(
    dataset: CalendarBatchMutationProfilerDataset,
    store: inout CalendarBatchMutationProfilerInMemoryStore
  ) -> CalendarBatchMutationProfilerOrchestrationResult {
    var outcomes: [CalendarBatchMutationProfilerOutcome] = []
    outcomes.reserveCapacity(dataset.createRequests.count + dataset.deleteRequests.count)
    var counts = CalendarBatchMutationProfilerExecutionCounts()

    counts.create.mutationItems = dataset.createRequests.count
    if !dataset.createRequests.isEmpty {
      // One native entry and one authorization preflight for the complete create request.
      counts.create.jsToNativeCalls = 1
      counts.create.authorizationChecks = 1
    }
    for request in dataset.createRequests {
      outcomes.append(store.stageCreate(request))
    }
    // The candidate defers EventKit commits until all successful creates have been staged.
    counts.create.eventKitCommits += store.commitStagedMutations()

    counts.delete.mutationItems = dataset.deleteRequests.count
    if !dataset.deleteRequests.isEmpty {
      counts.delete.jsToNativeCalls = 1
      counts.delete.authorizationChecks = 1
    }
    for request in dataset.deleteRequests {
      outcomes.append(store.stageDelete(request))
    }
    counts.delete.eventKitCommits += store.commitStagedMutations()

    return CalendarBatchMutationProfilerOrchestrationResult(
      orderedOutcomes: outcomes,
      counts: counts
    )
  }
}
