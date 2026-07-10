import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct PhotoLibraryVisionProfiler: VisionProfiling {
  private struct Measurement: Sendable {
    let outcomes: [PhotoAssetClassificationOutcome]
    let elapsedMilliseconds: Double

    var outcomeSummary: OutcomeSummary {
      let failureCount = outcomes.reduce(into: 0) { count, outcome in
        if case .failure = outcome {
          count += 1
        }
      }
      let totalLabelCount = outcomes.reduce(into: 0) { count, outcome in
        if case .success(let classification) = outcome {
          count += classification.labels.count
        }
      }
      return OutcomeSummary(
        processedSampleCount: outcomes.count,
        failureCount: failureCount,
        totalLabelCount: totalLabelCount
      )
    }
  }

  private struct OutcomeSummary: Sendable {
    let processedSampleCount: Int
    let failureCount: Int
    let totalLabelCount: Int
  }

  private struct StrategyMeasurements {
    private(set) var samplesMilliseconds: [Double] = []
    private(set) var processedSampleCount = 0
    private(set) var maximumFailureCount = 0
    private(set) var latestTotalLabelCount = 0

    mutating func record(_ measurement: Measurement) {
      let outcomes = measurement.outcomeSummary
      samplesMilliseconds.append(measurement.elapsedMilliseconds)
      processedSampleCount = outcomes.processedSampleCount
      maximumFailureCount = max(maximumFailureCount, outcomes.failureCount)
      latestTotalLabelCount = outcomes.totalLabelCount
    }

    func report(assetCount: Int) -> ProfilerReport.Vision.Strategy {
      precondition(!samplesMilliseconds.isEmpty)
      let timing = BenchmarkSummary.calculate(
        milliseconds: samplesMilliseconds,
        assetCount: assetCount
      )
      return ProfilerReport.Vision.Strategy(
        elapsedMilliseconds: timing.medianMilliseconds,
        assetsPerSecond: timing.medianAssetsPerSecond,
        processedSampleCount: processedSampleCount,
        failureCount: maximumFailureCount,
        totalLabelCount: latestTotalLabelCount,
        samplesMilliseconds: samplesMilliseconds,
        medianMilliseconds: timing.medianMilliseconds,
        p95Milliseconds: timing.p95Milliseconds
      )
    }
  }

  private struct MeasurementPair: Sendable {
    let baseline: Measurement
    let pipeline: Measurement
  }

  struct AssetWindowPlan: Equatable, Sendable {
    let requestedAssetsPerComparison: Int
    let assetsPerComparison: Int
    let comparisonCount: Int
    let availableAssetCount: Int
    let requestedUniqueAssetCount: Int
    let profiledUniqueAssetCount: Int

    func range(forComparisonAt index: Int) -> Range<Int> {
      precondition((0..<comparisonCount).contains(index))
      let start = index * assetsPerComparison
      return start..<(start + assetsPerComparison)
    }
  }

  public init() {}

  public func profile(
    assetIdentifiers: [String],
    sampleCount: Int,
    concurrency: Int,
    pipelineMaximumInFlight: Int,
    pipelineFirst: Bool,
    iterations: Int,
    warmupIterations: Int
  ) async throws -> ProfilerReport.Vision {
    guard sampleCount > 0 else {
      return ProfilerReport.Vision(
        status: "disabled",
        requestedSampleCount: 0,
        processedSampleCount: 0,
        failureCount: 0,
        totalLabelCount: 0,
        concurrency: concurrency,
        elapsedMilliseconds: nil,
        assetsPerSecond: nil,
        details: "Pass --vision-sample N to profile the shared PhotoKit/Vision classifier"
      )
    }

    let comparisonWindowCount = warmupIterations + iterations
    let identifierPlan = Self.assetWindowPlan(
      availableAssetCount: assetIdentifiers.count,
      requestedAssetsPerComparison: sampleCount,
      comparisonCount: comparisonWindowCount
    )
    let candidateIdentifiers = Array(
      assetIdentifiers.prefix(
        min(identifierPlan.requestedUniqueAssetCount, assetIdentifiers.count)
      )
    )
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: candidateIdentifiers, options: nil)
    var assetsByIdentifier: [String: PHAsset] = [:]
    assetsByIdentifier.reserveCapacity(fetchResult.count)
    fetchResult.enumerateObjects { asset, _, _ in
      assetsByIdentifier[asset.localIdentifier] = asset
    }
    let availableAssets = candidateIdentifiers.compactMap { assetsByIdentifier[$0] }
    let unavailableAssetCount = candidateIdentifiers.count - availableAssets.count
    let windowPlan = Self.assetWindowPlan(
      availableAssetCount: availableAssets.count,
      requestedAssetsPerComparison: sampleCount,
      comparisonCount: comparisonWindowCount
    )
    let profiledAssets = Array(availableAssets.prefix(windowPlan.profiledUniqueAssetCount))
    let measurementOrder = Self.measurementOrder(
      iterations: iterations,
      warmupIterations: warmupIterations,
      startingWithPipeline: pipelineFirst
    )
    let firstMeasuredPipelineFirst = measurementOrder.first == "pipeline-then-baseline"

    guard windowPlan.assetsPerComparison > 0 else {
      return ProfilerReport.Vision(
        status: "partial",
        requestedSampleCount: sampleCount,
        processedSampleCount: 0,
        failureCount: unavailableAssetCount,
        totalLabelCount: 0,
        concurrency: concurrency,
        elapsedMilliseconds: nil,
        assetsPerSecond: nil,
        details:
          "The available Photos snapshot is too small to allocate one disjoint asset to each comparison window",
        pipelineMaximumInFlight: pipelineMaximumInFlight,
        pipelineRanFirst: firstMeasuredPipelineFirst,
        measurementOrder: measurementOrder,
        availableAssetCount: assetIdentifiers.count,
        requestedUniqueAssetCount: windowPlan.requestedUniqueAssetCount,
        profiledUniqueAssetCount: 0,
        comparisonWindowCount: comparisonWindowCount,
        unavailableAssetCount: unavailableAssetCount
      )
    }

    let options = try PhotoAssetClassificationOptions(
      confidenceThreshold: 0.1,
      maximumLabelCount: 50
    )

    var baselineMeasurements = StrategyMeasurements()
    var pipelineMeasurements = StrategyMeasurements()
    var parityAccumulator = VisionOutcomeParityValidator.Accumulator()

    for runIndex in 0..<warmupIterations {
      let runPipelineFirst = Self.pipelineRunsFirst(
        at: runIndex,
        startingWithPipeline: pipelineFirst
      )
      let pair = await measurePair(
        assets: Array(
          profiledAssets[windowPlan.range(forComparisonAt: runIndex)]
        ),
        options: options,
        concurrency: concurrency,
        maximumInFlight: pipelineMaximumInFlight,
        pipelineFirst: runPipelineFirst
      )
      parityAccumulator.compare(
        baseline: pair.baseline.outcomes,
        pipeline: pair.pipeline.outcomes
      )
    }

    for runIndex in 0..<iterations {
      let runPipelineFirst = Self.pipelineRunsFirst(
        at: warmupIterations + runIndex,
        startingWithPipeline: pipelineFirst
      )
      let comparisonIndex = warmupIterations + runIndex
      let pair = await measurePair(
        assets: Array(
          profiledAssets[windowPlan.range(forComparisonAt: comparisonIndex)]
        ),
        options: options,
        concurrency: concurrency,
        maximumInFlight: pipelineMaximumInFlight,
        pipelineFirst: runPipelineFirst
      )
      parityAccumulator.compare(
        baseline: pair.baseline.outcomes,
        pipeline: pair.pipeline.outcomes
      )
      baselineMeasurements.record(pair.baseline)
      pipelineMeasurements.record(pair.pipeline)
    }

    let baselineReport = baselineMeasurements.report(assetCount: windowPlan.assetsPerComparison)
    let pipelineReport = pipelineMeasurements.report(assetCount: windowPlan.assetsPerComparison)
    let validation = parityAccumulator.validation
    let failureCount = pipelineReport.failureCount + unavailableAssetCount
    var detailComponents: [String] = []
    if windowPlan.assetsPerComparison < sampleCount {
      detailComponents.append(
        "Reduced each comparison from \(sampleCount) to \(windowPlan.assetsPerComparison) assets to keep all windows disjoint"
      )
    }
    if unavailableAssetCount > 0 {
      detailComponents.append(
        "PhotoKit could not refetch \(unavailableAssetCount) retained identifier(s)"
      )
    }
    if !validation.exactOutcomeParity {
      detailComponents.append(
        "Baseline and pipeline differed for \(validation.mismatchCount) asset outcome(s)"
      )
    }

    return ProfilerReport.Vision(
      status: failureCount == 0 && validation.exactOutcomeParity ? "ok" : "partial",
      requestedSampleCount: sampleCount,
      processedSampleCount: pipelineReport.processedSampleCount,
      failureCount: failureCount,
      totalLabelCount: pipelineReport.totalLabelCount,
      concurrency: concurrency,
      elapsedMilliseconds: pipelineReport.elapsedMilliseconds,
      assetsPerSecond: pipelineReport.assetsPerSecond,
      details: detailComponents.isEmpty ? nil : detailComponents.joined(separator: " | "),
      baseline: baselineReport,
      pipeline: pipelineReport,
      validation: validation,
      pipelineMaximumInFlight: pipelineMaximumInFlight,
      pipelineRanFirst: firstMeasuredPipelineFirst,
      measurementOrder: measurementOrder,
      availableAssetCount: assetIdentifiers.count,
      requestedUniqueAssetCount: windowPlan.requestedUniqueAssetCount,
      profiledUniqueAssetCount: windowPlan.profiledUniqueAssetCount,
      comparisonWindowCount: comparisonWindowCount,
      unavailableAssetCount: unavailableAssetCount
    )
  }

  static func assetWindowPlan(
    availableAssetCount: Int,
    requestedAssetsPerComparison: Int,
    comparisonCount: Int
  ) -> AssetWindowPlan {
    precondition(availableAssetCount >= 0)
    precondition(requestedAssetsPerComparison > 0)
    precondition(comparisonCount > 0)

    let (requestedUniqueAssetCount, overflowed) =
      requestedAssetsPerComparison.multipliedReportingOverflow(by: comparisonCount)
    let requestedUniqueCount = overflowed ? Int.max : requestedUniqueAssetCount
    let assetsPerComparison = min(
      requestedAssetsPerComparison,
      availableAssetCount / comparisonCount
    )
    return AssetWindowPlan(
      requestedAssetsPerComparison: requestedAssetsPerComparison,
      assetsPerComparison: assetsPerComparison,
      comparisonCount: comparisonCount,
      availableAssetCount: availableAssetCount,
      requestedUniqueAssetCount: requestedUniqueCount,
      profiledUniqueAssetCount: assetsPerComparison * comparisonCount
    )
  }

  static func measurementOrder(
    iterations: Int,
    warmupIterations: Int,
    startingWithPipeline: Bool
  ) -> [String] {
    precondition(iterations > 0)
    precondition(warmupIterations >= 0)
    return (0..<iterations).map { runIndex in
      pipelineRunsFirst(
        at: warmupIterations + runIndex,
        startingWithPipeline: startingWithPipeline
      )
        ? "pipeline-then-baseline" : "baseline-then-pipeline"
    }
  }

  static func pipelineRunsFirst(at runIndex: Int, startingWithPipeline: Bool) -> Bool {
    precondition(runIndex >= 0)
    return runIndex.isMultiple(of: 2) ? startingWithPipeline : !startingWithPipeline
  }

  private func measurePair(
    assets: [PHAsset],
    options: PhotoAssetClassificationOptions,
    concurrency: Int,
    maximumInFlight: Int,
    pipelineFirst: Bool
  ) async -> MeasurementPair {
    if pipelineFirst {
      let pipeline = await measurePipeline(
        assets: assets,
        options: options,
        concurrency: concurrency,
        maximumInFlight: maximumInFlight
      )
      let baseline = await measureBaseline(
        assets: assets,
        options: options,
        concurrency: concurrency
      )
      return MeasurementPair(baseline: baseline, pipeline: pipeline)
    }

    let baseline = await measureBaseline(
      assets: assets,
      options: options,
      concurrency: concurrency
    )
    let pipeline = await measurePipeline(
      assets: assets,
      options: options,
      concurrency: concurrency,
      maximumInFlight: maximumInFlight
    )
    return MeasurementPair(baseline: baseline, pipeline: pipeline)
  }

  private func measureBaseline(
    assets: [PHAsset],
    options: PhotoAssetClassificationOptions,
    concurrency: Int
  ) async -> Measurement {
    let classifier = PhotoAssetClassifier()
    let accumulator = VisionProfileOutcomeAccumulator(count: assets.count)
    let queue = OperationQueue()
    queue.name = "com.jonluca.palate.photos-profiler.vision-baseline"
    queue.qualityOfService = .userInitiated
    queue.maxConcurrentOperationCount = concurrency

    let start = DispatchTime.now().uptimeNanoseconds
    for (index, asset) in assets.enumerated() {
      queue.addOperation {
        let result = autoreleasepool {
          classifier.classify(asset: asset, options: options)
        }
        let outcome: PhotoAssetClassificationOutcome
        switch result {
        case .success(let classification):
          outcome = .success(classification)
        case .failure(let error):
          outcome = .failure(assetId: asset.localIdentifier, message: error.localizedDescription)
        }
        accumulator.record(outcome, at: index)
      }
    }
    await withCheckedContinuation { continuation in
      queue.addBarrierBlock {
        continuation.resume()
      }
    }
    let outcomes = accumulator.snapshot()
    let elapsedMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    return Measurement(outcomes: outcomes, elapsedMilliseconds: elapsedMilliseconds)
  }

  private func measurePipeline(
    assets: [PHAsset],
    options: PhotoAssetClassificationOptions,
    concurrency: Int,
    maximumInFlight: Int
  ) async -> Measurement {
    let pipeline = PhotoAssetClassificationPipeline(
      maximumInFlight: maximumInFlight,
      visionConcurrency: concurrency
    )
    let start = DispatchTime.now().uptimeNanoseconds
    let outcomes = await withCheckedContinuation { continuation in
      pipeline.classify(assets: assets, options: options) { outcomes in
        continuation.resume(returning: outcomes)
      }
    }
    let elapsedMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    return Measurement(outcomes: outcomes, elapsedMilliseconds: elapsedMilliseconds)
  }

}
