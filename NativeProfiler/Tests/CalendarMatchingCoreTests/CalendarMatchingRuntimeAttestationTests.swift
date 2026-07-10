import Foundation
import Testing

@testable import CalendarMatchingCore

@Suite("Calendar matching runtime attestation")
struct CalendarMatchingRuntimeAttestationTests {
  private struct Payload: Decodable {
    let schemaVersion: Int
    let runId: String
    let resolvedStrategy: String
    let resolvedGapDays: Double
  }

  @Test("A complete validation environment atomically writes the resolved configuration")
  func writesResolvedConfiguration() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    try Data("stale".utf8).write(to: temporary.fileURL)
    let environment = [
      CalendarMatchingRuntimeConfiguration.queryStrategyEnvironmentKey: "sparse",
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "14.5",
      CalendarMatchingRuntimeAttestation.validationRunIDEnvironmentKey: "calendar-run-123",
      CalendarMatchingRuntimeAttestation.validationAttestationPathEnvironmentKey:
        temporary.fileURL.path,
    ]
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: environment)

    #expect(
      CalendarMatchingRuntimeAttestation.writeIfRequested(
        configuration: configuration,
        environment: environment
      )
    )

    let payload = try JSONDecoder().decode(Payload.self, from: Data(contentsOf: temporary.fileURL))
    #expect(payload.schemaVersion == 1)
    #expect(payload.runId == "calendar-run-123")
    #expect(payload.resolvedStrategy == "sparse")
    #expect(payload.resolvedGapDays == 14.5)
  }

  @Test("Attestation records defaults after invalid tuning values are resolved")
  func writesResolvedDefaults() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let environment = [
      CalendarMatchingRuntimeConfiguration.queryStrategyEnvironmentKey: "invalid",
      CalendarMatchingRuntimeConfiguration.queryGapDaysEnvironmentKey: "999",
      CalendarMatchingRuntimeAttestation.validationRunIDEnvironmentKey: "default-run",
      CalendarMatchingRuntimeAttestation.validationAttestationPathEnvironmentKey:
        temporary.fileURL.path,
    ]
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: environment)

    #expect(
      CalendarMatchingRuntimeAttestation.writeIfRequested(
        configuration: configuration,
        environment: environment
      )
    )

    let payload = try JSONDecoder().decode(Payload.self, from: Data(contentsOf: temporary.fileURL))
    #expect(payload.resolvedStrategy == "broad")
    #expect(payload.resolvedGapDays == 7)
  }

  @Test("Both validation environment values are required")
  func requiresRunIDAndPath() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: [:])

    #expect(
      !CalendarMatchingRuntimeAttestation.writeIfRequested(
        configuration: configuration,
        environment: [
          CalendarMatchingRuntimeAttestation.validationAttestationPathEnvironmentKey:
            temporary.fileURL.path
        ]
      )
    )
    #expect(!FileManager.default.fileExists(atPath: temporary.fileURL.path))
    #expect(
      !CalendarMatchingRuntimeAttestation.writeIfRequested(
        configuration: configuration,
        environment: [
          CalendarMatchingRuntimeAttestation.validationRunIDEnvironmentKey: "run-without-path"
        ]
      )
    )
  }

  @Test("An unwritable destination is ignored")
  func ignoresWriteFailure() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let missingParentPath = temporary.directoryURL
      .appendingPathComponent("missing", isDirectory: true)
      .appendingPathComponent("attestation.json")
      .path
    let configuration = CalendarMatchingRuntimeConfiguration.resolve(environment: [:])

    #expect(
      !CalendarMatchingRuntimeAttestation.writeIfRequested(
        configuration: configuration,
        environment: [
          CalendarMatchingRuntimeAttestation.validationRunIDEnvironmentKey: "failed-run",
          CalendarMatchingRuntimeAttestation.validationAttestationPathEnvironmentKey:
            missingParentPath,
        ]
      )
    )
    #expect(!FileManager.default.fileExists(atPath: missingParentPath))
  }

  private struct TemporaryAttestationFile {
    let directoryURL: URL
    let fileURL: URL

    init() throws {
      directoryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
      fileURL = directoryURL.appendingPathComponent("calendar-attestation.json")
      try FileManager.default.createDirectory(
        at: directoryURL,
        withIntermediateDirectories: false
      )
    }

    func remove() {
      try? FileManager.default.removeItem(at: directoryURL)
    }
  }
}
