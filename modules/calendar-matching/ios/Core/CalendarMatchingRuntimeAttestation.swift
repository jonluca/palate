import Foundation

public enum CalendarMatchingRuntimeAttestation {
  public static let validationRunIDEnvironmentKey = "PALATE_CALENDAR_VALIDATION_RUN_ID"
  public static let validationAttestationPathEnvironmentKey =
    "PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH"

  private struct Payload: Encodable {
    let schemaVersion: Int
    let runId: String
    let resolvedStrategy: String
    let resolvedGapDays: Double
  }

  @discardableResult
  public static func writeIfRequested(
    configuration: CalendarMatchingRuntimeConfiguration,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    guard let runID = environment[validationRunIDEnvironmentKey], !runID.isEmpty,
      let path = environment[validationAttestationPathEnvironmentKey], !path.isEmpty
    else {
      return false
    }

    do {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let data = try encoder.encode(
        Payload(
          schemaVersion: 1,
          runId: runID,
          resolvedStrategy: configuration.queryStrategy.rawValue,
          resolvedGapDays: configuration.sparseCoalescingGapDays
        )
      )
      try data.write(to: URL(fileURLWithPath: path), options: .atomic)
      return true
    } catch {
      return false
    }
  }
}
