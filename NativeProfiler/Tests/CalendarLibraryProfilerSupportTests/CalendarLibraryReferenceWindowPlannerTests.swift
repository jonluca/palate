import Foundation
import Testing

@testable import CalendarLibraryProfilerSupport

@Suite("Calendar library independent reference windows")
struct CalendarLibraryReferenceWindowPlannerTests {
  @Test("Date ranges use exact fixed day bounds")
  func dateRange() {
    let anchor = Date(timeIntervalSince1970: 1_000_000)
    let range = CalendarLibraryDateRange(anchorDate: anchor, pastDays: 2, futureDays: 1)

    #expect(range.durationDays == 3)
    #expect(range.startDate == anchor.addingTimeInterval(-2 * 24 * 60 * 60))
    #expect(range.endDate == anchor.addingTimeInterval(24 * 60 * 60))
  }

  @Test("Reference windows are adjacent and exactly cover the range")
  func exactCoverage() {
    let start = Date(timeIntervalSince1970: 100)
    let end = start.addingTimeInterval(5 * CalendarLibraryDateRange.secondsPerDay)
    let windows = CalendarLibraryReferenceWindowPlanner.windows(
      startDate: start,
      endDate: end,
      maximumWindowDays: 2
    )

    #expect(windows.count == 3)
    #expect(windows.first?.start == start)
    #expect(windows.last?.end == end)
    #expect(windows[0].end == windows[1].start)
    #expect(windows[1].end == windows[2].start)
    #expect(windows.map(\.duration) == [172_800, 172_800, 86_400])
  }
}
