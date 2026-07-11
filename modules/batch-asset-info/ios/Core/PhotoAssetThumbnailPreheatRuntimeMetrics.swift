public struct PhotoAssetThumbnailPreheatRuntimeMetrics: Equatable, Sendable {
  public static let zero = PhotoAssetThumbnailPreheatRuntimeMetrics(
    updateCount: 0,
    startedKeyCount: 0,
    stoppedKeyCount: 0,
    retainedKeyCount: 0,
    fetchIdentifierCount: 0,
    cacheStartCallCount: 0,
    cacheStopCallCount: 0,
    cacheStopAllCount: 0,
    activeKeyCount: 0,
    pendingKeyCount: 0
  )

  public let updateCount: Int
  public let startedKeyCount: Int
  public let stoppedKeyCount: Int
  public let retainedKeyCount: Int
  public let fetchIdentifierCount: Int
  public let cacheStartCallCount: Int
  public let cacheStopCallCount: Int
  public let cacheStopAllCount: Int
  public let activeKeyCount: Int
  public let pendingKeyCount: Int
}
