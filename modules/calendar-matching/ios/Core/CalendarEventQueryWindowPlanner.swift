import Foundation

internal enum CalendarMatchingTimestamp {
  /// ECMAScript Date's TimeClip range: 100,000,000 days on either side of the epoch.
  static let maximumAbsoluteMilliseconds = 8_640_000_000_000_000.0

  static func isSupported(_ value: Double) -> Bool {
    value.isFinite && abs(value) <= maximumAbsoluteMilliseconds
  }
}

internal struct CalendarEventQueryWindow: Equatable, Sendable {
  let startDateMs: Double
  let endDateMs: Double
}

/// EventKit silently truncates predicates longer than four years to their first four years.
/// Fixed three-year windows stay safely below that limit, including across leap years.
internal enum CalendarEventQueryWindowPlanner {
  static let maximumWindowMilliseconds = 3 * 365 * 24 * 60 * 60 * 1_000.0

  static func windows(startDateMs: Double, endDateMs: Double) -> [CalendarEventQueryWindow] {
    precondition(
      CalendarMatchingTimestamp.isSupported(startDateMs)
        && CalendarMatchingTimestamp.isSupported(endDateMs)
        && endDateMs >= startDateMs
    )

    guard startDateMs < endDateMs else {
      return [CalendarEventQueryWindow(startDateMs: startDateMs, endDateMs: endDateMs)]
    }

    var result: [CalendarEventQueryWindow] = []
    var windowStart = startDateMs
    while windowStart < endDateMs {
      let proposedEnd = windowStart + maximumWindowMilliseconds
      precondition(proposedEnd > windowStart)
      let windowEnd = min(proposedEnd, endDateMs)
      result.append(
        CalendarEventQueryWindow(startDateMs: windowStart, endDateMs: windowEnd)
      )
      windowStart = windowEnd
    }
    return result
  }
}
