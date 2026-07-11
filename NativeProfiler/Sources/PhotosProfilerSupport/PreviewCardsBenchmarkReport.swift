import Foundation

public struct PreviewCardsBenchmarkReport: Encodable, Sendable {
  public struct CardLayout: Encodable, Equatable, Sendable {
    public let arity: Int
    public let itemPixelWidth: Int
    public let itemPixelHeight: Int
  }

  public struct Configuration: Encodable, Sendable {
    public let visibleCardCount: Int
    public let supportedCardArities: [Int]
    public let totalCardPixelWidth: Int
    public let cardPixelHeight: Int
    public let cardLayouts: [CardLayout]
    public let iterations: Int
    public let timeoutMilliseconds: Int
    public let rssSampleIntervalMilliseconds: Int
    public let rssMeasurementScope: String
    public let networkAccessAllowed: Bool
    public let preheatEnabled: Bool
    public let baselinePhotoKitBehavior: String
    public let candidatePhotoKitBehavior: String
    public let cacheParityScope: String
    public let workloadShape: String
    public let cancelResubmitDiagnostic: String
    public let warmRevisitDiagnostic: String
  }

  public struct MediaCoverage: Encodable, Sendable {
    public let supportedMediaTypes: [String]
    public let targetVideoStride: Int
    public let availableImageCount: Int
    public let availableVideoCount: Int
    public let sampledImageCount: Int
    public let sampledVideoCount: Int
    public let imagesOnlyLimitation: String?
  }

  public struct LoadMeasurement: Encodable, Equatable, Sendable {
    public let requestedCount: Int
    public let cardCount: Int
    public let requestedIdentifierDigest: String
    public let finalIdentifierDigest: String
    public let requestedTargetPixelCount: Int64
    public let renderableCount: Int
    public let degradedAssetCount: Int
    public let degradedEventCount: Int
    public let finalCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let unexpectedEventCount: Int
    public let staleEventCount: Int
    public let invalidDimensionCount: Int
    public let failureCodeCounts: [String: Int]
    public let firstRenderableMilliseconds: Double?
    public let firstDegradedMilliseconds: Double?
    public let firstFinalMilliseconds: Double?
    public let allStripRenderableMilliseconds: Double?
    public let allFinalMilliseconds: Double?
    public let allTerminalMilliseconds: Double
    public let finalLatency: InitialImageBenchmarkReport.LatencySummary?
    public let finalDimensions: InitialImageBenchmarkReport.DimensionSummary?
  }

  public struct MemoryMeasurement: Encodable, Equatable, Sendable {
    public let source: String
    public let units: String
    public let sameProcessAllocatorAndPhotoKitCachesMayCarryAcrossRuns: Bool
    public let baselineRssBytes: UInt64
    public let allStripRenderableRssBytes: UInt64?
    public let allFinalRssBytes: UInt64?
    public let afterTeardownRssBytes: UInt64?
    public let sampledPeakRssBytes: UInt64
    public let allStripRenderableDeltaBytes: Int64?
    public let allFinalDeltaBytes: Int64?
    public let afterTeardownDeltaBytes: Int64?
    public let sampledPeakDeltaBytes: Int64
    public let sampleCount: Int

    init(_ snapshot: PreviewCardsResidentMemorySampler.Snapshot) {
      source = "mach_task_basic_info.resident_size"
      units = "bytes"
      sameProcessAllocatorAndPhotoKitCachesMayCarryAcrossRuns = true
      baselineRssBytes = snapshot.baselineBytes
      allStripRenderableRssBytes = snapshot.allStripRenderableBytes
      allFinalRssBytes = snapshot.allFinalBytes
      afterTeardownRssBytes = snapshot.afterTeardownBytes
      sampledPeakRssBytes = snapshot.sampledPeakBytes
      allStripRenderableDeltaBytes = Self.delta(
        snapshot.allStripRenderableBytes,
        from: snapshot.baselineBytes
      )
      allFinalDeltaBytes = Self.delta(snapshot.allFinalBytes, from: snapshot.baselineBytes)
      afterTeardownDeltaBytes = Self.delta(
        snapshot.afterTeardownBytes,
        from: snapshot.baselineBytes
      )
      sampledPeakDeltaBytes = Self.delta(snapshot.sampledPeakBytes, from: snapshot.baselineBytes)
      sampleCount = snapshot.sampleCount
    }

    private static func delta(_ value: UInt64?, from baseline: UInt64) -> Int64? {
      value.map { delta($0, from: baseline) }
    }

    private static func delta(_ value: UInt64, from baseline: UInt64) -> Int64 {
      if value >= baseline {
        return Int64(min(value - baseline, UInt64(Int64.max)))
      }
      return -Int64(min(baseline - value, UInt64(Int64.max)))
    }
  }

  public struct Measurement: Encodable, Equatable, Sendable {
    public let strategy: PreviewCardsBenchmarkStrategy
    public let iteration: Int
    public let recencySlot: Int
    public let executionPosition: Int
    public let cardArities: [Int]
    public let assignmentIdentifierDigest: String
    public let assignmentOrderedIdentifierDigest: String
    public let assignmentImageCount: Int
    public let assignmentVideoCount: Int
    public let load: LoadMeasurement
    public let storeMetricsAtTerminal: ThumbnailScrollBenchmarkReport.StoreMetrics?
    public let storeMetricsAfterCleanup: ThumbnailScrollBenchmarkReport.StoreMetrics?
    public let memory: MemoryMeasurement
  }

