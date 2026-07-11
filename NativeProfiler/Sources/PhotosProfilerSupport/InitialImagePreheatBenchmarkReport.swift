import BatchAssetInfoCore
import Foundation

public struct InitialImagePreheatBenchmarkReport: Encodable, Sendable {
  public enum Arm: String, Encodable, Equatable, Sendable {
    case control
    case windowedPreheat
  }

  public struct Configuration: Encodable, Sendable {
    public let imageCounts: [Int]
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let iterations: Int
    public let timeoutMilliseconds: Int
    public let networkAccessAllowed: Bool
    public let leadWindowMatchesTargetCount: Bool
    public let preheatEstimatedBytesPerPixel: UInt64
    public let preheatMaximumPixelCount: UInt64
    public let preheatMaximumEstimatedByteCount: UInt64
    public let preheatMaximumKeyCount: Int
  }

  public struct PreheatMetrics: Encodable, Equatable, Sendable {
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

    init(_ metrics: PhotoAssetThumbnailPreheatRuntimeMetrics) {
      updateCount = metrics.updateCount
      startedKeyCount = metrics.startedKeyCount
      stoppedKeyCount = metrics.stoppedKeyCount
      retainedKeyCount = metrics.retainedKeyCount
      fetchIdentifierCount = metrics.fetchIdentifierCount
      cacheStartCallCount = metrics.cacheStartCallCount
      cacheStopCallCount = metrics.cacheStopCallCount
      cacheStopAllCount = metrics.cacheStopAllCount
      activeKeyCount = metrics.activeKeyCount
      pendingKeyCount = metrics.pendingKeyCount
    }
  }

  public struct StoreMetrics: Encodable, Equatable, Sendable {
    public struct AssetFetchScheduler: Encodable, Equatable, Sendable {
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
      public let activeBatchPriority: String?
      public let queuedPreheatIdentifierCount: Int
      public let queuedVisibleIdentifierCount: Int
      public let isQuiescent: Bool

      init(_ metrics: PhotoAssetThumbnailAssetFetchSchedulerMetrics) {
        supersededPreheatBatchCount = metrics.supersededPreheatBatchCount
        supersededPreheatIdentifierCount = metrics.supersededPreheatIdentifierCount
        visiblePromotionIdentifierCount = metrics.visiblePromotionIdentifierCount
        removedQueuedVisibleIdentifierCount = metrics.removedQueuedVisibleIdentifierCount
        invalidatedInFlightBatchCount = metrics.invalidatedInFlightBatchCount
        invalidatedInFlightIdentifierCount = metrics.invalidatedInFlightIdentifierCount
        maximumQueuedPreheatIdentifierCount = metrics.maximumQueuedPreheatIdentifierCount
        maximumQueuedVisibleIdentifierCount = metrics.maximumQueuedVisibleIdentifierCount
        preheatBatchCount = metrics.preheatBatchCount
        preheatBatchIdentifierCount = metrics.preheatBatchIdentifierCount
        visibleBatchCount = metrics.visibleBatchCount
        visibleBatchIdentifierCount = metrics.visibleBatchIdentifierCount
        activeBatchPriority = metrics.activeBatchPriority?.rawValue
        queuedPreheatIdentifierCount = metrics.queuedPreheatIdentifierCount
        queuedVisibleIdentifierCount = metrics.queuedVisibleIdentifierCount
        isQuiescent = metrics.isQuiescent
      }
    }

    public let assetFetchBatchCount: Int
    public let assetFetchIdentifierCount: Int
    public let imageRequestCount: Int
    public let assetFetchScheduler: AssetFetchScheduler
    public let preheat: PreheatMetrics

    init(_ metrics: PhotoAssetThumbnailStoreMetrics) {
      assetFetchBatchCount = metrics.assetFetchBatchCount
      assetFetchIdentifierCount = metrics.assetFetchIdentifierCount
      imageRequestCount = metrics.imageRequestCount
      assetFetchScheduler = AssetFetchScheduler(metrics.assetFetchScheduler)
      preheat = PreheatMetrics(metrics.preheat)
    }
  }

