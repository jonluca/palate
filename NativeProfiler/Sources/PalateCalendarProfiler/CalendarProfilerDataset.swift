import CalendarMatchingCore
import Foundation

struct CalendarProfilerDataset: Sendable {
  static let seed: UInt64 = 0xCA1E_4D4A_7C11_2026
  static let bufferMilliseconds = 30 * 60 * 1_000.0

  let visits: [CalendarMatchingVisit]
  let events: [CalendarMatchingEvent]
  let restaurantCount: Int
  let coverageCases: [String]

  static func generate(visitCount: Int, eventCount: Int) -> CalendarProfilerDataset {
    var random = SeededCalendarProfilerRandomNumberGenerator(seed: seed)
    let baseTime = 1_700_000_000_000.0
    var selectedCoverage: [CalendarProfilerCoverageFixture] = []
    var coverageEventCount = 0
    for fixture in CalendarProfilerCoverageFixture.all(baseTime: baseTime) {
      guard selectedCoverage.count < visitCount,
        coverageEventCount + fixture.events.count <= eventCount
      else {
        break
      }
      selectedCoverage.append(fixture)
      coverageEventCount += fixture.events.count
    }

    let bulkVisitCount = visitCount - selectedCoverage.count
    let bulkRestaurantCount = max(1, bulkVisitCount / 5)
    let bulkRestaurants = (0..<bulkRestaurantCount).map { index in
      CalendarMatchingRestaurant(
        id: "restaurant-\(index)",
        name: String(format: "Venue Alpha %06d", index)
      )
    }
    let bulkBaseTime = baseTime + 12 * 24 * 60 * 60 * 1_000
    let visitSpacing = 45 * 60 * 1_000.0
    let visitDuration = 90 * 60 * 1_000.0
    let bulkVisits = (0..<bulkVisitCount).map { index in
      let start = bulkBaseTime + Double(index) * visitSpacing
      return CalendarMatchingVisit(
        id: "visit-\(index)",
        startTimeMs: start,
        endTimeMs: start + visitDuration,
        suggestedRestaurants: index.isMultiple(of: 11)
          ? [bulkRestaurants[index % bulkRestaurantCount]] : []
      )
    }

    let remainingEventCount = eventCount - coverageEventCount
    var bulkEvents: [CalendarMatchingEvent] = []
    bulkEvents.reserveCapacity(remainingEventCount)
    let exactEventCount = min(bulkVisitCount, remainingEventCount)
    for index in 0..<exactEventCount {
      let visit = bulkVisits[index]
      let restaurant = bulkRestaurants[index % bulkRestaurantCount]
      let jitterMinutes = random.integer(upperBound: 21) - 10
      let durationMinutes = 60 + random.integer(upperBound: 121)
      let start = visit.startTimeMs + Double(jitterMinutes) * 60_000
      bulkEvents.append(
        CalendarMatchingEvent(
          id: "exact-event-\(index)",
          title: restaurant.name,
          notes: index.isMultiple(of: 4) ? "Imported note" : nil,
          location: location(for: index),
          startDateMs: start,
          endDateMs: start + Double(durationMinutes) * 60_000,
          isAllDay: false,
          calendarTitle: "Synthetic Reservations"
        )
      )
    }

    let timelineStart = bulkBaseTime - 6 * 60 * 60 * 1_000
    let timelineSpan = max(1, bulkVisitCount) * Int(visitSpacing) + 12 * 60 * 60 * 1_000
    for index in exactEventCount..<remainingEventCount {
      let startOffset = random.integer(upperBound: timelineSpan)
      let durationMinutes = 20 + random.integer(upperBound: 461)
      let start = timelineStart + Double(startOffset)
      bulkEvents.append(
        CalendarMatchingEvent(
          id: "background-event-\(index)",
          title: String(format: "Calendar Item %06d", index),
          notes: index.isMultiple(of: 7) ? "Imported note" : nil,
          location: location(for: index),
          startDateMs: start,
          endDateMs: start + Double(durationMinutes) * 60_000,
          isAllDay: false,
          calendarTitle: "Synthetic Calendar"
        )
      )
    }
    bulkEvents.shuffle(using: &random)

    let visits = selectedCoverage.map(\.visit) + bulkVisits
    let events = selectedCoverage.flatMap(\.events) + bulkEvents
    let restaurantIds = Set(
      visits.flatMap { visit in visit.suggestedRestaurants.map(\.id) }
    )
    return CalendarProfilerDataset(
      visits: visits,
      events: events,
      restaurantCount: restaurantIds.count,
      coverageCases: selectedCoverage.map(\.name)
    )
  }

  private static func location(for index: Int) -> String? {
    switch index % 3 {
    case 0:
      return "123 Main Street"
    case 1:
      return "https://example.com/event"
    default:
      return nil
    }
  }
}
