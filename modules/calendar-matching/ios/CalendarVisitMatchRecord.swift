import ExpoModulesCore

@Record
struct CalendarVisitMatchRecord {
  var visitId: String = ""
  var id: String = ""
  var title: String = ""
  var notes: String?
  var location: String?
  var startDate: Double = 0
  var endDate: Double = 0
  var isAllDay: Bool = false
  var calendarTitle: String?
  var suggestedRestaurantId: String?

  init() {}

  init(match: CalendarVisitMatch) {
    visitId = match.visitId
    id = match.event.id
    title = match.event.title
    notes = match.event.notes
    location = match.event.location
    startDate = match.event.startDateMs
    endDate = match.event.endDateMs
    isAllDay = match.event.isAllDay
    calendarTitle = match.event.calendarTitle
    suggestedRestaurantId = match.suggestedRestaurantId
  }
}
