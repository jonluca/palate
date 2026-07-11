import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset thumbnail asset-fetch scheduler state")
struct PhotoAssetThumbnailAssetFetchSchedulerStateTests {
  @Test("Rapid preheat windows replace obsolete queued speculative identifiers")
  func rapidPreheatWindowReplacement() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()

    let activeBatch = scheduler.replacePreheatDemand(
      with: ["active-a", "active-b"], cacheGeneration: 0)
    let active = try #require(activeBatch)
    #expect(active.priority == .preheat)
    #expect(active.identifiers == ["active-a", "active-b"])

    let obsoleteWindow = scheduler.replacePreheatDemand(
      with: ["obsolete-a", "retained"], cacheGeneration: 0)
    let currentWindow = scheduler.replacePreheatDemand(
      with: ["retained", "current-a", "current-b"], cacheGeneration: 0)
    #expect(obsoleteWindow == nil)
    #expect(currentWindow == nil)
    #expect(scheduler.queuedPreheatIdentifiers == ["retained", "current-a", "current-b"])

    let completion = scheduler.finish(active)
    #expect(completion.accepted)
    #expect(completion.nextBatch?.priority == .preheat)
    #expect(completion.nextBatch?.identifiers == ["retained", "current-a", "current-b"])
    #expect(scheduler.metrics.supersededPreheatBatchCount == 1)
    #expect(scheduler.metrics.supersededPreheatIdentifierCount == 1)
  }

  @Test("Visible demand promotes queued preheat identifiers and runs before remaining preheat")
  func visibleDemandPromotionAndPriority() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let activeBatch = scheduler.replacePreheatDemand(with: ["active"], cacheGeneration: 0)
    let active = try #require(activeBatch)
    let queuedPreheat = scheduler.replacePreheatDemand(
      with: ["preheat-a", "promoted", "preheat-b"], cacheGeneration: 0)
    #expect(queuedPreheat == nil)

    let queuedVisible = scheduler.enqueueVisibleDemand(
      ["promoted", "visible", "promoted"], cacheGeneration: 0)
    #expect(queuedVisible == nil)
    #expect(scheduler.queuedVisibleIdentifiers == ["promoted", "visible"])
    #expect(scheduler.queuedPreheatIdentifiers == ["preheat-a", "preheat-b"])
    #expect(scheduler.metrics.visiblePromotionIdentifierCount == 1)

    let activeCompletion = scheduler.finish(active)
    let visible = try #require(activeCompletion.nextBatch)
    #expect(visible.priority == .visible)
    #expect(visible.identifiers == ["promoted", "visible"])

    let visibleCompletion = scheduler.finish(visible)
    let remainingPreheat = try #require(visibleCompletion.nextBatch)
    #expect(remainingPreheat.priority == .preheat)
    #expect(remainingPreheat.identifiers == ["preheat-a", "preheat-b"])
  }

  @Test("Visible requests share identifiers already in flight without a duplicate fetch")
  func sharedInFlightIdentifiers() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let preheatBatch = scheduler.replacePreheatDemand(
      with: ["shared", "preheat-only"], cacheGeneration: 0)
    let preheat = try #require(preheatBatch)

    let queuedVisible = scheduler.enqueueVisibleDemand(
      ["shared", "visible-only", "shared"], cacheGeneration: 0)
    #expect(queuedVisible == nil)
    let preheatCompletion = scheduler.finish(preheat)
    let visible = try #require(preheatCompletion.nextBatch)

    #expect(visible.priority == .visible)
    #expect(visible.identifiers == ["visible-only"])
    #expect(!visible.identifiers.contains("shared"))
    let visibleCompletion = scheduler.finish(visible)
    #expect(visibleCompletion.nextBatch == nil)
  }

  @Test("Demand sources deduplicate identifiers across active and queued batches")
  func noDuplicateFetches() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let activeVisibleBatch = scheduler.enqueueVisibleDemand(
      ["a", "a", "b"], cacheGeneration: 0)
    let activeVisible = try #require(activeVisibleBatch)
    #expect(activeVisible.identifiers == ["a", "b"])

    let queuedPreheat = scheduler.replacePreheatDemand(
      with: ["a", "b", "c", "c"], cacheGeneration: 0)
    #expect(queuedPreheat == nil)
    #expect(scheduler.queuedPreheatIdentifiers == ["c"])
    let queuedVisible = scheduler.enqueueVisibleDemand(
      ["b", "c", "d", "d"], cacheGeneration: 0)
    #expect(queuedVisible == nil)

    let activeCompletion = scheduler.finish(activeVisible)
    let nextVisible = try #require(activeCompletion.nextBatch)
    #expect(nextVisible.identifiers == ["c", "d"])
    let visibleCompletion = scheduler.finish(nextVisible)
    #expect(visibleCompletion.nextBatch == nil)
    #expect(Set(activeVisible.identifiers).isDisjoint(with: nextVisible.identifiers))
  }

  @Test("Generation invalidation rejects late results without disturbing newer work")
  func generationInvalidationAndLateResultSafety() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let staleBatch = scheduler.replacePreheatDemand(with: ["stale"], cacheGeneration: 0)
    let stale = try #require(staleBatch)
    let queuedStale = scheduler.enqueueVisibleDemand(["also-stale"], cacheGeneration: 0)
    #expect(queuedStale == nil)

    scheduler.invalidateCache(to: 1)
    #expect(scheduler.activeBatch == stale)
    #expect(scheduler.queuedVisibleIdentifiers.isEmpty)
    #expect(scheduler.queuedPreheatIdentifiers.isEmpty)

    let currentBatch = scheduler.enqueueVisibleDemand(["current"], cacheGeneration: 1)
    #expect(currentBatch == nil)
    let staleCompletion = scheduler.finish(stale)
    #expect(!staleCompletion.accepted)
    let current = try #require(staleCompletion.nextBatch)
    #expect(scheduler.activeBatch == current)

    let currentCompletion = scheduler.finish(current)
    #expect(currentCompletion.accepted)
    #expect(scheduler.activeBatch == nil)
  }

  @Test("Repeated invalidations retain one physical worker and coalesce to the latest generation")
  func repeatedInvalidationDoesNotBuildPhysicalBacklog() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let staleBatch = scheduler.replacePreheatDemand(
      with: ["stale-a", "stale-b"], cacheGeneration: 0)
    let stale = try #require(staleBatch)

    scheduler.invalidateCache(to: 1)
    let generationOne = scheduler.enqueueVisibleDemand(
      ["generation-one"], cacheGeneration: 1)
    scheduler.invalidateCache(to: 2)
    let generationTwo = scheduler.enqueueVisibleDemand(
      ["generation-two"], cacheGeneration: 2)

    #expect(generationOne == nil)
    #expect(generationTwo == nil)
    #expect(scheduler.activeBatch == stale)
    #expect(scheduler.queuedVisibleIdentifiers == ["generation-two"])

    let staleCompletion = scheduler.finish(stale)
    let current = try #require(staleCompletion.nextBatch)
    #expect(!staleCompletion.accepted)
    #expect(current.cacheGeneration == 2)
    #expect(current.identifiers == ["generation-two"])
    #expect(scheduler.metrics.invalidatedInFlightBatchCount == 1)
    #expect(scheduler.metrics.invalidatedInFlightIdentifierCount == 2)
  }

  @Test("Canceled queued visible demand is retracted and promoted preheat can be restored")
  func canceledVisibleDemandIsReconciled() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let activeBatch = scheduler.replacePreheatDemand(with: ["active"], cacheGeneration: 0)
    let active = try #require(activeBatch)
    let queuedPreheat = scheduler.replacePreheatDemand(
      with: ["promoted", "preheat-only"], cacheGeneration: 0)
    let queuedVisible = scheduler.enqueueVisibleDemand(
      ["promoted", "canceled", "live"], cacheGeneration: 0)
    #expect(queuedPreheat == nil)
    #expect(queuedVisible == nil)

    let removed = scheduler.removeVisibleDemand(
      ["promoted", "canceled", "not-queued"], cacheGeneration: 0)
    let restoredPreheat = scheduler.replacePreheatDemand(
      with: ["promoted", "preheat-only"], cacheGeneration: 0)
    #expect(removed == 2)
    #expect(restoredPreheat == nil)
    #expect(scheduler.queuedVisibleIdentifiers == ["live"])
    #expect(scheduler.queuedPreheatIdentifiers == ["promoted", "preheat-only"])

    let activeCompletion = scheduler.finish(active)
    let visible = try #require(activeCompletion.nextBatch)
    #expect(visible.priority == .visible)
    #expect(visible.identifiers == ["live"])
    let visibleCompletion = scheduler.finish(visible)
    let preheat = try #require(visibleCompletion.nextBatch)
    #expect(preheat.priority == .preheat)
    #expect(preheat.identifiers == ["promoted", "preheat-only"])
    #expect(scheduler.metrics.removedQueuedVisibleIdentifierCount == 2)
  }

  @Test("A duplicate same-generation completion cannot release the next batch")
  func duplicateCompletionIsHarmless() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let firstBatch = scheduler.replacePreheatDemand(with: ["first"], cacheGeneration: 0)
    let first = try #require(firstBatch)
    let queuedVisible = scheduler.enqueueVisibleDemand(["second"], cacheGeneration: 0)
    #expect(queuedVisible == nil)

    let firstCompletion = scheduler.finish(first)
    let second = try #require(firstCompletion.nextBatch)
    let duplicateCompletion = scheduler.finish(first)

    #expect(!duplicateCompletion.accepted)
    #expect(duplicateCompletion.nextBatch == nil)
    #expect(scheduler.activeBatch == second)
  }

  @Test("Stale-generation demand cannot enter the current schedule")
  func staleGenerationDemandIsIgnored() {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState(cacheGeneration: 7)

    let stalePreheat = scheduler.replacePreheatDemand(
      with: ["stale-preheat"], cacheGeneration: 6)
    let staleVisible = scheduler.enqueueVisibleDemand(
      ["stale-visible"], cacheGeneration: 6)
    #expect(stalePreheat == nil)
    #expect(staleVisible == nil)
    #expect(scheduler.activeBatch == nil)
    #expect(scheduler.queuedVisibleIdentifiers.isEmpty)
    #expect(scheduler.queuedPreheatIdentifiers.isEmpty)
  }

  @Test("Preheat queues are bounded before a speculative batch starts")
  func boundedPreheatQueue() throws {
    #expect(
      PhotoAssetThumbnailAssetFetchSchedulerState.defaultMaximumQueuedPreheatIdentifierCount
        == PhotoAssetThumbnailPreheatRequest.maximumPayloadSize
    )
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState(
      maximumQueuedPreheatIdentifierCount: 3
    )

    let scheduledBatch = scheduler.replacePreheatDemand(
      with: ["one", "two", "three", "four"], cacheGeneration: 0)
    let batch = try #require(scheduledBatch)
    #expect(batch.identifiers == ["one", "two", "three"])
    #expect(scheduler.metrics.maximumQueuedPreheatIdentifierCount == 3)
  }

  @Test("Batch-source and queue high-water metrics follow actual scheduling")
  func schedulerMetrics() throws {
    var scheduler = PhotoAssetThumbnailAssetFetchSchedulerState()
    let preheatBatch = scheduler.replacePreheatDemand(with: ["preheat"], cacheGeneration: 0)
    let preheat = try #require(preheatBatch)
    let queuedPreheat = scheduler.replacePreheatDemand(
      with: ["promoted", "superseded"], cacheGeneration: 0)
    let queuedVisible = scheduler.enqueueVisibleDemand(
      ["promoted", "visible-a", "visible-b"], cacheGeneration: 0)
    #expect(queuedPreheat == nil)
    #expect(queuedVisible == nil)

    let preheatCompletion = scheduler.finish(preheat)
    let visible = try #require(preheatCompletion.nextBatch)
    let visibleCompletion = scheduler.finish(visible)
    let remainingPreheat = try #require(visibleCompletion.nextBatch)
    let metrics = scheduler.metrics

    #expect(metrics.preheatBatchCount == 2)
    #expect(metrics.preheatBatchIdentifierCount == 2)
    #expect(metrics.visibleBatchCount == 1)
    #expect(metrics.visibleBatchIdentifierCount == 3)
    #expect(metrics.visiblePromotionIdentifierCount == 1)
    #expect(metrics.maximumQueuedPreheatIdentifierCount == 2)
    #expect(metrics.maximumQueuedVisibleIdentifierCount == 3)
    #expect(metrics.activeBatchPriority == .preheat)
    #expect(remainingPreheat.identifiers == ["superseded"])
  }
}
