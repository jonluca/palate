import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matcher name normalization")
struct CalendarMatcherNameTests {
  @Test("Normalization handles accents, emoji, apostrophes, and ampersands")
  func normalizationParity() {
    #expect(CalendarNameNormalizer.normalize("  Café 🍣 Joe’s & Bar  ") == "cafe joes and bar")
    #expect(CalendarNameNormalizer.normalize("Foo\u{FEFF}Bar") == "foo bar")
  }

  @Test("Plain ASCII names retain case, spacing, and punctuation normalization")
  func asciiNormalization() {
    #expect(CalendarNameNormalizer.normalize("Le Bernardin") == "le bernardin")
    #expect(CalendarNameNormalizer.normalize("SUSHI_42") == "sushi_42")
    #expect(CalendarNameNormalizer.normalize("  Eleven  Madison Park  ") == "eleven madison park")
    #expect(CalendarNameNormalizer.normalize("") == "")
    #expect(CalendarNameNormalizer.normalize("   ") == "")

    for value in UInt8(0)...UInt8(127) {
      let character = String(UnicodeScalar(value))
      let expected: String
      switch value {
      case 65...90, 97...122, 48...57, 95:
        expected = "foo" + character.lowercased() + "bar"
      case 38:
        expected = "foo and bar"
      case 39, 96:
        expected = "foobar"
      default:
        expected = "foo bar"
      }
      #expect(CalendarNameNormalizer.normalize("FoO" + character + "BaR") == expected)
    }
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

  @Test("Dash normalization can expose reservation wrappers for the second cleaning pass")
  func dashSeparatedTitleWrappers() {
    #expect(CalendarTitleCleaner.cleanEventTitle("Dinner—at Lilia") == "Lilia")
    #expect(CalendarTitleCleaner.cleanEventTitle("— Dinner at Lilia —") == "Lilia")
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
