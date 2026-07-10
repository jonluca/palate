import Foundation

struct CalendarBatchMutationProfilerSemanticResult: Equatable, Sendable {
  let orderedOutcomes: [CalendarBatchMutationProfilerOutcome]
  let finalEvents: [CalendarBatchMutationProfilerDataset.Event]
}
