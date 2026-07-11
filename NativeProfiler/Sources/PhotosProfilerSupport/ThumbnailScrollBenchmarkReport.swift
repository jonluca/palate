import BatchAssetInfoCore
import Foundation

public struct ThumbnailScrollBenchmarkReport: Encodable, Sendable {
  public struct Configuration: Encodable, Sendable {
    public let columnCount: Int
    public let visibleRowCount: Int
    public let aheadRowCount: Int
    public let behindRowCount: Int
    public let flingTransitionCount: Int
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let iterations: Int
    public let timeoutMilliseconds: Int
    public let rssSampleIntervalMilliseconds: Int
    public let networkAccessAllowed: Bool
    public let contentMode: String
    public let requestSubmissionOrder: String
    public let workloadShape: String
    public let preheatMaximumKeyCount: Int
    public let preheatMaximumPixelCount: UInt64
    public let preheatMaximumEstimatedByteCount: UInt64
    public let preheatEstimatedBytesPerPixel: UInt64
  }

  public struct MediaCoverage: Encodable, Sendable {
    public let supportedMediaTypes: [String]
    public let videoThumbnailRequestPath: String
    public let availableImageCount: Int
    public let availableVideoCount: Int
    public let sampledImageCount: Int
    public let sampledVideoCount: Int
    public let imagesOnlyLimitation: String?
  }

  public struct AssetFetchSchedulerMetrics: Encodable, Equatable, Sendable {
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
    }
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
    public let assetFetchBatchCount: Int
    public let assetFetchIdentifierCount: Int
    public let imageRequestCount: Int
    public let assetFetchScheduler: AssetFetchSchedulerMetrics
    public let preheat: PreheatMetrics

