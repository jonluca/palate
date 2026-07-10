import Foundation

struct CalendarBatchMutationProfilerDataset: Sendable {
  static let seed: UInt64 = 0xc4a1_e7da_5eed_2026
  static let untouchedEventCount = 32

  struct Event: Comparable, Equatable, Sendable {
    let identifier: String
    let title: String
    let startMilliseconds: Int64
    let endMilliseconds: Int64
    let location: String?
    let notes: String?

    static func < (lhs: Event, rhs: Event) -> Bool {
      lhs.identifier < rhs.identifier
    }
  }

  struct CreateRequest: Equatable, Sendable {
    let clientIdentifier: String
    let title: String
    let startMilliseconds: Int64
    let endMilliseconds: Int64
    let location: String?
    let notes: String?
    let shouldFail: Bool
  }

  struct DeleteRequest: Equatable, Sendable {
    let requestIdentifier: String
    let eventIdentifier: String
    let shouldFail: Bool
  }

  let createRequests: [CreateRequest]
  let deleteRequests: [DeleteRequest]
  let initialEvents: [Event]
  let syntheticCreateFailureCount: Int
  let syntheticDeleteFailureCount: Int
  let syntheticAlreadyAbsentDeleteCount: Int

  static func generate(itemCount: Int) -> CalendarBatchMutationProfilerDataset {
    precondition(itemCount >= 0)
    precondition(itemCount <= CalendarBatchMutationProfilerArguments.maximumItemCount)

    var createRequests: [CreateRequest] = []
    var deleteRequests: [DeleteRequest] = []
    var initialEvents: [Event] = []
    createRequests.reserveCapacity(itemCount)
    deleteRequests.reserveCapacity(itemCount)
    initialEvents.reserveCapacity(itemCount + untouchedEventCount)
    var createFailureCount = 0
    var deleteFailureCount = 0
    var alreadyAbsentCount = 0

    for index in 0..<itemCount {
      let ordinal = index + 1
      let createShouldFail = ordinal.isMultiple(of: 997)
      if createShouldFail {
        createFailureCount += 1
      }
      let startMilliseconds = 1_800_000_000_000 + Int64(index) * 3_600_000
      createRequests.append(
        CreateRequest(
          clientIdentifier: identifier(prefix: "visit", index: index),
          title: title(index: index),
          startMilliseconds: startMilliseconds,
          endMilliseconds: startMilliseconds + Int64(60 + index % 180) * 60_000,
          location: index.isMultiple(of: 3) ? nil : "\(10 + index % 900) Market Street",
          notes: notes(index: index),
          shouldFail: createShouldFail
        )
      )

      let alreadyAbsent = ordinal.isMultiple(of: 887)
      let deleteShouldFail = !alreadyAbsent && ordinal.isMultiple(of: 991)
      if alreadyAbsent {
        alreadyAbsentCount += 1
      }
      if deleteShouldFail {
        deleteFailureCount += 1
      }
      let deleteEventIdentifier = identifier(
        prefix: alreadyAbsent ? "missing-delete-event" : "delete-event",
        index: index
      )
      deleteRequests.append(
        DeleteRequest(
          requestIdentifier: identifier(prefix: "delete-request", index: index),
          eventIdentifier: deleteEventIdentifier,
          shouldFail: deleteShouldFail
        )
      )
      if !alreadyAbsent {
        initialEvents.append(
          Event(
            identifier: deleteEventIdentifier,
            title: "Existing reservation \(index)",
            startMilliseconds: startMilliseconds - 86_400_000,
            endMilliseconds: startMilliseconds - 82_800_000,
            location: index.isMultiple(of: 2) ? "Existing location" : nil,
            notes: "Synthetic delete target"
          )
        )
      }
    }

    for index in 0..<untouchedEventCount {
      let startMilliseconds = 1_700_000_000_000 + Int64(index) * 7_200_000
      initialEvents.append(
        Event(
          identifier: identifier(prefix: "untouched-event", index: index),
          title: "Untouched \(index)",
          startMilliseconds: startMilliseconds,
          endMilliseconds: startMilliseconds + 3_600_000,
          location: nil,
          notes: "Must survive both strategies"
        )
      )
    }

    return CalendarBatchMutationProfilerDataset(
      createRequests: createRequests,
      deleteRequests: deleteRequests,
      initialEvents: initialEvents,
      syntheticCreateFailureCount: createFailureCount,
      syntheticDeleteFailureCount: deleteFailureCount,
      syntheticAlreadyAbsentDeleteCount: alreadyAbsentCount
    )
  }

  private static func identifier(prefix: String, index: Int) -> String {
    let suffix = index.isMultiple(of: 173) ? "-雪's" : ""
    return String(format: "%@-%08d%@", prefix, index, suffix)
  }

  private static func title(index: Int) -> String {
    switch index % 5 {
    case 0:
      return "Dinner at L'Atelier \(index)"
    case 1:
      return "寿司 reservation \(index)"
    case 2:
      return "Café & Bistro \(index)"
    case 3:
      return "🍽️ Tasting Menu \(index)"
    default:
      return "Restaurant Visit \(index)"
    }
  }

  private static func notes(index: Int) -> String? {
    switch index % 4 {
    case 0:
      return nil
    case 1:
      return ""
    case 2:
      return "Window table requested\n\n[Palate Export] Visit ID: \(index)"
    default:
      return "Guest's note 雪"
    }
  }
}
