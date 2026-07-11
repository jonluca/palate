import Foundation

public enum ThumbnailScrollBenchmarkArm: String, CaseIterable, Encodable, Equatable, Sendable {
  case control
  case currentVisibleFirst = "current-visible-first"
  case aheadBehindFirst = "ahead-behind-first"
  case futureOnly = "future-only"
}
