import Foundation

public struct StableIdentifierDigest: Equatable, Sendable {
  public private(set) var count = 0
  private var exclusiveOr: UInt64 = 0
  private var sum: UInt64 = 0

  public init() {}

  public mutating func add(_ identifier: String) {
    let identifierHash = Self.fnv1a(identifier)
    count += 1
    exclusiveOr ^= identifierHash
    sum &+= identifierHash
  }

  public var signature: String {
    "\(count):\(Self.hex(exclusiveOr)):\(Self.hex(sum))"
  }

  private static func fnv1a(_ value: String) -> UInt64 {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in value.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    return hash
  }

  private static func hex(_ value: UInt64) -> String {
    let unpadded = String(value, radix: 16, uppercase: false)
    return String(repeating: "0", count: 16 - unpadded.count) + unpadded
  }
}
