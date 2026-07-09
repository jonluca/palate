import Testing

@testable import CalendarMatchingCore

@Suite("Calendar EventKit query windows")
struct CalendarEventQueryWindowPlannerTests {
  @Test("Short and zero-length ranges use one exact window")
  func shortRanges() {
    #expect(
      CalendarEventQueryWindowPlanner.windows(startDateMs: 1_000, endDateMs: 2_000)
        == [CalendarEventQueryWindow(startDateMs: 1_000, endDateMs: 2_000)]
    )
    #expect(
      CalendarEventQueryWindowPlanner.windows(startDateMs: 1_000, endDateMs: 1_000)
        == [CalendarEventQueryWindow(startDateMs: 1_000, endDateMs: 1_000)]
    )
  }

  @Test("Long history is covered by adjacent windows below EventKit's limit")
  func longRanges() {
    let maximum = CalendarEventQueryWindowPlanner.maximumWindowMilliseconds
    let start = 1_700_000_000_000.0
    let end = start + maximum * 2.5
    let windows = CalendarEventQueryWindowPlanner.windows(startDateMs: start, endDateMs: end)

    #expect(windows.count == 3)
    #expect(windows.first?.startDateMs == start)
    #expect(windows.last?.endDateMs == end)
    #expect(windows.allSatisfy { $0.endDateMs - $0.startDateMs <= maximum })
    #expect(
      zip(windows, windows.dropFirst()).allSatisfy { previous, next in
        previous.endDateMs == next.startDateMs
      }
    )
  }

  @Test("Timestamp support matches ECMAScript Date's TimeClip range")
  func timestampRange() {
    let maximum = CalendarMatchingTimestamp.maximumAbsoluteMilliseconds
    #expect(CalendarMatchingTimestamp.isSupported(maximum))
    #expect(CalendarMatchingTimestamp.isSupported(-maximum))
    #expect(!CalendarMatchingTimestamp.isSupported(maximum + 1))
    #expect(!CalendarMatchingTimestamp.isSupported(.infinity))
  }
}
