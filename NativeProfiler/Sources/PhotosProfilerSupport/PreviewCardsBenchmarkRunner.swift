import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct PreviewCardsBenchmarkRunner: Sendable {
  private struct AssetSample {
    let assets: [PreviewCardsSamplePlan.Asset]
    let availableImageCount: Int
    let availableVideoCount: Int
    let imagesOnlyLimitation: String?
  }

  static let targetVideoStride = 8

  public init() {}

  public func run(arguments: ProfilerArguments) async throws -> PreviewCardsBenchmarkReport {
    let required = try PreviewCardsSamplePlan.requiredIdentifierCount(
      visibleCardCount: arguments.previewCardVisibleCount,
      iterations: arguments.previewCardIterations
    )
    let assetSample = Self.recentMixedAssets(limit: required)
    let plan = try PreviewCardsSamplePlan(
      assets: assetSample.assets,
      visibleCardCount: arguments.previewCardVisibleCount,
      iterations: arguments.previewCardIterations
    )
    let geometry = try PreviewCardsGeometry(
      totalCardPixelWidth: arguments.previewCardPixelWidth,
      cardPixelHeight: arguments.previewCardPixelHeight
    )

    var measurements: [PreviewCardsBenchmarkReport.Measurement] = []
    measurements.reserveCapacity(plan.runs.count)
    for run in plan.runs {
      let requests = try Self.requests(for: run.assignment, geometry: geometry)
      let measurement: PreviewCardsBenchmarkReport.Measurement
      switch run.strategy {
      case .expoPhotoLibraryAssetLoaderPhotoKit:
        measurement = try await measureBaseline(
          run: run,
          requests: requests,
          timeoutMilliseconds: arguments.previewCardTimeoutMilliseconds,
          rssSampleIntervalMilliseconds: arguments.previewCardRssSampleIntervalMilliseconds
        )
      case .photoAssetThumbnailStore:
        measurement = try await measureCandidate(
          run: run,
          requests: requests,
          timeoutMilliseconds: arguments.previewCardTimeoutMilliseconds,
          rssSampleIntervalMilliseconds: arguments.previewCardRssSampleIntervalMilliseconds
        )
      }
      measurements.append(measurement)
    }

    let layouts = try PreviewCardsGeometry.supportedArities.map { arity in
      let target = try geometry.target(for: arity)
      return PreviewCardsBenchmarkReport.CardLayout(
        arity: arity,
        itemPixelWidth: target.pixelWidth,
        itemPixelHeight: target.pixelHeight
      )
    }
    let validation = try Self.validation(
      plan: plan,
      measurements: measurements,
      availableVideoCount: assetSample.availableVideoCount
    )
    return PreviewCardsBenchmarkReport(
      schemaVersion: 1,
      configuration: PreviewCardsBenchmarkReport.Configuration(
        visibleCardCount: arguments.previewCardVisibleCount,
        supportedCardArities: PreviewCardsGeometry.supportedArities,
        totalCardPixelWidth: geometry.totalCardPixelWidth,
        cardPixelHeight: geometry.cardPixelHeight,
        cardLayouts: layouts,
        iterations: arguments.previewCardIterations,
        timeoutMilliseconds: arguments.previewCardTimeoutMilliseconds,
        rssSampleIntervalMilliseconds: arguments.previewCardRssSampleIntervalMilliseconds,
        rssMeasurementScope:
          "Per-run RSS baselines are captured after the profiler creates that run's loader/store; samples are same-process diagnostics and may retain allocator or PhotoKit cache state from earlier runs.",
        networkAccessAllowed: true,
        preheatEnabled: false,
        baselinePhotoKitBehavior:
          "One PHAsset.fetchAssets call per item; PHImageManager.default; current version; highQualityFormat delivery; fast resize; aspectFit request at a source-aspect cover target.",
        candidatePhotoKitBehavior:
          "PhotoAssetThumbnailStore; batched PHAsset fetch; PHCachingImageManager; opportunistic delivery; exact resize; aspectFill at the card item target.",
        cacheParityScope:
          "Cold, globally disjoint underlying PhotoKit behavior only. This does not claim parity with expo-image/SDWebImage warm memory or disk caches.",
        workloadShape:
          "\(arguments.previewCardVisibleCount) visible cards, rotating 1/2/3-item card arities; assets are stratified from separate recent-image and recent-video PhotoKit lists, and every item is submitted together as one visible strip.",
        cancelResubmitDiagnostic:
          "Deferred: this schema measures cold visible-strip loading and does not include a cancel/resubmit arm.",
        warmRevisitDiagnostic:
          "Deferred: this schema intentionally uses globally disjoint assets and does not claim warm-revisit cache parity."
      ),
      mediaCoverage: PreviewCardsBenchmarkReport.MediaCoverage(
        supportedMediaTypes: ["image", "video"],
        targetVideoStride: Self.targetVideoStride,
        availableImageCount: assetSample.availableImageCount,
        availableVideoCount: assetSample.availableVideoCount,
        sampledImageCount: plan.sampledImageCount,
        sampledVideoCount: plan.sampledVideoCount,
        imagesOnlyLimitation: assetSample.imagesOnlyLimitation
      ),
      availableEligibleAssetCount: assetSample.availableImageCount
        + assetSample.availableVideoCount,
      sampledIdentifierCount: plan.sampledIdentifierCount,
      sampledIdentifierDigest: plan.sampledIdentifierDigest,
      measurements: measurements,
      comparison: PreviewCardsBenchmarkReport.comparison(measurements),
      validation: validation
    )
  }

  private static func validation(
    plan: PreviewCardsSamplePlan,
    measurements: [PreviewCardsBenchmarkReport.Measurement],
    availableVideoCount: Int
  ) throws -> PreviewCardsBenchmarkReport.Validation {
    let candidateMeasurements = measurements.filter {
      $0.strategy == .photoAssetThumbnailStore
    }
    let everyStripBecameRenderable =
      measurements.count == plan.runs.count
      && measurements.allSatisfy { measurement in
        measurement.load.renderableCount == measurement.load.requestedCount
          && measurement.load.allStripRenderableMilliseconds != nil
      }
    let everyRequestCompletedExactly =
      measurements.count == plan.runs.count
      && measurements.allSatisfy { measurement in
        measurement.load.finalCount == measurement.load.requestedCount
          && measurement.load.failureCount == 0
          && measurement.load.timedOutCount == 0
      }
    let matchingRequestedAndFinalDigests = measurements.allSatisfy { measurement in
      measurement.load.requestedIdentifierDigest == measurement.assignmentIdentifierDigest
        && measurement.load.finalIdentifierDigest == measurement.load.requestedIdentifierDigest
    }
    let validDecodedDimensions = measurements.allSatisfy { measurement in
      measurement.load.invalidDimensionCount == 0
        && (measurement.load.finalDimensions?.totalDecodedPixels ?? 0) > 0
    }
    let noUnexpectedOrStaleEvents = measurements.allSatisfy { measurement in
      measurement.load.unexpectedEventCount == 0 && measurement.load.staleEventCount == 0
    }
    let candidateStoreSchedulerQuiescent =
      candidateMeasurements.count * 2 == measurements.count
      && candidateMeasurements.allSatisfy { measurement in
        guard let metrics = measurement.storeMetricsAfterCleanup else {
          return false
        }
        return metrics.assetFetchScheduler.activeBatchPriority == nil
          && metrics.assetFetchScheduler.queuedPreheatIdentifierCount == 0
          && metrics.assetFetchScheduler.queuedVisibleIdentifierCount == 0
          && metrics.preheat.activeKeyCount == 0
          && metrics.preheat.pendingKeyCount == 0
      }
    let candidatePreheatUnused = candidateMeasurements.allSatisfy { measurement in
      guard let metrics = measurement.storeMetricsAtTerminal else {
        return false
      }
      return metrics.preheat.updateCount == 0
        && metrics.preheat.startedKeyCount == 0
        && metrics.preheat.stoppedKeyCount == 0
        && metrics.preheat.retainedKeyCount == 0
        && metrics.preheat.fetchIdentifierCount == 0
        && metrics.preheat.cacheStartCallCount == 0
        && metrics.preheat.cacheStopCallCount == 0
        && metrics.preheat.activeKeyCount == 0
        && metrics.preheat.pendingKeyCount == 0
    }
    let encodedMeasurements = try JSONEncoder().encode(measurements)
    let encodedObject = try JSONSerialization.jsonObject(with: encodedMeasurements)
    let encodedStrings = Self.strings(in: encodedObject)
    let rawIdentifiers = plan.runs.flatMap { $0.assignment.assets.map(\.identifier) }
    let noRawIdentifiersEncoded = encodedStrings.allSatisfy { encodedString in
      rawIdentifiers.allSatisfy { !encodedString.contains($0) }
    }
    let result = PreviewCardsBenchmarkReport.Validation(
      globallyDisjointAssignments: plan.hasGloballyDisjointAssignments,
      counterbalancedRecencyExecutionAndGeometry: plan.isFullyCounterbalanced,
      mixedMediaCoverage: plan.sampledImageCount > 0
        && (availableVideoCount == 0 || plan.sampledVideoCount > 0),
      everyStripBecameRenderable: everyStripBecameRenderable,
      everyRequestCompletedExactly: everyRequestCompletedExactly,
      matchingRequestedAndFinalDigests: matchingRequestedAndFinalDigests,
      validDecodedDimensions: validDecodedDimensions,
      noUnexpectedOrStaleEvents: noUnexpectedOrStaleEvents,
      candidateStoreSchedulerQuiescent: candidateStoreSchedulerQuiescent,
      candidatePreheatUnused: candidatePreheatUnused,
      noRawIdentifiersEncoded: noRawIdentifiersEncoded
    )
    let checks = [
      ("globally disjoint assignments", result.globallyDisjointAssignments),
      (
        "independent recency/execution/geometry counterbalance",
        result.counterbalancedRecencyExecutionAndGeometry
      ),
      ("available mixed-media coverage", result.mixedMediaCoverage),
      ("all strips renderable", result.everyStripBecameRenderable),
      ("exact terminal results", result.everyRequestCompletedExactly),
      ("identifier digest parity", result.matchingRequestedAndFinalDigests),
      ("decoded dimensions", result.validDecodedDimensions),
      ("unexpected/stale events", result.noUnexpectedOrStaleEvents),
      ("candidate scheduler quiescence", result.candidateStoreSchedulerQuiescent),
      ("candidate preheat unused", result.candidatePreheatUnused),
      ("aggregate-only identifier privacy", result.noRawIdentifiersEncoded),
    ]
    if let failed = checks.first(where: { !$0.1 }) {
      throw PreviewCardsBenchmarkError.invalidReport(reason: failed.0)
    }
    return result
  }

  private func measureBaseline(
    run: PreviewCardsSamplePlan.Run,
    requests: [PreviewCardsAssetRequest],
    timeoutMilliseconds: Int,
    rssSampleIntervalMilliseconds: Int
  ) async throws -> PreviewCardsBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label:
        "com.jonluca.palate.photos-profiler.preview-cards.baseline.\(run.iteration)",
      qos: .userInitiated
    )
    let loader = PreviewCardsBaselineLoader(callbackQueue: callbackQueue)
    let sampler = PreviewCardsResidentMemorySampler(
      sampleIntervalMilliseconds: rssSampleIntervalMilliseconds
    )
    try await sampler.start()
    do {
      let session = PreviewCardsMeasurementSession(
        callbackQueue: callbackQueue,
        requests: requests,
        cardCount: run.assignment.cards.count,
        displayDegradedImages: false,
        timeoutMilliseconds: timeoutMilliseconds,
        onAllStripRenderable: { sampler.capture(.allStripRenderable) },
        onAllFinal: { sampler.capture(.allFinal) }
      )
      let load = await session.run { receive in
        loader.request(requests: requests, receive: receive).map { token in
          { token.cancel() }
        }
      }
      try Self.validate(load, run: run)
      sampler.capture(.afterTeardown)
      let memory = try await sampler.stop()
      try Self.validateMemory(memory, run: run)
      return Self.measurement(
        run: run,
        load: load,
        metricsAtTerminal: nil,
        metricsAfterCleanup: nil,
        memory: memory
      )
    } catch {
      _ = try? await sampler.stop()
      throw error
    }
  }

  private func measureCandidate(
    run: PreviewCardsSamplePlan.Run,
    requests: [PreviewCardsAssetRequest],
    timeoutMilliseconds: Int,
    rssSampleIntervalMilliseconds: Int
  ) async throws -> PreviewCardsBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label:
        "com.jonluca.palate.photos-profiler.preview-cards.candidate.\(run.iteration)",
      qos: .userInitiated
    )
    let loader = InitialImageCandidateLoader(callbackQueue: callbackQueue)
    let keys = try requests.map { request in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: request.identifier,
        target: request.target,
        contentMode: .aspectFill
      )
    }
    let sampler = PreviewCardsResidentMemorySampler(
      sampleIntervalMilliseconds: rssSampleIntervalMilliseconds
    )
    try await sampler.start()
    do {
      let session = PreviewCardsMeasurementSession(
        callbackQueue: callbackQueue,
        requests: requests,
        cardCount: run.assignment.cards.count,
        displayDegradedImages: true,
        timeoutMilliseconds: timeoutMilliseconds,
        onAllStripRenderable: { sampler.capture(.allStripRenderable) },
        onAllFinal: { sampler.capture(.allFinal) }
      )
      let load = await session.run { receive in
        loader.request(keys: keys, receive: receive)
      }
      try Self.validate(load, run: run)
      let metricsAtTerminal = try await Self.awaitSchedulerIdle(
        loader: loader,
        timeoutMilliseconds: timeoutMilliseconds,
        run: run
      )
      try Self.validatePreheatUnused(metricsAtTerminal, run: run)
      await loader.clear()
      let metricsAfterCleanup = await loader.readMetrics()
      try Self.validateSchedulerQuiescent(metricsAfterCleanup, run: run)
      sampler.capture(.afterTeardown)
      let memory = try await sampler.stop()
      try Self.validateMemory(memory, run: run)
      return Self.measurement(
        run: run,
        load: load,
        metricsAtTerminal: metricsAtTerminal,
        metricsAfterCleanup: metricsAfterCleanup,
        memory: memory
      )
    } catch {
      await loader.clear()
      _ = try? await sampler.stop()
      throw error
    }
  }

  private static func measurement(
    run: PreviewCardsSamplePlan.Run,
    load: PreviewCardsBenchmarkReport.LoadMeasurement,
    metricsAtTerminal: PhotoAssetThumbnailStoreMetrics?,
    metricsAfterCleanup: PhotoAssetThumbnailStoreMetrics?,
    memory: PreviewCardsResidentMemorySampler.Snapshot
  ) -> PreviewCardsBenchmarkReport.Measurement {
    PreviewCardsBenchmarkReport.Measurement(
      strategy: run.strategy,
      iteration: run.iteration,
      recencySlot: run.recencySlot,
      executionPosition: run.executionPosition,
      cardArities: run.assignment.arities,
      assignmentIdentifierDigest: run.assignment.identifierDigest,
      assignmentOrderedIdentifierDigest: run.assignment.orderedIdentifierDigest,
      assignmentImageCount: run.assignment.imageCount,
      assignmentVideoCount: run.assignment.videoCount,
      load: load,
      storeMetricsAtTerminal: metricsAtTerminal.map(
        ThumbnailScrollBenchmarkReport.StoreMetrics.init
      ),
      storeMetricsAfterCleanup: metricsAfterCleanup.map(
        ThumbnailScrollBenchmarkReport.StoreMetrics.init
      ),
      memory: PreviewCardsBenchmarkReport.MemoryMeasurement(memory)
    )
  }

  static func validate(
    _ load: PreviewCardsBenchmarkReport.LoadMeasurement,
    run: PreviewCardsSamplePlan.Run
  ) throws {
    let expectedCount = run.assignment.assets.count
    let reason: String?
    if load.requestedCount != expectedCount {
      reason = "requested count did not match the assigned card assets"
    } else if load.cardCount != run.assignment.cards.count {
      reason = "card count did not match the assigned visible cards"
    } else if load.renderableCount != expectedCount || load.allStripRenderableMilliseconds == nil {
      reason = "the full visible card strip did not become renderable"
    } else if load.finalCount != expectedCount || load.allFinalMilliseconds == nil {
      reason = "the full visible card strip did not produce final images"
    } else if load.failureCount != 0 || load.timedOutCount != 0 {
      reason = "the visible card strip recorded a failure or timeout"
    } else if load.unexpectedEventCount != 0 || load.staleEventCount != 0 {
      reason = "the visible card strip received an unexpected or stale event"
    } else if load.invalidDimensionCount != 0 {
      reason = "the visible card strip received an invalid decoded dimension"
    } else if load.requestedIdentifierDigest != run.assignment.identifierDigest {
      reason = "requested identifier digest did not match the assignment"
    } else if load.finalIdentifierDigest != load.requestedIdentifierDigest {
      reason = "final identifier digest did not match the requested digest"
    } else if load.finalDimensions == nil
      || load.finalDimensions?.totalDecodedPixels ?? 0 <= 0
    {
      reason = "final decoded dimensions were unavailable"
    } else {
      reason = nil
    }
    if let reason {
      throw PreviewCardsBenchmarkError.invalidMeasurement(
        strategy: run.strategy,
        iteration: run.iteration,
        reason: reason
      )
    }
  }

  private static func validatePreheatUnused(
    _ metrics: PhotoAssetThumbnailStoreMetrics,
    run: PreviewCardsSamplePlan.Run
  ) throws {
    let preheat = metrics.preheat
    guard preheat.updateCount == 0,
      preheat.startedKeyCount == 0,
      preheat.stoppedKeyCount == 0,
      preheat.retainedKeyCount == 0,
      preheat.fetchIdentifierCount == 0,
      preheat.cacheStartCallCount == 0,
      preheat.cacheStopCallCount == 0,
      preheat.activeKeyCount == 0,
      preheat.pendingKeyCount == 0
    else {
      throw PreviewCardsBenchmarkError.invalidMeasurement(
        strategy: run.strategy,
        iteration: run.iteration,
        reason: "the cold preview-card candidate unexpectedly used preheat state"
      )
    }
  }

  private static func validateSchedulerQuiescent(
    _ metrics: PhotoAssetThumbnailStoreMetrics,
    run: PreviewCardsSamplePlan.Run
  ) throws {
    let scheduler = metrics.assetFetchScheduler
    guard scheduler.activeBatchPriority == nil,
      scheduler.queuedPreheatIdentifierCount == 0,
      scheduler.queuedVisibleIdentifierCount == 0,
      metrics.preheat.activeKeyCount == 0,
      metrics.preheat.pendingKeyCount == 0
    else {
      throw PreviewCardsBenchmarkError.invalidMeasurement(
        strategy: run.strategy,
        iteration: run.iteration,
        reason: "the candidate store was not physically quiescent after cleanup"
      )
    }
  }

  private static func validateMemory(
    _ snapshot: PreviewCardsResidentMemorySampler.Snapshot,
    run: PreviewCardsSamplePlan.Run
  ) throws {
    guard snapshot.allStripRenderableBytes != nil,
      snapshot.allFinalBytes != nil,
      snapshot.afterTeardownBytes != nil,
      snapshot.sampleCount >= 5
    else {
      throw PreviewCardsBenchmarkError.invalidMeasurement(
        strategy: run.strategy,
        iteration: run.iteration,
        reason: "one or more required sampled RSS checkpoints were unavailable"
      )
    }
  }

  private static func awaitSchedulerIdle(
    loader: InitialImageCandidateLoader,
    timeoutMilliseconds: Int,
    run: PreviewCardsSamplePlan.Run
  ) async throws -> PhotoAssetThumbnailStoreMetrics {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    while true {
      let metrics = await loader.readMetrics()
      let scheduler = metrics.assetFetchScheduler
      if scheduler.activeBatchPriority == nil,
        scheduler.queuedPreheatIdentifierCount == 0,
        scheduler.queuedVisibleIdentifierCount == 0
      {
        return metrics
      }
      let elapsed = Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
      if elapsed >= Double(timeoutMilliseconds) {
        throw PreviewCardsBenchmarkError.invalidMeasurement(
          strategy: run.strategy,
          iteration: run.iteration,
          reason: "the candidate asset-fetch scheduler did not become idle"
        )
      }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
  }

  private static func requests(
    for assignment: PreviewCardsSamplePlan.Assignment,
    geometry: PreviewCardsGeometry
  ) throws -> [PreviewCardsAssetRequest] {
    try assignment.cards.flatMap { card in
      let target = try geometry.target(for: card.arity)
      return card.assets.map { asset in
        PreviewCardsAssetRequest(identifier: asset.identifier, target: target)
      }
    }
  }

  private static func strings(in value: Any) -> [String] {
    if let string = value as? String {
      return [string]
    }
    if let array = value as? [Any] {
      return array.flatMap(strings(in:))
    }
    if let dictionary = value as? [String: Any] {
      return dictionary.keys + dictionary.values.flatMap(strings(in:))
    }
    return []
  }

  private static func recentMixedAssets(limit: Int) -> AssetSample {
    let images = recentIdentifiers(mediaType: .image, limit: limit)
    let videos = recentIdentifiers(mediaType: .video, limit: limit)
    let assets = interleave(
      imageIdentifiers: images.identifiers,
      videoIdentifiers: videos.identifiers,
      limit: limit
    )
    return AssetSample(
      assets: assets,
      availableImageCount: images.availableCount,
      availableVideoCount: videos.availableCount,
      imagesOnlyLimitation: videos.identifiers.isEmpty
        ? "This Photos library exposed no eligible videos, so the run is images-only."
        : nil
    )
  }

  static func interleave(
    imageIdentifiers: [String],
    videoIdentifiers: [String],
    limit: Int
  ) -> [PreviewCardsSamplePlan.Asset] {
    guard limit > 0 else {
      return []
    }
    let desiredVideoCount = min(
      videoIdentifiers.count,
      (limit + targetVideoStride - 1) / targetVideoStride
    )
    let desiredImageCount = min(imageIdentifiers.count, limit - desiredVideoCount)
    let videoCount = min(videoIdentifiers.count, limit - desiredImageCount)
    let imageCount = min(imageIdentifiers.count, limit - videoCount)
    var imageIndex = 0
    var videoIndex = 0
    var assets: [PreviewCardsSamplePlan.Asset] = []
    assets.reserveCapacity(imageCount + videoCount)
    while assets.count < imageCount + videoCount {
      let wantsVideo = assets.count.isMultiple(of: targetVideoStride)
      if wantsVideo, videoIndex < videoCount {
        assets.append(
          PreviewCardsSamplePlan.Asset(
            identifier: videoIdentifiers[videoIndex],
            mediaType: .video
          )
        )
        videoIndex += 1
      } else if imageIndex < imageCount {
        assets.append(
          PreviewCardsSamplePlan.Asset(
            identifier: imageIdentifiers[imageIndex],
            mediaType: .image
          )
        )
        imageIndex += 1
      } else if videoIndex < videoCount {
        assets.append(
          PreviewCardsSamplePlan.Asset(
            identifier: videoIdentifiers[videoIndex],
            mediaType: .video
          )
        )
        videoIndex += 1
      }
    }
    return assets
  }

  private static func recentIdentifiers(
    mediaType: PHAssetMediaType,
    limit: Int
  ) -> (identifiers: [String], availableCount: Int) {
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.includeAssetSourceTypes = .typeUserLibrary
    options.includeAllBurstAssets = false
    options.includeHiddenAssets = false
    let result = PHAsset.fetchAssets(with: mediaType, options: options)
    var identifiers: [String] = []
    identifiers.reserveCapacity(min(limit, result.count))
    result.enumerateObjects { asset, index, stop in
      guard index < limit else {
        stop.pointee = true
        return
      }
      identifiers.append(asset.localIdentifier)
    }
    return (identifiers, result.count)
  }
}
