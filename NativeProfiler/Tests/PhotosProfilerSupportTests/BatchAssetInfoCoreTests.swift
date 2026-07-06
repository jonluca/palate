import BatchAssetInfoCore
import Testing

@Suite("Batch asset core")
struct BatchAssetInfoCoreTests {
  @Test("Zero-valued coordinates are valid")
  func zeroCoordinates() {
    let equator = PhotoAssetLocation(latitude: 0, longitude: 35)
    let primeMeridian = PhotoAssetLocation(latitude: 51.5, longitude: 0)
    let origin = PhotoAssetLocation(latitude: 0, longitude: 0)

    #expect(equator?.latitude == 0)
    #expect(primeMeridian?.longitude == 0)
    #expect(origin != nil)
  }

  @Test("Out-of-range and non-finite coordinates are rejected")
  func invalidCoordinates() {
    #expect(PhotoAssetLocation(latitude: 91, longitude: 0) == nil)
    #expect(PhotoAssetLocation(latitude: 0, longitude: -181) == nil)
    #expect(PhotoAssetLocation(latitude: .nan, longitude: 0) == nil)
  }

  @Test("Classification option bounds are explicit")
  func classificationOptionBounds() throws {
    let minimum = try PhotoAssetClassificationOptions(confidenceThreshold: 0, maximumLabelCount: 0)
    let maximum = try PhotoAssetClassificationOptions(confidenceThreshold: 1, maximumLabelCount: 1_000)

    #expect(minimum.confidenceThreshold == 0)
    #expect(minimum.maximumLabelCount == 0)
    #expect(maximum.confidenceThreshold == 1)
    #expect(maximum.maximumLabelCount == 1_000)

    #expect(throws: PhotoAssetClassificationError.self) {
      try PhotoAssetClassificationOptions(confidenceThreshold: -0.01, maximumLabelCount: 1)
    }
    #expect(throws: PhotoAssetClassificationError.self) {
      try PhotoAssetClassificationOptions(confidenceThreshold: 0.5, maximumLabelCount: 1_001)
    }
  }
}
