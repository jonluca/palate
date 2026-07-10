import Foundation

enum CalendarLibraryFetchStrategy: Sendable {
  case production
  case reference(windowDays: Int)
}