  public struct LeadMeasurement: Encodable, Equatable, Sendable {
    public let requestedIdentifierDigest: String
    public let finalIdentifierDigest: String
    public let requestedCount: Int
    public let finalCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let elapsedMilliseconds: Double
  }

  /// Monotonic markers relative to the start of one arm measurement.
  ///
  /// The end-to-end performance interval ends at `targetTerminalMilliseconds`. The later markers
  /// make profiler-only validation and metrics overhead visible without charging it to the user-
  /// observable interval. Validation and metrics work between the lead and target phases remains
  /// inside the end-to-end interval.
  public struct PhaseMarkers: Encodable, Equatable, Sendable {
    public let preheatSubmittedMilliseconds: Double?
    public let leadRequestStartedMilliseconds: Double
    public let leadTerminalMilliseconds: Double
    public let leadValidationCompletedMilliseconds: Double
    public let metricsAfterLeadCapturedMilliseconds: Double
    public let targetRequestStartedMilliseconds: Double
    public let targetTerminalMilliseconds: Double
    public let targetValidationCompletedMilliseconds: Double
    public let metricsAfterTargetCapturedMilliseconds: Double

    var interphaseMilliseconds: Double {
      targetRequestStartedMilliseconds - leadTerminalMilliseconds
    }
  }

  public struct ContinuousTiming: Encodable, Equatable, Sendable {
    /// One monotonic interval that starts before candidate preheat submission and ends when every
    /// target request reaches a terminal state.
    public let elapsedThroughTargetTerminalMilliseconds: Double
    public let phaseMarkers: PhaseMarkers
  }

  public struct Measurement: Encodable, Equatable, Sendable {
    public let arm: Arm
    public let imageCount: Int
    public let iteration: Int
    public let samplePosition: InitialImageSamplePosition
    public let executedFirst: Bool
    public let lead: LeadMeasurement
    public let target: InitialImageBenchmarkReport.Measurement
    public let continuousTiming: ContinuousTiming
    public let metricsAfterLead: StoreMetrics
    public let metricsAfterTarget: StoreMetrics
  }

  public struct ArmAggregate: Encodable, Equatable, Sendable {
    public let measurementCount: Int
    public let leadFinalImageCount: Int
    public let leadFailureCount: Int
    public let leadTimedOutCount: Int
    public let targetFinalImageCount: Int
    public let targetFailureCount: Int
    public let targetTimedOutCount: Int
    public let medianLeadElapsedMilliseconds: Double?
    public let medianTargetFirstRenderableMilliseconds: Double?
    public let medianTargetFirstFinalMilliseconds: Double?
    public let medianTargetAllVisibleFinalMilliseconds: Double?
    public let medianTargetAllTerminalMilliseconds: Double?
    public let medianTargetFinalP50Milliseconds: Double?
    public let medianTargetFinalP95Milliseconds: Double?
    public let medianTargetFinalMaximumMilliseconds: Double?
    public let medianInterphaseMilliseconds: Double?
    public let medianEndToEndMilliseconds: Double?
  }

  public struct TargetLatencySpeedup: Encodable, Equatable, Sendable {
    public let firstRenderable: Double?
    public let firstFinal: Double?
    public let allVisibleFinal: Double?
    public let allTerminal: Double?
    public let finalP50: Double?
    public let finalP95: Double?
    public let finalMaximum: Double?
  }

  public struct CountComparison: Encodable, Equatable, Sendable {
    public let imageCount: Int
    public let control: ArmAggregate
    public let windowedPreheat: ArmAggregate
    public let targetLatencySpeedup: TargetLatencySpeedup
    public let endToEndSpeedup: Double?
  }

  public let schemaVersion: Int
  public let configuration: Configuration
  public let availableRecentImageCount: Int
  public let sampledIdentifierCount: Int
  public let sampledIdentifierDigest: String
  public let disjointLeadAndTargetWindows: Bool
  public let measurements: [Measurement]
  public let comparisons: [CountComparison]

