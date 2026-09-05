import ExpoModulesCore

@Record
struct CalendarVisitRecord {
  var id: String = ""
  var startTime: Double = 0
  var endTime: Double = 0
  var suggestedRestaurants: [CalendarSuggestedRestaurantRecord] = []

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
