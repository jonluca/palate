import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matcher overlap boundaries")
struct CalendarMatcherOverlapTests {
  @Test("Unbuffered overlap excludes events that only touch either boundary")
  func strictUnbufferedBoundaries() {
    let visit = CalendarMatchingTestFixtures.visit()
    let endingAtStart = CalendarMatchingTestFixtures.event(
      id: "ending-at-start",
      startDateMs: 500,
      endDateMs: visit.startTimeMs
    )
    let startingAtEnd = CalendarMatchingTestFixtures.event(
      id: "starting-at-end",
      startDateMs: visit.endTimeMs,
      endDateMs: 2_500
    )

    #expect(CalendarMatchingTestFixtures.match(event: endingAtStart, visit: visit) == nil)
    #expect(CalendarMatchingTestFixtures.match(event: startingAtEnd, visit: visit) == nil)

    let endingInside = CalendarMatchingTestFixtures.event(
      id: "ending-inside",
      startDateMs: 500,
      endDateMs: visit.startTimeMs + 1
    )
    let startingInside = CalendarMatchingTestFixtures.event(
      id: "starting-inside",
      startDateMs: visit.endTimeMs - 1,
      endDateMs: 2_500
    )

    #expect(
      CalendarMatchingTestFixtures.match(event: endingInside, visit: visit)?.event.id
        == "ending-inside")
    #expect(
      CalendarMatchingTestFixtures.match(event: startingInside, visit: visit)?.event.id
        == "starting-inside")
  }

  @Test("Buffered overlap remains strict at the expanded boundaries")
  func strictBufferedBoundaries() {
    let visit = CalendarMatchingTestFixtures.visit()
    let buffer = 100.0
    let endingAtBufferedStart = CalendarMatchingTestFixtures.event(
      id: "ending-at-buffered-start",
      startDateMs: 500,
      endDateMs: visit.startTimeMs - buffer
    )
    let startingAtBufferedEnd = CalendarMatchingTestFixtures.event(
      id: "starting-at-buffered-end",
      startDateMs: visit.endTimeMs + buffer,
      endDateMs: 2_500
    )

    #expect(
      CalendarMatchingTestFixtures.match(
        event: endingAtBufferedStart,
        visit: visit,
        bufferMilliseconds: buffer
      ) == nil
    )
    #expect(
      CalendarMatchingTestFixtures.match(
        event: startingAtBufferedEnd,
        visit: visit,
        bufferMilliseconds: buffer
      ) == nil
    )

    let endingInsideBuffer = CalendarMatchingTestFixtures.event(
      id: "ending-inside-buffer",
      startDateMs: 500,
      endDateMs: visit.startTimeMs - buffer + 1
    )
    let startingInsideBuffer = CalendarMatchingTestFixtures.event(
      id: "starting-inside-buffer",
      startDateMs: visit.endTimeMs + buffer - 1,
      endDateMs: 2_500
    )

    #expect(
      CalendarMatchingTestFixtures.match(
        event: endingInsideBuffer,
        visit: visit,
        bufferMilliseconds: buffer
      )?.event.id == "ending-inside-buffer"
    )
    #expect(
      CalendarMatchingTestFixtures.match(
        event: startingInsideBuffer,
        visit: visit,
        bufferMilliseconds: buffer
      )?.event.id == "starting-inside-buffer"
    )
  }
}
