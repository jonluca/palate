import Foundation

public struct CalendarVisitMatch: Equatable, Sendable {
  public let visitId: String
  public let event: CalendarMatchingEvent
  public let suggestedRestaurantId: String?

  public init(
    visitId: String,
    event: CalendarMatchingEvent,
    suggestedRestaurantId: String?
  ) {
    self.visitId = visitId
    self.event = event
    self.suggestedRestaurantId = suggestedRestaurantId
  }
}
