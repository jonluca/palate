public struct PhotoAssetThumbnailAssetFetchSchedulerMetrics: Equatable, Sendable {
  public static let zero = PhotoAssetThumbnailAssetFetchSchedulerMetrics(
    supersededPreheatBatchCount: 0,
    supersededPreheatIdentifierCount: 0,
    visiblePromotionIdentifierCount: 0,
    removedQueuedVisibleIdentifierCount: 0,
    invalidatedInFlightBatchCount: 0,
    invalidatedInFlightIdentifierCount: 0,
    maximumQueuedPreheatIdentifierCount: 0,
    maximumQueuedVisibleIdentifierCount: 0,
    preheatBatchCount: 0,
    preheatBatchIdentifierCount: 0,
    visibleBatchCount: 0,
    visibleBatchIdentifierCount: 0,
    activeBatchPriority: nil,
    queuedPreheatIdentifierCount: 0,
    queuedVisibleIdentifierCount: 0
  )

  public let supersededPreheatBatchCount: Int
  public let supersededPreheatIdentifierCount: Int
  public let visiblePromotionIdentifierCount: Int
  public let removedQueuedVisibleIdentifierCount: Int
  public let invalidatedInFlightBatchCount: Int
  public let invalidatedInFlightIdentifierCount: Int
  public let maximumQueuedPreheatIdentifierCount: Int
  public let maximumQueuedVisibleIdentifierCount: Int
  public let preheatBatchCount: Int
  public let preheatBatchIdentifierCount: Int
  public let visibleBatchCount: Int
  public let visibleBatchIdentifierCount: Int
  public let activeBatchPriority: PhotoAssetThumbnailAssetFetchPriority?
  public let queuedPreheatIdentifierCount: Int
  public let queuedVisibleIdentifierCount: Int

  /// True only after the serialized physical fetch worker and both demand queues are empty.
  public var isQuiescent: Bool {
    activeBatchPriority == nil && queuedPreheatIdentifierCount == 0
      && queuedVisibleIdentifierCount == 0
  }
}
