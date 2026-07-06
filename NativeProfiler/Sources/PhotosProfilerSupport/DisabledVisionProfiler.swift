import Foundation

public struct DisabledVisionProfiler: VisionProfiling {
  public init() {}

  public func profile(
    assetIdentifiers: [String],
    sampleCount: Int,
    concurrency: Int
  ) async throws -> ProfilerReport.Vision {
    ProfilerReport.Vision(
      status: sampleCount == 0 ? "disabled" : "providerNotInstalled",
      requestedSampleCount: sampleCount,
      processedSampleCount: 0,
      failureCount: 0,
      totalLabelCount: 0,
      concurrency: concurrency,
      elapsedMilliseconds: nil,
      assetsPerSecond: nil,
      details: sampleCount == 0
        ? "Pass --vision-sample to exercise an injected VisionProfiling implementation"
        : "The extension seam is active, but this build does not install a VisionProfiling implementation"
    )
  }
}
