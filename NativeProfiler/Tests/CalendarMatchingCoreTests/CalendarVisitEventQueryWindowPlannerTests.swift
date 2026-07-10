import Testing

@testable import CalendarMatchingCore

@Suite("Sparse Calendar EventKit query windows")
struct CalendarVisitEventQueryWindowPlannerTests {
  private struct EventIdentity: Hashable {
    let id: String
    let startDateMs: Double
    let endDateMs: Double
  }

  @Test("Empty visit input produces no EventKit queries")
  func emptyInput() throws {
    #expect(
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [],
        bufferMilliseconds: 1_000,
        coalescingGapMilliseconds: 1_000
      ).isEmpty
    )
  }

  @Test("Unordered and duplicate visits produce deterministic unique intervals")
  func unorderedDuplicateVisits() throws {
    let visits = [
      visit(id: "third", start: 300, end: 350),
      visit(id: "duplicate-b", start: 100, end: 150),
      visit(id: "second", start: 200, end: 250),
      visit(id: "duplicate-a", start: 100, end: 150),
    ]

    #expect(
      try windows(visits, gap: 0) == [
        window(start: 100, end: 150),
        window(start: 200, end: 250),
        window(start: 300, end: 350),
      ]
    )
    #expect(try windows(visits.reversed(), gap: 0) == windows(visits, gap: 0))
  }

  @Test("Overlapping and adjacent buffered intervals coalesce")
  func overlapAndAdjacency() throws {
    let visits = [
      visit(id: "overlap-a", start: 100, end: 200),
      visit(id: "overlap-b", start: 150, end: 250),
      visit(id: "adjacent", start: 250, end: 300),
    ]

    #expect(try windows(visits, gap: 0) == [window(start: 100, end: 300)])
  }

  @Test("Gaps below and at the threshold coalesce but a gap above it does not")
  func coalescingThreshold() throws {
    let visits = [
      visit(id: "first", start: 0, end: 10),
      visit(id: "below", start: 19, end: 20),
      visit(id: "at", start: 30, end: 40),
      visit(id: "above", start: 51, end: 60),
    ]

    #expect(
      try windows(visits, gap: 10) == [
        window(start: 0, end: 40),
        window(start: 51, end: 60),
      ]
    )
  }

  @Test("Zero-duration visits retain an exact point window before buffering")
  func zeroDuration() throws {
    let pointVisit = visit(id: "point", start: 100, end: 100)

    #expect(try windows([pointVisit], gap: 0) == [window(start: 100, end: 100)])
    #expect(
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [pointVisit],
        bufferMilliseconds: 25,
        coalescingGapMilliseconds: 0
      ) == [window(start: 75, end: 125)]
    )
  }

  @Test("Exact TimeClip boundaries are supported")
  func exactTimeClipBoundaries() throws {
    let maximum = CalendarMatchingTimestamp.maximumAbsoluteMilliseconds
    let lower = visit(id: "lower", start: -maximum + 10, end: -maximum + 20)
    let upper = visit(id: "upper", start: maximum - 20, end: maximum - 10)

    #expect(
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [lower],
        bufferMilliseconds: 10,
        coalescingGapMilliseconds: 0
      ) == [window(start: -maximum, end: -maximum + 30)]
    )
    #expect(
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [upper],
        bufferMilliseconds: 10,
        coalescingGapMilliseconds: 0
      ) == [window(start: maximum - 30, end: maximum)]
    )
  }

  @Test("Buffer expansion beyond either TimeClip boundary throws a focused error")
  func timeClipOverflow() {
    let maximum = CalendarMatchingTimestamp.maximumAbsoluteMilliseconds

    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.bufferedStartOutsideSupportedRange(
        visitID: "lower"
      )
    ) {
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [visit(id: "lower", start: -maximum, end: -maximum)],
        bufferMilliseconds: 0.5,
        coalescingGapMilliseconds: 0
      )
    }
    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.bufferedEndOutsideSupportedRange(
        visitID: "upper"
      )
    ) {
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [visit(id: "upper", start: maximum, end: maximum)],
        bufferMilliseconds: 0.5,
        coalescingGapMilliseconds: 0
      )
    }
  }

  @Test("Merged histories are split below EventKit's maximum predicate duration")
  func longRangeSplitting() throws {
    let maximum = CalendarEventQueryWindowPlanner.maximumWindowMilliseconds
    let start = 1_700_000_000_000.0
    let end = start + maximum * 2.5
    let planned = try windows([visit(id: "long", start: start, end: end)], gap: 0)

    #expect(planned.count == 3)
    #expect(planned.first?.startDateMs == start)
    #expect(planned.last?.endDateMs == end)
    #expect(planned.allSatisfy { $0.endDateMs - $0.startDateMs <= maximum })
    #expect(
      zip(planned, planned.dropFirst()).allSatisfy { previous, next in
        previous.endDateMs == next.startDateMs
      }
    )
  }

  @Test("Every buffered visit interval is completely covered by the planned windows")
  func completeBufferedCoverage() throws {
    let buffer = 50.0
    let maximum = CalendarEventQueryWindowPlanner.maximumWindowMilliseconds
    let visits = [
      visit(id: "late", start: 10_000, end: 10_200),
      visit(id: "early", start: 1_000, end: 1_000),
      visit(id: "overlap", start: 1_040, end: 1_300),
      visit(id: "long", start: 20_000, end: 20_000 + maximum * 1.5),
    ]
    let planned = try CalendarVisitEventQueryWindowPlanner.windows(
      visits: visits,
      bufferMilliseconds: buffer,
      coalescingGapMilliseconds: 100
    )

    for visit in visits {
      #expect(
        covers(
          start: visit.startTimeMs - buffer,
          end: visit.endTimeMs + buffer,
          with: planned
        )
      )
    }
  }

  @Test("Sparse EventKit-style fetching preserves broad matches and stable event ordering")
  func sparseMatcherParity() throws {
    let buffer = 10_000.0
    let restaurant = CalendarMatchingRestaurant(id: "blue-cedar", name: "Blue Cedar")
    let visits = [
      CalendarMatchingTestFixtures.visit(
        id: "first-visit",
        startTimeMs: 1_000_000,
        endTimeMs: 1_100_000,
        suggestedRestaurants: [restaurant]
      ),
      visit(id: "second-visit", start: 100_000_000, end: 100_100_000),
      visit(id: "tie-visit", start: 200_000_000, end: 200_100_000),
    ]
    let events = [
      event(id: "long-cross-window", title: "Project Workshop", start: 1_050_000, end: 200_050_000),
      event(id: "exact-blue", title: "Dinner at Blue Cedar", start: 1_020_000, end: 1_080_000),
      event(id: "before-strict-boundary", title: "Dinner Before", start: 900_000, end: 990_000),
      event(id: "after-strict-boundary", title: "Dinner After", start: 1_110_000, end: 1_120_000),
      event(id: "irrelevant-gap", title: "Dinner in Gap", start: 50_000_000, end: 50_100_000),
      event(id: "second-dinner", title: "Dinner at Harbor", start: 100_020_000, end: 100_080_000),
      event(id: "tie-first", title: "Team Sync", start: 200_020_000, end: 200_080_000),
      event(id: "tie-second", title: "Team Sync", start: 200_020_000, end: 200_080_000),
    ]

    let broadWindows = CalendarEventQueryWindowPlanner.windows(
      startDateMs: visits.map(\.startTimeMs).min()! - buffer,
      endDateMs: visits.map(\.endTimeMs).max()! + buffer
    )
    let sparseWindows = try CalendarVisitEventQueryWindowPlanner.windows(
      visits: visits,
      bufferMilliseconds: buffer,
      coalescingGapMilliseconds: 0
    )
    let broadEvents = eventStoreOrderedEvents(events, matching: broadWindows)
    let sparseEvents = eventStoreOrderedEvents(events, matching: sparseWindows)

    #expect(sparseWindows.count == 3)
    #expect(sparseEvents.count < broadEvents.count)
    #expect(sparseEvents.filter { $0.id == "long-cross-window" }.count == 1)
    #expect(!sparseEvents.contains { $0.id == "irrelevant-gap" })

    let broadMatches = CalendarMatcher.matchEligibleEvents(
      visits: visits,
      events: broadEvents,
      bufferMilliseconds: buffer
    )
    let sparseMatches = CalendarMatcher.matchEligibleEvents(
      visits: visits,
      events: sparseEvents,
      bufferMilliseconds: buffer
    )

    #expect(sparseMatches == broadMatches)
    #expect(sparseMatches.map { $0.event.id } == ["exact-blue", "second-dinner", "tie-first"])
    #expect(sparseMatches.map(\.suggestedRestaurantId) == ["blue-cedar", nil, nil])
  }

  @Test("Split query composition is invariant to reversed EventKit batch order")
  func splitQueryCompositionIgnoresBatchOrder() throws {
    let buffer = 10_000.0
    let visits = [
      visit(id: "first-visit", start: 1_000_000, end: 1_100_000),
      visit(id: "tie-visit", start: 100_000_000, end: 100_100_000),
    ]
    let events = [
      event(id: "z-event", title: "Team Sync", start: 100_020_000, end: 100_080_000),
      event(id: "a-event", title: "Team Sync", start: 100_020_000, end: 100_080_000),
      event(
        id: "long-cross-window",
        title: "Project Workshop",
        start: 1_050_000,
        end: 100_050_000
      ),
    ]
    let broadWindows = CalendarEventQueryWindowPlanner.windows(
      startDateMs: visits.map(\.startTimeMs).min()! - buffer,
      endDateMs: visits.map(\.endTimeMs).max()! + buffer
    )
    let splitWindows = try CalendarVisitEventQueryWindowPlanner.windows(
      visits: visits,
      bufferMilliseconds: buffer,
      coalescingGapMilliseconds: 0
    )

    let broadFetchOrder = eventStoreOrderedEvents(
      events,
      matching: broadWindows,
      canonicalize: false
    )
    let reversedSplitFetchOrder = eventStoreOrderedEvents(
      events,
      matching: splitWindows,
      reverseEachBatch: true,
      canonicalize: false
    )
    #expect(broadFetchOrder.map(\.id) != reversedSplitFetchOrder.map(\.id))
    #expect(
      CalendarMatcher.matchEligibleEvents(
        visits: visits,
        events: broadFetchOrder,
        bufferMilliseconds: buffer
      )
        == CalendarMatcher.matchEligibleEvents(
          visits: visits,
          events: reversedSplitFetchOrder,
          bufferMilliseconds: buffer
        )
    )

    let broadEvents = eventStoreOrderedEvents(events, matching: broadWindows)
    let splitEvents = eventStoreOrderedEvents(
      events,
      matching: splitWindows,
      reverseEachBatch: true
    )
    #expect(broadEvents == splitEvents)

    let broadMatches = CalendarMatcher.matchEligibleEvents(
      visits: visits,
      events: broadEvents,
      bufferMilliseconds: buffer
    )
    let splitMatches = CalendarMatcher.matchEligibleEvents(
      visits: visits,
      events: splitEvents,
      bufferMilliseconds: buffer
    )
    #expect(splitMatches == broadMatches)
    #expect(splitMatches.map { $0.event.id } == ["long-cross-window", "a-event"])
  }

  @Test("Invalid configuration and unvalidated visits throw")
  func invalidInputs() {
    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.invalidBufferMilliseconds(-1)
    ) {
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [],
        bufferMilliseconds: -1,
        coalescingGapMilliseconds: 0
      )
    }
    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.invalidCoalescingGapMilliseconds(
        .infinity
      )
    ) {
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [],
        bufferMilliseconds: 0,
        coalescingGapMilliseconds: .infinity
      )
    }
    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.invalidCoalescingGapMilliseconds(-1)
    ) {
      try CalendarVisitEventQueryWindowPlanner.windows(
        visits: [],
        bufferMilliseconds: 0,
        coalescingGapMilliseconds: -1
      )
    }
    #expect(
      throws: CalendarVisitEventQueryWindowPlannerError.invalidVisitRange(
        visitID: "reversed",
        startTimeMs: 2,
        endTimeMs: 1
      )
    ) {
      try windows([visit(id: "reversed", start: 2, end: 1)], gap: 0)
    }
  }

  private func visit(id: String, start: Double, end: Double) -> CalendarMatchingVisit {
    CalendarMatchingTestFixtures.visit(id: id, startTimeMs: start, endTimeMs: end)
  }

  private func window(start: Double, end: Double) -> CalendarEventQueryWindow {
    CalendarEventQueryWindow(startDateMs: start, endDateMs: end)
  }

  private func event(
    id: String,
    title: String,
    start: Double,
    end: Double
  ) -> CalendarMatchingEvent {
    CalendarMatchingTestFixtures.event(
      id: id,
      title: title,
      startDateMs: start,
      endDateMs: end
    )
  }

  private func windows<S: Sequence>(
    _ visits: S,
    gap: Double
  ) throws -> [CalendarEventQueryWindow] where S.Element == CalendarMatchingVisit {
    try CalendarVisitEventQueryWindowPlanner.windows(
      visits: Array(visits),
      bufferMilliseconds: 0,
      coalescingGapMilliseconds: gap
    )
  }

  private func covers(
    start: Double,
    end: Double,
    with windows: [CalendarEventQueryWindow]
  ) -> Bool {
    var coveredThrough = start
    var foundStart = false
    for window in windows {
      if window.endDateMs < coveredThrough || window.startDateMs > coveredThrough {
        continue
      }
      foundStart = true
      coveredThrough = max(coveredThrough, window.endDateMs)
      if coveredThrough >= end {
        return true
      }
    }
    return foundStart && coveredThrough >= end
  }

  private func eventStoreOrderedEvents(
    _ events: [CalendarMatchingEvent],
    matching windows: [CalendarEventQueryWindow],
    reverseEachBatch: Bool = false,
    canonicalize: Bool = true
  ) -> [CalendarMatchingEvent] {
    var seenEvents: Set<EventIdentity> = []
    var composedEvents: [CalendarMatchingEvent] = []

    for window in windows {
      let matchingEvents = events.filter { event in
        event.startDateMs < window.endDateMs && event.endDateMs > window.startDateMs
      }
      let batch = reverseEachBatch ? Array(matchingEvents.reversed()) : matchingEvents
      for event in batch {
        let identity = EventIdentity(
          id: event.id,
          startDateMs: event.startDateMs,
          endDateMs: event.endDateMs
        )
        guard seenEvents.insert(identity).inserted else {
          continue
        }
        composedEvents.append(event)
      }
    }

    guard canonicalize else {
      return composedEvents
    }
    return composedEvents.sorted { first, second in
      if first.startDateMs != second.startDateMs {
        return first.startDateMs < second.startDateMs
      }
      if first.endDateMs != second.endDateMs {
        return first.endDateMs < second.endDateMs
      }
      return first.id < second.id
    }
  }
}
