import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset scan runtime attestation")
struct PhotoAssetScanRuntimeAttestationTests {
  private struct Payload: Decodable {
    let schemaVersion: Int
    let runId: String
    let configuredPhotoScanStrategy: String?
    let resolvedPhotoScanStrategy: String
    let selectedScanKind: String
    let selectedScanImplementation: String
    let libraryTotalCount: Int
    let unknownVisibleCount: Int
    let excludedVisibleCount: Int
    let excludedPhotosWithLocation: Int
    let excludedSkippedAssets: Int
    let observedAtEpochSeconds: Double
  }

  @Test("Incremental begin writes the exact configured, resolved, and selected strategy")
  func writesIncrementalPayload() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    try Data("stale".utf8).write(to: temporary.fileURL)
    let environment = temporary.environment(
      runID: "photo-run-incremental",
      configuredStrategy: "incremental"
    )

    #expect(
      try PhotoAssetScanRuntimeAttestation.writeIfRequested(
        selectedScanImplementation: .databaseBacked,
        metrics: .init(
          libraryTotalCount: 10,
          unknownVisibleCount: 3,
          excludedVisibleCount: 7,
          excludedPhotosWithLocation: 4,
          excludedSkippedAssets: 1
        ),
        environment: environment,
        observedAtEpochSeconds: { 1_750_000_000.25 }
      )
    )

    let payload = try decodePayload(at: temporary.fileURL)
    #expect(payload.schemaVersion == 2)
    #expect(payload.runId == "photo-run-incremental")
    #expect(payload.configuredPhotoScanStrategy == "incremental")
    #expect(payload.resolvedPhotoScanStrategy == "incremental")
    #expect(payload.selectedScanKind == "incremental")
    #expect(payload.selectedScanImplementation == "database-backed")
    #expect(payload.libraryTotalCount == 10)
    #expect(payload.unknownVisibleCount == 3)
    #expect(payload.excludedVisibleCount == 7)
    #expect(payload.excludedPhotosWithLocation == 4)
    #expect(payload.excludedSkippedAssets == 1)
    #expect(payload.observedAtEpochSeconds == 1_750_000_000.25)
  }

  @Test("A later full fallback atomically replaces an incremental attestation")
  func fullFallbackOverwritesIncrementalSelection() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let environment = temporary.environment(
      runID: "photo-run-fallback",
      configuredStrategy: "incremental"
    )

    try PhotoAssetScanRuntimeAttestation.writeIfRequested(
      selectedScanImplementation: .identifierList,
      metrics: .init(
        libraryTotalCount: 8,
        unknownVisibleCount: 2,
        excludedVisibleCount: 6,
        excludedPhotosWithLocation: 3,
        excludedSkippedAssets: 1
      ),
      environment: environment,
      observedAtEpochSeconds: { 100 }
    )
    let identifierPayload = try decodePayload(at: temporary.fileURL)
    #expect(identifierPayload.selectedScanKind == "incremental")
    #expect(identifierPayload.selectedScanImplementation == "identifier-list")
    try PhotoAssetScanRuntimeAttestation.writeIfRequested(
      selectedScanImplementation: .legacy,
      metrics: .init(
        libraryTotalCount: 8,
        unknownVisibleCount: 8,
        excludedVisibleCount: 0,
        excludedPhotosWithLocation: 0,
        excludedSkippedAssets: 0
      ),
      environment: environment,
      observedAtEpochSeconds: { 101 }
    )

    let payload = try decodePayload(at: temporary.fileURL)
    #expect(payload.configuredPhotoScanStrategy == "incremental")
    #expect(payload.resolvedPhotoScanStrategy == "incremental")
    #expect(payload.selectedScanKind == "legacy")
    #expect(payload.selectedScanImplementation == "legacy")
    #expect(payload.libraryTotalCount == 8)
    #expect(payload.unknownVisibleCount == 8)
    #expect(payload.excludedVisibleCount == 0)
    #expect(payload.excludedPhotosWithLocation == 0)
    #expect(payload.excludedSkippedAssets == 0)
    #expect(payload.observedAtEpochSeconds == 101)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: temporary.directoryURL.path) == [
        "attestation.json"
      ])
  }

  @Test("An omitted strategy is encoded as null and resolves to incremental")
  func recordsNativeDefault() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let environment = temporary.environment(runID: "photo-run-default")

    try PhotoAssetScanRuntimeAttestation.writeIfRequested(
      selectedScanImplementation: .databaseBacked,
      metrics: .init(
        libraryTotalCount: 0,
        unknownVisibleCount: 0,
        excludedVisibleCount: 0,
        excludedPhotosWithLocation: 0,
        excludedSkippedAssets: 0
      ),
      environment: environment,
      observedAtEpochSeconds: { 200 }
    )

    let data = try Data(contentsOf: temporary.fileURL)
    let payload = try JSONDecoder().decode(Payload.self, from: data)
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(payload.configuredPhotoScanStrategy == nil)
    #expect(payload.resolvedPhotoScanStrategy == "incremental")
    #expect(payload.selectedScanKind == "incremental")
    #expect(payload.selectedScanImplementation == "database-backed")
    #expect(object.keys.contains("configuredPhotoScanStrategy"))
    #expect(object["configuredPhotoScanStrategy"] is NSNull)
  }

  @Test("Incomplete validation environment performs no write or timestamp observation")
  func validationDisabledWithoutBothValues() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let sentinel = Data("unchanged".utf8)
    try sentinel.write(to: temporary.fileURL)
    var observedTimestamp = false

    #expect(
      try !PhotoAssetScanRuntimeAttestation.writeIfRequested(
        selectedScanImplementation: .legacy,
        metrics: .init(
          libraryTotalCount: 1,
          unknownVisibleCount: 1,
          excludedVisibleCount: 0,
          excludedPhotosWithLocation: 0,
          excludedSkippedAssets: 0
        ),
        environment: [
          PhotoAssetScanRuntimeAttestation.validationAttestationPathEnvironmentKey:
            temporary.fileURL.path
        ],
        observedAtEpochSeconds: {
          observedTimestamp = true
          return 300
        }
      )
    )
    #expect(!observedTimestamp)
    #expect(try Data(contentsOf: temporary.fileURL) == sentinel)
  }

  @Test("Inconsistent counters fail before producing an attestation")
  func rejectsInvalidMetrics() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let environment = temporary.environment(runID: "invalid-counts")

    #expect(throws: PhotoAssetScanRuntimeAttestation.ValidationError.invalidMetrics) {
      try PhotoAssetScanRuntimeAttestation.writeIfRequested(
        selectedScanImplementation: .databaseBacked,
        metrics: .init(
          libraryTotalCount: 4,
          unknownVisibleCount: 2,
          excludedVisibleCount: 1,
          excludedPhotosWithLocation: 0,
          excludedSkippedAssets: 0
        ),
        environment: environment,
        observedAtEpochSeconds: { 400 }
      )
    }
    #expect(!FileManager.default.fileExists(atPath: temporary.fileURL.path))
  }

  @Test("Enabled validation propagates an atomic write failure")
  func propagatesWriteFailure() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let missingPath = temporary.directoryURL
      .appendingPathComponent("missing", isDirectory: true)
      .appendingPathComponent("attestation.json")
      .path
    let environment = [
      PhotoAssetScanRuntimeAttestation.validationRunIDEnvironmentKey: "write-failure",
      PhotoAssetScanRuntimeAttestation.validationAttestationPathEnvironmentKey: missingPath,
    ]

    do {
      try PhotoAssetScanRuntimeAttestation.writeIfRequested(
        selectedScanImplementation: .legacy,
        metrics: .init(
          libraryTotalCount: 1,
          unknownVisibleCount: 1,
          excludedVisibleCount: 0,
          excludedPhotosWithLocation: 0,
          excludedSkippedAssets: 0
        ),
        environment: environment,
        observedAtEpochSeconds: { 500 }
      )
      Issue.record("Expected enabled validation to reject an unwritable attestation path")
    } catch {
      #expect(!FileManager.default.fileExists(atPath: missingPath))
    }
  }

  private func decodePayload(at url: URL) throws -> Payload {
    try JSONDecoder().decode(Payload.self, from: Data(contentsOf: url))
  }

  private struct TemporaryAttestationFile {
    let directoryURL: URL
    let fileURL: URL

    init() throws {
      directoryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
      fileURL = directoryURL.appendingPathComponent("attestation.json")
      try FileManager.default.createDirectory(
        at: directoryURL,
        withIntermediateDirectories: false
      )
    }

    func environment(
      runID: String,
      configuredStrategy: String? = nil
    ) -> [String: String] {
      var environment = [
        PhotoAssetScanRuntimeAttestation.validationRunIDEnvironmentKey: runID,
        PhotoAssetScanRuntimeAttestation.validationAttestationPathEnvironmentKey: fileURL.path,
      ]
      if let configuredStrategy {
        environment[PhotoAssetScanStrategy.environmentKey] = configuredStrategy
      }
      return environment
    }

    func remove() {
      try? FileManager.default.removeItem(at: directoryURL)
    }
  }
}
