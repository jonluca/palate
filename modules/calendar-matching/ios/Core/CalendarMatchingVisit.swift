import Foundation

public struct CalendarMatchingVisit: Equatable, Sendable {
  public let id: String
  public let startTimeMs: Double
  public let endTimeMs: Double
  public let suggestedRestaurants: [CalendarMatchingRestaurant]

  public init(
    id: String,
    startTimeMs: Double,
    endTimeMs: Double,
    suggestedRestaurants: [CalendarMatchingRestaurant]
  ) {
    self.id = id
    self.startTimeMs = startTimeMs
    self.endTimeMs = endTimeMs
    self.suggestedRestaurants = suggestedRestaurants
  }
}
