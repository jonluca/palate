import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matcher name normalization")
struct CalendarMatcherNameTests {
  @Test("Normalization handles accents, emoji, apostrophes, and ampersands")
  func normalizationParity() {
    #expect(CalendarNameNormalizer.normalize("  Café 🍣 Joe’s & Bar  ") == "cafe joes and bar")
    #expect(CalendarNameNormalizer.normalize("Foo\u{FEFF}Bar") == "foo bar")
  }

  @Test("Normalized calendar titles match equivalent restaurant spelling")
  func normalizedExactMatch() {
    let restaurant = CalendarMatchingRestaurant(
      id: "cafe-dangelo",
      name: "Cafe DAngelo and Sons"
    )
    let visit = CalendarMatchingTestFixtures.visit(suggestedRestaurants: [restaurant])
    let event = CalendarMatchingTestFixtures.event(
      id: "normalized",
      title: "🍽 Dinner at Café D’Angelo & Sons"
    )

    let match = CalendarMatchingTestFixtures.match(event: event, visit: visit)

    #expect(match?.event.id == event.id)
    #expect(match?.suggestedRestaurantId == restaurant.id)
  }

  @Test("Title cleaning repeatedly removes nested reservation wrappers")
  func iterativeTitleCleaning() {
    #expect(
      CalendarTitleCleaner.cleanEventTitle(
        "Reminder: Reservation at Resy: Dinner at Lilia (4 guests)"
      ) == "Lilia"
    )
  }

  @Test("Dash-delimited party sizes are removed before dash normalization")
  func dashDelimitedPartySize() {
    let title = "Le Bernardin - 2 people"
    let nonbreakingHyphenTitle = "Le Bernardin ‑ 2 people"

    #expect(CalendarTitleCleaner.cleanEventTitle(title) == "Le Bernardin")
    #expect(CalendarTitleCleaner.cleanEventTitle(nonbreakingHyphenTitle) == "Le Bernardin")
    #expect(
      CalendarRestaurantNameMatcher.isExactMatch(
        calendarTitle: title,
        restaurantName: "Le Bernardin"
      )
    )
    #expect(
      CalendarRestaurantNameMatcher.isExactMatch(
        calendarTitle: nonbreakingHyphenTitle,
        restaurantName: "Le Bernardin"
      )
    )
  }

  @Test("Comparison stripping repeatedly removes prefixes and descriptor suffixes")
  func iterativeComparisonStripping() {
    #expect(
      CalendarTitleCleaner.stripComparisonAffixes(
        "Reservation: The Restaurant: The Lilia Restaurant NYC"
      ) == "Lilia"
    )
  }
}
