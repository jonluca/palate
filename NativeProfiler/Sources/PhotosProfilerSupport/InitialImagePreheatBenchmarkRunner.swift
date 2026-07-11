import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct InitialImagePreheatBenchmarkRunner: Sendable {
  public init() {}

  public func run(arguments: ProfilerArguments) async throws -> InitialImagePreheatBenchmarkReport {
    let requiredIdentifierCount = try InitialImagePreheatSamplePlan.requiredIdentifierCount(
      imageCounts: arguments.initialImageCounts,
      iterations: arguments.initialImageIterations
    )
    let assetSample = Self.recentImageIdentifiers(limit: requiredIdentifierCount)
    let plan = try InitialImagePreheatSamplePlan(
      identifiers: assetSample.identifiers,
      imageCounts: arguments.initialImageCounts,
      iterations: arguments.initialImageIterations
    )
    let target = try PhotoAssetThumbnailTarget(
      pixelWidth: arguments.initialImagePixelWidth,
      pixelHeight: arguments.initialImagePixelHeight
    )

    var measurements: [InitialImagePreheatBenchmarkReport.Measurement] = []
    for pair in plan.pairs {
      if pair.executeCandidateFirst {
        measurements.append(
          try await measure(
            arm: .windowedPreheat,
            assignment: pair.candidate,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            executedFirst: true,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
        measurements.append(
          try await measure(
            arm: .control,
            assignment: pair.control,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            executedFirst: false,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
      } else {
        measurements.append(
          try await measure(
            arm: .control,
            assignment: pair.control,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            executedFirst: true,
            target: target,
            timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds
          )
        )
        measurements.append(
          try await measure(
            arm: .windowedPreheat,
            assignment: pair.candidate,
            imageCount: pair.imageCount,
            iteration: pair.iteration,
            executedFirst: false,
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
      return left.arm == .control && right.arm == .windowedPreheat
    }
    let budget = PhotoAssetThumbnailPreheatBudget.windowedV1
    return InitialImagePreheatBenchmarkReport(
      schemaVersion: 2,
      configuration: InitialImagePreheatBenchmarkReport.Configuration(
        imageCounts: arguments.initialImageCounts,
        pixelWidth: target.pixelWidth,
        pixelHeight: target.pixelHeight,
        iterations: arguments.initialImageIterations,
        timeoutMilliseconds: arguments.initialImageTimeoutMilliseconds,
        networkAccessAllowed: true,
        leadWindowMatchesTargetCount: true,
        preheatEstimatedBytesPerPixel: PhotoAssetThumbnailPreheatBudget.estimatedBytesPerPixel,
        preheatMaximumPixelCount: budget.maximumPixelCount,
        preheatMaximumEstimatedByteCount: budget.maximumEstimatedByteCount,
        preheatMaximumKeyCount: budget.maximumKeyCount
      ),
      availableRecentImageCount: assetSample.availableCount,
      sampledIdentifierCount: plan.sampledIdentifierCount,
      sampledIdentifierDigest: plan.sampledIdentifierDigest,
      disjointLeadAndTargetWindows: true,
      measurements: sortedMeasurements,
      comparisons: arguments.initialImageCounts.map { imageCount in
        InitialImagePreheatBenchmarkReport.comparison(
          imageCount: imageCount,
          measurements: sortedMeasurements
        )
      }
    )
  }

  private func measure(
    arm: InitialImagePreheatBenchmarkReport.Arm,
    assignment: InitialImagePreheatSamplePlan.Assignment,
    imageCount: Int,
    iteration: Int,
    executedFirst: Bool,
    target: PhotoAssetThumbnailTarget,
    timeoutMilliseconds: Int
  ) async throws -> InitialImagePreheatBenchmarkReport.Measurement {
    let callbackQueue = DispatchQueue(
      label:
        "com.jonluca.palate.photos-profiler.initial-image-preheat.\(arm.rawValue).\(iteration)",
      qos: .userInitiated
    )
    let loader = InitialImageCandidateLoader(callbackQueue: callbackQueue)
    let leadKeys = try Self.keys(identifiers: assignment.leadIdentifiers, target: target)
    let targetKeys = try Self.keys(identifiers: assignment.targetIdentifiers, target: target)
    let measurementStartedAt = DispatchTime.now().uptimeNanoseconds
    var preheatSubmittedMilliseconds: Double?

    if arm == .windowedPreheat {
      loader.preheat(keys: targetKeys)
      preheatSubmittedMilliseconds = Self.elapsedMilliseconds(since: measurementStartedAt)
    }

    let leadRequestStartedMilliseconds = Self.elapsedMilliseconds(since: measurementStartedAt)
    let timedLead = await Self.measureWindow(
      loader: loader,
      callbackQueue: callbackQueue,
      keys: leadKeys,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: assignment.position,
      timeoutMilliseconds: timeoutMilliseconds
    )
    let lead = timedLead.measurement
    let leadTerminalMilliseconds = Self.elapsedMilliseconds(
      since: measurementStartedAt,
      through: timedLead.terminalUptimeNanoseconds
    )
    do {
      try Self.validate(lead, arm: arm, phase: "lead")
    } catch {
      await loader.clear()
      throw error
    }
    let leadValidationCompletedMilliseconds = Self.elapsedMilliseconds(
      since: measurementStartedAt
    )
    let metricsAfterLead = await loader.readMetrics()
    let metricsAfterLeadCapturedMilliseconds = Self.elapsedMilliseconds(since: measurementStartedAt)
    do {
      try Self.validate(
        metricsAfterLead,
        arm: arm,
        phase: "lead",
        iteration: iteration
      )
    } catch {
      await loader.clear()
      throw error
    }

    let targetRequestStartedMilliseconds = Self.elapsedMilliseconds(since: measurementStartedAt)
    let timedTarget = await Self.measureWindow(
      loader: loader,
      callbackQueue: callbackQueue,
      keys: targetKeys,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: assignment.position,
      timeoutMilliseconds: timeoutMilliseconds
    )
    let targetMeasurement = timedTarget.measurement
    let targetTerminalMilliseconds = Self.elapsedMilliseconds(
      since: measurementStartedAt,
      through: timedTarget.terminalUptimeNanoseconds
    )
    do {
      try Self.validate(targetMeasurement, arm: arm, phase: "target")
    } catch {
      await loader.clear()
      throw error
    }
    let targetValidationCompletedMilliseconds = Self.elapsedMilliseconds(
      since: measurementStartedAt
    )
    let metricsAfterTarget = await loader.readMetrics()
    let metricsAfterTargetCapturedMilliseconds = Self.elapsedMilliseconds(
      since: measurementStartedAt
    )
    do {
      try Self.validate(
        metricsAfterTarget,
        arm: arm,
        phase: "target",
        iteration: iteration
      )
    } catch {
      await loader.clear()
      throw error
    }

    let measurement = InitialImagePreheatBenchmarkReport.Measurement(
      arm: arm,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: assignment.position,
      executedFirst: executedFirst,
      lead: InitialImagePreheatBenchmarkReport.LeadMeasurement(
        requestedIdentifierDigest: lead.requestedIdentifierDigest,
        finalIdentifierDigest: lead.finalIdentifierDigest,
        requestedCount: lead.requestedCount,
        finalCount: lead.finalCount,
        failureCount: lead.failureCount,
        timedOutCount: lead.timedOutCount,
        elapsedMilliseconds: lead.allTerminalMilliseconds
      ),
      target: targetMeasurement,
      continuousTiming: InitialImagePreheatBenchmarkReport.ContinuousTiming(
        elapsedThroughTargetTerminalMilliseconds: targetTerminalMilliseconds,
        phaseMarkers: InitialImagePreheatBenchmarkReport.PhaseMarkers(
          preheatSubmittedMilliseconds: preheatSubmittedMilliseconds,
          leadRequestStartedMilliseconds: leadRequestStartedMilliseconds,
          leadTerminalMilliseconds: leadTerminalMilliseconds,
          leadValidationCompletedMilliseconds: leadValidationCompletedMilliseconds,
          metricsAfterLeadCapturedMilliseconds: metricsAfterLeadCapturedMilliseconds,
          targetRequestStartedMilliseconds: targetRequestStartedMilliseconds,
          targetTerminalMilliseconds: targetTerminalMilliseconds,
          targetValidationCompletedMilliseconds: targetValidationCompletedMilliseconds,
          metricsAfterTargetCapturedMilliseconds: metricsAfterTargetCapturedMilliseconds
        )
      ),
      metricsAfterLead: InitialImagePreheatBenchmarkReport.StoreMetrics(metricsAfterLead),
      metricsAfterTarget: InitialImagePreheatBenchmarkReport.StoreMetrics(metricsAfterTarget)
    )
    await loader.clear()
    return measurement
  }

  private static func measureWindow(
    loader: InitialImageCandidateLoader,
    callbackQueue: DispatchQueue,
    keys: [PhotoAssetThumbnailRequestKey],
    imageCount: Int,
    iteration: Int,
    samplePosition: InitialImageSamplePosition,
    timeoutMilliseconds: Int
  ) async -> InitialImageMeasurementSession.TimedMeasurement {
    let session = InitialImageMeasurementSession(
      callbackQueue: callbackQueue,
      strategy: .batchedThumbnailStore,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: samplePosition,
      timeoutMilliseconds: timeoutMilliseconds,
      requestedIdentifiers: keys.map(\.assetIdentifier),
      displayDegradedImages: true
    )
    return await session.runWithTerminalTimestamp { receive in
      loader.request(keys: keys, receive: receive)
    }
  }

  private static func keys(
    identifiers: [String],
    target: PhotoAssetThumbnailTarget
  ) throws -> [PhotoAssetThumbnailRequestKey] {
    try identifiers.map { identifier in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: identifier,
        target: target,
        contentMode: .aspectFill
      )
    }
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

  static func validate(
    _ measurement: InitialImageBenchmarkReport.Measurement,
    arm: InitialImagePreheatBenchmarkReport.Arm,
    phase: String
  ) throws {
    let reason: String?
    if measurement.requestedCount != measurement.imageCount {
      reason =
        "\(phase) requested count \(measurement.requestedCount) did not match image count \(measurement.imageCount)"
    } else if measurement.timedOutCount != 0 {
      reason = "\(phase) timed out for \(measurement.timedOutCount) request(s)"
    } else if measurement.failureCount != 0 {
      reason = "\(phase) failed \(measurement.failureCount) request(s)"
    } else if measurement.finalCount + measurement.failureCount != measurement.requestedCount {
      reason = "\(phase) terminal result count did not match the requested count"
    } else if measurement.finalCount != measurement.requestedCount {
      reason = "\(phase) final image count did not match the requested count"
    } else if measurement.finalIdentifierDigest != measurement.requestedIdentifierDigest {
      reason = "\(phase) final identifier digest did not match the requested identifier digest"
    } else if measurement.unexpectedEventCount != 0 {
      reason =
        "\(phase) received \(measurement.unexpectedEventCount) event(s) for unrequested identifiers"
    } else if measurement.duplicateTerminalEventCount != 0 {
      reason =
        "\(phase) received \(measurement.duplicateTerminalEventCount) duplicate terminal event(s)"
    } else if measurement.invalidDimensionCount != 0 {
      reason =
        "\(phase) received \(measurement.invalidDimensionCount) image(s) with invalid dimensions"
    } else {
      reason = nil
    }

    if let reason {
      throw InitialImageBenchmarkError.invalidMeasurement(
        strategy: measurement.strategy,
        iteration: measurement.iteration,
        reason: "\(arm.rawValue): \(reason)"
      )
    }
  }

  static func validate(
    _ metrics: PhotoAssetThumbnailStoreMetrics,
    arm: InitialImagePreheatBenchmarkReport.Arm,
    phase: String,
    iteration: Int
  ) throws {
    let scheduler = metrics.assetFetchScheduler
    let scheduledBatchCount = scheduler.preheatBatchCount + scheduler.visibleBatchCount
    let scheduledIdentifierCount =
      scheduler.preheatBatchIdentifierCount + scheduler.visibleBatchIdentifierCount
    let reason: String?
    if metrics.assetFetchBatchCount != scheduledBatchCount {
      reason =
        "\(phase) aggregate asset-fetch batch count \(metrics.assetFetchBatchCount) did not match scheduler count \(scheduledBatchCount)"
    } else if metrics.assetFetchIdentifierCount != scheduledIdentifierCount {
      reason =
        "\(phase) aggregate asset-fetch identifier count \(metrics.assetFetchIdentifierCount) did not match scheduler count \(scheduledIdentifierCount)"
    } else if !scheduler.isQuiescent {
      reason =
        "\(phase) asset-fetch scheduler was not quiescent (active=\(scheduler.activeBatchPriority?.rawValue ?? "none"), queuedVisible=\(scheduler.queuedVisibleIdentifierCount), queuedPreheat=\(scheduler.queuedPreheatIdentifierCount))"
    } else {
      reason = nil
    }

    if let reason {
      throw InitialImageBenchmarkError.invalidMeasurement(
        strategy: .batchedThumbnailStore,
        iteration: iteration,
        reason: "\(arm.rawValue): \(reason)"
      )
    }
  }

  private static func elapsedMilliseconds(since start: UInt64) -> Double {
    elapsedMilliseconds(since: start, through: DispatchTime.now().uptimeNanoseconds)
  }

  private static func elapsedMilliseconds(since start: UInt64, through end: UInt64) -> Double {
    Double(end - start) / 1_000_000
  }
}
