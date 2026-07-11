import Foundation

enum InitialImagePreheatPlannerBenchmark {
  struct Configuration: Encodable {
    let assetCount: Int
    let windowSize: Int
    let windowStep: Int
    let windowCount: Int
    let pixelWidth: Int
    let pixelHeight: Int
    let samples: Int
    let warmupSamples: Int
  }

  struct TimingSummary: Encodable {
    let samplesMilliseconds: [Double]
    let minimumMilliseconds: Double
    let medianMilliseconds: Double
    let p95Milliseconds: Double
    let maximumMilliseconds: Double
  }

  struct StrategyReport: Encodable {
    let timing: TimingSummary
    let startsPerSample: Int
    let stopsPerSample: Int
    let retainedPerSample: Int
  }

  struct Report: Encodable {
    let schemaVersion: Int
    let benchmark: String
    let generatedAt: String
    let configuration: Configuration
    let usesSyntheticIdentifiers: Bool
    let accessesPhotoLibrary: Bool
    let independentFullWindowStarts: StrategyReport
    let overlappingPreheat: StrategyReport
    let startOperationReductionRatio: Double
    let notes: [String]
  }

  struct ArmResult {
    let elapsedMilliseconds: Double
    let starts: Int
    let stops: Int
    let retained: Int
  }

  enum Strategy {
    case independentFullWindowStarts
    case overlappingPreheat
  }

  enum BenchmarkError: Error, LocalizedError {
    case invalidArgument(String)
    case invariantFailure(String)

    var errorDescription: String? {
      switch self {
      case .invalidArgument(let message), .invariantFailure(let message):
        return message
      }
    }
  }

  static let defaultConfiguration = Configuration(
    assetCount: 4_096,
    windowSize: 48,
    windowStep: 12,
    windowCount: 128,
    pixelWidth: 384,
    pixelHeight: 480,
    samples: 15,
    warmupSamples: 3
  )

  static let maximumAssetCount = 1_000_000
  static let maximumWindowEntries = 5_000_000
  static let maximumTimedPlannerItemsPerArm = 50_000_000

