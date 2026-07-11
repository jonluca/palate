public struct PhotoAssetThumbnailAssetFetchSchedulerState: Sendable {
  public static let defaultMaximumQueuedPreheatIdentifierCount =
    PhotoAssetThumbnailPreheatRequest.maximumPayloadSize

  public private(set) var cacheGeneration: UInt64
  public private(set) var activeBatch: PhotoAssetThumbnailAssetFetchBatch?
  public private(set) var queuedVisibleIdentifiers: [String] = []
  public private(set) var queuedPreheatIdentifiers: [String] = []
  public let maximumQueuedPreheatIdentifierCount: Int

  private var nextBatchSequence: UInt64 = 0
  private var queuedVisibleIdentifierSet: Set<String> = []
  private var queuedPreheatIdentifierSet: Set<String> = []
  private var supersededPreheatBatchCount = 0
  private var supersededPreheatIdentifierCount = 0
  private var visiblePromotionIdentifierCount = 0
  private var removedQueuedVisibleIdentifierCount = 0
  private var invalidatedInFlightBatchCount = 0
  private var invalidatedInFlightIdentifierCount = 0
  private var maximumObservedQueuedPreheatIdentifierCount = 0
  private var maximumObservedQueuedVisibleIdentifierCount = 0
  private var preheatBatchCount = 0
  private var preheatBatchIdentifierCount = 0
  private var visibleBatchCount = 0
  private var visibleBatchIdentifierCount = 0

  public init(
    cacheGeneration: UInt64 = 0,
    maximumQueuedPreheatIdentifierCount: Int = Self.defaultMaximumQueuedPreheatIdentifierCount
  ) {
    self.cacheGeneration = cacheGeneration
    self.maximumQueuedPreheatIdentifierCount = max(0, maximumQueuedPreheatIdentifierCount)
  }

  public var metrics: PhotoAssetThumbnailAssetFetchSchedulerMetrics {
    PhotoAssetThumbnailAssetFetchSchedulerMetrics(
      supersededPreheatBatchCount: supersededPreheatBatchCount,
      supersededPreheatIdentifierCount: supersededPreheatIdentifierCount,
      visiblePromotionIdentifierCount: visiblePromotionIdentifierCount,
      removedQueuedVisibleIdentifierCount: removedQueuedVisibleIdentifierCount,
      invalidatedInFlightBatchCount: invalidatedInFlightBatchCount,
      invalidatedInFlightIdentifierCount: invalidatedInFlightIdentifierCount,
      maximumQueuedPreheatIdentifierCount: maximumObservedQueuedPreheatIdentifierCount,
      maximumQueuedVisibleIdentifierCount: maximumObservedQueuedVisibleIdentifierCount,
      preheatBatchCount: preheatBatchCount,
      preheatBatchIdentifierCount: preheatBatchIdentifierCount,
      visibleBatchCount: visibleBatchCount,
      visibleBatchIdentifierCount: visibleBatchIdentifierCount,
      activeBatchPriority: activeBatch?.priority,
      queuedPreheatIdentifierCount: queuedPreheatIdentifiers.count,
      queuedVisibleIdentifierCount: queuedVisibleIdentifiers.count
    )
  }

  /// Replaces all queued speculative demand with the latest ordered preheat window. An in-flight
  /// fetch remains shared when its identifier is still desired, but obsolete queued windows are
  /// discarded instead of accumulating behind it.
  public mutating func replacePreheatDemand(
    with identifiers: [String],
    cacheGeneration requestedGeneration: UInt64
  ) -> PhotoAssetThumbnailAssetFetchBatch? {
    guard requestedGeneration == cacheGeneration else {
      return nil
    }

    let activeIdentifiers = currentGenerationActiveIdentifiers
    var seen: Set<String> = []
    var replacement: [String] = []
    replacement.reserveCapacity(min(identifiers.count, maximumQueuedPreheatIdentifierCount))
    for identifier in identifiers {
      guard replacement.count < maximumQueuedPreheatIdentifierCount else {
        break
      }
      guard !identifier.isEmpty, seen.insert(identifier).inserted,
        !activeIdentifiers.contains(identifier),
        !queuedVisibleIdentifierSet.contains(identifier)
      else {
        continue
      }
      replacement.append(identifier)
    }

    let replacementSet = Set(replacement)
    let supersededIdentifierCount = queuedPreheatIdentifierSet.subtracting(replacementSet).count
    if supersededIdentifierCount > 0 {
      supersededPreheatBatchCount += 1
      supersededPreheatIdentifierCount += supersededIdentifierCount
    }

    queuedPreheatIdentifiers = replacement
    queuedPreheatIdentifierSet = Set(replacement)
    maximumObservedQueuedPreheatIdentifierCount = max(
      maximumObservedQueuedPreheatIdentifierCount,
      replacement.count
    )
    return startNextBatchIfIdle()
  }

  /// Adds visible demand in stable order. Identifiers already in flight share that fetch; queued
  /// speculative identifiers are promoted so the visible request is never behind preheat backlog.
  public mutating func enqueueVisibleDemand(
    _ identifiers: [String],
    cacheGeneration requestedGeneration: UInt64
  ) -> PhotoAssetThumbnailAssetFetchBatch? {
    guard requestedGeneration == cacheGeneration else {
      return nil
    }

    let activeIdentifiers = currentGenerationActiveIdentifiers
    var promotedIdentifierCount = 0
    for identifier in identifiers {
      guard !identifier.isEmpty, !activeIdentifiers.contains(identifier),
        queuedVisibleIdentifierSet.insert(identifier).inserted
      else {
        continue
      }
      queuedVisibleIdentifiers.append(identifier)
      if queuedPreheatIdentifierSet.contains(identifier) {
        promotedIdentifierCount += 1
      }
    }
    visiblePromotionIdentifierCount += promotedIdentifierCount
    maximumObservedQueuedVisibleIdentifierCount = max(
      maximumObservedQueuedVisibleIdentifierCount,
      queuedVisibleIdentifiers.count
    )

    if !queuedPreheatIdentifiers.isEmpty, !queuedVisibleIdentifierSet.isEmpty {
      queuedPreheatIdentifiers.removeAll { queuedVisibleIdentifierSet.contains($0) }
      queuedPreheatIdentifierSet = Set(queuedPreheatIdentifiers)
    }
    return startNextBatchIfIdle()
  }

  /// Removes identifiers whose final visible waiter was canceled before fetching started. Active
  /// work cannot be canceled, and callers can subsequently replace preheat demand to restore any
  /// identifier that remains speculatively desired.
  @discardableResult
  public mutating func removeVisibleDemand(
    _ identifiers: [String],
    cacheGeneration requestedGeneration: UInt64
  ) -> Int {
    guard requestedGeneration == cacheGeneration, !queuedVisibleIdentifiers.isEmpty else {
      return 0
    }

    let identifiersToRemove = Set(identifiers)
    guard !identifiersToRemove.isEmpty else {
      return 0
    }
    let countBeforeRemoval = queuedVisibleIdentifiers.count
    queuedVisibleIdentifiers.removeAll { identifiersToRemove.contains($0) }
    let removedCount = countBeforeRemoval - queuedVisibleIdentifiers.count
    guard removedCount > 0 else {
      return 0
    }

    queuedVisibleIdentifierSet = Set(queuedVisibleIdentifiers)
    removedQueuedVisibleIdentifierCount += removedCount
    return removedCount
  }

  /// Completes only the exact active batch. A stale or generation-invalidated callback cannot
  /// release or replace newer work.
  public mutating func finish(
    _ batch: PhotoAssetThumbnailAssetFetchBatch
  ) -> PhotoAssetThumbnailAssetFetchCompletion {
    guard batch == activeBatch else {
      return PhotoAssetThumbnailAssetFetchCompletion(accepted: false, nextBatch: nil)
    }

    activeBatch = nil
    return PhotoAssetThumbnailAssetFetchCompletion(
      accepted: batch.cacheGeneration == cacheGeneration,
      nextBatch: startNextBatchIfIdle()
    )
  }

  /// Invalidates queued demand while retaining the active batch as a physical-worker token. The
  /// underlying synchronous PhotoKit call cannot be canceled, so current-generation work stays
  /// queued in this state instead of accumulating behind stale closures on the serial worker.
  public mutating func invalidateCache(to generation: UInt64) {
    if generation != cacheGeneration, let activeBatch,
      activeBatch.cacheGeneration == cacheGeneration
    {
      invalidatedInFlightBatchCount += 1
      invalidatedInFlightIdentifierCount += activeBatch.identifiers.count
    }
    cacheGeneration = generation
    queuedVisibleIdentifiers.removeAll(keepingCapacity: false)
    queuedPreheatIdentifiers.removeAll(keepingCapacity: false)
    queuedVisibleIdentifierSet.removeAll(keepingCapacity: false)
    queuedPreheatIdentifierSet.removeAll(keepingCapacity: false)
  }

  private var currentGenerationActiveIdentifiers: Set<String> {
    guard let activeBatch, activeBatch.cacheGeneration == cacheGeneration else {
      return []
    }
    return Set(activeBatch.identifiers)
  }

  private mutating func startNextBatchIfIdle() -> PhotoAssetThumbnailAssetFetchBatch? {
    guard activeBatch == nil else {
      return nil
    }

    let priority: PhotoAssetThumbnailAssetFetchPriority
    let identifiers: [String]
    if !queuedVisibleIdentifiers.isEmpty {
      priority = .visible
      identifiers = queuedVisibleIdentifiers
      queuedVisibleIdentifiers.removeAll(keepingCapacity: true)
      queuedVisibleIdentifierSet.removeAll(keepingCapacity: true)
    } else if !queuedPreheatIdentifiers.isEmpty {
      priority = .preheat
      identifiers = queuedPreheatIdentifiers
      queuedPreheatIdentifiers.removeAll(keepingCapacity: true)
      queuedPreheatIdentifierSet.removeAll(keepingCapacity: true)
    } else {
      return nil
    }

    nextBatchSequence &+= 1
    let batch = PhotoAssetThumbnailAssetFetchBatch(
      sequence: nextBatchSequence,
      cacheGeneration: cacheGeneration,
      priority: priority,
      identifiers: identifiers
    )
    switch priority {
    case .preheat:
      preheatBatchCount += 1
      preheatBatchIdentifierCount += identifiers.count
    case .visible:
      visibleBatchCount += 1
      visibleBatchIdentifierCount += identifiers.count
    }
    activeBatch = batch
    return batch
  }
}
