import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct ThumbnailScrollBenchmarkRunner: Sendable {
  private struct AssetSample {
    let assets: [ThumbnailScrollSamplePlan.Asset]
    let availableImageCount: Int
    let availableVideoCount: Int
    let imagesOnlyLimitation: String?
  }

  private static let columnCount = 3
  private static let targetVideoStride = 6

  public init() {}

  public func run(arguments: ProfilerArguments) async throws -> ThumbnailScrollBenchmarkReport {
    let requiredIdentifierCount = try ThumbnailScrollSamplePlan.requiredIdentifierCount(
      columnCount: Self.columnCount,
      visibleRowCount: arguments.thumbnailScrollVisibleRowCount,
      aheadRowCount: arguments.thumbnailScrollAheadRowCount,
      behindRowCount: arguments.thumbnailScrollBehindRowCount,
      flingTransitionCount: arguments.thumbnailScrollFlingTransitionCount,
      iterations: arguments.thumbnailScrollIterations
    )
    let assetSample = Self.recentMixedAssets(limit: requiredIdentifierCount)
    let plan = try ThumbnailScrollSamplePlan(
      assets: assetSample.assets,
      columnCount: Self.columnCount,
      visibleRowCount: arguments.thumbnailScrollVisibleRowCount,
      aheadRowCount: arguments.thumbnailScrollAheadRowCount,
      behindRowCount: arguments.thumbnailScrollBehindRowCount,
      flingTransitionCount: arguments.thumbnailScrollFlingTransitionCount,
      iterations: arguments.thumbnailScrollIterations
    )
    let target = try PhotoAssetThumbnailTarget(
      pixelWidth: arguments.thumbnailScrollPixelWidth,
      pixelHeight: arguments.thumbnailScrollPixelHeight
    )

    var measurements: [ThumbnailScrollBenchmarkReport.Measurement] = []
    measurements.reserveCapacity(plan.runs.count)
    for run in plan.runs {
      measurements.append(
        try await measure(
          run: run,
          target: target,
          timeoutMilliseconds: arguments.thumbnailScrollTimeoutMilliseconds,
          rssSampleIntervalMilliseconds: arguments.thumbnailScrollRssSampleIntervalMilliseconds
        )
      )
    }

    let budget = PhotoAssetThumbnailPreheatBudget.windowedV1
    return ThumbnailScrollBenchmarkReport(
      schemaVersion: 1,
      configuration: ThumbnailScrollBenchmarkReport.Configuration(
        columnCount: Self.columnCount,
        visibleRowCount: arguments.thumbnailScrollVisibleRowCount,
        aheadRowCount: arguments.thumbnailScrollAheadRowCount,
        behindRowCount: arguments.thumbnailScrollBehindRowCount,
        flingTransitionCount: arguments.thumbnailScrollFlingTransitionCount,
        pixelWidth: target.pixelWidth,
        pixelHeight: target.pixelHeight,
        iterations: arguments.thumbnailScrollIterations,
        timeoutMilliseconds: arguments.thumbnailScrollTimeoutMilliseconds,
        rssSampleIntervalMilliseconds: arguments.thumbnailScrollRssSampleIntervalMilliseconds,
        networkAccessAllowed: true,
        contentMode: "aspect-fill",
        requestSubmissionOrder:
          "visible request first, then the arm-specific preheat candidate ordering",
        workloadShape:
          "burst-forward: current visible, immediate speculative window replacements, then destination visible",
        preheatMaximumKeyCount: budget.maximumKeyCount,
        preheatMaximumPixelCount: budget.maximumPixelCount,
        preheatMaximumEstimatedByteCount: budget.maximumEstimatedByteCount,
        preheatEstimatedBytesPerPixel: PhotoAssetThumbnailPreheatBudget.estimatedBytesPerPixel
      ),
      mediaCoverage: ThumbnailScrollBenchmarkReport.MediaCoverage(
        supportedMediaTypes: ["image", "video"],
        videoThumbnailRequestPath:
          "PHCachingImageManager.requestImage(for:targetSize:contentMode:options:resultHandler:)",
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
      assetsPerAssignment: plan.assetsPerAssignment,
      measurements: measurements,
      comparisons: ThumbnailScrollBenchmarkReport.comparisons(measurements),
      validation: ThumbnailScrollBenchmarkReport.Validation(
        globallyDisjointAssignments: true,
        everyVisibleWindowCompletedExactly: true,
        noRawIdentifiersEncoded: true,
        logicalPreheatEmptyAfterEnd: true,
        schedulerStateEmptyAfterCacheCleanup: true
      )
    )
  }

  private func measure(
    run: ThumbnailScrollSamplePlan.Run,
    target: PhotoAssetThumbnailTarget,
    timeoutMilliseconds: Int,
    rssSampleIntervalMilliseconds: Int
  ) async throws -> ThumbnailScrollBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label:
        "com.jonluca.palate.photos-profiler.thumbnail-scroll.\(run.arm.rawValue).\(run.iteration)",
      qos: .userInitiated
    )
    let loader = InitialImageCandidateLoader(callbackQueue: callbackQueue)
    let sampler = ThumbnailScrollResidentMemorySampler(
      sampleIntervalMilliseconds: rssSampleIntervalMilliseconds
    )
    let currentKeys = try Self.keys(assets: run.assignment.currentVisibleAssets, target: target)
    let nextKeys = try Self.keys(assets: run.assignment.nextVisibleAssets, target: target)
    let samplePosition: InitialImageSamplePosition = run.recencySlot < 2 ? .earlier : .later

    try await sampler.start()
    let cycleStartedAt = DispatchTime.now().uptimeNanoseconds
    do {
      let currentSession = ThumbnailScrollWindowMeasurementSession(
        callbackQueue: callbackQueue,
        imageCount: currentKeys.count,
        iteration: run.iteration,
        samplePosition: samplePosition,
        timeoutMilliseconds: timeoutMilliseconds,
        requestedIdentifiers: currentKeys.map(\.assetIdentifier)
      ) {
        sampler.capture(.currentVisibleTerminal)
      }
      await currentSession.start { receive in
        loader.request(keys: currentKeys, receive: receive)
      }
      let currentRequestSubmittedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)

      let initialCandidates = run.assignment.candidateAssets(for: run.arm, at: 0)
      let initialCandidateKeys = try Self.keys(assets: initialCandidates, target: target)
      let initialPreheatSubmittedMilliseconds: Double?
      if run.arm == .control {
        initialPreheatSubmittedMilliseconds = nil
      } else {
        loader.preheat(keys: initialCandidateKeys)
        initialPreheatSubmittedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)
      }

      var rapidWindowPlans: [ThumbnailScrollBenchmarkReport.PlannedWindow] = []
      if run.arm != .control, run.assignment.flingTransitionCount > 1 {
        for transition in 1..<run.assignment.flingTransitionCount {
          let candidates = run.assignment.candidateAssets(for: run.arm, at: transition)
          let keys = try Self.keys(assets: candidates, target: target)
          rapidWindowPlans.append(Self.plannedWindow(keys: keys))
          loader.preheat(keys: keys)
        }
      }
      let rapidUpdatesSubmittedMilliseconds =
        rapidWindowPlans.isEmpty
        ? nil : Self.elapsedMilliseconds(since: cycleStartedAt)

      let nextSession = ThumbnailScrollWindowMeasurementSession(
        callbackQueue: callbackQueue,
        imageCount: nextKeys.count,
        iteration: run.iteration,
        samplePosition: samplePosition,
        timeoutMilliseconds: timeoutMilliseconds,
        requestedIdentifiers: nextKeys.map(\.assetIdentifier)
      ) {
        sampler.capture(.nextVisibleTerminal)
      }
      await nextSession.start { receive in
        loader.request(keys: nextKeys, receive: receive)
      }
      let nextRequestSubmittedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)

      let nextCandidates = run.assignment.candidateAssets(
        for: run.arm,
        at: run.assignment.flingTransitionCount
      )
      let nextCandidateKeys = try Self.keys(assets: nextCandidates, target: target)
      let nextPreheatSubmittedMilliseconds: Double?
      if run.arm == .control {
        nextPreheatSubmittedMilliseconds = nil
      } else {
        loader.preheat(keys: nextCandidateKeys)
        nextPreheatSubmittedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)
      }

      async let currentResult = currentSession.result()
      async let nextResult = nextSession.result()
      let (timedCurrent, timedNext) = await (currentResult, nextResult)
      try Self.validate(timedCurrent.measurement, arm: run.arm, phase: "current-visible")
      try Self.validate(timedNext.measurement, arm: run.arm, phase: "next-visible")
      let validationCompletedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)

      let metricsAfterVisibleWindows = await loader.readMetrics()
      let metricsCapturedMilliseconds = Self.elapsedMilliseconds(since: cycleStartedAt)
      _ = await loader.endPreheatAndReadMetrics()
      let metricsAfterPreheatEnd = try await Self.awaitSchedulerIdle(
        loader: loader,
        timeoutMilliseconds: timeoutMilliseconds,
        arm: run.arm,
        iteration: run.iteration
      )
      guard metricsAfterPreheatEnd.preheat.activeKeyCount == 0,
        metricsAfterPreheatEnd.preheat.pendingKeyCount == 0
      else {
        throw ThumbnailScrollBenchmarkError.invalidMeasurement(
          arm: run.arm,
          iteration: run.iteration,
          reason: "logical preheat state remained active after ending the lease"
        )
      }
      sampler.capture(.afterPreheatEnd)
      await loader.clear()
      let metricsAfterCacheCleanup = await loader.readMetrics()
      let schedulerAfterCleanup = metricsAfterCacheCleanup.assetFetchScheduler
      guard schedulerAfterCleanup.activeBatchPriority == nil,
        schedulerAfterCleanup.queuedPreheatIdentifierCount == 0,
        schedulerAfterCleanup.queuedVisibleIdentifierCount == 0
      else {
        throw ThumbnailScrollBenchmarkError.invalidMeasurement(
          arm: run.arm,
          iteration: run.iteration,
          reason: "scheduler state remained active after cache invalidation"
        )
      }
      sampler.capture(.afterCacheCleanup)
      let memorySnapshot = try await sampler.stop()
      try Self.validateMemory(memorySnapshot, arm: run.arm, iteration: run.iteration)

      return ThumbnailScrollBenchmarkReport.Measurement(
        arm: run.arm,
        iteration: run.iteration,
        recencySlot: run.recencySlot,
        executionPosition: run.executionPosition,
        assignmentIdentifierDigest: run.assignment.identifierDigest,
        assignmentImageCount: run.assignment.imageCount,
        assignmentVideoCount: run.assignment.videoCount,
        rapidPreheatUpdateCount: rapidWindowPlans.count,
        initialWindowPlan: Self.plannedWindow(keys: initialCandidateKeys),
        rapidWindowPlans: rapidWindowPlans,
        nextWindowPlan: Self.plannedWindow(keys: nextCandidateKeys),
        currentVisible: timedCurrent.measurement,
        nextVisible: timedNext.measurement,
        continuousTiming: ThumbnailScrollBenchmarkReport.ContinuousTiming(
          elapsedThroughNextVisibleTerminalMilliseconds: Self.elapsedMilliseconds(
            since: cycleStartedAt,
            through: timedNext.terminalUptimeNanoseconds
          ),
          elapsedThroughAllIssuedVisibleTerminalsMilliseconds: Self.elapsedMilliseconds(
            since: cycleStartedAt,
            through: max(
              timedCurrent.terminalUptimeNanoseconds,
              timedNext.terminalUptimeNanoseconds
            )
          ),
          phaseMarkers: ThumbnailScrollBenchmarkReport.PhaseMarkers(
            currentVisibleRequestSubmittedMilliseconds: currentRequestSubmittedMilliseconds,
            initialPreheatSubmittedMilliseconds: initialPreheatSubmittedMilliseconds,
            rapidPreheatUpdatesSubmittedMilliseconds: rapidUpdatesSubmittedMilliseconds,
            nextVisibleRequestSubmittedMilliseconds: nextRequestSubmittedMilliseconds,
            nextVisiblePreheatSubmittedMilliseconds: nextPreheatSubmittedMilliseconds,
            currentVisibleTerminalMilliseconds: Self.elapsedMilliseconds(
              since: cycleStartedAt,
              through: timedCurrent.terminalUptimeNanoseconds
            ),
            nextVisibleTerminalMilliseconds: Self.elapsedMilliseconds(
              since: cycleStartedAt,
              through: timedNext.terminalUptimeNanoseconds
            ),
            validationCompletedMilliseconds: validationCompletedMilliseconds,
            metricsCapturedMilliseconds: metricsCapturedMilliseconds
          )
        ),
        metricsAfterVisibleWindows: ThumbnailScrollBenchmarkReport.StoreMetrics(
          metricsAfterVisibleWindows
        ),
        metricsAfterPreheatEnd: ThumbnailScrollBenchmarkReport.StoreMetrics(
          metricsAfterPreheatEnd
        ),
        metricsAfterCacheCleanup: ThumbnailScrollBenchmarkReport.StoreMetrics(
          metricsAfterCacheCleanup
        ),
        memory: ThumbnailScrollBenchmarkReport.MemoryMeasurement(memorySnapshot)
      )
    } catch {
      await loader.clear()
      _ = try? await sampler.stop()
      throw error
    }
  }

  static func plannedWindow(
    keys: [PhotoAssetThumbnailRequestKey]
  ) -> ThumbnailScrollBenchmarkReport.PlannedWindow {
    var digest = ThumbnailScrollOrderedIdentifierDigest()
    for key in keys {
      digest.add(key.assetIdentifier)
    }

    let budget = PhotoAssetThumbnailPreheatBudget.windowedV1
    let pixelsPerKey =
      UInt64(keys.first?.target.pixelWidth ?? 0)
      * UInt64(keys.first?.target.pixelHeight ?? 0)
    let estimatedBytesPerKey =
      pixelsPerKey
      * PhotoAssetThumbnailPreheatBudget.estimatedBytesPerPixel
    let pixelBound = pixelsPerKey == 0 ? 0 : Int(budget.maximumPixelCount / pixelsPerKey)
    let byteBound =
      estimatedBytesPerKey == 0
      ? 0 : Int(budget.maximumEstimatedByteCount / estimatedBytesPerKey)
    let selectedCount = min(keys.count, budget.maximumKeyCount, pixelBound, byteBound)
    return ThumbnailScrollBenchmarkReport.PlannedWindow(
      requestedCandidateCount: keys.count,
      requestedCandidateOrderedDigest: digest.signature,
      expectedMaximumSelectedKeyCount: selectedCount,
      expectedMaximumSelectedPixelCount: UInt64(selectedCount) * pixelsPerKey,
      expectedMaximumSelectedEstimatedByteCount: UInt64(selectedCount) * estimatedBytesPerKey
    )
  }

  private static func keys(
    assets: [ThumbnailScrollSamplePlan.Asset],
    target: PhotoAssetThumbnailTarget
  ) throws -> [PhotoAssetThumbnailRequestKey] {
    try assets.map { asset in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: asset.identifier,
        target: target,
        contentMode: .aspectFill
      )
    }
  }

  static func validate(
    _ measurement: InitialImageBenchmarkReport.Measurement,
    arm: ThumbnailScrollBenchmarkArm,
    phase: String
  ) throws {
    let reason: String?
    if measurement.requestedCount != measurement.imageCount {
      reason = "\(phase) requested count did not match the visible image count"
    } else if measurement.finalCount != measurement.requestedCount {
      reason = "\(phase) did not produce one final image for every request"
    } else if measurement.failureCount != 0 {
      reason = "\(phase) recorded \(measurement.failureCount) failure(s)"
    } else if measurement.timedOutCount != 0 {
      reason = "\(phase) recorded \(measurement.timedOutCount) timeout(s)"
    } else if measurement.unexpectedEventCount != 0 {
      reason = "\(phase) received an event for an unrequested identifier"
    } else if measurement.duplicateTerminalEventCount != 0 {
      reason = "\(phase) received a duplicate terminal event"
    } else if measurement.invalidDimensionCount != 0 {
      reason = "\(phase) received an image with invalid dimensions"
    } else if measurement.requestedIdentifierDigest != measurement.finalIdentifierDigest {
      reason = "\(phase) final identifier digest did not match the requested digest"
    } else if measurement.finalDimensions == nil {
      reason = "\(phase) did not record final decoded dimensions"
    } else {
      reason = nil
    }

    if let reason {
      throw ThumbnailScrollBenchmarkError.invalidMeasurement(
        arm: arm,
        iteration: measurement.iteration,
        reason: reason
      )
    }
  }

  private static func validateMemory(
    _ snapshot: ThumbnailScrollResidentMemorySampler.Snapshot,
    arm: ThumbnailScrollBenchmarkArm,
    iteration: Int
  ) throws {
    guard snapshot.currentVisibleTerminalBytes != nil,
      snapshot.nextVisibleTerminalBytes != nil,
      snapshot.nextVisibleTerminalSampledPeakBytes != nil,
      snapshot.afterPreheatEndBytes != nil,
      snapshot.afterCacheCleanupBytes != nil,
      snapshot.sampleCount >= 5
    else {
      throw ThumbnailScrollBenchmarkError.invalidMeasurement(
        arm: arm,
        iteration: iteration,
        reason: "one or more required sampled RSS checkpoints were unavailable"
      )
    }
  }

  private static func awaitSchedulerIdle(
    loader: InitialImageCandidateLoader,
    timeoutMilliseconds: Int,
    arm: ThumbnailScrollBenchmarkArm,
    iteration: Int
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
      if elapsedMilliseconds(since: startedAt) >= Double(timeoutMilliseconds) {
        throw ThumbnailScrollBenchmarkError.invalidMeasurement(
          arm: arm,
          iteration: iteration,
          reason: "the physical asset-fetch scheduler did not become idle before cleanup"
        )
      }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
  }

  private static func recentMixedAssets(limit: Int) -> AssetSample {
    let images = recentIdentifiers(mediaType: .image, identifierLimit: limit)
    let videos = recentIdentifiers(mediaType: .video, identifierLimit: limit)
    let desiredVideoCount = min(videos.identifiers.count, max(1, limit / targetVideoStride))
    let initialImageCount = min(images.identifiers.count, limit - desiredVideoCount)
    let videoCount = min(videos.identifiers.count, limit - initialImageCount)
    let imageCount = min(images.identifiers.count, limit - videoCount)

    var assets: [ThumbnailScrollSamplePlan.Asset] = []
    assets.reserveCapacity(imageCount + videoCount)
    var imageIndex = 0
    var videoIndex = 0
    while assets.count < imageCount + videoCount {
      let wantsVideo = (assets.count + 1).isMultiple(of: targetVideoStride)
      if wantsVideo, videoIndex < videoCount {
        assets.append(
          ThumbnailScrollSamplePlan.Asset(
            identifier: videos.identifiers[videoIndex],
            mediaType: .video
          )
        )
        videoIndex += 1
      } else if imageIndex < imageCount {
        assets.append(
          ThumbnailScrollSamplePlan.Asset(
            identifier: images.identifiers[imageIndex],
            mediaType: .image
          )
        )
        imageIndex += 1
      } else if videoIndex < videoCount {
        assets.append(
          ThumbnailScrollSamplePlan.Asset(
            identifier: videos.identifiers[videoIndex],
            mediaType: .video
          )
        )
        videoIndex += 1
      }
    }

    let limitation =
      videoCount == 0
      ? "This Photos library exposed no eligible videos, so the run is images-only."
      : nil
    return AssetSample(
      assets: assets,
      availableImageCount: images.availableCount,
      availableVideoCount: videos.availableCount,
      imagesOnlyLimitation: limitation
    )
  }

  private static func recentIdentifiers(
    mediaType: PHAssetMediaType,
    identifierLimit: Int
  ) -> (
    identifiers: [String], availableCount: Int
  ) {
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.includeAssetSourceTypes = .typeUserLibrary
    options.includeAllBurstAssets = false
    options.includeHiddenAssets = false
    let result = PHAsset.fetchAssets(with: mediaType, options: options)
    var identifiers: [String] = []
    identifiers.reserveCapacity(min(identifierLimit, result.count))
    result.enumerateObjects { asset, index, stop in
      guard index < identifierLimit else {
        stop.pointee = true
        return
      }
      identifiers.append(asset.localIdentifier)
    }
    return (identifiers, result.count)
  }

  private static func elapsedMilliseconds(since start: UInt64) -> Double {
    elapsedMilliseconds(since: start, through: DispatchTime.now().uptimeNanoseconds)
  }

  private static func elapsedMilliseconds(since start: UInt64, through end: UInt64) -> Double {
    Double(end - start) / 1_000_000
  }
}
