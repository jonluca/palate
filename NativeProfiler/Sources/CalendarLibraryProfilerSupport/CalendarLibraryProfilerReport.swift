import Foundation

public struct CalendarLibraryProfilerReport: Encodable, Sendable {
  public struct Configuration: Encodable, Sendable {
    public let pastDays: Int
    public let futureDays: Int
    public let totalRangeDays: Int
    public let referenceWindowDays: Int
    public let productionMaximumWindowDays: Int
    public let iterations: Int
    public let warmupIterations: Int
    public let requestAccess: Bool
  }

  public struct Correctness: Encodable, Sendable {
    public let exactUniqueEventParity: Bool
    public let stableDigest: String
    public let uniqueEventCount: Int
    public let productionWindowCount: Int
    public let productionRawEventCount: Int
    public let productionDuplicateCount: Int
    public let referenceWindowCount: Int
    public let referenceRawEventCount: Int
    public let referenceDuplicateCount: Int
  }

  public struct Timings: Encodable, Sendable {
    public let initialProductionMilliseconds: Double
    public let initialReferenceMilliseconds: Double
    public let productionSamplesMilliseconds: [Double]
    public let referenceSamplesMilliseconds: [Double]
    public let production: CalendarLibraryBenchmarkSummary
    public let reference: CalendarLibraryBenchmarkSummary
  }

  public let schemaVersion: Int
  public let status: String
  public let generatedAt: String
  public let authorizationStatus: String
  public let readableCalendarCount: Int
  public let configuration: Configuration
  public let correctness: Correctness
  public let timings: Timings
}
