@preconcurrency import EventKit
import Foundation

@MainActor
public final class CalendarEventKitMutationProfilerTemporaryCalendar {
  public let calendar: EKCalendar
  public let calendarIdentifier: String
  public let sourceType: String

  private let eventStore: EKEventStore

  private init(eventStore: EKEventStore, calendar: EKCalendar, sourceType: String) {
    self.eventStore = eventStore
    self.calendar = calendar
    calendarIdentifier = calendar.calendarIdentifier
    self.sourceType = sourceType
  }

  public static func create(
    eventStore: EKEventStore
  ) throws -> CalendarEventKitMutationProfilerTemporaryCalendar {
    let candidateIdentifiers = sourceCandidateIdentifiers(eventStore: eventStore)
    let title = "Palate EventKit Mutation Profiler \(UUID().uuidString)"

    for sourceIdentifier in candidateIdentifiers {
      guard
        let source = eventStore.source(withIdentifier: sourceIdentifier),
        isEligible(source.sourceType),
        visibleWritableSourceIdentifiers(eventStore: eventStore).contains(sourceIdentifier)
      else {
        continue
      }
      let calendar = EKCalendar(for: .event, eventStore: eventStore)
      calendar.title = title
      calendar.source = source
      do {
        try eventStore.saveCalendar(calendar, commit: true)
      } catch {
        try cleanupAfterFailedSave(calendar: calendar, eventStore: eventStore)
        continue
      }

      let identifier = calendar.calendarIdentifier
      guard !identifier.isEmpty else {
        try? eventStore.removeCalendar(calendar, commit: true)
        eventStore.reset()
        throw CalendarEventKitMutationProfilerError
          .temporaryCalendarIdentifierUnavailable
      }
      guard
        let persistedCalendar = usablePersistedCalendar(
          identifier: identifier,
          expectedSourceIdentifier: sourceIdentifier,
          eventStore: eventStore
        )
      else {
        try removePersistedCalendar(identifier: identifier, eventStore: eventStore)
        continue
      }
      return CalendarEventKitMutationProfilerTemporaryCalendar(
        eventStore: eventStore,
        calendar: persistedCalendar,
        sourceType: sourceTypeName(source.sourceType)
      )
    }

    throw CalendarEventKitMutationProfilerError.noWritableCalendarSource(
      attemptedSourceCount: candidateIdentifiers.count
    )
  }

  public func remove() throws {
    try Self.removePersistedCalendar(
      identifier: calendarIdentifier,
      eventStore: eventStore
    )
  }

  private static func sourceCandidateIdentifiers(eventStore: EKEventStore) -> [String] {
    let writableSourceIdentifiers = visibleWritableSourceIdentifiers(eventStore: eventStore)
    let defaultSourceIdentifier: String?
    if let defaultCalendar = eventStore.defaultCalendarForNewEvents,
      defaultCalendar.allowsContentModifications,
      !defaultCalendar.isImmutable,
      !defaultCalendar.isSubscribed
    {
      defaultSourceIdentifier = defaultCalendar.source?.sourceIdentifier
    } else {
      defaultSourceIdentifier = nil
    }

    let plannedSources = eventStore.sources.map { source in
      CalendarEventKitMutationProfilerSourcePlan.Source(
        identifier: source.sourceIdentifier,
        isEligibleType: isEligible(source.sourceType),
        isLocal: source.sourceType == .local,
        hasVisibleWritableCalendar: writableSourceIdentifiers.contains(
          source.sourceIdentifier
        ),
        isDefault: source.sourceIdentifier == defaultSourceIdentifier
      )
    }
    return CalendarEventKitMutationProfilerSourcePlan.orderedIdentifiers(
      from: plannedSources
    )
  }

  private static func visibleWritableSourceIdentifiers(
    eventStore: EKEventStore
  ) -> Set<String> {
    Set(
      eventStore.calendars(for: .event).compactMap { calendar -> String? in
        guard calendar.allowsContentModifications,
          !calendar.isImmutable,
          !calendar.isSubscribed,
          let source = calendar.source
        else {
          return nil
        }
        return source.sourceIdentifier
      }
    )
  }

  private static func usablePersistedCalendar(
    identifier: String,
    expectedSourceIdentifier: String,
    eventStore: EKEventStore
  ) -> EKCalendar? {
    guard
      let persistedCalendar = eventStore.calendar(withIdentifier: identifier),
      persistedCalendar.calendarIdentifier == identifier,
      persistedCalendar.source?.sourceIdentifier == expectedSourceIdentifier,
      !persistedCalendar.allowedEntityTypes.isDisjoint(with: .event),
      persistedCalendar.allowsContentModifications,
      !persistedCalendar.isImmutable,
      !persistedCalendar.isSubscribed,
      eventStore.calendars(for: .event).contains(where: {
        $0.calendarIdentifier == identifier
      })
    else {
      return nil
    }
    return persistedCalendar
  }

  private static func cleanupAfterFailedSave(
    calendar: EKCalendar,
    eventStore: EKEventStore
  ) throws {
    let identifier = calendar.calendarIdentifier
    guard !identifier.isEmpty else {
      try? eventStore.removeCalendar(calendar, commit: true)
      eventStore.reset()
      return
    }
    try removePersistedCalendar(
      identifier: identifier,
      initialPresenceRequirement: .bestEffort,
      eventStore: eventStore
    )
  }

  private static func removePersistedCalendar(
    identifier: String,
    initialPresenceRequirement:
      CalendarEventKitMutationProfilerVerifiedCalendarCleanup.InitialPresenceRequirement =
      .required,
    eventStore: EKEventStore
  ) throws {
    try CalendarEventKitMutationProfilerVerifiedCalendarCleanup.run(
      identifier: identifier,
      initialPresenceRequirement: initialPresenceRequirement,
      reset: { eventStore.reset() },
      removePersistedCalendarIfPresent: {
        guard let persistedCalendar = eventStore.calendar(withIdentifier: identifier) else {
          return
        }
        try eventStore.removeCalendar(persistedCalendar, commit: true)
      },
      persistedCalendarIsPresent: {
        eventStore.calendar(withIdentifier: identifier) != nil
      }
    )
  }

  private static func isEligible(_ sourceType: EKSourceType) -> Bool {
    switch sourceType {
    case .birthdays, .subscribed:
      return false
    default:
      return true
    }
  }

  private static func sourceTypeName(_ sourceType: EKSourceType) -> String {
    switch sourceType {
    case .local:
      return "local"
    case .exchange:
      return "exchange"
    case .calDAV:
      return "calDAV"
    case .mobileMe:
      return "mobileMe"
    case .subscribed:
      return "subscribed"
    case .birthdays:
      return "birthdays"
    @unknown default:
      return "unknown"
    }
  }
}
