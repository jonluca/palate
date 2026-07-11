import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset thumbnail preheat strategy")
struct PhotoAssetThumbnailPreheatStrategyTests {
  @Test("Environment key and opt-in default are stable")
  func stableContract() {
    #expect(
      PhotoAssetThumbnailPreheatStrategy.environmentKey
        == "PALATE_PHOTO_THUMBNAIL_PREHEAT_STRATEGY"
    )
    #expect(PhotoAssetThumbnailPreheatStrategy.resolve(environment: [:]) == .off)
  }

  @Test(
    "Exact supported strategy values resolve",
    arguments: [
      ("off", PhotoAssetThumbnailPreheatStrategy.off),
      ("windowed-v1", PhotoAssetThumbnailPreheatStrategy.windowedV1),
    ]
  )
  func supportedStrategies(
    value: String,
    expected: PhotoAssetThumbnailPreheatStrategy
  ) {
    #expect(
      PhotoAssetThumbnailPreheatStrategy.resolve(environment: [
        PhotoAssetThumbnailPreheatStrategy.environmentKey: value
      ]) == expected
    )
  }

  @Test(
    "Invalid values remain off",
    arguments: [
      "", "OFF", "WINDOWED-V1", " windowed-v1", "windowed-v1 ", "windowed-v2", "1",
    ]
  )
  func invalidValues(value: String) {
    #expect(
      PhotoAssetThumbnailPreheatStrategy.resolve(environment: [
        PhotoAssetThumbnailPreheatStrategy.environmentKey: value
      ]) == .off
    )
  }
}
