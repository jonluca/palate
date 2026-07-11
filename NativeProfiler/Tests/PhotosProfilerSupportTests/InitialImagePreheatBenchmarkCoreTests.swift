import Foundation
import Testing

@testable import BatchAssetInfoCore
@testable import PhotosProfilerSupport

@Suite("Initial-image preheat benchmark core")
struct InitialImagePreheatBenchmarkCoreTests {
  @Test("Measurement session exposes the callback-queue terminal timestamp")
  func terminalTimestamp() async throws {
    let callbackQueue = DispatchQueue(label: "initial-image-preheat-terminal-timestamp-test")
    let session = InitialImageMeasurementSession(
      callbackQueue: callbackQueue,
      strategy: .batchedThumbnailStore,
      imageCount: 1,
      iteration: 1,
      samplePosition: .earlier,
      timeoutMilliseconds: 1_000,
      requestedIdentifiers: ["asset-1"],
      displayDegradedImages: true
    )
    let before = DispatchTime.now().uptimeNanoseconds
    let result = await session.runWithTerminalTimestamp { receive in
      receive(
        .image(
          identifier: "asset-1",
          pixelWidth: 100,
          pixelHeight: 100,
          isDegraded: false
        )
      )
      return []
    }
    let after = DispatchTime.now().uptimeNanoseconds

    #expect(result.measurement.finalCount == 1)
    #expect(result.terminalUptimeNanoseconds >= before)
    #expect(result.terminalUptimeNanoseconds <= after)
  }

  @Test("Sample windows are globally disjoint with independent recency and execution balance")
  func samplePlanCounterbalance() throws {
    let identifiers = (0..<80).map { "private-asset-\($0)" }
    let plan = try InitialImagePreheatSamplePlan(
      identifiers: identifiers,
      imageCounts: [2, 3],
      iterations: 4
    )

    #expect(plan.sampledIdentifierCount == 80)
    #expect(plan.pairs.count == 8)
    for imageCount in [2, 3] {
      let pairs = plan.pairs.filter { $0.imageCount == imageCount }
      #expect(pairs.map(\.candidate.position) == [.later, .earlier, .later, .earlier])
      #expect(pairs.map(\.executeCandidateFirst) == [false, true, true, false])
      #expect(pairs.allSatisfy { $0.control.leadIdentifiers.count == imageCount })
      #expect(pairs.allSatisfy { $0.control.targetIdentifiers.count == imageCount })
      #expect(pairs.allSatisfy { $0.candidate.leadIdentifiers.count == imageCount })
      #expect(pairs.allSatisfy { $0.candidate.targetIdentifiers.count == imageCount })
    }

    let usedIdentifiers = plan.pairs.flatMap { pair in
      pair.control.leadIdentifiers + pair.control.targetIdentifiers
        + pair.candidate.leadIdentifiers + pair.candidate.targetIdentifiers
    }
    #expect(usedIdentifiers.count == plan.sampledIdentifierCount)
    #expect(Set(usedIdentifiers).count == usedIdentifiers.count)
    #expect(!plan.sampledIdentifierDigest.contains("private-asset"))
  }

