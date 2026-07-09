import Foundation

struct CalendarProfilerReport: Encodable, Sendable {
  struct Configuration: Encodable, Sendable {
    let iterations: Int
    let warmupIterations: Int
    let bufferMilliseconds: Double
  }

  struct Dataset: Encodable, Sendable {
    let seed: String
    let visits: Int
    let events: Int
    let restaurants: Int
    let matches: Int
    let coverageCases: [String]
  }

  struct Validation: Encodable, Sendable {
    let optimizedMatchesExhaustive: Bool
    let checksum: String
  }

  let schemaVersion = 1
  let status = "ok"
  let configuration: Configuration
  let dataset: Dataset
  let validation: Validation
  let optimized: CalendarProfilerBenchmarkSummary
  let exhaustive: CalendarProfilerBenchmarkSummary
  let speedup: Double
}
