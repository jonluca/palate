import BatchAssetInfoCore
import Testing

@Suite("Photo asset scan core")
struct PhotoAssetScanCoreTests {
  @Test("Profiler and scan session share the same maximum page size")
  func maximumPageSize() {
    #expect(PhotoAssetScanSession.maximumPageSize == 5_000)
  }

  @Test("Scan errors expose stable bridge codes without Photos access")
  func errorCodes() {
    let offsetError = PhotoAssetScanError.invalidOffset(offset: -1, totalCount: 10)
    let limitError = PhotoAssetScanError.invalidLimit(limit: 0, maximum: 5_000)

    #expect(offsetError.code == "ERR_ASSET_SCAN_INVALID_OFFSET")
    #expect(limitError.code == "ERR_ASSET_SCAN_INVALID_LIMIT")
    #expect(offsetError.localizedDescription.contains("-1"))
    #expect(limitError.localizedDescription.contains("5000"))
  }
}
