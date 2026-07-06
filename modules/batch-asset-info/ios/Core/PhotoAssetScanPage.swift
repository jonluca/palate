public struct PhotoAssetScanPage: Sendable {
  public let assets: [PhotoAssetScanRecord]
  public let offset: Int
  public let nextOffset: Int?
  public let totalCount: Int
  public let hasNextPage: Bool
}
