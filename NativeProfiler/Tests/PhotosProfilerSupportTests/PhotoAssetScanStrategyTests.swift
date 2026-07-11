import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset scan strategy")
struct PhotoAssetScanStrategyTests {
  @Test("Explicit legacy and incremental strategies resolve")
  func explicitStrategies() {
    #expect(
      PhotoAssetScanStrategy.resolve(environment: [
        PhotoAssetScanStrategy.environmentKey: "legacy"
      ]) == .legacy
    )
    #expect(
      PhotoAssetScanStrategy.resolve(environment: [
        PhotoAssetScanStrategy.environmentKey: "incremental"
      ]) == .incremental
    )
  }

  @Test("Missing and invalid strategies default to incremental")
  func fallbackStrategy() {
    #expect(PhotoAssetScanStrategy.resolve(environment: [:]) == .incremental)
    #expect(
      PhotoAssetScanStrategy.resolve(environment: [
        PhotoAssetScanStrategy.environmentKey: "LEGACY"
      ]) == .incremental
    )
    #expect(
      PhotoAssetScanStrategy.resolve(environment: [
        PhotoAssetScanStrategy.environmentKey: "unknown"
      ]) == .incremental
    )
  }
}
