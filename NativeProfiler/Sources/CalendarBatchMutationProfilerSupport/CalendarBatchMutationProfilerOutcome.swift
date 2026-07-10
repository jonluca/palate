import Foundation

struct CalendarBatchMutationProfilerOutcome: Equatable, Sendable {
  enum Phase: String, Sendable {
    case create
    case delete
  }

  enum Status: String, Sendable {
    case alreadyAbsent
    case created
    case deleted
    case failed
  }

  let phase: Phase
  let requestIdentifier: String
  let eventIdentifier: String?
  let status: Status
}
