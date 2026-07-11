import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset Vision result transport runtime attestation")
struct PhotoAssetVisionResultTransportRuntimeAttestationTests {
  typealias Attestation = PhotoAssetVisionResultTransportRuntimeAttestation

  @Test("Incomplete validation environment performs no work")
  func disabledWithoutBothEnvironmentValues() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let sentinel = Data("unchanged".utf8)
    try sentinel.write(to: temporary.fileURL)
    var observedTimestamp = false
    let attestation = Attestation(
      environment: [
        Attestation.validationAttestationPathEnvironmentKey: temporary.fileURL.path
      ],
      observedAtEpochSeconds: {
        observedTimestamp = true
        return 1
      }
    )

    let dispatch = try attestation.beginDispatchIfRequested(
      selectedTransport: .legacy,
      requestedAssetCount: 3
    )

    #expect(dispatch == nil)
    #expect(
      try !attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    )
    #expect(!observedTimestamp)
    #expect(try Data(contentsOf: temporary.fileURL) == sentinel)
  }

  @Test("Beginning a dispatch atomically writes its in-flight aggregate")
  func beginWritesInFlightPayload() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    try Data("stale".utf8).write(to: temporary.fileURL)
    let attestation = Attestation(
      environment: temporary.environment(
        runID: "vision-run-packed",
        configuredTransport: "packed-v1"
      ),
      observedAtEpochSeconds: { 1_750_000_000.25 }
    )

    let dispatch = try attestation.beginDispatchIfRequested(
      selectedTransport: .packedV1,
      requestedAssetCount: 7
    )
    let payload = try temporary.payload()

    #expect(dispatch != nil)
    #expect(payload.schemaVersion == 2)
    #expect(payload.runId == "vision-run-packed")
    #expect(payload.configuredResultTransport == "packed-v1")
    #expect(payload.resolvedResultTransport == "packed-v1")
    #expect(payload.selectedResultTransport == "packed-v1")
    #expect(payload.observedAtEpochSeconds == 1_750_000_000.25)
    #expect(payload.lastObservedAtEpochSeconds == 1_750_000_000.25)
    #expect(payload.startedBatchCount == 1)
    #expect(payload.startedRequestedAssetCount == 7)
    #expect(payload.completedBatchCount == 0)
    #expect(payload.completedRequestedAssetCount == 0)
    #expect(payload.inFlightBatchCount == 1)
    #expect(payload.inFlightRequestedAssetCount == 7)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: temporary.directoryURL.path) == [
        "attestation.json"
      ])
  }

  @Test("Resolved, rejected, and cancelled dispatches remain balanced")
  func completionAggregatesRemainBalanced() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    var timestamp = 99.0
    let attestation = Attestation(
      environment: temporary.environment(runID: "vision-run-balanced"),
      observedAtEpochSeconds: {
        timestamp += 1
        return timestamp
      }
    )
    let resolved = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 3
      ))
    let rejected = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 0
      ))
    let cancelled = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 5
      ))

    #expect(
      try attestation.completeDispatchIfRequested(rejected, completion: .rejected)
    )
    #expect(
      try attestation.completeDispatchIfRequested(resolved, completion: .resolved)
    )
    #expect(
      try attestation.completeDispatchIfRequested(cancelled, completion: .cancelled)
    )
    let payload = try temporary.payload()

    #expect(payload.observedAtEpochSeconds == 100)
    #expect(payload.lastObservedAtEpochSeconds == 105)
    #expect(payload.startedBatchCount == 3)
    #expect(payload.startedRequestedAssetCount == 8)
    #expect(payload.completedBatchCount == 3)
    #expect(payload.completedRequestedAssetCount == 8)
    #expect(payload.resolvedBatchCount == 1)
    #expect(payload.resolvedRequestedAssetCount == 3)
    #expect(payload.rejectedBatchCount == 1)
    #expect(payload.rejectedRequestedAssetCount == 0)
    #expect(payload.cancelledBatchCount == 1)
    #expect(payload.cancelledRequestedAssetCount == 5)
    #expect(payload.inFlightBatchCount == 0)
    #expect(payload.inFlightRequestedAssetCount == 0)
  }

  @Test("A completed dispatch cannot be completed twice")
  func duplicateCompletionIsRejectedWithoutRewrite() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    var timestampObservations = 0
    let attestation = Attestation(
      environment: temporary.environment(runID: "vision-run-duplicate"),
      observedAtEpochSeconds: {
        timestampObservations += 1
        return Double(timestampObservations)
      }
    )
    let dispatch = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 2
      ))
    try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    let firstPayload = try Data(contentsOf: temporary.fileURL)

    #expect(throws: Attestation.ValidationError.dispatchAlreadyCompleted(1)) {
      try attestation.completeDispatchIfRequested(dispatch, completion: .cancelled)
    }
    #expect(timestampObservations == 2)
    #expect(try Data(contentsOf: temporary.fileURL) == firstPayload)
  }

  @Test("Mixed transports are rejected without mutating aggregates")
  func mixedTransportIsRejected() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    var timestampObservations = 0
    let attestation = Attestation(
      environment: temporary.environment(
        runID: "vision-run-mixed",
        configuredTransport: "legacy"
      ),
      observedAtEpochSeconds: {
        timestampObservations += 1
        return Double(timestampObservations)
      }
    )
    _ = try attestation.beginDispatchIfRequested(
      selectedTransport: .legacy,
      requestedAssetCount: 4
    )
    let firstPayload = try Data(contentsOf: temporary.fileURL)

    #expect(
      throws: Attestation.ValidationError.mixedSelectedTransports(
        first: "legacy",
        subsequent: "packed-v1"
      )
    ) {
      try attestation.beginDispatchIfRequested(
        selectedTransport: .packedV1,
        requestedAssetCount: 4
      )
    }
    #expect(timestampObservations == 1)
    #expect(try Data(contentsOf: temporary.fileURL) == firstPayload)
  }

  @Test("Attestation instances in one process share a run aggregate")
  func instancesShareRunAggregate() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let environment = temporary.environment(runID: "vision-run-shared")
    var firstTimestamps = [1.0, 4.0]
    var secondTimestamps = [2.0, 3.0]
    let first = Attestation(
      environment: environment,
      observedAtEpochSeconds: { firstTimestamps.removeFirst() }
    )
    let second = Attestation(
      environment: environment,
      observedAtEpochSeconds: { secondTimestamps.removeFirst() }
    )
    let firstDispatch = try #require(
      try first.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 3
      ))
    let secondDispatch = try #require(
      try second.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 5
      ))

    #expect(
      try second.completeDispatchIfRequested(firstDispatch, completion: .resolved)
    )
    #expect(
      try first.completeDispatchIfRequested(secondDispatch, completion: .cancelled)
    )
    let payload = try temporary.payload()
    #expect(payload.startedBatchCount == 2)
    #expect(payload.startedRequestedAssetCount == 8)
    #expect(payload.resolvedBatchCount == 1)
    #expect(payload.resolvedRequestedAssetCount == 3)
    #expect(payload.cancelledBatchCount == 1)
    #expect(payload.cancelledRequestedAssetCount == 5)
    #expect(payload.inFlightBatchCount == 0)
    #expect(payload.lastObservedAtEpochSeconds == 4)
  }

  @Test("A dispatch token cannot cross attestation instances")
  func foreignDispatchIsRejected() throws {
    let firstTemporary = try TemporaryAttestationFile()
    let secondTemporary = try TemporaryAttestationFile()
    defer {
      firstTemporary.remove()
      secondTemporary.remove()
    }
    let first = Attestation(
      environment: firstTemporary.environment(runID: "vision-run-first")
    )
    let second = Attestation(
      environment: secondTemporary.environment(runID: "vision-run-second")
    )
    let dispatch = try #require(
      try first.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 1
      ))

    #expect(throws: Attestation.ValidationError.foreignDispatch) {
      try second.completeDispatchIfRequested(dispatch, completion: .resolved)
    }
    #expect(!FileManager.default.fileExists(atPath: secondTemporary.fileURL.path))
  }

  @Test("Invalid counts, environment values, and timestamps are rejected")
  func malformedInputsAreRejected() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let invalidEnvironments:
      [(
        environment: [String: String],
        expected: Attestation.ValidationError
      )] = [
        (temporary.environment(runID: ""), .invalidRunID),
        (
          [
            Attestation.validationRunIDEnvironmentKey: "vision-run-relative",
            Attestation.validationAttestationPathEnvironmentKey: "relative-attestation.json",
          ],
          .invalidAttestationPath
        ),
      ]

    for invalid in invalidEnvironments {
      let attestation = Attestation(environment: invalid.environment)
      #expect(throws: invalid.expected) {
        try attestation.beginDispatchIfRequested(
          selectedTransport: .legacy,
          requestedAssetCount: 1
        )
      }
    }

    let valid = Attestation(
      environment: temporary.environment(runID: "vision-run-invalid-count")
    )
    #expect(throws: Attestation.ValidationError.invalidRequestedAssetCount(-1)) {
      try valid.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: -1
      )
    }

    let nonfinite = Attestation(
      environment: temporary.environment(runID: "vision-run-invalid-time"),
      observedAtEpochSeconds: { .infinity }
    )
    #expect(throws: Attestation.ValidationError.invalidObservedTimestamp) {
      try nonfinite.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 1
      )
    }
  }

  @Test("A backward completion timestamp preserves the active dispatch")
  func backwardTimestampRollsBack() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    var timestamps = [2.0, 1.0, 3.0]
    let attestation = Attestation(
      environment: temporary.environment(runID: "vision-run-clock"),
      observedAtEpochSeconds: { timestamps.removeFirst() }
    )
    let dispatch = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 4
      ))
    let inFlightPayload = try Data(contentsOf: temporary.fileURL)

    #expect(
      throws: Attestation.ValidationError.observedTimestampMovedBackward(
        previous: 2,
        subsequent: 1
      )
    ) {
      try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    }
    #expect(try Data(contentsOf: temporary.fileURL) == inFlightPayload)
    #expect(
      try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    )
    let payload = try temporary.payload()
    #expect(payload.completedBatchCount == 1)
    #expect(payload.lastObservedAtEpochSeconds == 3)
  }

  @Test("A failed begin write rolls state back and can be retried")
  func beginWriteFailureRollsBack() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let missingDirectory = temporary.directoryURL.appendingPathComponent(
      "missing",
      isDirectory: true
    )
    let missingFile = missingDirectory.appendingPathComponent("attestation.json")
    var timestamp = 0.0
    let attestation = Attestation(
      environment: temporary.environment(
        runID: "vision-run-begin-retry",
        fileURL: missingFile
      ),
      observedAtEpochSeconds: {
        timestamp += 1
        return timestamp
      }
    )

    #expect(throws: (any Error).self) {
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 6
      )
    }
    try FileManager.default.createDirectory(
      at: missingDirectory,
      withIntermediateDirectories: false
    )
    let dispatch = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 6
      ))
    let payload = try temporary.payload(fileURL: missingFile)

    #expect(payload.startedBatchCount == 1)
    #expect(payload.startedRequestedAssetCount == 6)
    #expect(payload.observedAtEpochSeconds == 2)
    #expect(
      try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    )
  }

  @Test("A failed completion write preserves the active dispatch for retry")
  func completionWriteFailureRollsBack() throws {
    let temporary = try TemporaryAttestationFile()
    defer { temporary.remove() }
    let nestedDirectory = temporary.directoryURL.appendingPathComponent(
      "nested",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: nestedDirectory,
      withIntermediateDirectories: false
    )
    let nestedFile = nestedDirectory.appendingPathComponent("attestation.json")
    let attestation = Attestation(
      environment: temporary.environment(
        runID: "vision-run-completion-retry",
        fileURL: nestedFile
      )
    )
    let dispatch = try #require(
      try attestation.beginDispatchIfRequested(
        selectedTransport: .legacy,
        requestedAssetCount: 9
      ))
    try FileManager.default.removeItem(at: nestedDirectory)

    #expect(throws: (any Error).self) {
      try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    }
    try FileManager.default.createDirectory(
      at: nestedDirectory,
      withIntermediateDirectories: false
    )
    #expect(
      try attestation.completeDispatchIfRequested(dispatch, completion: .resolved)
    )
    let payload = try temporary.payload(fileURL: nestedFile)

    #expect(payload.completedBatchCount == 1)
    #expect(payload.resolvedRequestedAssetCount == 9)
    #expect(payload.inFlightBatchCount == 0)
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
      configuredTransport: String? = nil,
      fileURL: URL? = nil
    ) -> [String: String] {
      var environment = [
        Attestation.validationRunIDEnvironmentKey: runID,
        Attestation.validationAttestationPathEnvironmentKey: (fileURL ?? self.fileURL).path,
      ]
      if let configuredTransport {
        environment[PhotoAssetClassificationRuntimeConfiguration.resultTransportEnvironmentKey] =
          configuredTransport
      }
      return environment
    }

    func payload(fileURL: URL? = nil) throws -> Attestation.Payload {
      try JSONDecoder().decode(
        Attestation.Payload.self,
        from: Data(contentsOf: fileURL ?? self.fileURL)
      )
    }

    func remove() {
      try? FileManager.default.removeItem(at: directoryURL)
    }
  }
}
