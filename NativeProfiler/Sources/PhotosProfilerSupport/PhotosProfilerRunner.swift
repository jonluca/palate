import Foundation

public struct PhotosProfilerRunner: Sendable {
  private let visionProfiler: any VisionProfiling

  public init(visionProfiler: any VisionProfiling = PhotoLibraryVisionProfiler()) {
    self.visionProfiler = visionProfiler
  }

  public func run(arguments: ProfilerArguments, bundleIdentifier: String) async throws
    -> ProfilerReport
  {
    let authorizationStatus = await PhotoLibraryAuthorization.requestIfNeeded()
    let authorizationName = PhotoLibraryAuthorization.name(for: authorizationStatus)
    guard PhotoLibraryAuthorization.permitsReading(authorizationStatus) else {
      throw PhotosProfilerError.photoLibraryAccessUnavailable(status: authorizationName)
    }

    let metadata: MetadataBenchmarkReport?
    let vision: ProfilerReport.Vision?
    let initialImages: InitialImageBenchmarkReport?
    switch arguments.mode {
    case .photos:
      let metadataRunner = try MetadataBenchmarkRunner()
      let metadataResult = try metadataRunner.run(arguments: arguments)
      metadata = metadataResult.report
      vision = try await visionProfiler.profile(
        assetIdentifiers: metadataResult.assetIdentifiers,
        sampleCount: arguments.visionSampleCount,
        concurrency: arguments.visionConcurrency
      )
      initialImages = nil
    case .initialImages:
      metadata = nil
      vision = nil
      initialImages = try await InitialImageBenchmarkRunner().run(arguments: arguments)
    }

    return ProfilerReport(
      schemaVersion: 1,
      status: "ok",
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      authorizationStatus: authorizationName,
      environment: ProfilerReport.Environment(
        bundleIdentifier: bundleIdentifier,
        operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
        architecture: Self.architecture,
        activeProcessorCount: ProcessInfo.processInfo.activeProcessorCount,
        physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory
      ),
      configuration: ProfilerReport.Configuration(
        mode: arguments.mode,
        batchSizes: arguments.batchSizes,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations,
        maximumAssetCount: arguments.maximumAssetCount,
        visionSampleCount: arguments.visionSampleCount,
        visionConcurrency: arguments.visionConcurrency
      ),
      metadata: metadata,
      vision: vision,
      initialImages: initialImages
    )
  }

  private static var architecture: String {
    #if arch(arm64)
      "arm64"
    #elseif arch(x86_64)
      "x86_64"
    #else
      "unknown"
    #endif
  }
}
