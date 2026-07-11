import Foundation
import Testing

@testable import BatchAssetInfoCore
@testable import PhotosProfilerSupport

@Suite("Preview-card benchmark core")
struct PreviewCardsBenchmarkCoreTests {
  @Test("Default card geometry matches 1/2/3-photo production-shaped targets")
  func geometry() throws {
    let geometry = try PreviewCardsGeometry(
      totalCardPixelWidth: 1_200,
      cardPixelHeight: 320
    )

    #expect(try geometry.target(for: 1).pixelWidth == 1_200)
    #expect(try geometry.target(for: 2).pixelWidth == 600)
    #expect(try geometry.target(for: 3).pixelWidth == 400)
    #expect(try geometry.target(for: 3).pixelHeight == 320)
    #expect(throws: PreviewCardsBenchmarkError.invalidCardArity(4)) {
      _ = try geometry.target(for: 4)
    }
  }

  @Test("Plans are globally disjoint and counterbalance recency, order, and arity rotations")
  func counterbalancedPlan() throws {
    let required = try PreviewCardsSamplePlan.requiredIdentifierCount(
      visibleCardCount: 4,
      iterations: 12
    )
    #expect(required == 192)
    let assets = (0..<required).map { index in
      PreviewCardsSamplePlan.Asset(
        identifier: "private-preview-asset-\(index)",
        mediaType: index.isMultiple(of: 8) ? .video : .image
      )
    }
    let plan = try PreviewCardsSamplePlan(
      assets: assets,
      visibleCardCount: 4,
      iterations: 12
    )

    #expect(plan.runs.count == 24)
    #expect(plan.sampledIdentifierCount == 192)
    #expect(plan.sampledVideoCount == 24)
    #expect(plan.sampledImageCount == 168)
    #expect(plan.hasGloballyDisjointAssignments)
    #expect(plan.isFullyCounterbalanced)
    #expect(!plan.sampledIdentifierDigest.contains("private-preview-asset"))
    #expect(
      plan.runs.allSatisfy { run in
        !run.assignment.orderedIdentifierDigest.contains("private-preview-asset")
      })
    let assigned = plan.runs.flatMap { $0.assignment.assets.map(\.identifier) }
    #expect(assigned.count == required)
    #expect(Set(assigned).count == required)
    #expect(plan.runs.allSatisfy { $0.assignment.videoCount == 1 })

    for strategy in [
      PreviewCardsBenchmarkStrategy.expoPhotoLibraryAssetLoaderPhotoKit,
      .photoAssetThumbnailStore,
    ] {
      let runs = plan.runs.filter { $0.strategy == strategy }
      #expect(runs.filter { $0.recencySlot == 0 }.count == 6)
      #expect(runs.filter { $0.recencySlot == 1 }.count == 6)
      #expect(runs.filter { $0.executionPosition == 0 }.count == 6)
      #expect(runs.filter { $0.executionPosition == 1 }.count == 6)
      #expect(Set(runs.map(\.assignment.arities)).count == 3)
      let factorialCells = Set(
        runs.map { run in
          "\(run.assignment.arities)-\(run.recencySlot)-\(run.executionPosition)"
        })
      #expect(factorialCells.count == 12)
    }
  }

  @Test("Mixed-media selection uses one video in each eight-asset stride")
  func mixedMediaSelection() {
    let assets = PreviewCardsBenchmarkRunner.interleave(
      imageIdentifiers: (0..<30).map { "image-\($0)" },
      videoIdentifiers: (0..<4).map { "video-\($0)" },
      limit: 24
    )

    #expect(assets.count == 24)
    #expect(assets.filter { $0.mediaType == .video }.count == 3)
    #expect(assets[0].mediaType == .video)
    #expect(assets[8].mediaType == .video)
    #expect(assets[16].mediaType == .video)
  }

  @Test("Planning rejects incomplete, duplicate, and imbalanced samples")
  func invalidPlans() throws {
    let assets = (0..<191).map {
      PreviewCardsSamplePlan.Asset(identifier: "asset-\($0)", mediaType: .image)
    }
    #expect(
      throws: PreviewCardsBenchmarkError.insufficientAssets(required: 192, available: 191)
    ) {
      _ = try PreviewCardsSamplePlan(
        assets: assets,
        visibleCardCount: 4,
        iterations: 12
      )
    }
    #expect(throws: PreviewCardsBenchmarkError.iterationsMustBeMultipleOfTwelve) {
      _ = try PreviewCardsSamplePlan(
        assets: [],
        visibleCardCount: 4,
        iterations: 4
      )
    }
    var duplicates = (0..<192).map {
      PreviewCardsSamplePlan.Asset(identifier: "asset-\($0)", mediaType: .image)
    }
    duplicates[191] = duplicates[0]
    #expect(throws: PreviewCardsBenchmarkError.duplicateAssetIdentifier) {
      _ = try PreviewCardsSamplePlan(
        assets: duplicates,
        visibleCardCount: 4,
        iterations: 12
      )
    }
  }

  @Test("Candidate degraded images make the full strip renderable before finals")
  func allStripRenderableTiming() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 600, pixelHeight: 320)
    let requests = ["one", "two"].map {
      PreviewCardsAssetRequest(identifier: $0, target: target)
    }
    var accumulator = PreviewCardsMeasurementAccumulator(
      requests: requests,
      cardCount: 1,
      displayDegradedImages: true
    )
    accumulator.record(
      .image(identifier: "one", pixelWidth: 300, pixelHeight: 160, isDegraded: true),
      elapsedMilliseconds: 2
    )
    accumulator.record(
      .image(identifier: "two", pixelWidth: 300, pixelHeight: 160, isDegraded: true),
      elapsedMilliseconds: 3
    )
    accumulator.record(
      .image(identifier: "two", pixelWidth: 600, pixelHeight: 320, isDegraded: false),
      elapsedMilliseconds: 8
    )
    accumulator.record(
      .image(identifier: "one", pixelWidth: 600, pixelHeight: 320, isDegraded: false),
      elapsedMilliseconds: 10
    )
    let measurement = accumulator.makeMeasurement(allTerminalMilliseconds: 10)

    #expect(measurement.allStripRenderableMilliseconds == 3)
    #expect(measurement.allFinalMilliseconds == 10)
    #expect(measurement.degradedAssetCount == 2)
    #expect(measurement.finalCount == 2)
    #expect(measurement.finalDimensions?.totalDecodedPixels == 384_000)
    #expect(measurement.requestedIdentifierDigest == measurement.finalIdentifierDigest)
  }

  @Test("Strict validation rejects stale events and mismatched digests")
  func strictValidation() throws {
    let plan = try Self.plan()
    let run = try #require(plan.runs.first)
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 400, pixelHeight: 320)
    let requests = run.assignment.assets.map {
      PreviewCardsAssetRequest(identifier: $0.identifier, target: target)
    }
    var accumulator = PreviewCardsMeasurementAccumulator(
      requests: requests,
      cardCount: run.assignment.cards.count,
      displayDegradedImages: true
    )
    for (index, request) in requests.enumerated() {
      accumulator.record(
        .image(
          identifier: request.identifier,
          pixelWidth: 400,
          pixelHeight: 320,
          isDegraded: false
        ),
        elapsedMilliseconds: Double(index + 1)
      )
      if index == 0 {
        accumulator.record(
          .image(
            identifier: request.identifier,
            pixelWidth: 400,
            pixelHeight: 320,
            isDegraded: false
          ),
          elapsedMilliseconds: 2
        )
      }
    }
    let measurement = accumulator.makeMeasurement(allTerminalMilliseconds: 20)

    #expect(measurement.staleEventCount == 1)
    #expect(throws: PreviewCardsBenchmarkError.self) {
      try PreviewCardsBenchmarkRunner.validate(measurement, run: run)
    }
  }

  @Test("Aggregate reports remain privacy-safe and compare renderable/final timing")
  func reportAggregationAndPrivacy() throws {
    let rawIdentifier = "private-preview-report-identifier"
    var digest = StableIdentifierDigest()
    digest.add(rawIdentifier)
    let baseline = Self.measurement(
      strategy: .expoPhotoLibraryAssetLoaderPhotoKit,
      digest: digest.signature,
      renderableMilliseconds: 20,
      finalMilliseconds: 20,
      decodedPixels: 2_000
    )
    let candidate = Self.measurement(
      strategy: .photoAssetThumbnailStore,
      digest: digest.signature,
      renderableMilliseconds: 5,
      finalMilliseconds: 10,
      decodedPixels: 1_000
    )
    let comparison = PreviewCardsBenchmarkReport.comparison([baseline, candidate])
    #expect(comparison.candidateAllStripRenderableSpeedup == 4)
    #expect(comparison.candidateAllFinalSpeedup == 2)
    #expect(comparison.candidateToBaselineDecodedPixelRatio == 0.5)

    let report = PreviewCardsBenchmarkReport(
      schemaVersion: 1,
      configuration: Self.configuration,
      mediaCoverage: PreviewCardsBenchmarkReport.MediaCoverage(
        supportedMediaTypes: ["image", "video"],
        targetVideoStride: 8,
        availableImageCount: 100,
        availableVideoCount: 20,
        sampledImageCount: 14,
        sampledVideoCount: 2,
        imagesOnlyLimitation: nil
      ),
      availableEligibleAssetCount: 120,
      sampledIdentifierCount: 2,
      sampledIdentifierDigest: digest.signature,
      measurements: [baseline, candidate],
      comparison: comparison,
      validation: PreviewCardsBenchmarkReport.Validation(
        globallyDisjointAssignments: true,
        counterbalancedRecencyExecutionAndGeometry: true,
        mixedMediaCoverage: true,
        everyStripBecameRenderable: true,
        everyRequestCompletedExactly: true,
        matchingRequestedAndFinalDigests: true,
        validDecodedDimensions: true,
        noUnexpectedOrStaleEvents: true,
        candidateStoreSchedulerQuiescent: true,
        candidatePreheatUnused: true,
        noRawIdentifiersEncoded: true
      )
    )
    let json = try #require(String(data: JSONEncoder().encode(report), encoding: .utf8))
    #expect(json.contains(digest.signature))
    #expect(json.contains("assignmentOrderedIdentifierDigest"))
    #expect(json.contains("warmRevisitDiagnostic"))
    #expect(!json.contains(rawIdentifier))
  }

  private static func plan() throws -> PreviewCardsSamplePlan {
    let assets = (0..<192).map {
      PreviewCardsSamplePlan.Asset(identifier: "asset-\($0)", mediaType: .image)
    }
    return try PreviewCardsSamplePlan(
      assets: assets,
      visibleCardCount: 4,
      iterations: 12
    )
  }

  private static var configuration: PreviewCardsBenchmarkReport.Configuration {
    PreviewCardsBenchmarkReport.Configuration(
      visibleCardCount: 4,
      supportedCardArities: [1, 2, 3],
      totalCardPixelWidth: 1_200,
      cardPixelHeight: 320,
      cardLayouts: [
        .init(arity: 1, itemPixelWidth: 1_200, itemPixelHeight: 320),
        .init(arity: 2, itemPixelWidth: 600, itemPixelHeight: 320),
        .init(arity: 3, itemPixelWidth: 400, itemPixelHeight: 320),
      ],
      iterations: 12,
      timeoutMilliseconds: 30_000,
      rssSampleIntervalMilliseconds: 5,
      rssMeasurementScope: "after loader construction",
      networkAccessAllowed: true,
      preheatEnabled: false,
      baselinePhotoKitBehavior: "baseline",
      candidatePhotoKitBehavior: "candidate",
      cacheParityScope: "cold only",
      workloadShape: "four cards",
      cancelResubmitDiagnostic: "deferred",
      warmRevisitDiagnostic: "deferred"
    )
  }

  private static func measurement(
    strategy: PreviewCardsBenchmarkStrategy,
    digest: String,
    renderableMilliseconds: Double,
    finalMilliseconds: Double,
    decodedPixels: Int64
  ) -> PreviewCardsBenchmarkReport.Measurement {
    let load = PreviewCardsBenchmarkReport.LoadMeasurement(
      requestedCount: 1,
      cardCount: 1,
      requestedIdentifierDigest: digest,
      finalIdentifierDigest: digest,
      requestedTargetPixelCount: 1_000,
      renderableCount: 1,
      degradedAssetCount: strategy == .photoAssetThumbnailStore ? 1 : 0,
      degradedEventCount: strategy == .photoAssetThumbnailStore ? 1 : 0,
      finalCount: 1,
      failureCount: 0,
      timedOutCount: 0,
      unexpectedEventCount: 0,
      staleEventCount: 0,
      invalidDimensionCount: 0,
      failureCodeCounts: [:],
      firstRenderableMilliseconds: renderableMilliseconds,
      firstDegradedMilliseconds: strategy == .photoAssetThumbnailStore
        ? renderableMilliseconds : nil,
      firstFinalMilliseconds: finalMilliseconds,
      allStripRenderableMilliseconds: renderableMilliseconds,
      allFinalMilliseconds: finalMilliseconds,
      allTerminalMilliseconds: finalMilliseconds,
      finalLatency: .init(
        p50Milliseconds: finalMilliseconds,
        p95Milliseconds: finalMilliseconds,
        maximumMilliseconds: finalMilliseconds
      ),
      finalDimensions: .init(
        minimumPixelWidth: Int(decodedPixels),
        maximumPixelWidth: Int(decodedPixels),
        minimumPixelHeight: 1,
        maximumPixelHeight: 1,
        totalDecodedPixels: decodedPixels
      )
    )
    return PreviewCardsBenchmarkReport.Measurement(
      strategy: strategy,
      iteration: 1,
      recencySlot: 0,
      executionPosition: 0,
      cardArities: [1],
      assignmentIdentifierDigest: digest,
      assignmentOrderedIdentifierDigest: digest,
      assignmentImageCount: 1,
      assignmentVideoCount: 0,
      load: load,
      storeMetricsAtTerminal: nil,
      storeMetricsAfterCleanup: nil,
      memory: .init(
        PreviewCardsResidentMemorySampler.Snapshot(
          baselineBytes: 10_000,
          allStripRenderableBytes: 10_100,
          allFinalBytes: 10_200,
          afterTeardownBytes: 10_050,
          sampledPeakBytes: 10_300,
          sampleCount: 5
        )
      )
    )
  }
}
