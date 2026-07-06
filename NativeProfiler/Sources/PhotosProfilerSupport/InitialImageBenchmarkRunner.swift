import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct InitialImageBenchmarkRunner: Sendable {
  public init() {}

  public func run(arguments: ProfilerArguments) async throws -> InitialImageBenchmarkReport {
    let requiredIdentifierCount = try InitialImageSamplePlan.requiredIdentifierCount(
      imageCounts: arguments.initialImageCounts,
      iterations: arguments.initialImageIterations
    )
    let assetSample = Self.recentImageIdentifiers(limit: requiredIdentifierCount)
    let plan = try InitialImageSamplePlan(
      identifiers: assetSample.identifiers,
      imageCounts: arguments.initialImageCounts,
      iterations: arguments.initialImageIterations
    )
    let target = try PhotoAssetThumbnailTarget(
      pixelWidth: arguments.initialImagePixelWidth,
      pixelHeight: arguments.initialImagePixelHeight
    )

    var measurements: [InitialImageBenchmarkReport.Measurement] = []
    measurements.reserveCapacity(plan.pairs.count * 2)
    for pair in plan.pairs {
      if pair.executeCandidateFirst {
        measurements.append(
          try await measureCandidate(
            assignment: pair.candidate,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
        measurements.append(
          try await measureBaseline(
            assignment: pair.baseline,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
      } else {
        measurements.append(
          try await measureBaseline(
            assignment: pair.baseline,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
        measurements.append(
          try await measureCandidate(
            assignment: pair.candidate,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
      }
    }

    let sortedMeasurements = measurements.sorted { left, right in
      if left.imageCount != right.imageCount {
        return left.imageCount < right.imageCount
      }
      if left.iteration != right.iteration {
        return left.iteration < right.iteration
      }
      return left.strategy == .currentPerItemRefetch && right.strategy == .batchedThumbnailStore
    }

    return InitialImageBenchmarkReport(
      configuration: InitialImageBenchmarkReport.Configuration(
        imageCounts: arguments.initialImageCounts,
        pixelWidth: target.pixelWidth,
        pixelHeight: target.pixelHeight,
        iterations: arguments.initialImageIterations,
        timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds,
        networkAccessAllowed: true,
        networkPolicy:
          "Both strategies allow PhotoKit network access because the production thumbnail store currently requires it."
      ),
      availableRecentImageCount: assetSample.availableCount,
      sampledIdentifierCount: plan.sampledIdentifierCount,
      sampledIdentifierDigest: plan.sampledIdentifierDigest,
      disjointSampleSets: true,
      measurements: sortedMeasurements,
      comparisons: arguments.initialImageCounts.map { imageCount in
        Self.comparison(imageCount: imageCount, measurements: sortedMeasurements)
      }
    )
  }

  private func measureBaseline(
    assignment: InitialImageSamplePlan.Assignment,
    imageCount: Int,
    iteration: Int,
    target: PhotoAssetThumbnailTarget,
    timeoutMilliseconds: Int
  ) async throws -> InitialImageBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label: "com.jonluca.palate.photos-profiler.initial-images.baseline-events",
      qos: .userInitiated
    )
    let loader = InitialImageBaselineLoader(callbackQueue: callbackQueue)
    let session = InitialImageMeasurementSession(
      callbackQueue: callbackQueue,
      strategy: .currentPerItemRefetch,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: assignment.position,
      timeoutMilliseconds: timeoutMilliseconds,
      requestedIdentifiers: assignment.identifiers,
      displayDegradedImages: false
    )
    let measurement = await session.run { receive in
      loader.request(identifiers: assignment.identifiers, target: target, receive: receive).map {
        token in
        { token.cancel() }
      }
    }
    try Self.validate(measurement)
    return measurement
  }

  private func measureCandidate(
    assignment: InitialImageSamplePlan.Assignment,
    imageCount: Int,
    iteration: Int,
    target: PhotoAssetThumbnailTarget,
    timeoutMilliseconds: Int
  ) async throws -> InitialImageBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label: "com.jonluca.palate.photos-profiler.initial-images.candidate-events",
      qos: .userInitiated
    )
    let loader = InitialImageCandidateLoader(callbackQueue: callbackQueue)
    let keys = try assignment.identifiers.map { identifier in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: identifier,
        target: target,
        contentMode: .aspectFill
      )
    }
    let session = InitialImageMeasurementSession(
      callbackQueue: callbackQueue,
      strategy: .batchedThumbnailStore,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: assignment.position,
      timeoutMilliseconds: timeoutMilliseconds,
      requestedIdentifiers: assignment.identifiers,
      displayDegradedImages: true
    )
    let measurement = await session.run { receive in
      loader.request(keys: keys, receive: receive)
    }
    try Self.validate(measurement)
    return measurement
  }

  private static func recentImageIdentifiers(limit: Int) -> (
    identifiers: [String], availableCount: Int
  ) {
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.includeAssetSourceTypes = .typeUserLibrary
    options.includeAllBurstAssets = false
    options.includeHiddenAssets = false
    let result = PHAsset.fetchAssets(with: .image, options: options)
    var identifiers: [String] = []
    identifiers.reserveCapacity(min(limit, result.count))
    for index in 0..<min(limit, result.count) {
      identifiers.append(result.object(at: index).localIdentifier)
    }
    return (identifiers, result.count)
  }

  private static func validate(_ measurement: InitialImageBenchmarkReport.Measurement) throws {
    let reason: String?
    if measurement.requestedCount != measurement.imageCount {
      reason =
        "requested count \(measurement.requestedCount) did not match image count \(measurement.imageCount)"
    } else if measurement.finalCount + measurement.failureCount != measurement.requestedCount {
      reason = "terminal result count did not match the requested count"
    } else if measurement.unexpectedEventCount != 0 {
      reason = "received \(measurement.unexpectedEventCount) event(s) for unrequested identifiers"
    } else if measurement.duplicateTerminalEventCount != 0 {
      reason = "received \(measurement.duplicateTerminalEventCount) duplicate terminal event(s)"
    } else if measurement.invalidDimensionCount != 0 {
      reason = "received \(measurement.invalidDimensionCount) image(s) with invalid dimensions"
    } else {
      reason = nil
    }

    if let reason {
      throw InitialImageBenchmarkError.invalidMeasurement(
        strategy: measurement.strategy,
        iteration: measurement.iteration,
        reason: reason
      )
    }
  }

  private static func comparison(
    imageCount: Int,
    measurements: [InitialImageBenchmarkReport.Measurement]
  ) -> InitialImageBenchmarkReport.CountComparison {
    let matching = measurements.filter { $0.imageCount == imageCount }
    let baseline = aggregate(matching.filter { $0.strategy == .currentPerItemRefetch })
    let candidate = aggregate(matching.filter { $0.strategy == .batchedThumbnailStore })
    return InitialImageBenchmarkReport.CountComparison(
      imageCount: imageCount,
      baseline: baseline,
      candidate: candidate,
      candidateSpeedup: InitialImageBenchmarkReport.CandidateSpeedup(
        firstRenderable: speedup(
          baseline.medianFirstRenderableMilliseconds,
          candidate.medianFirstRenderableMilliseconds
        ),
        firstFinal: speedup(
          baseline.medianFirstFinalMilliseconds, candidate.medianFirstFinalMilliseconds),
        allVisibleFinal: speedup(
          baseline.medianAllVisibleFinalMilliseconds,
          candidate.medianAllVisibleFinalMilliseconds
        ),
        finalP50: speedup(
          baseline.medianFinalP50Milliseconds, candidate.medianFinalP50Milliseconds),
        finalP95: speedup(baseline.medianFinalP95Milliseconds, candidate.medianFinalP95Milliseconds)
      )
    )
  }

  private static func aggregate(
    _ measurements: [InitialImageBenchmarkReport.Measurement]
  ) -> InitialImageBenchmarkReport.StrategyAggregate {
    InitialImageBenchmarkReport.StrategyAggregate(
      measurementCount: measurements.count,
      finalImageCount: measurements.reduce(0) { $0 + $1.finalCount },
      failureCount: measurements.reduce(0) { $0 + $1.failureCount },
      timedOutCount: measurements.reduce(0) { $0 + $1.timedOutCount },
      medianFirstRenderableMilliseconds: median(
        measurements.compactMap(\.firstRenderableMilliseconds)),
      medianFirstFinalMilliseconds: median(measurements.compactMap(\.firstFinalMilliseconds)),
      medianAllVisibleFinalMilliseconds: medianWhenComplete(
        measurements.map(\.allVisibleFinalMilliseconds),
        expectedCount: measurements.count
      ),
      medianFinalP50Milliseconds: median(
        measurements.compactMap { $0.finalLatency?.p50Milliseconds }),
      medianFinalP95Milliseconds: median(
        measurements.compactMap { $0.finalLatency?.p95Milliseconds }),
      medianFinalMaximumMilliseconds: median(
        measurements.compactMap { $0.finalLatency?.maximumMilliseconds })
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

  private static func speedup(_ baseline: Double?, _ candidate: Double?) -> Double? {
    guard let baseline, let candidate, candidate > 0 else {
      return nil
    }
    return baseline / candidate
  }
}
