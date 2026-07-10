import Foundation

public struct CalendarLibraryEventIdentity: Comparable, Hashable, Sendable {
  let calendarItemIdentifier: String
  let startDateMilliseconds: Int64
  let endDateMilliseconds: Int64

  public static func < (
    lhs: CalendarLibraryEventIdentity,
    rhs: CalendarLibraryEventIdentity
  ) -> Bool {
    if lhs.calendarItemIdentifier != rhs.calendarItemIdentifier {
      return lhs.calendarItemIdentifier < rhs.calendarItemIdentifier
    }
    if lhs.startDateMilliseconds != rhs.startDateMilliseconds {
      return lhs.startDateMilliseconds < rhs.startDateMilliseconds
    }
    return lhs.endDateMilliseconds < rhs.endDateMilliseconds
  }
}
