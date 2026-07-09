import CalendarMatchingCore
import Foundation

struct CalendarMatchChecksum: Equatable, Sendable {
  private var hash: UInt64 = 14_695_981_039_346_656_037
  private(set) var count = 0

  mutating func add(_ match: CalendarVisitMatch) {
    add(match.visitId)
    add(match.event.id)
    add(match.suggestedRestaurantId ?? "")
    count += 1
  }

  var signature: String {
    let hexadecimal = String(hash, radix: 16, uppercase: false)
    return "\(count):\(String(repeating: "0", count: 16 - hexadecimal.count))\(hexadecimal)"
  }

  static func calculate(_ matches: [CalendarVisitMatch]) -> CalendarMatchChecksum {
    var checksum = CalendarMatchChecksum()
    for match in matches {
      checksum.add(match)
    }
    return checksum
  }

  private mutating func add(_ value: String) {
    for byte in value.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    hash ^= 0xFF
    hash &*= 1_099_511_628_211
  }
}
