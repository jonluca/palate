import Foundation

public struct ProfilerReport: Encodable, Sendable {
  public struct Environment: Encodable, Sendable {
    public let bundleIdentifier: String
    public let operatingSystem: String
    public let architecture: String
    public let activeProcessorCount: Int
    public let physicalMemoryBytes: UInt64
  }

  public struct Configuration: Encodable, Sendable {
    public let mode: ProfilerMode
    public let batchSizes: [Int]
    public let iterations: Int
    public let warmupIterations: Int
    public let maximumAssetCount: Int?
    public let visionSampleCount: Int
    public let visionConcurrency: Int
  }

  public struct Vision: Encodable, Sendable {
    public let status: String
    public let requestedSampleCount: Int
    public let processedSampleCount: Int
    public let failureCount: Int
    public let totalLabelCount: Int
    public let concurrency: Int
    public let elapsedMilliseconds: Double?
    public let assetsPerSecond: Double?
    public let details: String?

    public init(
      status: String,
      requestedSampleCount: Int,
      processedSampleCount: Int,
      failureCount: Int,
      totalLabelCount: Int,
      concurrency: Int,
      elapsedMilliseconds: Double?,
      assetsPerSecond: Double?,
      details: String?
    ) {
      self.status = status
      self.requestedSampleCount = requestedSampleCount
      self.processedSampleCount = processedSampleCount
      self.failureCount = failureCount
      self.totalLabelCount = totalLabelCount
      self.concurrency = concurrency
      self.elapsedMilliseconds = elapsedMilliseconds
      self.assetsPerSecond = assetsPerSecond
      self.details = details
    }
  }

  public let schemaVersion: Int
  public let status: String
  public let generatedAt: String
  public let authorizationStatus: String
  public let environment: Environment
  public let configuration: Configuration
  public let metadata: MetadataBenchmarkReport?
  public let vision: Vision?
  public let initialImages: InitialImageBenchmarkReport?
}
