import BatchAssetInfoCore
import Foundation

/// Read-only preparation benchmark. Tokens live only in memory and never advance the app's checkpoint.
public struct PhotoLibraryChangeBenchmarkRunner {
  public struct Measurement: Encodable, Sendable {
    let mode: String
    let milliseconds: Double
    let candidateCount: Int
    let unknownCount: Int
  }

  public struct Report: Encodable, Sendable {
    let schemaVersion = 1
    let status = "ok"
    let sourceReadOnly = true
    let appCheckpointUnchanged = true
    let full: [Measurement]
    let delta: [Measurement]
  }

  public init() {}

  public func run(databasePath: String) async throws -> Report {
    let status = await PhotoLibraryAuthorization.requestIfNeeded(timeoutMilliseconds: 1_000)
    guard PhotoLibraryAuthorization.permitsReading(status) else {
      throw PhotosProfilerError.photoLibraryAccessUnavailable(status: PhotoLibraryAuthorization.name(for: status))
    }

    var full: [Measurement] = []
    var delta: [Measurement] = []
    for _ in 0..<5 {
      let baselineStart = DispatchTime.now().uptimeNanoseconds
      let baseline = try PhotoLibraryChangeScan(databasePath: databasePath, serializedToken: nil)
      full.append(measurement(baseline, start: baselineStart))

      let deltaStart = DispatchTime.now().uptimeNanoseconds
      let resumed = try PhotoLibraryChangeScan(databasePath: databasePath, serializedToken: baseline.changeToken)
      delta.append(measurement(resumed, start: deltaStart))
    }
    return Report(full: full, delta: delta)
  }

  private func measurement(_ scan: PhotoLibraryChangeScan, start: UInt64) -> Measurement {
    Measurement(
      mode: scan.mode.rawValue,
      milliseconds: Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000,
      candidateCount: scan.session.libraryTotalCount,
      unknownCount: scan.session.totalCount
    )
  }
}