  public struct StrategyAggregate: Encodable, Equatable, Sendable {
    public let measurementCount: Int
    public let finalImageCount: Int
    public let degradedAssetCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let totalDecodedPixels: Int64
    public let medianAllStripRenderableMilliseconds: Double?
    public let medianAllFinalMilliseconds: Double?
    public let medianFinalP95Milliseconds: Double?
    public let medianSampledPeakRssDeltaBytes: Double?
    public let maximumSampledPeakRssDeltaBytes: Int64?
  }

  public struct Comparison: Encodable, Equatable, Sendable {
    public let baseline: StrategyAggregate
    public let candidate: StrategyAggregate
    public let candidateAllStripRenderableSpeedup: Double?
    public let candidateAllFinalSpeedup: Double?
    public let candidateFinalP95Speedup: Double?
    public let candidateToBaselineDecodedPixelRatio: Double?
  }

  public struct Validation: Encodable, Equatable, Sendable {
    public let globallyDisjointAssignments: Bool
    public let counterbalancedRecencyExecutionAndGeometry: Bool
    public let mixedMediaCoverage: Bool
    public let everyStripBecameRenderable: Bool
    public let everyRequestCompletedExactly: Bool
    public let matchingRequestedAndFinalDigests: Bool
    public let validDecodedDimensions: Bool
    public let noUnexpectedOrStaleEvents: Bool
    public let candidateStoreSchedulerQuiescent: Bool
    public let candidatePreheatUnused: Bool
    public let noRawIdentifiersEncoded: Bool
  }

  public let schemaVersion: Int
  public let configuration: Configuration
  public let mediaCoverage: MediaCoverage
  public let availableEligibleAssetCount: Int
  public let sampledIdentifierCount: Int
  public let sampledIdentifierDigest: String
  public let measurements: [Measurement]
  public let comparison: Comparison
  public let validation: Validation

  static func comparison(_ measurements: [Measurement]) -> Comparison {
    let baseline = aggregate(
      measurements.filter { $0.strategy == .expoPhotoLibraryAssetLoaderPhotoKit }
    )
    let candidate = aggregate(
      measurements.filter { $0.strategy == .photoAssetThumbnailStore }
    )
    return Comparison(
      baseline: baseline,
      candidate: candidate,
      candidateAllStripRenderableSpeedup: speedup(
        baseline.medianAllStripRenderableMilliseconds,
        candidate.medianAllStripRenderableMilliseconds
      ),
      candidateAllFinalSpeedup: speedup(
        baseline.medianAllFinalMilliseconds,
        candidate.medianAllFinalMilliseconds
      ),
      candidateFinalP95Speedup: speedup(
        baseline.medianFinalP95Milliseconds,
        candidate.medianFinalP95Milliseconds
      ),
      candidateToBaselineDecodedPixelRatio: ratio(
        candidate.totalDecodedPixels,
        baseline.totalDecodedPixels
      )
    )
  }

  private static func aggregate(_ measurements: [Measurement]) -> StrategyAggregate {
    StrategyAggregate(
      measurementCount: measurements.count,
      finalImageCount: measurements.reduce(0) { $0 + $1.load.finalCount },
      degradedAssetCount: measurements.reduce(0) { $0 + $1.load.degradedAssetCount },
      failureCount: measurements.reduce(0) { $0 + $1.load.failureCount },
      timedOutCount: measurements.reduce(0) { $0 + $1.load.timedOutCount },
      totalDecodedPixels: measurements.reduce(into: Int64(0)) { total, measurement in
        total += measurement.load.finalDimensions?.totalDecodedPixels ?? 0
      },
      medianAllStripRenderableMilliseconds: medianWhenComplete(
        measurements.map(\.load.allStripRenderableMilliseconds),
        expectedCount: measurements.count
      ),
      medianAllFinalMilliseconds: medianWhenComplete(
        measurements.map(\.load.allFinalMilliseconds),
        expectedCount: measurements.count
      ),
      medianFinalP95Milliseconds: medianWhenComplete(
        measurements.map { $0.load.finalLatency?.p95Milliseconds },
        expectedCount: measurements.count
      ),
      medianSampledPeakRssDeltaBytes: median(
        measurements.map { Double($0.memory.sampledPeakDeltaBytes) }
      ),
      maximumSampledPeakRssDeltaBytes: measurements.map(\.memory.sampledPeakDeltaBytes).max()
    )
  }

  private static func medianWhenComplete(_ values: [Double?], expectedCount: Int) -> Double? {
    let complete = values.compactMap { $0 }
    guard complete.count == expectedCount else {
      return nil
    }
    return median(complete)
  }

  private static func median(_ values: [Double]) -> Double? {
    guard !values.isEmpty else {
      return nil
    }
    let sorted = values.sorted()
    if sorted.count.isMultiple(of: 2) {
      let upper = sorted.count / 2
      return (sorted[upper - 1] + sorted[upper]) / 2
    }
    return sorted[sorted.count / 2]
  }

  private static func speedup(_ baseline: Double?, _ candidate: Double?) -> Double? {
    guard let baseline, let candidate, candidate > 0 else {
      return nil
    }
    return baseline / candidate
  }

  private static func ratio(_ numerator: Int64, _ denominator: Int64) -> Double? {
    guard denominator > 0 else {
      return nil
    }
    return Double(numerator) / Double(denominator)
  }
}
