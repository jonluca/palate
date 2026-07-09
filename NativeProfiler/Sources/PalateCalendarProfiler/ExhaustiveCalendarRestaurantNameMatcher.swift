import Foundation

enum ExhaustiveCalendarRestaurantNameMatcher {
  private static let insignificantWords: Set<String> = [
    "the", "restaurant", "cafe", "café", "bar", "bistro", "kitchen", "grill", "house",
    "room", "place", "a", "an", "and", "&", "eatery", "dining", "tavern", "pub", "inn",
    "lounge", "spot", "joint", "diner", "at", "of", "in", "on", "for",
  ]

  static func isExactMatch(
    normalizedCalendar: String,
    cleanedRestaurant: String,
    normalizedRestaurant: String
  ) -> Bool {
    guard normalizedCalendar.utf16.count >= 3, normalizedRestaurant.utf16.count >= 3 else {
      return false
    }
    if normalizedCalendar == normalizedRestaurant {
      return true
    }
    return cleanedRestaurant.utf16.count >= 8
      && normalizedCalendar.split(separator: " ").contains { $0 == normalizedRestaurant }
  }

  static func isFuzzyMatch(
    normalizedFirst: String,
    normalizedSecond: String,
    threshold: Int = 3
  ) -> Bool {
    guard normalizedFirst.utf16.count >= threshold,
      normalizedSecond.utf16.count >= threshold
    else {
      return false
    }
    if normalizedFirst == normalizedSecond || normalizedFirst.contains(normalizedSecond)
      || normalizedSecond.contains(normalizedFirst)
    {
      return true
    }

    let firstWords = significantWords(in: normalizedFirst)
    let secondWords = significantWords(in: normalizedSecond)
    if !firstWords.isEmpty,
      firstWords.count <= 2,
      firstWords.allSatisfy({ normalizedSecond.contains($0) })
    {
      return true
    }
    if !secondWords.isEmpty,
      secondWords.count <= 2,
      secondWords.allSatisfy({ normalizedFirst.contains($0) })
    {
      return true
    }
    return false
  }

  private static func significantWords(in value: String) -> [String] {
    value
      .split(separator: " ")
      .map(String.init)
      .filter { $0.utf16.count > 1 && !insignificantWords.contains($0) }
  }
}
