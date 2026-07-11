import Foundation
import Testing

@testable import BatchAssetInfoCore
@testable import PhotosProfilerSupport

@Suite("Thumbnail-scroll benchmark core")
struct ThumbnailScrollBenchmarkCoreTests {
  @Test("Four-arm plans use globally disjoint assignments and balanced marginal order")
  func disjointCounterbalancedPlan() throws {
    let required = try ThumbnailScrollSamplePlan.requiredIdentifierCount(
      columnCount: 3,
      visibleRowCount: 2,
      aheadRowCount: 1,
      behindRowCount: 2,
      flingTransitionCount: 2,
      iterations: 4
    )
    #expect(required == 432)
    let assets = (0..<required).map { index in
      ThumbnailScrollSamplePlan.Asset(
        identifier: "private-asset-\(index)",
        mediaType: index.isMultiple(of: 6) ? .video : .image
      )
    }
    let plan = try ThumbnailScrollSamplePlan(
      assets: assets,
      columnCount: 3,
      visibleRowCount: 2,
      aheadRowCount: 1,
      behindRowCount: 2,
      flingTransitionCount: 2,
      iterations: 4
    )

    #expect(plan.runs.count == 16)
    #expect(plan.assetsPerAssignment == 27)
    #expect(plan.sampledIdentifierCount == required)
    #expect(plan.sampledImageCount + plan.sampledVideoCount == required)
    #expect(!plan.sampledIdentifierDigest.contains("private-asset"))
    for arm in ThumbnailScrollBenchmarkArm.allCases {
      let runs = plan.runs.filter { $0.arm == arm }
      #expect(Set(runs.map(\.recencySlot)) == Set(0..<4))
      #expect(Set(runs.map(\.executionPosition)) == Set(0..<4))
      #expect(runs.allSatisfy { $0.assignment.imageCount + $0.assignment.videoCount == 27 })
    }

    let allAssignedIdentifiers = plan.runs.flatMap { $0.assignment.assets.map(\.identifier) }
    #expect(allAssignedIdentifiers.count == required)
    #expect(Set(allAssignedIdentifiers).count == required)
  }

  @Test("Candidate policies preserve production row priority and forward destination topology")
  func candidateOrdering() throws {
    let assets = (0..<432).map { index in
      ThumbnailScrollSamplePlan.Asset(identifier: "asset-\(index)", mediaType: .image)
    }
    let plan = try ThumbnailScrollSamplePlan(
      assets: assets,
      columnCount: 3,
      visibleRowCount: 2,
      aheadRowCount: 1,
      behindRowCount: 2,
      flingTransitionCount: 2,
      iterations: 4
    )
    let assignment = try #require(
      plan.runs.first { $0.iteration == 1 && $0.arm == .currentVisibleFirst }
    ).assignment

    func rowIdentifiers(_ row: Int) -> [String] {
      let lower = row * 3
      return assignment.assets[lower..<(lower + 3)].map(\.identifier)
    }

