import ExpoModulesCore

struct CalendarVisitRecord: Record {
  @Field var id: String = ""
  @Field var startTime: Double = 0
  @Field var endTime: Double = 0
  @Field var suggestedRestaurants: [CalendarSuggestedRestaurantRecord] = []

  func validatedCoreVisit() throws -> CalendarMatchingVisit {
    guard CalendarMatchingTimestamp.isSupported(startTime),
      CalendarMatchingTimestamp.isSupported(endTime),
      endTime >= startTime
    else {
      throw CalendarMatchingModuleError.invalidVisitRange(
        id: id,
        startMs: startTime,
        endMs: endTime
      )
    }
    return CalendarMatchingVisit(
      id: id,
      startTimeMs: startTime,
      endTimeMs: endTime,
      suggestedRestaurants: suggestedRestaurants.map(\.coreRestaurant)
    )
  }
}
