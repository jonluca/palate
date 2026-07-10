import Foundation

public enum CalendarEventKitMutationProfilerSourcePlan {
  public struct Source: Equatable, Sendable {
    public let identifier: String
    public let isEligibleType: Bool
    public let isLocal: Bool
    public let hasVisibleWritableCalendar: Bool
    public let isDefault: Bool

    public init(
      identifier: String,
      isEligibleType: Bool,
      isLocal: Bool,
      hasVisibleWritableCalendar: Bool,
      isDefault: Bool
    ) {
      self.identifier = identifier
      self.isEligibleType = isEligibleType
      self.isLocal = isLocal
      self.hasVisibleWritableCalendar = hasVisibleWritableCalendar
      self.isDefault = isDefault
    }
  }

  public static func orderedIdentifiers(from sources: [Source]) -> [String] {
    var seenIdentifiers = Set<String>()
    return
      sources
      .filter { source in
        !source.identifier.isEmpty
          && source.isEligibleType
          && source.hasVisibleWritableCalendar
      }
      .sorted { left, right in
        let leftRank = preferenceRank(left)
        let rightRank = preferenceRank(right)
        if leftRank != rightRank {
          return leftRank < rightRank
        }
        return left.identifier < right.identifier
      }
      .compactMap { source in
        seenIdentifiers.insert(source.identifier).inserted ? source.identifier : nil
      }
  }

  private static func preferenceRank(_ source: Source) -> Int {
    if source.isLocal {
      return 0
    }
    if source.isDefault {
      return 1
    }
    return 2
  }
}
