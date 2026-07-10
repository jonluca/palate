import CryptoKit
import Foundation

enum CalendarBatchMutationProfilerStableDigest {
  static func outcomes(
    _ outcomes: [CalendarBatchMutationProfilerOutcome]
  ) -> String {
    var hasher = SHA256()
    add(UInt64(outcomes.count), to: &hasher)
    for outcome in outcomes {
      add(outcome.phase.rawValue, to: &hasher)
      add(outcome.requestIdentifier, to: &hasher)
      add(outcome.eventIdentifier, to: &hasher)
      add(outcome.status.rawValue, to: &hasher)
    }
    return signature(hasher.finalize())
  }

  static func finalEvents(
    _ events: [CalendarBatchMutationProfilerDataset.Event]
  ) -> String {
    var hasher = SHA256()
    let sortedEvents = events.sorted()
    add(UInt64(sortedEvents.count), to: &hasher)
    for event in sortedEvents {
      add(event.identifier, to: &hasher)
      add(event.title, to: &hasher)
      add(event.startMilliseconds, to: &hasher)
      add(event.endMilliseconds, to: &hasher)
      add(event.location, to: &hasher)
      add(event.notes, to: &hasher)
    }
    return signature(hasher.finalize())
  }

  private static func add(_ value: String?, to hasher: inout SHA256) {
    guard let value else {
      add(UInt8(0), to: &hasher)
      return
    }
    add(UInt8(1), to: &hasher)
    add(value, to: &hasher)
  }

  private static func add(_ value: String, to hasher: inout SHA256) {
    let bytes = Array(value.utf8)
    add(UInt64(bytes.count), to: &hasher)
    hasher.update(data: Data(bytes))
  }

  private static func add(_ value: Int64, to hasher: inout SHA256) {
    add(UInt64(bitPattern: value), to: &hasher)
  }

  private static func add(_ value: UInt8, to hasher: inout SHA256) {
    hasher.update(data: Data([value]))
  }

  private static func add(_ value: UInt64, to hasher: inout SHA256) {
    var bigEndianValue = value.bigEndian
    withUnsafeBytes(of: &bigEndianValue) { bytes in
      hasher.update(data: Data(bytes))
    }
  }

  private static func signature<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
    digest.map { String(format: "%02x", $0) }.joined()
  }
}