  @Test("Required sample count accounts for four windows and rejects invalid samples")
  func requiredSampleCount() throws {
    #expect(
      try InitialImagePreheatSamplePlan.requiredIdentifierCount(
        imageCounts: [2, 3],
        iterations: 4
      ) == 80
    )
    #expect(
      throws: InitialImageBenchmarkError.insufficientImageAssets(required: 80, available: 79)
    ) {
      _ = try InitialImagePreheatSamplePlan(
        identifiers: (0..<79).map { "asset-\($0)" },
        imageCounts: [2, 3],
        iterations: 4
      )
    }
    #expect(throws: InitialImageBenchmarkError.sampleSizeOverflow) {
      _ = try InitialImagePreheatSamplePlan.requiredIdentifierCount(
        imageCounts: [Int.max],
        iterations: 2
      )
    }

    var duplicateIdentifiers = (0..<80).map { "asset-\($0)" }
    duplicateIdentifiers[79] = duplicateIdentifiers[0]
    #expect(throws: InitialImageBenchmarkError.duplicateAssetIdentifier) {
      _ = try InitialImagePreheatSamplePlan(
        identifiers: duplicateIdentifiers,
        imageCounts: [2, 3],
        iterations: 4
      )
    }
  }

  @Test("Comparison keeps phase timings and uses continuous end-to-end speedup")
  func comparisonAggregation() {
    let metrics = Self.metrics()
    let measurements = [
      Self.measurement(
        arm: .control,
        iteration: 1,
        leadElapsed: 5,
        targetFirst: 10,
        targetAll: 20,
        endToEnd: 30,
        metrics: metrics
      ),
      Self.measurement(
        arm: .windowedPreheat,
        iteration: 1,
        leadElapsed: 8,
        targetFirst: 5,
        targetAll: 10,
        endToEnd: 24,
        metrics: metrics
      ),
      Self.measurement(
        arm: .control,
        iteration: 2,
        leadElapsed: 7,
        targetFirst: 20,
        targetAll: 40,
        endToEnd: 50,
        metrics: metrics
      ),
      Self.measurement(
        arm: .windowedPreheat,
        iteration: 2,
        leadElapsed: 10,
        targetFirst: 10,
        targetAll: 20,
        endToEnd: 36,
        metrics: metrics
      ),
    ]

    let comparison = InitialImagePreheatBenchmarkReport.comparison(
      imageCount: 2,
      measurements: measurements
    )
    #expect(comparison.control.measurementCount == 2)
    #expect(comparison.windowedPreheat.measurementCount == 2)
    #expect(comparison.control.medianLeadElapsedMilliseconds == 6)
    #expect(comparison.windowedPreheat.medianLeadElapsedMilliseconds == 9)
    #expect(comparison.control.medianTargetAllTerminalMilliseconds == 30)
    #expect(comparison.windowedPreheat.medianTargetAllTerminalMilliseconds == 15)
    #expect(comparison.targetLatencySpeedup.firstRenderable == 2)
    #expect(comparison.targetLatencySpeedup.allVisibleFinal == 2)
    #expect(comparison.targetLatencySpeedup.allTerminal == 2)
    #expect(comparison.targetLatencySpeedup.finalP95 == 2)
    #expect(comparison.control.medianEndToEndMilliseconds == 40)
    #expect(comparison.windowedPreheat.medianEndToEndMilliseconds == 30)
    #expect(comparison.endToEndSpeedup == 4.0 / 3.0)
    #expect(comparison.control.medianInterphaseMilliseconds == 3)
    #expect(comparison.windowedPreheat.medianInterphaseMilliseconds == 5)
  }

  @Test("Store metric snapshots preserve every production counter")
  func storeMetricSnapshot() {
    let snapshot = InitialImagePreheatBenchmarkReport.StoreMetrics(Self.metrics())

    #expect(snapshot.assetFetchBatchCount == 20)
    #expect(snapshot.assetFetchIdentifierCount == 22)
    #expect(snapshot.imageRequestCount == 3)
    #expect(snapshot.assetFetchScheduler.supersededPreheatBatchCount == 1)
    #expect(snapshot.assetFetchScheduler.supersededPreheatIdentifierCount == 2)
    #expect(snapshot.assetFetchScheduler.visiblePromotionIdentifierCount == 3)
    #expect(snapshot.assetFetchScheduler.removedQueuedVisibleIdentifierCount == 4)
    #expect(snapshot.assetFetchScheduler.invalidatedInFlightBatchCount == 5)
    #expect(snapshot.assetFetchScheduler.invalidatedInFlightIdentifierCount == 6)
    #expect(snapshot.assetFetchScheduler.maximumQueuedPreheatIdentifierCount == 7)
    #expect(snapshot.assetFetchScheduler.maximumQueuedVisibleIdentifierCount == 8)
    #expect(snapshot.assetFetchScheduler.preheatBatchCount == 9)
    #expect(snapshot.assetFetchScheduler.preheatBatchIdentifierCount == 10)
    #expect(snapshot.assetFetchScheduler.visibleBatchCount == 11)
    #expect(snapshot.assetFetchScheduler.visibleBatchIdentifierCount == 12)
    #expect(snapshot.assetFetchScheduler.activeBatchPriority == "preheat")
    #expect(snapshot.assetFetchScheduler.queuedPreheatIdentifierCount == 13)
    #expect(snapshot.assetFetchScheduler.queuedVisibleIdentifierCount == 14)
    #expect(!snapshot.assetFetchScheduler.isQuiescent)
    #expect(snapshot.preheat.updateCount == 4)
    #expect(snapshot.preheat.startedKeyCount == 5)
    #expect(snapshot.preheat.stoppedKeyCount == 6)
    #expect(snapshot.preheat.retainedKeyCount == 7)
    #expect(snapshot.preheat.fetchIdentifierCount == 8)
    #expect(snapshot.preheat.cacheStartCallCount == 9)
    #expect(snapshot.preheat.cacheStopCallCount == 10)
    #expect(snapshot.preheat.cacheStopAllCount == 11)
    #expect(snapshot.preheat.activeKeyCount == 12)
    #expect(snapshot.preheat.pendingKeyCount == 13)
  }

  @Test("Runner rejects terminal failures, timeouts, and identifier mismatches")
  func runnerRejectsIncorrectMeasurements() {
    let metrics = Self.quiescentMetrics()
    let failed = Self.measurement(
      arm: .control,
      iteration: 1,
      leadElapsed: 5,
      targetFirst: 10,
      targetAll: 20,
      endToEnd: 30,
      metrics: metrics,
      finalCount: 1,
      failureCount: 1
    ).target
    #expect(throws: InitialImageBenchmarkError.self) {
      try InitialImagePreheatBenchmarkRunner.validate(
        failed,
        arm: .control,
        phase: "target"
      )
    }

    let timedOut = Self.measurement(
      arm: .control,
      iteration: 1,
      leadElapsed: 5,
      targetFirst: 10,
      targetAll: 20,
      endToEnd: 30,
      metrics: metrics,
      finalCount: 1,
      failureCount: 1,
      timedOutCount: 1
    ).target
    #expect(throws: InitialImageBenchmarkError.self) {
      try InitialImagePreheatBenchmarkRunner.validate(
        timedOut,
        arm: .control,
        phase: "target"
      )
    }

    let digestMismatch = Self.measurement(
      arm: .control,
      iteration: 1,
      leadElapsed: 5,
      targetFirst: 10,
      targetAll: 20,
      endToEnd: 30,
      metrics: metrics,
      finalDigest: "2:0000000000000003:0000000000000004"
    ).target
    #expect(throws: InitialImageBenchmarkError.self) {
      try InitialImagePreheatBenchmarkRunner.validate(
        digestMismatch,
        arm: .control,
        phase: "target"
      )
    }
  }

  @Test("Runner requires internally consistent, quiescent asset-fetch metrics")
  func runnerRequiresSchedulerQuiescence() throws {
    let quiescent = Self.quiescentMetrics()
    try InitialImagePreheatBenchmarkRunner.validate(
      quiescent,
      arm: .windowedPreheat,
      phase: "target",
      iteration: 1
    )

    #expect(throws: InitialImageBenchmarkError.self) {
      try InitialImagePreheatBenchmarkRunner.validate(
        Self.metrics(),
        arm: .windowedPreheat,
        phase: "target",
        iteration: 1
      )
    }
    #expect(throws: InitialImageBenchmarkError.self) {
      try InitialImagePreheatBenchmarkRunner.validate(
        Self.quiescentMetrics(assetFetchBatchCount: 3),
        arm: .windowedPreheat,
        phase: "target",
        iteration: 1
      )
    }
  }

  @Test("Encoded measurements contain digests but no raw Photos identifiers")
  func reportIdentifierPrivacy() throws {
    let rawIdentifier = "private-photos-identifier"
    var digest = StableIdentifierDigest()
    digest.add(rawIdentifier)
    let metrics = Self.metrics()
    let measurement = Self.measurement(
      arm: .control,
      iteration: 1,
      leadElapsed: 5,
      targetFirst: 10,
      targetAll: 20,
      endToEnd: 30,
      metrics: metrics,
      digest: digest.signature
    )
    let report = InitialImagePreheatBenchmarkReport(
      schemaVersion: 2,
      configuration: InitialImagePreheatBenchmarkReport.Configuration(
        imageCounts: [2],
        pixelWidth: 100,
        pixelHeight: 100,
        iterations: 1,
        timeoutMilliseconds: 1_000,
        networkAccessAllowed: true,
        leadWindowMatchesTargetCount: true,
        preheatEstimatedBytesPerPixel: 4,
        preheatMaximumPixelCount: 100,
        preheatMaximumEstimatedByteCount: 400,
        preheatMaximumKeyCount: 2
      ),
      availableRecentImageCount: 4,
      sampledIdentifierCount: 4,
      sampledIdentifierDigest: digest.signature,
      disjointLeadAndTargetWindows: true,
      measurements: [measurement],
      comparisons: [
        InitialImagePreheatBenchmarkReport.comparison(
          imageCount: 2,
          measurements: [measurement]
        )
      ]
    )

    let data = try JSONEncoder().encode(report)
    let json = try #require(String(data: data, encoding: .utf8))
    #expect(json.contains(digest.signature))
    #expect(json.contains("elapsedThroughTargetTerminalMilliseconds"))
    #expect(json.contains("assetFetchScheduler"))
    #expect(json.contains("isQuiescent"))
    #expect(!json.contains(rawIdentifier))
  }

  private static func metrics() -> PhotoAssetThumbnailStoreMetrics {
    PhotoAssetThumbnailStoreMetrics(
      assetFetchBatchCount: 20,
      assetFetchIdentifierCount: 22,
      imageRequestCount: 3,
      assetFetchScheduler: PhotoAssetThumbnailAssetFetchSchedulerMetrics(
        supersededPreheatBatchCount: 1,
        supersededPreheatIdentifierCount: 2,
        visiblePromotionIdentifierCount: 3,
        removedQueuedVisibleIdentifierCount: 4,
        invalidatedInFlightBatchCount: 5,
        invalidatedInFlightIdentifierCount: 6,
        maximumQueuedPreheatIdentifierCount: 7,
        maximumQueuedVisibleIdentifierCount: 8,
        preheatBatchCount: 9,
        preheatBatchIdentifierCount: 10,
        visibleBatchCount: 11,
        visibleBatchIdentifierCount: 12,
        activeBatchPriority: .preheat,
        queuedPreheatIdentifierCount: 13,
        queuedVisibleIdentifierCount: 14
      ),
      preheat: PhotoAssetThumbnailPreheatRuntimeMetrics(
        updateCount: 4,
        startedKeyCount: 5,
        stoppedKeyCount: 6,
        retainedKeyCount: 7,
        fetchIdentifierCount: 8,
        cacheStartCallCount: 9,
        cacheStopCallCount: 10,
        cacheStopAllCount: 11,
        activeKeyCount: 12,
        pendingKeyCount: 13
      )
    )
  }

  private static func quiescentMetrics(
    assetFetchBatchCount: Int = 2
  ) -> PhotoAssetThumbnailStoreMetrics {
    PhotoAssetThumbnailStoreMetrics(
      assetFetchBatchCount: assetFetchBatchCount,
      assetFetchIdentifierCount: 4,
      imageRequestCount: 2,
      assetFetchScheduler: PhotoAssetThumbnailAssetFetchSchedulerMetrics(
        supersededPreheatBatchCount: 0,
        supersededPreheatIdentifierCount: 0,
        visiblePromotionIdentifierCount: 0,
        removedQueuedVisibleIdentifierCount: 0,
        invalidatedInFlightBatchCount: 0,
        invalidatedInFlightIdentifierCount: 0,
        maximumQueuedPreheatIdentifierCount: 2,
        maximumQueuedVisibleIdentifierCount: 2,
        preheatBatchCount: 1,
        preheatBatchIdentifierCount: 2,
        visibleBatchCount: 1,
        visibleBatchIdentifierCount: 2,
        activeBatchPriority: nil,
        queuedPreheatIdentifierCount: 0,
        queuedVisibleIdentifierCount: 0
      ),
      preheat: .zero
    )
  }

  private static func measurement(
    arm: InitialImagePreheatBenchmarkReport.Arm,
    iteration: Int,
    leadElapsed: Double,
    targetFirst: Double,
    targetAll: Double,
    endToEnd: Double,
    metrics: PhotoAssetThumbnailStoreMetrics,
    digest: String = "2:0000000000000001:0000000000000002",
    finalDigest: String? = nil,
    finalCount: Int = 2,
    failureCount: Int = 0,
    timedOutCount: Int = 0
  ) -> InitialImagePreheatBenchmarkReport.Measurement {
    InitialImagePreheatBenchmarkReport.Measurement(
      arm: arm,
      imageCount: 2,
      iteration: iteration,
      samplePosition: arm == .control ? .earlier : .later,
      executedFirst: arm == .control,
      lead: InitialImagePreheatBenchmarkReport.LeadMeasurement(
        requestedIdentifierDigest: digest,
        finalIdentifierDigest: finalDigest ?? digest,
        requestedCount: 2,
        finalCount: finalCount,
        failureCount: failureCount,
        timedOutCount: timedOutCount,
        elapsedMilliseconds: leadElapsed
      ),
      target: InitialImageBenchmarkReport.Measurement(
        strategy: .batchedThumbnailStore,
        imageCount: 2,
        iteration: iteration,
        samplePosition: arm == .control ? .earlier : .later,
        requestedIdentifierDigest: digest,
        finalIdentifierDigest: finalDigest ?? digest,
        requestedCount: 2,
        renderableCount: 2,
        degradedAssetCount: 0,
        degradedEventCount: 0,
        finalCount: finalCount,
        failureCount: failureCount,
        timedOutCount: timedOutCount,
        unexpectedEventCount: 0,
        duplicateTerminalEventCount: 0,
        invalidDimensionCount: 0,
        failureCodeCounts: [:],
        firstRenderableMilliseconds: targetFirst,
        firstDegradedMilliseconds: nil,
        firstFinalMilliseconds: targetFirst,
        allVisibleFinalMilliseconds: targetAll,
        allTerminalMilliseconds: targetAll,
        finalLatency: InitialImageBenchmarkReport.LatencySummary(
          p50Milliseconds: targetFirst,
          p95Milliseconds: targetAll,
          maximumMilliseconds: targetAll
        ),
        finalDimensions: InitialImageBenchmarkReport.DimensionSummary(
          minimumPixelWidth: 100,
          maximumPixelWidth: 100,
          minimumPixelHeight: 100,
          maximumPixelHeight: 100,
          totalDecodedPixels: 20_000
        )
      ),
      continuousTiming: InitialImagePreheatBenchmarkReport.ContinuousTiming(
        elapsedThroughTargetTerminalMilliseconds: endToEnd,
        phaseMarkers: InitialImagePreheatBenchmarkReport.PhaseMarkers(
          preheatSubmittedMilliseconds: arm == .windowedPreheat ? 0.25 : nil,
          leadRequestStartedMilliseconds: 0.5,
          leadTerminalMilliseconds: 0.5 + leadElapsed,
          leadValidationCompletedMilliseconds: 0.6 + leadElapsed,
          metricsAfterLeadCapturedMilliseconds: 0.7 + leadElapsed,
          targetRequestStartedMilliseconds: endToEnd - targetAll - 0.5,
          targetTerminalMilliseconds: endToEnd,
          targetValidationCompletedMilliseconds: endToEnd + 0.1,
          metricsAfterTargetCapturedMilliseconds: endToEnd + 0.2
        )
      ),
      metricsAfterLead: InitialImagePreheatBenchmarkReport.StoreMetrics(metrics),
      metricsAfterTarget: InitialImagePreheatBenchmarkReport.StoreMetrics(metrics)
    )
  }
}
