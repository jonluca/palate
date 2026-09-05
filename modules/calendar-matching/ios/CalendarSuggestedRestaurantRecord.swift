import ExpoModulesCore

@Record
struct CalendarSuggestedRestaurantRecord {
  var id: String = ""
  var name: String = ""

  var coreRestaurant: CalendarMatchingRestaurant {
    CalendarMatchingRestaurant(id: id, name: name)
  }
}
