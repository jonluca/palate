import Foundation

public struct CalendarBatchMutationProfilerReport: Encodable, Sendable {
  public struct Configuration: Encodable, Sendable {
    public let itemCountPerPhase: Int
    public let measuredMutationItemsPerSample: Int
    public let iterations: Int
    public let warmupIterations: Int
  }

  public struct Dataset: Encodable, Sendable {
    public let seed: String
    public let createItems: Int
    public let deleteItems: Int
    public let initialEvents: Int
    public let syntheticCreateFailures: Int
    public let syntheticDeleteFailures: Int
    public let syntheticAlreadyAbsentDeletes: Int
  }

  public struct Correctness: Encodable, Sendable {
    public let exactOrderedOutcomeParity: Bool
    public let exactFinalStateParity: Bool
    public let allWarmupAndMeasuredResultsStable: Bool
    public let allWarmupAndMeasuredOperationCountsStable: Bool
    public let orderedOutcomeSHA256: String
    public let finalStateSHA256: String
    public let orderedOutcomeCount: Int
    public let finalEventCount: Int
  }

  public struct Timings: Encodable, Sendable {
    public let currentJavaScriptOrchestration: CalendarBatchMutationProfilerBenchmarkSummary
    public let nativeSingleCallOrchestration: CalendarBatchMutationProfilerBenchmarkSummary
    public let currentToNativeMedianSwiftCPURatio: Double
  }

  public let schemaVersion = 1
  public let status = "ok"
  public let mode = "synthetic-permission-free"
  public let generatedAt: String
  public let measurementScope: String
  public let configuration: Configuration
  public let dataset: Dataset
  public let correctness: Correctness
  public let operationModel: CalendarBatchMutationProfilerOperationModel
  public let timings: Timings
}
