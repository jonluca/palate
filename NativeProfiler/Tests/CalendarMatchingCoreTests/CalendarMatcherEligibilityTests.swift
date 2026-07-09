import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matcher eligibility")
struct CalendarMatcherEligibilityTests {
  @Test("All-day, travel, lodging, and placeholder events are ineligible")
  func ineligibleEvents() {
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "all-day", isAllDay: true)
      )
    )
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "travel", title: "✈️ Flight to Paris")
      )
    )
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "lodging", title: "Airbnb Check-in")
      )
    )
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "placeholder", title: "Untitled Event")
      )
    )
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(
          id: "wrapped-placeholder", title: "\u{FEFF}custom\u{FEFF}")
      )
    )
    #expect(
      !CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "feff-check-in", title: "check\u{FEFF}in")
      )
    )
    #expect(
      CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "nel-check-in", title: "check\u{0085}in")
      )
    )
    #expect(
      CalendarMatchingEventEvaluator.isEligible(
        CalendarMatchingTestFixtures.event(id: "valid", title: "Dinner at Lilia")
      )
    )
  }

  @Test("Empty visits or events return no matches")
  func emptyInputs() {
    let visit = CalendarMatchingTestFixtures.visit()
    let event = CalendarMatchingTestFixtures.event(id: "event")

    #expect(CalendarMatcher.match(visits: [], events: [event]).isEmpty)
    #expect(CalendarMatcher.match(visits: [visit], events: []).isEmpty)
  }
}
