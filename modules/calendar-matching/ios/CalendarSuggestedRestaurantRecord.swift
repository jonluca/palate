import ExpoModulesCore

struct CalendarSuggestedRestaurantRecord: Record {
  @Field var id: String = ""
  @Field var name: String = ""

  var coreRestaurant: CalendarMatchingRestaurant {
    CalendarMatchingRestaurant(id: id, name: name)
  }
}
