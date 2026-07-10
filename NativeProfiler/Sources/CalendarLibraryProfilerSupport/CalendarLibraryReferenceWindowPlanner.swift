import Foundation

public enum CalendarLibraryReferenceWindowPlanner {
  public static func windows(
    startDate: Date,
    endDate: Date,
    maximumWindowDays: Int
  ) -> [DateInterval] {
    precondition(endDate > startDate)
    precondition(maximumWindowDays > 0)

    let maximumWindowSeconds = Double(maximumWindowDays) * CalendarLibraryDateRange.secondsPerDay
    var windows: [DateInterval] = []
    var windowStart = startDate
    while windowStart < endDate {
      let proposedEnd = windowStart.addingTimeInterval(maximumWindowSeconds)
      precondition(proposedEnd > windowStart)
      let windowEnd = min(proposedEnd, endDate)
      windows.append(DateInterval(start: windowStart, end: windowEnd))
      windowStart = windowEnd
    }
    return windows
  }
}
