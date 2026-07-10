import Foundation

public struct CalendarLibraryDateRange: Equatable, Sendable {
  public static let secondsPerDay: TimeInterval = 24 * 60 * 60

  public let startDate: Date
  public let endDate: Date

  public init(anchorDate: Date, pastDays: Int, futureDays: Int) {
    precondition(pastDays >= 0 && futureDays >= 0)
    precondition(pastDays > 0 || futureDays > 0)

    startDate = anchorDate.addingTimeInterval(-Double(pastDays) * Self.secondsPerDay)
    endDate = anchorDate.addingTimeInterval(Double(futureDays) * Self.secondsPerDay)
  }

  public var durationDays: Int {
    Int((endDate.timeIntervalSince(startDate) / Self.secondsPerDay).rounded())
  }
}
