import Foundation

public struct CalendarMatchingEvent: Equatable, Sendable {
  public let id: String
  public let title: String
  public let notes: String?
  public let location: String?
  public let startDateMs: Double
  public let endDateMs: Double
  public let isAllDay: Bool
  public let calendarTitle: String?

  public init(
    id: String,
    title: String,
    notes: String?,
    location: String?,
    startDateMs: Double,
    endDateMs: Double,
    isAllDay: Bool,
    calendarTitle: String?
  ) {
    self.id = id
    self.title = title
    self.notes = notes
    self.location = location
    self.startDateMs = startDateMs
    self.endDateMs = endDateMs
    self.isAllDay = isAllDay
    self.calendarTitle = calendarTitle
  }
}
