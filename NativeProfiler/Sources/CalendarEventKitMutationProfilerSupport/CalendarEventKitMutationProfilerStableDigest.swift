import CryptoKit
import Foundation

public enum CalendarEventKitMutationProfilerStableDigest {
  public static func signature(
    for events: [CalendarEventKitMutationProfilerSemanticEvent]
  ) -> String {
    let material =
      events
      .map(\.canonicalRepresentation)
      .sorted()
      .joined(separator: "\n")
    let digest = SHA256.hash(data: Data(material.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}
