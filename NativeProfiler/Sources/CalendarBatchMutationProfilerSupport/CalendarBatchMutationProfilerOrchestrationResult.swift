import Foundation

struct CalendarBatchMutationProfilerOrchestrationResult: Sendable {
  let orderedOutcomes: [CalendarBatchMutationProfilerOutcome]
  let counts: CalendarBatchMutationProfilerExecutionCounts
}
