import Foundation

public enum CalendarEventKitMutationProfilerDataset {
  // Keep the fixed fixture close to the validation environment. EventKit may accept a save whose
  // start date is beyond its supported future horizon but omit it from predicate readback.
  public static let anchorMilliseconds: Int64 = 1_785_585_600_000

  public static func events(count: Int) -> [CalendarEventKitMutationProfilerSemanticEvent] {
    precondition(count > 0)

    return (0..<count).map { index in
      let startMilliseconds = anchorMilliseconds + Int64(index) * 7_200_000
      let durationMilliseconds = Int64(60 + (index % 4) * 15) * 60_000
      let token = String(format: "%04d", index)
      return CalendarEventKitMutationProfilerSemanticEvent(
        title: "Palate EventKit mutation profile \(token)",
        startMilliseconds: startMilliseconds,
        endMilliseconds: startMilliseconds + durationMilliseconds,
        location: "Profiler table \((index % 9) + 1)",
        notes: "Synthetic deterministic profiler event \(token); no user data.",
        isAllDay: false
      )
    }
  }

  public static func queryRange(
    for events: [CalendarEventKitMutationProfilerSemanticEvent]
  ) -> DateInterval {
    precondition(!events.isEmpty)
    let paddingMilliseconds: Int64 = 86_400_000
    let start = events.map(\.startMilliseconds).min()! - paddingMilliseconds
    let end = events.map(\.endMilliseconds).max()! + paddingMilliseconds
    return DateInterval(
      start: Date(timeIntervalSince1970: Double(start) / 1_000),
      end: Date(timeIntervalSince1970: Double(end) / 1_000)
    )
  }
}