    #expect(
      assignment.currentVisibleAssets.map(\.identifier) == rowIdentifiers(2) + rowIdentifiers(3))
    #expect(assignment.nextVisibleAssets.map(\.identifier) == rowIdentifiers(6) + rowIdentifiers(7))
    #expect(
      assignment.candidateAssets(for: .currentVisibleFirst, at: 0).map(\.identifier)
        == rowIdentifiers(2) + rowIdentifiers(3) + rowIdentifiers(4) + rowIdentifiers(1)
        + rowIdentifiers(0)
    )
    #expect(
      assignment.candidateAssets(for: .aheadBehindFirst, at: 0).map(\.identifier)
        == rowIdentifiers(4) + rowIdentifiers(1) + rowIdentifiers(0) + rowIdentifiers(2)
        + rowIdentifiers(3)
    )
    #expect(
      assignment.candidateAssets(for: .futureOnly, at: 0).map(\.identifier)
        == rowIdentifiers(4)
    )
    #expect(assignment.candidateAssets(for: .control, at: 0).isEmpty)
  }

  @Test("Sample planning rejects incomplete, duplicate, imbalanced, and overflowing input")
  func invalidPlans() throws {
    let assets = (0..<431).map {
      ThumbnailScrollSamplePlan.Asset(identifier: "asset-\($0)", mediaType: .image)
    }
    #expect(
      throws: ThumbnailScrollBenchmarkError.insufficientAssets(required: 432, available: 431)
    ) {
      _ = try ThumbnailScrollSamplePlan(
        assets: assets,
        columnCount: 3,
        visibleRowCount: 2,
        aheadRowCount: 1,
        behindRowCount: 2,
        flingTransitionCount: 2,
        iterations: 4
      )
    }
    #expect(throws: ThumbnailScrollBenchmarkError.iterationsMustBeMultipleOfFour) {
      _ = try ThumbnailScrollSamplePlan(
        assets: [],
        columnCount: 3,
        visibleRowCount: 2,
        aheadRowCount: 1,
        behindRowCount: 1,
        flingTransitionCount: 2,
        iterations: 2
      )
    }
    #expect(throws: ThumbnailScrollBenchmarkError.sampleSizeOverflow) {
      _ = try ThumbnailScrollSamplePlan.requiredIdentifierCount(
        columnCount: Int.max,
        visibleRowCount: Int.max,
        aheadRowCount: 1,
        behindRowCount: 1,
        flingTransitionCount: 4,
        iterations: 4
      )
    }

    var duplicateAssets = (0..<432).map {
      ThumbnailScrollSamplePlan.Asset(identifier: "asset-\($0)", mediaType: .image)
    }
    duplicateAssets[431] = duplicateAssets[0]
    #expect(throws: ThumbnailScrollBenchmarkError.duplicateAssetIdentifier) {
      _ = try ThumbnailScrollSamplePlan(
        assets: duplicateAssets,
        columnCount: 3,
        visibleRowCount: 2,
        aheadRowCount: 1,
        behindRowCount: 2,
        flingTransitionCount: 2,
        iterations: 4
      )
    }
  }

  @Test("Ordered digests distinguish candidate priority and 480-pixel budget selects 18 keys")
  func orderedDigestAndBudget() throws {
    var forward = ThumbnailScrollOrderedIdentifierDigest()
    var reverse = ThumbnailScrollOrderedIdentifierDigest()
    for identifier in ["one", "two", "three"] {
      forward.add(identifier)
    }
    for identifier in ["three", "two", "one"] {
      reverse.add(identifier)
    }
    #expect(forward.signature != reverse.signature)
    #expect(!forward.signature.contains("one"))

    let target = try PhotoAssetThumbnailTarget(pixelWidth: 480, pixelHeight: 480)
    let keys = try (0..<24).map { index in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: "private-budget-asset-\(index)",
        target: target,
        contentMode: .aspectFill
      )
    }
    let planned = ThumbnailScrollBenchmarkRunner.plannedWindow(keys: keys)
    #expect(planned.requestedCandidateCount == 24)
    #expect(planned.expectedMaximumSelectedKeyCount == 18)
    #expect(planned.expectedMaximumSelectedPixelCount == 4_147_200)
    #expect(planned.expectedMaximumSelectedEstimatedByteCount == 16_588_800)
    #expect(!planned.requestedCandidateOrderedDigest.contains("private-budget-asset"))
  }

  @Test("Strict validation rejects terminal failures even when result counts balance")
  func strictValidation() {
    let failed = Self.visibleMeasurement(
      iteration: 3,
      elapsedMilliseconds: 20,
      requestedCount: 2,
      finalCount: 1,
      failureCount: 1
    )
    #expect(
      throws: ThumbnailScrollBenchmarkError.invalidMeasurement(
        arm: .futureOnly,
        iteration: 3,
        reason: "next-visible did not produce one final image for every request"
      )
    ) {
      try ThumbnailScrollBenchmarkRunner.validate(
        failed,
        arm: .futureOnly,
        phase: "next-visible"
      )
    }
  }

  @Test("Report aggregation uses destination-cycle latency and encodes no raw identifiers")
  func reportAggregationAndPrivacy() throws {
    let rawIdentifier = "private-report-identifier"
    var digest = StableIdentifierDigest()
    digest.add(rawIdentifier)
    let control = Self.reportMeasurement(
      arm: .control,
      iteration: 1,
      digest: digest.signature,
      currentMilliseconds: 20,
      nextMilliseconds: 40,
      destinationCycleMilliseconds: 50,
      peakDeltaBytes: 2_000
    )
    let candidate = Self.reportMeasurement(
      arm: .futureOnly,
      iteration: 1,
      digest: digest.signature,
      currentMilliseconds: 25,
      nextMilliseconds: 20,
      destinationCycleMilliseconds: 40,
      peakDeltaBytes: 3_000
    )
    let comparisons = ThumbnailScrollBenchmarkReport.comparisons([control, candidate])
    let future = try #require(comparisons.first { $0.arm == .futureOnly })
    #expect(future.aggregate.measurementCount == 1)
    #expect(future.nextVisibleSpeedupVersusControl == 2)
    #expect(future.destinationCycleSpeedupVersusControl == 1.25)
    #expect(future.allIssuedVisibleTerminalsSpeedupVersusControl == 1.25)
    #expect(future.aggregate.medianSampledPeakRssDeltaBytes == 3_000)

    let report = ThumbnailScrollBenchmarkReport(
      schemaVersion: 1,
      configuration: Self.configuration,
      mediaCoverage: ThumbnailScrollBenchmarkReport.MediaCoverage(
        supportedMediaTypes: ["image", "video"],
        videoThumbnailRequestPath: "PHCachingImageManager.requestImage",
        availableImageCount: 100,
        availableVideoCount: 20,
        sampledImageCount: 10,
        sampledVideoCount: 2,
        imagesOnlyLimitation: nil
      ),
      availableEligibleAssetCount: 120,
      sampledIdentifierCount: 12,
      sampledIdentifierDigest: digest.signature,
      assetsPerAssignment: 6,
      measurements: [control, candidate],
      comparisons: comparisons,
      validation: ThumbnailScrollBenchmarkReport.Validation(
        globallyDisjointAssignments: true,
        everyVisibleWindowCompletedExactly: true,
        noRawIdentifiersEncoded: true,
        logicalPreheatEmptyAfterEnd: true,
        schedulerStateEmptyAfterCacheCleanup: true
      )
    )
    let json = try #require(String(data: JSONEncoder().encode(report), encoding: .utf8))
    #expect(json.contains(digest.signature))
    #expect(json.contains("rapidWindowPlans"))
    #expect(json.contains("sampledPeakThroughNextVisibleTerminalRssBytes"))
    #expect(!json.contains(rawIdentifier))
  }

  private static var configuration: ThumbnailScrollBenchmarkReport.Configuration {
    ThumbnailScrollBenchmarkReport.Configuration(
      columnCount: 3,
      visibleRowCount: 4,
      aheadRowCount: 3,
      behindRowCount: 1,
      flingTransitionCount: 4,
      pixelWidth: 480,
      pixelHeight: 480,
      iterations: 4,
      timeoutMilliseconds: 30_000,
      rssSampleIntervalMilliseconds: 5,
      networkAccessAllowed: true,
      contentMode: "aspect-fill",
      requestSubmissionOrder: "visible first",
      workloadShape: "burst-forward",
      preheatMaximumKeyCount: 24,
      preheatMaximumPixelCount: 4_194_304,
      preheatMaximumEstimatedByteCount: 16_777_216,
      preheatEstimatedBytesPerPixel: 4
    )
  }

  private static func reportMeasurement(
    arm: ThumbnailScrollBenchmarkArm,
    iteration: Int,
    digest: String,
    currentMilliseconds: Double,
    nextMilliseconds: Double,
    destinationCycleMilliseconds: Double,
    peakDeltaBytes: UInt64
  ) -> ThumbnailScrollBenchmarkReport.Measurement {
    let emptyPlan = ThumbnailScrollBenchmarkReport.PlannedWindow(
      requestedCandidateCount: 0,
      requestedCandidateOrderedDigest: "0:0000000000000000",
      expectedMaximumSelectedKeyCount: 0,
      expectedMaximumSelectedPixelCount: 0,
      expectedMaximumSelectedEstimatedByteCount: 0
    )
    let metrics = ThumbnailScrollBenchmarkReport.StoreMetrics(Self.storeMetrics)
    let memory = ThumbnailScrollBenchmarkReport.MemoryMeasurement(
      ThumbnailScrollResidentMemorySampler.Snapshot(
        baselineBytes: 10_000,
        currentVisibleTerminalBytes: 10_500,
        nextVisibleTerminalBytes: 10_800,
        currentVisibleTerminalSampledPeakBytes: 10_700,
        nextVisibleTerminalSampledPeakBytes: 10_000 + peakDeltaBytes,
        afterPreheatEndBytes: 10_600,
        afterCacheCleanupBytes: 9_900,
        sampledPeakBytes: 10_000 + peakDeltaBytes,
        sampleCount: 8
      )
    )
    return ThumbnailScrollBenchmarkReport.Measurement(
      arm: arm,
      iteration: iteration,
      recencySlot: 0,
      executionPosition: 0,
      assignmentIdentifierDigest: digest,
      assignmentImageCount: 5,
      assignmentVideoCount: 1,
      rapidPreheatUpdateCount: arm == .control ? 0 : 3,
      initialWindowPlan: emptyPlan,
      rapidWindowPlans: arm == .control ? [] : [emptyPlan, emptyPlan, emptyPlan],
      nextWindowPlan: emptyPlan,
      currentVisible: visibleMeasurement(
        iteration: iteration,
        elapsedMilliseconds: currentMilliseconds
      ),
      nextVisible: visibleMeasurement(
        iteration: iteration,
        elapsedMilliseconds: nextMilliseconds
      ),
      continuousTiming: ThumbnailScrollBenchmarkReport.ContinuousTiming(
        elapsedThroughNextVisibleTerminalMilliseconds: destinationCycleMilliseconds,
        elapsedThroughAllIssuedVisibleTerminalsMilliseconds: destinationCycleMilliseconds,
        phaseMarkers: ThumbnailScrollBenchmarkReport.PhaseMarkers(
          currentVisibleRequestSubmittedMilliseconds: 0.1,
          initialPreheatSubmittedMilliseconds: arm == .control ? nil : 0.2,
          rapidPreheatUpdatesSubmittedMilliseconds: arm == .control ? nil : 0.3,
          nextVisibleRequestSubmittedMilliseconds: 0.4,
          nextVisiblePreheatSubmittedMilliseconds: arm == .control ? nil : 0.5,
          currentVisibleTerminalMilliseconds: currentMilliseconds,
          nextVisibleTerminalMilliseconds: destinationCycleMilliseconds,
          validationCompletedMilliseconds: destinationCycleMilliseconds + 0.1,
          metricsCapturedMilliseconds: destinationCycleMilliseconds + 0.2
        )
      ),
      metricsAfterVisibleWindows: metrics,
      metricsAfterPreheatEnd: metrics,
      metricsAfterCacheCleanup: metrics,
      memory: memory
    )
  }

  private static func visibleMeasurement(
    iteration: Int,
    elapsedMilliseconds: Double,
    requestedCount: Int = 2,
    finalCount: Int = 2,
    failureCount: Int = 0
  ) -> InitialImageBenchmarkReport.Measurement {
    let digest = requestedCount == finalCount ? "2:0000000000000001:0000000000000002" : "mismatch"
    return InitialImageBenchmarkReport.Measurement(
      strategy: .batchedThumbnailStore,
      imageCount: requestedCount,
      iteration: iteration,
      samplePosition: .earlier,
      requestedIdentifierDigest: "2:0000000000000001:0000000000000002",
      finalIdentifierDigest: digest,
      requestedCount: requestedCount,
      renderableCount: finalCount,
      degradedAssetCount: 0,
      degradedEventCount: 0,
      finalCount: finalCount,
      failureCount: failureCount,
      timedOutCount: 0,
      unexpectedEventCount: 0,
      duplicateTerminalEventCount: 0,
      invalidDimensionCount: 0,
      failureCodeCounts: failureCount == 0 ? [:] : ["failure": failureCount],
      firstRenderableMilliseconds: 1,
      firstDegradedMilliseconds: nil,
      firstFinalMilliseconds: 1,
      allVisibleFinalMilliseconds: failureCount == 0 ? elapsedMilliseconds : nil,
      allTerminalMilliseconds: elapsedMilliseconds,
      finalLatency: InitialImageBenchmarkReport.LatencySummary(
        p50Milliseconds: 1,
        p95Milliseconds: elapsedMilliseconds,
        maximumMilliseconds: elapsedMilliseconds
      ),
      finalDimensions: InitialImageBenchmarkReport.DimensionSummary(
        minimumPixelWidth: 480,
        maximumPixelWidth: 480,
        minimumPixelHeight: 480,
        maximumPixelHeight: 480,
        totalDecodedPixels: Int64(finalCount * 480 * 480)
      )
    )
  }

  private static var storeMetrics: PhotoAssetThumbnailStoreMetrics {
    PhotoAssetThumbnailStoreMetrics(
      assetFetchBatchCount: 2,
      assetFetchIdentifierCount: 4,
      imageRequestCount: 4,
      assetFetchScheduler: PhotoAssetThumbnailAssetFetchSchedulerMetrics(
        supersededPreheatBatchCount: 1,
        supersededPreheatIdentifierCount: 2,
        visiblePromotionIdentifierCount: 3,
        removedQueuedVisibleIdentifierCount: 0,
        invalidatedInFlightBatchCount: 0,
        invalidatedInFlightIdentifierCount: 0,
        maximumQueuedPreheatIdentifierCount: 4,
        maximumQueuedVisibleIdentifierCount: 5,
        preheatBatchCount: 6,
        preheatBatchIdentifierCount: 7,
        visibleBatchCount: 8,
        visibleBatchIdentifierCount: 9,
        activeBatchPriority: nil,
        queuedPreheatIdentifierCount: 0,
        queuedVisibleIdentifierCount: 0
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
        activeKeyCount: 0,
        pendingKeyCount: 0
      )
    )
  }
}
