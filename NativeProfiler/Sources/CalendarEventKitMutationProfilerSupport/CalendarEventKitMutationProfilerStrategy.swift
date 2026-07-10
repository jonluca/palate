import Foundation

public enum CalendarEventKitMutationProfilerStrategy: String, CaseIterable, Codable, Hashable,
  Sendable
{
  case legacy
  case candidate
}
