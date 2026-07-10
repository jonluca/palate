import Foundation

public struct CalendarEventKitMutationProfilerReport: Codable, Sendable {
  public struct Configuration: Codable, Sendable {
    public let eventCounts: [Int]
    public let iterations: Int
    public let warmupIterations: Int
    public let requestAccess: Bool

    public init(
      eventCounts: [Int],
      iterations: Int,
      warmupIterations: Int,
      requestAccess: Bool
    ) {
      self.eventCounts = eventCounts
      self.iterations = iterations
      self.warmupIterations = warmupIterations
      self.requestAccess = requestAccess
    }
  }

  public struct TemporaryCalendar: Codable, Sendable {
    public let uniqueNameUsed: Bool
    public let sourceType: String
    public let identifierWasNonempty: Bool
    public let removedAfterBenchmark: Bool
    public let calendarLifecycleCommitsExcludedFromMutationCounts: Bool

    public init(
      uniqueNameUsed: Bool,
      sourceType: String,
      identifierWasNonempty: Bool,
      removedAfterBenchmark: Bool,
      calendarLifecycleCommitsExcludedFromMutationCounts: Bool
    ) {
      self.uniqueNameUsed = uniqueNameUsed
      self.sourceType = sourceType
      self.identifierWasNonempty = identifierWasNonempty
      self.removedAfterBenchmark = removedAfterBenchmark
      self.calendarLifecycleCommitsExcludedFromMutationCounts =
        calendarLifecycleCommitsExcludedFromMutationCounts
    }
  }

  public struct DigestEntry: Codable, Sendable {
    public let eventCount: Int
    public let semanticSHA256: String

    public init(eventCount: Int, semanticSHA256: String) {
      self.eventCount = eventCount
      self.semanticSHA256 = semanticSHA256
    }
  }

  public struct Correctness: Codable, Sendable {
    public let exactSemanticEventFieldParity: Bool
    public let stableEventCounts: Bool
    public let nonemptyUniqueEventIdentifiers: Bool
    public let candidateIdentifiersObservedBeforeFinalCommit: Bool
    public let candidateIdentifiersStableAfterCommit: Bool
    public let zeroRemainingEventsAfterEveryDelete: Bool
    public let strategyOrderAlternated: Bool
    public let semanticFieldsCompared: [String]
    public let semanticDigestExcludesEventKitIdentifiers: Bool
    public let semanticDigests: [DigestEntry]

    public init(
      exactSemanticEventFieldParity: Bool,
      stableEventCounts: Bool,
      nonemptyUniqueEventIdentifiers: Bool,
      candidateIdentifiersObservedBeforeFinalCommit: Bool,
      candidateIdentifiersStableAfterCommit: Bool,
      zeroRemainingEventsAfterEveryDelete: Bool,
      strategyOrderAlternated: Bool,
      semanticFieldsCompared: [String],
      semanticDigestExcludesEventKitIdentifiers: Bool,
      semanticDigests: [DigestEntry]
    ) {
      self.exactSemanticEventFieldParity = exactSemanticEventFieldParity
      self.stableEventCounts = stableEventCounts
      self.nonemptyUniqueEventIdentifiers = nonemptyUniqueEventIdentifiers
      self.candidateIdentifiersObservedBeforeFinalCommit =
        candidateIdentifiersObservedBeforeFinalCommit
      self.candidateIdentifiersStableAfterCommit = candidateIdentifiersStableAfterCommit
      self.zeroRemainingEventsAfterEveryDelete = zeroRemainingEventsAfterEveryDelete
      self.strategyOrderAlternated = strategyOrderAlternated
      self.semanticFieldsCompared = semanticFieldsCompared
      self.semanticDigestExcludesEventKitIdentifiers =
        semanticDigestExcludesEventKitIdentifiers
      self.semanticDigests = semanticDigests
    }
  }

  public struct StrategyResult: Codable, Sendable {
    public let create: CalendarEventKitMutationProfilerBenchmarkSummary
    public let delete: CalendarEventKitMutationProfilerBenchmarkSummary
    public let createCommitsPerSample: Int
    public let deleteCommitsPerSample: Int
    public let totalMeasuredCreateCommits: Int
    public let totalMeasuredDeleteCommits: Int

    public init(
      create: CalendarEventKitMutationProfilerBenchmarkSummary,
      delete: CalendarEventKitMutationProfilerBenchmarkSummary,
      createCommitsPerSample: Int,
      deleteCommitsPerSample: Int,
      totalMeasuredCreateCommits: Int,
      totalMeasuredDeleteCommits: Int
    ) {
      self.create = create
      self.delete = delete
      self.createCommitsPerSample = createCommitsPerSample
      self.deleteCommitsPerSample = deleteCommitsPerSample
      self.totalMeasuredCreateCommits = totalMeasuredCreateCommits
      self.totalMeasuredDeleteCommits = totalMeasuredDeleteCommits
    }
  }

  public struct SizeResult: Codable, Sendable {
    public let eventCount: Int
    public let semanticSHA256: String
    public let legacy: StrategyResult
    public let candidate: StrategyResult
    public let candidateCreateMedianSpeedup: Double
    public let candidateDeleteMedianSpeedup: Double

    public init(
      eventCount: Int,
      semanticSHA256: String,
      legacy: StrategyResult,
      candidate: StrategyResult,
      candidateCreateMedianSpeedup: Double,
      candidateDeleteMedianSpeedup: Double
    ) {
      self.eventCount = eventCount
      self.semanticSHA256 = semanticSHA256
      self.legacy = legacy
      self.candidate = candidate
      self.candidateCreateMedianSpeedup = candidateCreateMedianSpeedup
      self.candidateDeleteMedianSpeedup = candidateDeleteMedianSpeedup
    }
  }

  public let schemaVersion: Int
  public let status: String
  public let mode: String
  public let generatedAt: String
  public let authorizationStatus: String
  public let configuration: Configuration
  public let temporaryCalendar: TemporaryCalendar
  public let correctness: Correctness
  public let commitCountingScope: String
  public let measurementScope: String
  public let measurementExclusions: [String]
  public let results: [SizeResult]

  public init(
    schemaVersion: Int,
    status: String,
    mode: String,
    generatedAt: String,
    authorizationStatus: String,
    configuration: Configuration,
    temporaryCalendar: TemporaryCalendar,
    correctness: Correctness,
    commitCountingScope: String,
    measurementScope: String,
    measurementExclusions: [String],
    results: [SizeResult]
  ) {
    self.schemaVersion = schemaVersion
    self.status = status
    self.mode = mode
    self.generatedAt = generatedAt
    self.authorizationStatus = authorizationStatus
    self.configuration = configuration
    self.temporaryCalendar = temporaryCalendar
    self.correctness = correctness
    self.commitCountingScope = commitCountingScope
    self.measurementScope = measurementScope
    self.measurementExclusions = measurementExclusions
    self.results = results
  }
}
