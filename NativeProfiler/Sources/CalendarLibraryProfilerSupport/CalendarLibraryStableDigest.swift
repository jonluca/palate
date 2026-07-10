import CryptoKit
import Foundation

public enum CalendarLibraryStableDigest {
  public static func signature(for identities: Set<CalendarLibraryEventIdentity>) -> String {
    var hasher = SHA256()
    for identity in identities.sorted() {
      add(identity.calendarItemIdentifier, to: &hasher)
      add(identity.startDateMilliseconds, to: &hasher)
      add(identity.endDateMilliseconds, to: &hasher)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func add(_ value: String, to hasher: inout SHA256) {
    let bytes = Array(value.utf8)
    add(UInt64(bytes.count), to: &hasher)
    hasher.update(data: Data(bytes))
  }

  private static func add(_ value: Int64, to hasher: inout SHA256) {
    add(UInt64(bitPattern: value), to: &hasher)
  }

  private static func add(_ value: UInt64, to hasher: inout SHA256) {
    var bigEndianValue = value.bigEndian
    withUnsafeBytes(of: &bigEndianValue) { bytes in
      hasher.update(data: Data(bytes))
    }
  }
}
