import Foundation

public enum CalendarEventKitMutationProfilerVerifiedCalendarCleanup {
  public enum InitialPresenceRequirement: Equatable, Sendable {
    case bestEffort
    case required
  }

  public static func run(
    identifier: String,
    initialPresenceRequirement: InitialPresenceRequirement,
    reset: () -> Void,
    removePersistedCalendarIfPresent: () throws -> Void,
    persistedCalendarIsPresent: () -> Bool
  ) throws {
    reset()
    guard persistedCalendarIsPresent() else {
      if initialPresenceRequirement == .required {
        throw
          CalendarEventKitMutationProfilerError
          .temporaryCalendarCleanupLookupFailed(identifier: identifier)
      }
      return
    }
    do {
      try removePersistedCalendarIfPresent()
    } catch {
      reset()
      throw error
    }
    reset()
    guard !persistedCalendarIsPresent() else {
      throw
        CalendarEventKitMutationProfilerError
        .temporaryCalendarCleanupVerificationFailed(identifier: identifier)
    }
  }
}
