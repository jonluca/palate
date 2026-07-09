import ExpoModulesCore

struct CalendarVisitMatchRecord: Record {
  @Field var visitId: String = ""
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var notes: String?
  @Field var location: String?
  @Field var startDate: Double = 0
  @Field var endDate: Double = 0
  @Field var isAllDay: Bool = false
  @Field var calendarTitle: String?
  @Field var suggestedRestaurantId: String?

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
