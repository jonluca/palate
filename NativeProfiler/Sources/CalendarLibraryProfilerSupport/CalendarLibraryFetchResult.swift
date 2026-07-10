import Foundation

struct CalendarLibraryFetchResult: Sendable {
  let windowCount: Int
  let rawEventCount: Int
  let uniqueEventIdentities: Set<CalendarLibraryEventIdentity>
}
