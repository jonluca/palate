import Foundation

public struct CalendarEventKitMutationProfilerEventSnapshot: Equatable, Sendable {
  public let eventIdentifier: String
  public let semanticEvent: CalendarEventKitMutationProfilerSemanticEvent

  public init(
    eventIdentifier: String,
    semanticEvent: CalendarEventKitMutationProfilerSemanticEvent
  ) {
    self.eventIdentifier = eventIdentifier
    self.semanticEvent = semanticEvent
  }
}
