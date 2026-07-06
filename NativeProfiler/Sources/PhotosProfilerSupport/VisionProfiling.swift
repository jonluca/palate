import Foundation

public protocol VisionProfiling: Sendable {
  func profile(
    assetIdentifiers: [String],
    sampleCount: Int,
    concurrency: Int
  ) async throws -> ProfilerReport.Vision
}
