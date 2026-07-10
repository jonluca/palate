import Foundation

public protocol VisionProfiling: Sendable {
  func profile(
    assetIdentifiers: [String],
    sampleCount: Int,
    concurrency: Int,
    pipelineMaximumInFlight: Int,
    pipelineFirst: Bool,
    iterations: Int,
    warmupIterations: Int
  ) async throws -> ProfilerReport.Vision
}
