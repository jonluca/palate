import Foundation

struct CalendarBatchMutationProfilerInMemoryStore: Sendable {
  private var eventsByIdentifier: [String: CalendarBatchMutationProfilerDataset.Event]
  private var stagedMutationCount = 0
  private(set) var committedMutationCount = 0

  init(initialEvents: [CalendarBatchMutationProfilerDataset.Event]) {
    eventsByIdentifier = Dictionary(
      uniqueKeysWithValues: initialEvents.map { ($0.identifier, $0) }
    )
    precondition(eventsByIdentifier.count == initialEvents.count)
  }

  mutating func create(
    _ request: CalendarBatchMutationProfilerDataset.CreateRequest
  ) -> CalendarBatchMutationProfilerOutcome {
    precondition(stagedMutationCount == 0)
    let result = applyCreate(request)
    if result.didMutate {
      committedMutationCount += 1
    }
    return result.outcome
  }

  mutating func stageCreate(
    _ request: CalendarBatchMutationProfilerDataset.CreateRequest
  ) -> CalendarBatchMutationProfilerOutcome {
    let result = applyCreate(request)
    if result.didMutate {
      stagedMutationCount += 1
    }
    return result.outcome
  }

  mutating func delete(
    _ request: CalendarBatchMutationProfilerDataset.DeleteRequest
  ) -> CalendarBatchMutationProfilerOutcome {
    precondition(stagedMutationCount == 0)
    let result = applyDelete(request)
    if result.didMutate {
      committedMutationCount += 1
    }
    return result.outcome
  }

  mutating func stageDelete(
    _ request: CalendarBatchMutationProfilerDataset.DeleteRequest
  ) -> CalendarBatchMutationProfilerOutcome {
    let result = applyDelete(request)
    if result.didMutate {
      stagedMutationCount += 1
    }
    return result.outcome
  }

  mutating func commitStagedMutations() -> Int {
    guard stagedMutationCount > 0 else {
      return 0
    }

    stagedMutationCount = 0
    committedMutationCount += 1
    return 1
  }

  func sortedEvents() -> [CalendarBatchMutationProfilerDataset.Event] {
    precondition(stagedMutationCount == 0)
    return eventsByIdentifier.values.sorted()
  }

  private mutating func applyCreate(
    _ request: CalendarBatchMutationProfilerDataset.CreateRequest
  ) -> (outcome: CalendarBatchMutationProfilerOutcome, didMutate: Bool) {
    guard !request.shouldFail else {
      return (
        CalendarBatchMutationProfilerOutcome(
          phase: .create,
          requestIdentifier: request.clientIdentifier,
          eventIdentifier: nil,
          status: .failed
        ),
        false
      )
    }

    let eventIdentifier = "created-event:\(request.clientIdentifier)"
    guard eventsByIdentifier[eventIdentifier] == nil else {
      return (
        CalendarBatchMutationProfilerOutcome(
          phase: .create,
          requestIdentifier: request.clientIdentifier,
          eventIdentifier: nil,
          status: .failed
        ),
        false
      )
    }

    eventsByIdentifier[eventIdentifier] = CalendarBatchMutationProfilerDataset.Event(
      identifier: eventIdentifier,
      title: request.title,
      startMilliseconds: request.startMilliseconds,
      endMilliseconds: request.endMilliseconds,
      location: request.location,
      notes: request.notes
    )
    return (
      CalendarBatchMutationProfilerOutcome(
        phase: .create,
        requestIdentifier: request.clientIdentifier,
        eventIdentifier: eventIdentifier,
        status: .created
      ),
      true
    )
  }

  private mutating func applyDelete(
    _ request: CalendarBatchMutationProfilerDataset.DeleteRequest
  ) -> (outcome: CalendarBatchMutationProfilerOutcome, didMutate: Bool) {
    guard !request.shouldFail else {
      return (
        CalendarBatchMutationProfilerOutcome(
          phase: .delete,
          requestIdentifier: request.requestIdentifier,
          eventIdentifier: request.eventIdentifier,
          status: .failed
        ),
        false
      )
    }

    guard eventsByIdentifier.removeValue(forKey: request.eventIdentifier) != nil else {
      return (
        CalendarBatchMutationProfilerOutcome(
          phase: .delete,
          requestIdentifier: request.requestIdentifier,
          eventIdentifier: request.eventIdentifier,
          status: .alreadyAbsent
        ),
        false
      )
    }

    return (
      CalendarBatchMutationProfilerOutcome(
        phase: .delete,
        requestIdentifier: request.requestIdentifier,
        eventIdentifier: request.eventIdentifier,
        status: .deleted
      ),
      true
    )
  }
}
