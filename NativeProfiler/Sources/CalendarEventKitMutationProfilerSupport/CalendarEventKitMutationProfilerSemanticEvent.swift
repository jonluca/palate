import Foundation

public struct CalendarEventKitMutationProfilerSemanticEvent: Codable, Hashable, Sendable {
  public static let comparedFieldNames = [
    "title", "startMilliseconds", "endMilliseconds", "location", "notes", "isAllDay",
  ]

  public let title: String
  public let startMilliseconds: Int64
  public let endMilliseconds: Int64
  public let location: String
  public let notes: String
  public let isAllDay: Bool

  public init(
    title: String,
    startMilliseconds: Int64,
    endMilliseconds: Int64,
    location: String,
    notes: String,
    isAllDay: Bool
  ) {
    self.title = title
    self.startMilliseconds = startMilliseconds
    self.endMilliseconds = endMilliseconds
    self.location = location
    self.notes = notes
    self.isAllDay = isAllDay
  }

  public var startDate: Date {
    Date(timeIntervalSince1970: Double(startMilliseconds) / 1_000)
  }

  public var endDate: Date {
    Date(timeIntervalSince1970: Double(endMilliseconds) / 1_000)
  }

  public var canonicalRepresentation: String {
    [
      field(title),
      String(startMilliseconds),
      String(endMilliseconds),
      field(location),
      field(notes),
      isAllDay ? "1" : "0",
    ].joined(separator: "|")
  }

  private func field(_ value: String) -> String {
    "\(value.utf8.count):\(value)"
  }
}
