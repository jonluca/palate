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

  @Test("Equal score and time select the same event across every input permutation")
  func deterministicTies() {
    let first = CalendarMatchingTestFixtures.event(id: "a-event")
    let middle = CalendarMatchingTestFixtures.event(id: "m-event")
    let last = CalendarMatchingTestFixtures.event(id: "z-event")
    let permutations = [
      [first, middle, last],
      [first, last, middle],
      [middle, first, last],
      [middle, last, first],
      [last, first, middle],
      [last, middle, first],
    ]

    let selectedEventIDs = permutations.map { events in
      CalendarMatcher.match(
        visits: [CalendarMatchingTestFixtures.visit()],
        events: events,
        bufferMilliseconds: 0
      ).first?.event.id
    }

    #expect(selectedEventIDs == Array(repeating: "a-event", count: permutations.count))
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

  @Test("Suggestion-free selection matches the ranked fallback path")
  func suggestionFreeFastPathParity() {
    let unrelatedRestaurant = CalendarMatchingRestaurant(id: "other", name: "Unrelated Venue")
    let events = [
      CalendarMatchingTestFixtures.event(
        id: "outside",
        title: "Dinner reservation",
        startDateMs: 3_000,
        endDateMs: 4_000
      ),
      CalendarMatchingTestFixtures.event(
        id: "lower",
        title: "Project Sync",
        startDateMs: 1_100,
        endDateMs: 1_900
      ),
      CalendarMatchingTestFixtures.event(
        id: "winner",
        title: "Dinner reservation",
        notes: "Table for two",
        location: "123 Main Street",
        startDateMs: 1_200,
        endDateMs: 1_800
      ),
      CalendarMatchingTestFixtures.event(
        id: "equal-but-later",
        title: "Dinner reservation",
        notes: "Table for two",
        location: "123 Main Street",
        startDateMs: 1_300,
        endDateMs: 1_900
      ),
    ]
    let matches = CalendarMatcher.match(
      visits: [
        CalendarMatchingTestFixtures.visit(id: "fast"),
        CalendarMatchingTestFixtures.visit(
          id: "ranked",
          suggestedRestaurants: [unrelatedRestaurant]
        ),
      ],
      events: events,
      bufferMilliseconds: 0
    )

    #expect(matches.map(\.event.id) == ["winner", "winner"])
    #expect(matches.allSatisfy { $0.suggestedRestaurantId == nil })
  }
}
