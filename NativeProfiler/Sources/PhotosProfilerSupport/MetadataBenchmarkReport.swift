import Foundation

public struct MetadataBenchmarkReport: Encodable, Sendable {
  public struct Measurement: Encodable, Sendable {
    public let iteration: Int
    public let elapsedMilliseconds: Double
    public let assetCount: Int
    public let identifierDigest: String
  }

  public struct Strategy: Encodable, Sendable {
    public let name: String
    public let batchSize: Int
    public let measurements: [Measurement]
    public let summary: BenchmarkSummary
  }

  public struct Validation: Encodable, Sendable {
    public let batchSize: Int
    public let retainedAssetCount: Int
    public let refetchedAssetCount: Int
    public let retainedIdentifierDigest: String
    public let refetchedIdentifierDigest: String
    public let countsMatch: Bool
    public let identifierDigestsMatch: Bool
    public let retainedMedianMilliseconds: Double
    public let refetchedMedianMilliseconds: Double
    public let retainedSpeedupVersusRefetch: Double
  }

  public let sessionSetupMilliseconds: Double
  public let snapshotAssetCount: Int
  public let profiledAssetCount: Int
  public let canonicalIdentifierDigest: String
  public let coldRetainedPass: Strategy
  public let strategies: [Strategy]
  public let validations: [Validation]
}