    init(_ metrics: PhotoAssetThumbnailStoreMetrics) {
      assetFetchBatchCount = metrics.assetFetchBatchCount
      assetFetchIdentifierCount = metrics.assetFetchIdentifierCount
      imageRequestCount = metrics.imageRequestCount
      assetFetchScheduler = AssetFetchSchedulerMetrics(metrics.assetFetchScheduler)
      preheat = PreheatMetrics(metrics.preheat)
    }
  }

  public struct PlannedWindow: Encodable, Equatable, Sendable {
    public let requestedCandidateCount: Int
    public let requestedCandidateOrderedDigest: String
    public let expectedMaximumSelectedKeyCount: Int
    public let expectedMaximumSelectedPixelCount: UInt64
    public let expectedMaximumSelectedEstimatedByteCount: UInt64
  }

  public struct PhaseMarkers: Encodable, Equatable, Sendable {
    public let currentVisibleRequestSubmittedMilliseconds: Double
    public let initialPreheatSubmittedMilliseconds: Double?
    public let rapidPreheatUpdatesSubmittedMilliseconds: Double?
    public let nextVisibleRequestSubmittedMilliseconds: Double
    public let nextVisiblePreheatSubmittedMilliseconds: Double?
    public let currentVisibleTerminalMilliseconds: Double
    public let nextVisibleTerminalMilliseconds: Double
    public let validationCompletedMilliseconds: Double
    public let metricsCapturedMilliseconds: Double
  }

  public struct ContinuousTiming: Encodable, Equatable, Sendable {
    /// Destination latency; the intentionally uncancelled current window may finish later.
    public let elapsedThroughNextVisibleTerminalMilliseconds: Double
    public let elapsedThroughAllIssuedVisibleTerminalsMilliseconds: Double
    public let phaseMarkers: PhaseMarkers
  }

  public struct MemoryMeasurement: Encodable, Equatable, Sendable {
    public let source: String
    public let units: String
    public let sameProcessAllocatorAndPhotoKitCachesMayCarryAcrossArms: Bool
    public let baselineRssBytes: UInt64
    public let currentVisibleTerminalRssBytes: UInt64?
    public let nextVisibleTerminalRssBytes: UInt64?
    public let afterPreheatEndRssBytes: UInt64?
    public let afterCacheCleanupRssBytes: UInt64?
    public let sampledPeakRssBytes: UInt64
    public let sampledPeakThroughNextVisibleTerminalRssBytes: UInt64?
    public let currentVisibleTerminalDeltaBytes: Int64?
    public let nextVisibleTerminalDeltaBytes: Int64?
    public let afterPreheatEndDeltaBytes: Int64?
    public let afterCacheCleanupDeltaBytes: Int64?
    public let sampledPeakDeltaBytes: Int64
    public let sampledPeakThroughNextVisibleTerminalDeltaBytes: Int64?
    public let sampleCount: Int

    init(_ snapshot: ThumbnailScrollResidentMemorySampler.Snapshot) {
      source = "mach_task_basic_info.resident_size"
      units = "bytes"
      sameProcessAllocatorAndPhotoKitCachesMayCarryAcrossArms = true
      baselineRssBytes = snapshot.baselineBytes
      currentVisibleTerminalRssBytes = snapshot.currentVisibleTerminalBytes
      nextVisibleTerminalRssBytes = snapshot.nextVisibleTerminalBytes
      afterPreheatEndRssBytes = snapshot.afterPreheatEndBytes
      afterCacheCleanupRssBytes = snapshot.afterCacheCleanupBytes
      sampledPeakRssBytes = snapshot.sampledPeakBytes
      sampledPeakThroughNextVisibleTerminalRssBytes =
        snapshot.nextVisibleTerminalSampledPeakBytes
      currentVisibleTerminalDeltaBytes = Self.delta(
        snapshot.currentVisibleTerminalBytes,
        from: snapshot.baselineBytes
      )
      nextVisibleTerminalDeltaBytes = Self.delta(
        snapshot.nextVisibleTerminalBytes,
        from: snapshot.baselineBytes
      )
      afterPreheatEndDeltaBytes = Self.delta(
        snapshot.afterPreheatEndBytes,
        from: snapshot.baselineBytes
      )
      afterCacheCleanupDeltaBytes = Self.delta(
        snapshot.afterCacheCleanupBytes,
        from: snapshot.baselineBytes
      )
      sampledPeakDeltaBytes = Self.delta(snapshot.sampledPeakBytes, from: snapshot.baselineBytes)
      sampledPeakThroughNextVisibleTerminalDeltaBytes = Self.delta(
        snapshot.nextVisibleTerminalSampledPeakBytes,
        from: snapshot.baselineBytes
      )
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
    public let arm: ThumbnailScrollBenchmarkArm
    public let iteration: Int
    public let recencySlot: Int
    public let executionPosition: Int
    public let assignmentIdentifierDigest: String
    public let assignmentImageCount: Int
    public let assignmentVideoCount: Int
    public let rapidPreheatUpdateCount: Int
    public let initialWindowPlan: PlannedWindow
    public let rapidWindowPlans: [PlannedWindow]
    public let nextWindowPlan: PlannedWindow
    public let currentVisible: InitialImageBenchmarkReport.Measurement
    public let nextVisible: InitialImageBenchmarkReport.Measurement
    public let continuousTiming: ContinuousTiming
    public let metricsAfterVisibleWindows: StoreMetrics
    public let metricsAfterPreheatEnd: StoreMetrics
    public let metricsAfterCacheCleanup: StoreMetrics
    public let memory: MemoryMeasurement
  }

  public struct ArmAggregate: Encodable, Equatable, Sendable {
    public let measurementCount: Int
    public let currentVisibleFinalCount: Int
    public let nextVisibleFinalCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let medianCurrentVisibleAllTerminalMilliseconds: Double?
    public let medianNextVisibleAllTerminalMilliseconds: Double?
    public let medianDestinationCycleMilliseconds: Double?
    public let medianAllIssuedVisibleTerminalsMilliseconds: Double?
    public let medianSampledPeakRssDeltaBytes: Double?
    public let maximumSampledPeakRssDeltaBytes: Int64?
    public let medianStartedKeyCount: Double?
    public let medianStoppedKeyCountAfterEnd: Double?
    public let medianSupersededPreheatIdentifierCount: Double?
    public let medianVisiblePromotionIdentifierCount: Double?
  }

  public struct ArmComparison: Encodable, Equatable, Sendable {
    public let arm: ThumbnailScrollBenchmarkArm
    public let aggregate: ArmAggregate
    public let currentVisibleSpeedupVersusControl: Double?
    public let nextVisibleSpeedupVersusControl: Double?
    public let destinationCycleSpeedupVersusControl: Double?
    public let allIssuedVisibleTerminalsSpeedupVersusControl: Double?
  }

  public struct Validation: Encodable, Sendable {
    public let globallyDisjointAssignments: Bool
    public let everyVisibleWindowCompletedExactly: Bool
    public let noRawIdentifiersEncoded: Bool
    public let logicalPreheatEmptyAfterEnd: Bool
    public let schedulerStateEmptyAfterCacheCleanup: Bool
  }

  public let schemaVersion: Int
  public let configuration: Configuration
  public let mediaCoverage: MediaCoverage
  public let availableEligibleAssetCount: Int
  public let sampledIdentifierCount: Int
  public let sampledIdentifierDigest: String
  public let assetsPerAssignment: Int
  public let measurements: [Measurement]
  public let comparisons: [ArmComparison]
  public let validation: Validation

  static func comparisons(_ measurements: [Measurement]) -> [ArmComparison] {
    let control = aggregate(measurements.filter { $0.arm == .control })
    return ThumbnailScrollBenchmarkArm.allCases.map { arm in
      let aggregate = aggregate(measurements.filter { $0.arm == arm })
      return ArmComparison(
        arm: arm,
        aggregate: aggregate,
        currentVisibleSpeedupVersusControl: speedup(
          control.medianCurrentVisibleAllTerminalMilliseconds,
          aggregate.medianCurrentVisibleAllTerminalMilliseconds
        ),
        nextVisibleSpeedupVersusControl: speedup(
          control.medianNextVisibleAllTerminalMilliseconds,
          aggregate.medianNextVisibleAllTerminalMilliseconds
        ),
        destinationCycleSpeedupVersusControl: speedup(
          control.medianDestinationCycleMilliseconds,
          aggregate.medianDestinationCycleMilliseconds
        ),
        allIssuedVisibleTerminalsSpeedupVersusControl: speedup(
          control.medianAllIssuedVisibleTerminalsMilliseconds,
          aggregate.medianAllIssuedVisibleTerminalsMilliseconds
        )
      )
    }
  }

  private static func aggregate(_ measurements: [Measurement]) -> ArmAggregate {
    ArmAggregate(
      measurementCount: measurements.count,
      currentVisibleFinalCount: measurements.reduce(0) { $0 + $1.currentVisible.finalCount },
      nextVisibleFinalCount: measurements.reduce(0) { $0 + $1.nextVisible.finalCount },
      failureCount: measurements.reduce(0) {
        $0 + $1.currentVisible.failureCount + $1.nextVisible.failureCount
      },
      timedOutCount: measurements.reduce(0) {
        $0 + $1.currentVisible.timedOutCount + $1.nextVisible.timedOutCount
      },
      medianCurrentVisibleAllTerminalMilliseconds: median(
        measurements.map(\.currentVisible.allTerminalMilliseconds)
      ),
      medianNextVisibleAllTerminalMilliseconds: median(
        measurements.map(\.nextVisible.allTerminalMilliseconds)
      ),
      medianDestinationCycleMilliseconds: median(
        measurements.map(\.continuousTiming.elapsedThroughNextVisibleTerminalMilliseconds)
      ),
      medianAllIssuedVisibleTerminalsMilliseconds: median(
        measurements.map(
          \.continuousTiming.elapsedThroughAllIssuedVisibleTerminalsMilliseconds
        )
      ),
      medianSampledPeakRssDeltaBytes: median(
        measurements.compactMap {
          $0.memory.sampledPeakThroughNextVisibleTerminalDeltaBytes.map(Double.init)
        }
      ),
      maximumSampledPeakRssDeltaBytes: measurements.compactMap(
        \.memory.sampledPeakThroughNextVisibleTerminalDeltaBytes
      ).max(),
      medianStartedKeyCount: median(
        measurements.map { Double($0.metricsAfterVisibleWindows.preheat.startedKeyCount) }
      ),
      medianStoppedKeyCountAfterEnd: median(
        measurements.map { Double($0.metricsAfterPreheatEnd.preheat.stoppedKeyCount) }
      ),
      medianSupersededPreheatIdentifierCount: median(
        measurements.map {
          Double(
            $0.metricsAfterVisibleWindows.assetFetchScheduler.supersededPreheatIdentifierCount)
        }
      ),
      medianVisiblePromotionIdentifierCount: median(
        measurements.map {
          Double($0.metricsAfterVisibleWindows.assetFetchScheduler.visiblePromotionIdentifierCount)
        }
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

  private static func speedup(_ control: Double?, _ candidate: Double?) -> Double? {
    guard let control, let candidate, control.isFinite, candidate.isFinite, candidate > 0 else {
      return nil
    }
    return control / candidate
  }
}