  static func run() throws {
    guard let configuration = try parseConfiguration(CommandLine.arguments.dropFirst()) else {
      print(usage)
      return
    }
    try validate(configuration)

    let target = try PhotoAssetThumbnailTarget(
      pixelWidth: configuration.pixelWidth,
      pixelHeight: configuration.pixelHeight
    )
    let keys = try (0..<configuration.assetCount).map { index in
      try PhotoAssetThumbnailRequestKey(
        assetIdentifier: "synthetic-asset-\(index)",
        target: target,
        contentMode: .aspectFill
      )
    }
    let windows = (0..<configuration.windowCount).map { windowIndex in
      let start = windowIndex * configuration.windowStep
      return Array(keys[start..<(start + configuration.windowSize)])
    }
    let pixelsPerKey = UInt64(target.pixelWidth) * UInt64(target.pixelHeight)
    let maximumPixelCount = pixelsPerKey * UInt64(configuration.windowSize)
    let budget = PhotoAssetThumbnailPreheatBudget(
      maximumPixelCount: maximumPixelCount,
      maximumEstimatedByteCount:
        maximumPixelCount * PhotoAssetThumbnailPreheatBudget.estimatedBytesPerPixel
    )
    try validatePlannerModel(windows: windows, budget: budget)

    var fullMeasurements: [Double] = []
    var preheatMeasurements: [Double] = []
    var fullReference: ArmResult?
    var preheatReference: ArmResult?
    let totalSamples = configuration.warmupSamples + configuration.samples
    for sampleIndex in 0..<totalSamples {
      let full: ArmResult
      let preheat: ArmResult
      if sampleIndex.isMultiple(of: 2) {
        full = measure(.independentFullWindowStarts, windows: windows, budget: budget)
        preheat = measure(.overlappingPreheat, windows: windows, budget: budget)
      } else {
        preheat = measure(.overlappingPreheat, windows: windows, budget: budget)
        full = measure(.independentFullWindowStarts, windows: windows, budget: budget)
      }
      try validate(
        full: full,
        preheat: preheat,
        configuration: configuration
      )

      guard sampleIndex >= configuration.warmupSamples else {
        continue
      }
      fullMeasurements.append(full.elapsedMilliseconds)
      preheatMeasurements.append(preheat.elapsedMilliseconds)
      fullReference = full
      preheatReference = preheat
    }

    guard let fullReference, let preheatReference else {
      throw BenchmarkError.invariantFailure("No measured benchmark samples were produced.")
    }
    let report = Report(
      schemaVersion: 1,
      benchmark: "initial-image-thumbnail-preheat-planner",
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      configuration: configuration,
      usesSyntheticIdentifiers: true,
      accessesPhotoLibrary: false,
      independentFullWindowStarts: StrategyReport(
        timing: summarize(fullMeasurements),
        startsPerSample: fullReference.starts,
        stopsPerSample: fullReference.stops,
        retainedPerSample: fullReference.retained
      ),
      overlappingPreheat: StrategyReport(
        timing: summarize(preheatMeasurements),
        startsPerSample: preheatReference.starts,
        stopsPerSample: preheatReference.stops,
        retainedPerSample: preheatReference.retained
      ),
      startOperationReductionRatio: Double(fullReference.starts) / Double(preheatReference.starts),
      notes: [
        "This synthetic benchmark measures pure native planner CPU time and derived cache deltas; it does not call PhotoKit or measure image decoding.",
        "The independent-full-window arm models issuing every requested start with fresh planner state; it does not model a stop-all call, so its zero stops are not comparable to the preheated arm's per-key stops.",
        "The preheated arm retains overlap and emits ordered per-key start and stop deltas.",
        "Arms are counterbalanced, inputs are identical, and correctness invariants are checked before results are emitted.",
      ]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(report)
    guard let json = String(data: data, encoding: .utf8) else {
      throw BenchmarkError.invariantFailure("Failed to encode the benchmark report as UTF-8.")
    }
    print(json)
  }

  static var usage: String {
    """
    Usage: benchmark-initial-image-preheat-planner.sh [options]

      --asset-count=N    Synthetic identifiers (default: \(defaultConfiguration.assetCount))
      --window-size=N    Keys per preheat window (default: \(defaultConfiguration.windowSize))
      --window-step=N    New keys per shifted window (default: \(defaultConfiguration.windowStep))
      --window-count=N   Window transitions per sample (default: \(defaultConfiguration.windowCount))
      --pixel-width=N    Target pixel width (default: \(defaultConfiguration.pixelWidth))
      --pixel-height=N   Target pixel height (default: \(defaultConfiguration.pixelHeight))
      --samples=N        Measured counterbalanced pairs (default: \(defaultConfiguration.samples))
      --warmup=N         Warmup pairs (default: \(defaultConfiguration.warmupSamples))
      --help, -h         Show this help
    """
  }

  private static func parseConfiguration<S: Sequence>(_ arguments: S) throws -> Configuration?
  where S.Element == String {
    var values: [String: Int] = [:]
    for argument in arguments {
      if argument == "--help" || argument == "-h" {
        return nil
      }
      if argument == "--" {
        continue
      }
      let pieces = argument.split(separator: "=", maxSplits: 1).map(String.init)
      guard pieces.count == 2, pieces[0].hasPrefix("--"), let value = Int(pieces[1]) else {
        throw BenchmarkError.invalidArgument("Unknown or invalid argument: \(argument)")
      }
      let name = String(pieces[0].dropFirst(2))
      guard
        [
          "asset-count", "window-size", "window-step", "window-count", "pixel-width",
          "pixel-height", "samples", "warmup",
        ].contains(name)
      else {
        throw BenchmarkError.invalidArgument("Unknown option: --\(name)")
      }
      values[name] = value
    }

    return Configuration(
      assetCount: values["asset-count"] ?? defaultConfiguration.assetCount,
      windowSize: values["window-size"] ?? defaultConfiguration.windowSize,
      windowStep: values["window-step"] ?? defaultConfiguration.windowStep,
      windowCount: values["window-count"] ?? defaultConfiguration.windowCount,
      pixelWidth: values["pixel-width"] ?? defaultConfiguration.pixelWidth,
      pixelHeight: values["pixel-height"] ?? defaultConfiguration.pixelHeight,
      samples: values["samples"] ?? defaultConfiguration.samples,
      warmupSamples: values["warmup"] ?? defaultConfiguration.warmupSamples
    )
  }

  private static func validate(_ configuration: Configuration) throws {
    guard configuration.assetCount > 0,
      configuration.windowSize > 0,
      configuration.windowStep > 0,
      configuration.windowStep <= configuration.windowSize,
      configuration.windowCount > 1,
      configuration.pixelWidth > 0,
      configuration.pixelHeight > 0,
      configuration.samples > 0,
      configuration.warmupSamples >= 0
    else {
      throw BenchmarkError.invalidArgument(
        "Counts and dimensions must be positive, warmup must be non-negative, and window step must not exceed window size."
      )
    }
    let (totalSamples, sampleOverflow) = configuration.samples.addingReportingOverflow(
      configuration.warmupSamples
    )
    guard !sampleOverflow else {
      throw BenchmarkError.invalidArgument("Samples plus warmup overflowed the bounded work model.")
    }
    guard configuration.assetCount <= maximumAssetCount else {
      throw BenchmarkError.invalidArgument(
        "Asset count exceeds the bounded maximum of \(maximumAssetCount)."
      )
    }
    let (windowEntries, windowEntriesOverflow) = configuration.windowCount
      .multipliedReportingOverflow(by: configuration.windowSize)
    guard !windowEntriesOverflow, windowEntries <= maximumWindowEntries else {
      throw BenchmarkError.invalidArgument(
        "Window count times window size exceeds the bounded maximum of \(maximumWindowEntries)."
      )
    }
    let (timedPlannerItems, timedItemsOverflow) = windowEntries.multipliedReportingOverflow(
      by: totalSamples
    )
    guard !timedItemsOverflow, timedPlannerItems <= maximumTimedPlannerItemsPerArm else {
      throw BenchmarkError.invalidArgument(
        "Synthetic planner work per arm exceeds the bounded maximum of \(maximumTimedPlannerItemsPerArm) items."
      )
    }
    let (shiftedCount, shiftOverflow) = (configuration.windowCount - 1)
      .multipliedReportingOverflow(by: configuration.windowStep)
    let (requiredAssetCount, assetOverflow) = configuration.windowSize.addingReportingOverflow(
      shiftedCount
    )
    guard !shiftOverflow, !assetOverflow, requiredAssetCount <= configuration.assetCount else {
      throw BenchmarkError.invalidArgument(
        "Asset count must cover every non-wrapping shifted window (required: \(assetOverflow ? Int.max : requiredAssetCount))."
      )
    }
  }

  private static func measure(
    _ strategy: Strategy,
    windows: [[PhotoAssetThumbnailRequestKey]],
    budget: PhotoAssetThumbnailPreheatBudget
  ) -> ArmResult {
    let start = DispatchTime.now().uptimeNanoseconds
    var starts = 0
    var stops = 0
    var retained = 0

    switch strategy {
    case .independentFullWindowStarts:
      for window in windows {
        var planner = PhotoAssetThumbnailPreheatPlanner()
        let delta = planner.transition(to: window, budget: budget, generation: 0)
        starts += delta.starts.count
        stops += delta.stops.count
        retained += delta.retained.count
      }
    case .overlappingPreheat:
      var planner = PhotoAssetThumbnailPreheatPlanner()
      for window in windows {
        let delta = planner.transition(to: window, budget: budget, generation: 0)
        starts += delta.starts.count
        stops += delta.stops.count
        retained += delta.retained.count
      }
    }

    let end = DispatchTime.now().uptimeNanoseconds
    return ArmResult(
      elapsedMilliseconds: Double(end - start) / 1_000_000,
      starts: starts,
      stops: stops,
      retained: retained
    )
  }

  private static func validatePlannerModel(
    windows: [[PhotoAssetThumbnailRequestKey]],
    budget: PhotoAssetThumbnailPreheatBudget
  ) throws {
    var preheatPlanner = PhotoAssetThumbnailPreheatPlanner()
    var previousWindow: [PhotoAssetThumbnailRequestKey]?

    for window in windows {
      var restartPlanner = PhotoAssetThumbnailPreheatPlanner()
      let restart = restartPlanner.transition(to: window, budget: budget, generation: 0)
      guard restart.starts == window,
        restart.stops.isEmpty,
        restart.retained.isEmpty,
        restart.activeKeys == window
      else {
        throw BenchmarkError.invariantFailure(
          "Full-window planner identities did not match the requested synthetic window."
        )
      }

      let preheat = preheatPlanner.transition(to: window, budget: budget, generation: 0)
      let previousKeySet = Set(previousWindow ?? [])
      let currentKeySet = Set(window)
      let expectedStarts = window.filter { !previousKeySet.contains($0) }
      let expectedStops = (previousWindow ?? []).filter { !currentKeySet.contains($0) }
      let expectedRetained = window.filter { previousKeySet.contains($0) }
      guard preheat.starts == expectedStarts,
        preheat.stops == expectedStops,
        preheat.retained == expectedRetained,
        preheat.activeKeys == window
      else {
        throw BenchmarkError.invariantFailure(
          "Preheated planner identities did not match the exact synthetic overlap delta."
        )
      }
      previousWindow = window
    }
  }

  private static func validate(
    full: ArmResult,
    preheat: ArmResult,
    configuration: Configuration
  ) throws {
    let expectedFullStarts = configuration.windowCount * configuration.windowSize
    let expectedShiftedKeys = (configuration.windowCount - 1) * configuration.windowStep
    let expectedPreheatStarts = configuration.windowSize + expectedShiftedKeys
    let expectedRetained =
      (configuration.windowCount - 1)
      * (configuration.windowSize - configuration.windowStep)
    guard full.starts == expectedFullStarts,
      full.stops == 0,
      full.retained == 0,
      preheat.starts == expectedPreheatStarts,
      preheat.stops == expectedShiftedKeys,
      preheat.retained == expectedRetained
    else {
      throw BenchmarkError.invariantFailure(
        "Planner operation counts did not match the synthetic model."
      )
    }
  }

  private static func summarize(_ values: [Double]) -> TimingSummary {
    let sorted = values.sorted()
    return TimingSummary(
      samplesMilliseconds: values,
      minimumMilliseconds: sorted[0],
      medianMilliseconds: percentile(sorted, fraction: 0.5),
      p95Milliseconds: percentile(sorted, fraction: 0.95),
      maximumMilliseconds: sorted[sorted.count - 1]
    )
  }

  private static func percentile(_ sortedValues: [Double], fraction: Double) -> Double {
    let rank = Int((Double(sortedValues.count - 1) * fraction).rounded(.up))
    return sortedValues[rank]
  }
}

do {
  try InitialImagePreheatPlannerBenchmark.run()
} catch {
  FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
  exit(1)
}
