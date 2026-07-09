import CalendarMatchingCore

enum CalendarMatchingTestFixtures {
  static func event(
    id: String,
    title: String = "Team Sync",
    notes: String? = nil,
    location: String? = nil,
    startDateMs: Double = 1_200,
    endDateMs: Double = 1_800,
    isAllDay: Bool = false
  ) -> CalendarMatchingEvent {
    CalendarMatchingEvent(
      id: id,
      title: title,
      notes: notes,
      location: location,
      startDateMs: startDateMs,
      endDateMs: endDateMs,
      isAllDay: isAllDay,
      calendarTitle: "Test Calendar"
    )
  }

  static func visit(
    id: String = "visit",
    startTimeMs: Double = 1_000,
    endTimeMs: Double = 2_000,
    suggestedRestaurants: [CalendarMatchingRestaurant] = []
  ) -> CalendarMatchingVisit {
    CalendarMatchingVisit(
      id: id,
      startTimeMs: startTimeMs,
      endTimeMs: endTimeMs,
      suggestedRestaurants: suggestedRestaurants
    )
  }

  static func match(
    event: CalendarMatchingEvent,
    visit: CalendarMatchingVisit = visit(),
    bufferMilliseconds: Double = 0
  ) -> CalendarVisitMatch? {
    CalendarMatcher.match(
      visits: [visit],
      events: [event],
      bufferMilliseconds: bufferMilliseconds
    ).first
  }
}
