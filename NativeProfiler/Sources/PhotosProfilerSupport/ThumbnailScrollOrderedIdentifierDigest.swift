import Foundation

struct ThumbnailScrollOrderedIdentifierDigest: Equatable, Sendable {
  private(set) var count = 0
  private var hash: UInt64 = 14_695_981_039_346_656_037

  mutating func add(_ identifier: String) {
    for byte in identifier.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    // A separator and ordinal make concatenation boundaries and repeated positions explicit.
    hash ^= 0xff
    hash &*= 1_099_511_628_211
    var ordinal = UInt64(count).littleEndian
    withUnsafeBytes(of: &ordinal) { bytes in
      for byte in bytes {
        hash ^= UInt64(byte)
        hash &*= 1_099_511_628_211
      }
    }
    count += 1
  }

  var signature: String {
    let unpadded = String(hash, radix: 16, uppercase: false)
    return "\(count):\(String(repeating: "0", count: 16 - unpadded.count))\(unpadded)"
  }
}
