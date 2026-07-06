import Foundation

public struct InitialImageBenchmarkReport: Encodable, Sendable {
  public struct Configuration: Encodable, Sendable {
    public let imageCounts: [Int]
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let iterations: Int
    public let timeoutMilliseconds: Int
    public let networkAccessAllowed: Bool
    public let networkPolicy: String
  }

  public struct LatencySummary: Encodable, Equatable, Sendable {
    public let p50Milliseconds: Double
    public let p95Milliseconds: Double
    public let maximumMilliseconds: Double

    static func calculate(_ values: [Double]) -> LatencySummary? {
      guard !values.isEmpty else {
        return nil
      }
      let sorted = values.sorted()
      let p50: Double
      if sorted.count.isMultiple(of: 2) {
        let upper = sorted.count / 2
        p50 = (sorted[upper - 1] + sorted[upper]) / 2
      } else {
        p50 = sorted[sorted.count / 2]
      }
      let p95Index = min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * 0.95)) - 1))
      return LatencySummary(
        p50Milliseconds: p50,
        p95Milliseconds: sorted[p95Index],
        maximumMilliseconds: sorted[sorted.count - 1]
      )
    }
  }

  public struct DimensionSummary: Encodable, Equatable, Sendable {
    public let minimumPixelWidth: Int
    public let maximumPixelWidth: Int
    public let minimumPixelHeight: Int
    public let maximumPixelHeight: Int
    public let totalDecodedPixels: Int64
  }

  public struct Measurement: Encodable, Equatable, Sendable {
    public let strategy: InitialImageStrategy
    public let imageCount: Int
    public let iteration: Int
    public let samplePosition: InitialImageSamplePosition
    public let requestedIdentifierDigest: String
    public let finalIdentifierDigest: String
    public let requestedCount: Int
    public let renderableCount: Int
    public let degradedAssetCount: Int
    public let degradedEventCount: Int
    public let finalCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let unexpectedEventCount: Int
    public let duplicateTerminalEventCount: Int
    public let invalidDimensionCount: Int
    public let failureCodeCounts: [String: Int]
    public let firstRenderableMilliseconds: Double?
    public let firstDegradedMilliseconds: Double?
    public let firstFinalMilliseconds: Double?
    public let allVisibleFinalMilliseconds: Double?
    public let allTerminalMilliseconds: Double
    public let finalLatency: LatencySummary?
    public let finalDimensions: DimensionSummary?
  }

  public struct StrategyAggregate: Encodable, Sendable {
    public let measurementCount: Int
    public let finalImageCount: Int
    public let failureCount: Int
    public let timedOutCount: Int
    public let medianFirstRenderableMilliseconds: Double?
    public let medianFirstFinalMilliseconds: Double?
    public let medianAllVisibleFinalMilliseconds: Double?
    public let medianFinalP50Milliseconds: Double?
    public let medianFinalP95Milliseconds: Double?
    public let medianFinalMaximumMilliseconds: Double?
  }

  public struct CandidateSpeedup: Encodable, Sendable {
    public let firstRenderable: Double?
    public let firstFinal: Double?
    public let allVisibleFinal: Double?
    public let finalP50: Double?
    public let finalP95: Double?
  }

  public struct CountComparison: Encodable, Sendable {
    public let imageCount: Int
    public let baseline: StrategyAggregate
    public let candidate: StrategyAggregate
    public let candidateSpeedup: CandidateSpeedup
  }

  public let configuration: Configuration
  public let availableRecentImageCount: Int
  public let sampledIdentifierCount: Int
  public let sampledIdentifierDigest: String
  public let disjointSampleSets: Bool
  public let measurements: [Measurement]
  public let comparisons: [CountComparison]
}
