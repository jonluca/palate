import CalendarMatchingCore
import Foundation

struct CalendarProfilerCoverageFixture: Sendable {
  let name: String
  let visit: CalendarMatchingVisit
  let events: [CalendarMatchingEvent]

  static func all(baseTime: Double) -> [CalendarProfilerCoverageFixture] {
    let normalizedRestaurant = CalendarMatchingRestaurant(
      id: "coverage-normalized-restaurant",
      name: "Cafe DAngelo and Sons"
    )
    let exactPreferenceRestaurant = CalendarMatchingRestaurant(
      id: "coverage-exact-preference-restaurant",
      name: "Blue Cedar"
    )
    let fuzzyRestaurant = CalendarMatchingRestaurant(
      id: "coverage-fuzzy-restaurant",
      name: "North Pond"
    )
    let unrelatedRestaurant = CalendarMatchingRestaurant(
      id: "coverage-unrelated-restaurant",
      name: "Unrelated Venue"
    )
    let iterativeRestaurant = CalendarMatchingRestaurant(
      id: "coverage-iterative-restaurant",
      name: "Lilia"
    )

    let normalizedVisit = visit(
      id: "coverage-normalized-exact",
      index: 0,
      baseTime: baseTime,
      restaurants: [normalizedRestaurant]
    )
    let exactPreferenceVisit = visit(
      id: "coverage-exact-before-fuzzy",
      index: 1,
      baseTime: baseTime,
      restaurants: [exactPreferenceRestaurant]
    )
    let fuzzyVisit = visit(
      id: "coverage-fuzzy",
      index: 2,
      baseTime: baseTime,
      restaurants: [fuzzyRestaurant]
    )
    let fallbackVisit = visit(
      id: "coverage-fallback",
      index: 3,
      baseTime: baseTime,
      restaurants: [unrelatedRestaurant]
    )
    let domainVisit = visit(id: "coverage-bare-domain", index: 4, baseTime: baseTime)
    let boundaryVisit = visit(id: "coverage-strict-boundaries", index: 5, baseTime: baseTime)
    let stableTieVisit = visit(id: "coverage-stable-ties", index: 6, baseTime: baseTime)
    let eligibilityVisit = visit(id: "coverage-eligibility", index: 7, baseTime: baseTime)
    let iterativeVisit = visit(
      id: "coverage-iterative-cleaning",
      index: 8,
      baseTime: baseTime,
      restaurants: [iterativeRestaurant]
    )

    return [
      CalendarProfilerCoverageFixture(
        name: "cleaned-normalized-exact",
        visit: normalizedVisit,
        events: [
          event(
            id: "coverage-normalized-exact-event",
            title: "🍽 Dinner at Café D’Angelo & Sons (4 guests)",
            visit: normalizedVisit
          ),
          event(id: "coverage-normalized-fallback", title: "Team Sync", visit: normalizedVisit),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "exact-before-fuzzy",
        visit: exactPreferenceVisit,
        events: [
          event(
            id: "coverage-higher-ranked-fuzzy",
            title: "Dinner at Blue Cedar Downtown",
            notes: "Imported note",
            location: "123 Main Street",
            visit: exactPreferenceVisit
          ),
          event(
            id: "coverage-lower-ranked-exact",
            title: "Blue Cedar",
            visit: exactPreferenceVisit
          ),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "fuzzy-only",
        visit: fuzzyVisit,
        events: [
          event(
            id: "coverage-higher-ranked-unrelated",
            title: "Dinner reservation",
            location: "123 Main Street",
            visit: fuzzyVisit
          ),
          event(
            id: "coverage-fuzzy-match",
            title: "North Pond Tasting Menu",
            visit: fuzzyVisit
          ),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "reservation-score-fallback",
        visit: fallbackVisit,
        events: [
          event(id: "coverage-low-score", title: "Project Sync", visit: fallbackVisit),
          event(
            id: "coverage-reservation-score",
            title: "Dinner reservation",
            notes: "Imported note",
            location: "123 Main Street",
            visit: fallbackVisit
          ),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "bare-domain-url-score",
        visit: domainVisit,
        events: [
          event(
            id: "coverage-bare-domain",
            title: "Planning Session",
            location: "example.com/details",
            visit: domainVisit
          ),
          event(
            id: "coverage-street-address",
            title: "Planning Session",
            location: "123 Main Street",
            visit: domainVisit
          ),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "strict-overlap-boundaries",
        visit: boundaryVisit,
        events: [
          CalendarMatchingEvent(
            id: "coverage-before-boundary",
            title: "Dinner reservation",
            notes: nil,
            location: nil,
            startDateMs: boundaryVisit.startTimeMs - 2 * 60 * 60 * 1_000,
            endDateMs: boundaryVisit.startTimeMs - CalendarProfilerDataset.bufferMilliseconds,
            isAllDay: false,
            calendarTitle: "Coverage"
          ),
          CalendarMatchingEvent(
            id: "coverage-after-boundary",
            title: "Dinner reservation",
            notes: nil,
            location: nil,
            startDateMs: boundaryVisit.endTimeMs + CalendarProfilerDataset.bufferMilliseconds,
            endDateMs: boundaryVisit.endTimeMs + 2 * 60 * 60 * 1_000,
            isAllDay: false,
            calendarTitle: "Coverage"
          ),
          CalendarMatchingEvent(
            id: "coverage-inside-boundary",
            title: "Inside Boundary",
            notes: nil,
            location: nil,
            startDateMs: boundaryVisit.startTimeMs - 60 * 60 * 1_000,
            endDateMs:
              boundaryVisit.startTimeMs - CalendarProfilerDataset.bufferMilliseconds + 1,
            isAllDay: false,
            calendarTitle: "Coverage"
          ),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "stable-score-time-ties",
        visit: stableTieVisit,
        events: [
          event(id: "coverage-stable-first", title: "Planning Session", visit: stableTieVisit),
          event(id: "coverage-stable-second", title: "Planning Session", visit: stableTieVisit),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "travel-lodging-all-day-eligibility",
        visit: eligibilityVisit,
        events: [
          event(
            id: "coverage-travel-invalid",
            title: "✈️ Dinner reservation",
            notes: "Imported note",
            location: "123 Main Street",
            visit: eligibilityVisit
          ),
          event(
            id: "coverage-lodging-invalid",
            title: "Airbnb Check-in dinner",
            notes: "Imported note",
            location: "123 Main Street",
            visit: eligibilityVisit
          ),
          event(
            id: "coverage-all-day-invalid",
            title: "Dinner reservation",
            notes: "Imported note",
            location: "123 Main Street",
            visit: eligibilityVisit,
            isAllDay: true
          ),
          event(id: "coverage-eligible", title: "Team Sync", visit: eligibilityVisit),
        ]
      ),
      CalendarProfilerCoverageFixture(
        name: "iterative-title-cleaning",
        visit: iterativeVisit,
        events: [
          event(
            id: "coverage-iterative-exact",
            title: "Reminder: Reservation at Resy: Dinner at Lilia (4 guests)",
            visit: iterativeVisit
          ),
          event(id: "coverage-iterative-fallback", title: "Team Sync", visit: iterativeVisit),
        ]
      ),
    ]
  }

  private static func visit(
    id: String,
    index: Int,
    baseTime: Double,
    restaurants: [CalendarMatchingRestaurant] = []
  ) -> CalendarMatchingVisit {
    let start = baseTime + Double(index) * 24 * 60 * 60 * 1_000
    return CalendarMatchingVisit(
      id: id,
      startTimeMs: start,
      endTimeMs: start + 60 * 60 * 1_000,
      suggestedRestaurants: restaurants
    )
  }

  private static func event(
    id: String,
    title: String,
    notes: String? = nil,
    location: String? = nil,
    visit: CalendarMatchingVisit,
    isAllDay: Bool = false
  ) -> CalendarMatchingEvent {
    CalendarMatchingEvent(
      id: id,
      title: title,
      notes: notes,
      location: location,
      startDateMs: visit.startTimeMs + 10 * 60 * 1_000,
      endDateMs: visit.startTimeMs + 50 * 60 * 1_000,
      isAllDay: isAllDay,
      calendarTitle: "Coverage"
    )
  }
}