  static func comparison(
    imageCount: Int,
    measurements: [Measurement]
  ) -> CountComparison {
    let matching = measurements.filter { $0.imageCount == imageCount }
    let control = aggregate(matching.filter { $0.arm == .control })
    let windowedPreheat = aggregate(matching.filter { $0.arm == .windowedPreheat })
    return CountComparison(
      imageCount: imageCount,
      control: control,
      windowedPreheat: windowedPreheat,
      targetLatencySpeedup: TargetLatencySpeedup(
        firstRenderable: speedup(
          control.medianTargetFirstRenderableMilliseconds,
          windowedPreheat.medianTargetFirstRenderableMilliseconds
        ),
        firstFinal: speedup(
          control.medianTargetFirstFinalMilliseconds,
          windowedPreheat.medianTargetFirstFinalMilliseconds
        ),
        allVisibleFinal: speedup(
          control.medianTargetAllVisibleFinalMilliseconds,
          windowedPreheat.medianTargetAllVisibleFinalMilliseconds
        ),
        allTerminal: speedup(
          control.medianTargetAllTerminalMilliseconds,
          windowedPreheat.medianTargetAllTerminalMilliseconds
        ),
        finalP50: speedup(
          control.medianTargetFinalP50Milliseconds,
          windowedPreheat.medianTargetFinalP50Milliseconds
        ),
        finalP95: speedup(
          control.medianTargetFinalP95Milliseconds,
          windowedPreheat.medianTargetFinalP95Milliseconds
        ),
        finalMaximum: speedup(
          control.medianTargetFinalMaximumMilliseconds,
          windowedPreheat.medianTargetFinalMaximumMilliseconds
        )
      ),
      endToEndSpeedup: speedup(
        control.medianEndToEndMilliseconds,
        windowedPreheat.medianEndToEndMilliseconds
      )
    )
  }

  private static func aggregate(_ measurements: [Measurement]) -> ArmAggregate {
    ArmAggregate(
      measurementCount: measurements.count,
      leadFinalImageCount: measurements.reduce(0) { $0 + $1.lead.finalCount },
      leadFailureCount: measurements.reduce(0) { $0 + $1.lead.failureCount },
      leadTimedOutCount: measurements.reduce(0) { $0 + $1.lead.timedOutCount },
      targetFinalImageCount: measurements.reduce(0) { $0 + $1.target.finalCount },
      targetFailureCount: measurements.reduce(0) { $0 + $1.target.failureCount },
      targetTimedOutCount: measurements.reduce(0) { $0 + $1.target.timedOutCount },
      medianLeadElapsedMilliseconds: median(measurements.map(\.lead.elapsedMilliseconds)),
      medianTargetFirstRenderableMilliseconds: median(
        measurements.compactMap(\.target.firstRenderableMilliseconds)
      ),
      medianTargetFirstFinalMilliseconds: median(
        measurements.compactMap(\.target.firstFinalMilliseconds)
      ),
      medianTargetAllVisibleFinalMilliseconds: medianWhenComplete(
        measurements.map(\.target.allVisibleFinalMilliseconds),
        expectedCount: measurements.count
      ),
      medianTargetAllTerminalMilliseconds: median(
        measurements.map(\.target.allTerminalMilliseconds)
      ),
      medianTargetFinalP50Milliseconds: median(
        measurements.compactMap { $0.target.finalLatency?.p50Milliseconds }
      ),
      medianTargetFinalP95Milliseconds: median(
        measurements.compactMap { $0.target.finalLatency?.p95Milliseconds }
      ),
      medianTargetFinalMaximumMilliseconds: median(
        measurements.compactMap { $0.target.finalLatency?.maximumMilliseconds }
      ),
      medianInterphaseMilliseconds: median(
        measurements.map { $0.continuousTiming.phaseMarkers.interphaseMilliseconds }
      ),
      medianEndToEndMilliseconds: median(
        measurements.map(\.continuousTiming.elapsedThroughTargetTerminalMilliseconds)
      )
    )
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

  private static func medianWhenComplete(_ values: [Double?], expectedCount: Int) -> Double? {
    let complete = values.compactMap { $0 }
    guard complete.count == expectedCount else {
      return nil
    }
    return median(complete)
  }

  private static func speedup(_ control: Double?, _ candidate: Double?) -> Double? {
    guard let control, let candidate, candidate > 0 else {
      return nil
    }
    return control / candidate
  }
}
