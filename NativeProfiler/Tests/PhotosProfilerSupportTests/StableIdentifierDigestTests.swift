import Testing
@testable import PhotosProfilerSupport

@Suite("Stable identifier digest")
struct StableIdentifierDigestTests {
  @Test("Digest is independent of fetch result ordering")
  func orderIndependent() {
    var forward = StableIdentifierDigest()
    var reverse = StableIdentifierDigest()

    ["asset-a", "asset-b", "asset-c"].forEach { forward.add($0) }
    ["asset-c", "asset-b", "asset-a"].forEach { reverse.add($0) }

    #expect(forward == reverse)
    #expect(forward.signature == reverse.signature)
  }

  @Test("Digest changes when an identifier is missing")
  func missingIdentifier() {
    var complete = StableIdentifierDigest()
    var incomplete = StableIdentifierDigest()

    ["asset-a", "asset-b"].forEach { complete.add($0) }
    incomplete.add("asset-a")

    #expect(complete != incomplete)
    #expect(complete.count == 2)
    #expect(incomplete.count == 1)
  }
}
