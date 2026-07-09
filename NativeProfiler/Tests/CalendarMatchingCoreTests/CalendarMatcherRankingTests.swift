import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matcher ranking")
struct CalendarMatcherRankingTests {
  @Test("Scoring includes reservation, metadata, proximity, and duration signals")
  func scoringSignals() {
    let event = CalendarMatchingTestFixtures.event(
      id: "reservation",
      title: "Dinner reservation",
      notes: "Table for two",
      location: "123 Main Street",
      startDateMs: 1_000,
      endDateMs: 2_000
    )

    #expect(
      CalendarMatchingEventEvaluator.score(
        event,
        visitStartMs: 1_000,
        visitEndMs: 2_000
      ) == 395
    )
  }

  @Test("Equal score and time preserve original event order")
  func stableTies() {
    let firstInInput = CalendarMatchingTestFixtures.event(id: "input-first")
    let secondInInput = CalendarMatchingTestFixtures.event(id: "input-second")

    let match = CalendarMatcher.match(
      visits: [CalendarMatchingTestFixtures.visit()],
      events: [firstInInput, secondInInput],
      bufferMilliseconds: 0
    ).first

    #expect(match?.event.id == "input-first")
  }

  @Test("An exact restaurant match wins before a higher-ranked fuzzy match")
  func exactBeforeFuzzy() {
    let restaurant = CalendarMatchingRestaurant(id: "blue-cedar", name: "Blue Cedar")
    let visit = CalendarMatchingTestFixtures.visit(suggestedRestaurants: [restaurant])
    let higherRankedFuzzy = CalendarMatchingTestFixtures.event(
      id: "fuzzy",
      title: "Blue Cedar Downtown",
      notes: "Reservation details",
      location: "123 Main Street"
    )
    let lowerRankedExact = CalendarMatchingTestFixtures.event(
      id: "exact",
      title: "Blue Cedar"
    )

    let match = CalendarMatcher.match(
      visits: [visit],
      events: [higherRankedFuzzy, lowerRankedExact],
      bufferMilliseconds: 0
    ).first

    #expect(match?.event.id == "exact")
    #expect(match?.suggestedRestaurantId == restaurant.id)
  }

  @Test("No restaurant match falls back to the highest-ranked event")
  func fallbackToTopEvent() {
    let unrelatedRestaurant = CalendarMatchingRestaurant(id: "other", name: "Unrelated Venue")
    let visit = CalendarMatchingTestFixtures.visit(suggestedRestaurants: [unrelatedRestaurant])
    let lowerRanked = CalendarMatchingTestFixtures.event(id: "lower", title: "Project Sync")
    let higherRanked = CalendarMatchingTestFixtures.event(
      id: "higher",
      title: "Dinner reservation",
      notes: "Table for two",
      location: "123 Main Street"
    )

    let match = CalendarMatcher.match(
      visits: [visit],
      events: [lowerRanked, higherRanked],
      bufferMilliseconds: 0
    ).first

    #expect(match?.event.id == "higher")
    #expect(match?.suggestedRestaurantId == nil)
  }
}
