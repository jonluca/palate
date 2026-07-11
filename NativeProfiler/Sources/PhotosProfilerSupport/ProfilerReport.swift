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
    public let visionPipelineMaximumInFlight: Int
    public let visionPipelineFirst: Bool
    public let authorizationTimeoutMilliseconds: Int
  }

  public struct Vision: Encodable, Sendable {
    public struct Strategy: Encodable, Sendable {
      public let elapsedMilliseconds: Double
      public let assetsPerSecond: Double
      public let processedSampleCount: Int
      public let failureCount: Int
      public let totalLabelCount: Int
      public let samplesMilliseconds: [Double]
      public let medianMilliseconds: Double
      public let p95Milliseconds: Double
    }

    public struct Validation: Encodable, Sendable {
      public let exactOutcomeParity: Bool
      public let mismatchCount: Int
      public let comparedAssetCount: Int
      public let comparisonRuns: Int
    }

    public let status: String
    public let requestedSampleCount: Int
    public let processedSampleCount: Int
    public let failureCount: Int
    public let totalLabelCount: Int
    public let concurrency: Int
    public let elapsedMilliseconds: Double?
    public let assetsPerSecond: Double?
    public let details: String?
    public let baseline: Strategy?
    public let pipeline: Strategy?
    public let validation: Validation?
    public let pipelineMaximumInFlight: Int?
    public let pipelineRanFirst: Bool?
    public let measurementOrder: [String]?
    public let availableAssetCount: Int?
    public let requestedUniqueAssetCount: Int?
    public let profiledUniqueAssetCount: Int?
    public let comparisonWindowCount: Int?
    public let unavailableAssetCount: Int?

    public init(
      status: String,
      requestedSampleCount: Int,
      processedSampleCount: Int,
      failureCount: Int,
      totalLabelCount: Int,
      concurrency: Int,
      elapsedMilliseconds: Double?,
      assetsPerSecond: Double?,
      details: String?,
      baseline: Strategy? = nil,
      pipeline: Strategy? = nil,
      validation: Validation? = nil,
      pipelineMaximumInFlight: Int? = nil,
      pipelineRanFirst: Bool? = nil,
      measurementOrder: [String]? = nil,
      availableAssetCount: Int? = nil,
      requestedUniqueAssetCount: Int? = nil,
      profiledUniqueAssetCount: Int? = nil,
      comparisonWindowCount: Int? = nil,
      unavailableAssetCount: Int? = nil
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
      self.baseline = baseline
      self.pipeline = pipeline
      self.validation = validation
      self.pipelineMaximumInFlight = pipelineMaximumInFlight
      self.pipelineRanFirst = pipelineRanFirst
      self.measurementOrder = measurementOrder
      self.availableAssetCount = availableAssetCount
      self.requestedUniqueAssetCount = requestedUniqueAssetCount
      self.profiledUniqueAssetCount = profiledUniqueAssetCount
      self.comparisonWindowCount = comparisonWindowCount
      self.unavailableAssetCount = unavailableAssetCount
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
  public let initialImagePreheat: InitialImagePreheatBenchmarkReport?
  public let thumbnailScroll: ThumbnailScrollBenchmarkReport?
  public let previewCards: PreviewCardsBenchmarkReport?
}
