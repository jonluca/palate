import Foundation

enum PhotoAssetVisionVisitFoodValidationMode {
  static func isEnabled(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    guard
      let runID = environment[
        PhotoAssetVisionResultTransportRuntimeAttestation.validationRunIDEnvironmentKey
      ],
      let attestationPath = environment[
        PhotoAssetVisionResultTransportRuntimeAttestation
          .validationAttestationPathEnvironmentKey
      ]
    else {
      return false
    }

    return !runID.isEmpty
      && !attestationPath.isEmpty
      && NSString(string: attestationPath).isAbsolutePath
  }
}

final class PhotoAssetVisionResultTransportRuntimeAttestation: @unchecked Sendable {
  static let schemaVersion = 2
  static let validationRunIDEnvironmentKey = "PALATE_VISION_VALIDATION_RUN_ID"
  static let validationAttestationPathEnvironmentKey =
    "PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH"

  enum DispatchCompletion: String, Equatable, Sendable {
    case resolved
    case rejected
    case cancelled
  }

  struct Dispatch: Hashable, Sendable {
    fileprivate let ownerID: UUID
    fileprivate let id: UInt64
    fileprivate let requestedAssetCount: Int
    fileprivate let selectedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport
  }

  struct Payload: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let runId: String
    let configuredResultTransport: String?
    let resolvedResultTransport: String
    let selectedResultTransport: String
    let observedAtEpochSeconds: Double
    let lastObservedAtEpochSeconds: Double
    let startedBatchCount: Int
    let startedRequestedAssetCount: Int
    let completedBatchCount: Int
    let completedRequestedAssetCount: Int
    let resolvedBatchCount: Int
    let resolvedRequestedAssetCount: Int
    let rejectedBatchCount: Int
    let rejectedRequestedAssetCount: Int
    let cancelledBatchCount: Int
    let cancelledRequestedAssetCount: Int
    let inFlightBatchCount: Int
    let inFlightRequestedAssetCount: Int

    private enum CodingKeys: String, CodingKey {
      case schemaVersion
      case runId
      case configuredResultTransport
      case resolvedResultTransport
      case selectedResultTransport
      case observedAtEpochSeconds
      case lastObservedAtEpochSeconds
      case startedBatchCount
      case startedRequestedAssetCount
      case completedBatchCount
      case completedRequestedAssetCount
      case resolvedBatchCount
      case resolvedRequestedAssetCount
      case rejectedBatchCount
      case rejectedRequestedAssetCount
      case cancelledBatchCount
      case cancelledRequestedAssetCount
      case inFlightBatchCount
      case inFlightRequestedAssetCount
    }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(schemaVersion, forKey: .schemaVersion)
      try container.encode(runId, forKey: .runId)
      if let configuredResultTransport {
        try container.encode(configuredResultTransport, forKey: .configuredResultTransport)
      } else {
        try container.encodeNil(forKey: .configuredResultTransport)
      }
      try container.encode(resolvedResultTransport, forKey: .resolvedResultTransport)
      try container.encode(selectedResultTransport, forKey: .selectedResultTransport)
      try container.encode(observedAtEpochSeconds, forKey: .observedAtEpochSeconds)
      try container.encode(lastObservedAtEpochSeconds, forKey: .lastObservedAtEpochSeconds)
      try container.encode(startedBatchCount, forKey: .startedBatchCount)
      try container.encode(startedRequestedAssetCount, forKey: .startedRequestedAssetCount)
      try container.encode(completedBatchCount, forKey: .completedBatchCount)
      try container.encode(completedRequestedAssetCount, forKey: .completedRequestedAssetCount)
      try container.encode(resolvedBatchCount, forKey: .resolvedBatchCount)
      try container.encode(resolvedRequestedAssetCount, forKey: .resolvedRequestedAssetCount)
      try container.encode(rejectedBatchCount, forKey: .rejectedBatchCount)
      try container.encode(rejectedRequestedAssetCount, forKey: .rejectedRequestedAssetCount)
      try container.encode(cancelledBatchCount, forKey: .cancelledBatchCount)
      try container.encode(cancelledRequestedAssetCount, forKey: .cancelledRequestedAssetCount)
      try container.encode(inFlightBatchCount, forKey: .inFlightBatchCount)
      try container.encode(inFlightRequestedAssetCount, forKey: .inFlightRequestedAssetCount)
    }
  }

  enum ValidationError: Error, Equatable, LocalizedError {
    case invalidRunID
    case invalidAttestationPath
    case invalidRequestedAssetCount(Int)
    case invalidObservedTimestamp
    case observedTimestampMovedBackward(previous: Double, subsequent: Double)
    case mixedSelectedTransports(first: String, subsequent: String)
    case foreignDispatch
    case dispatchAlreadyCompleted(UInt64)
    case counterOverflow

    var errorDescription: String? {
      switch self {
      case .invalidRunID:
        "Vision result transport validation run ID must be non-empty."
      case .invalidAttestationPath:
        "Vision result transport attestation path must be a non-empty absolute path."
      case .invalidRequestedAssetCount(let count):
        "Vision result transport requested-asset count must be non-negative; received \(count)."
      case .invalidObservedTimestamp:
        "Vision result transport attestation timestamp must be finite."
      case .observedTimestampMovedBackward(let previous, let subsequent):
        "Vision result transport attestation timestamp moved backward from \(previous) to \(subsequent)."
      case .mixedSelectedTransports(let first, let subsequent):
        "Vision result transport changed from \(first) to \(subsequent) during one validation run."
      case .foreignDispatch:
        "Vision result transport dispatch belongs to a different attestation instance."
      case .dispatchAlreadyCompleted(let id):
        "Vision result transport dispatch \(id) is unknown or already completed."
      case .counterOverflow:
        "Vision result transport attestation counters overflowed."
      }
    }
  }

  private enum Request {
    case disabled
    case invalid(ValidationError)
    case enabled(
      runID: String,
      path: String,
      configuredTransport: String?,
      resolvedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport
    )
  }

  private struct Counter: Equatable, Sendable {
    var batches = 0
    var requestedAssets = 0

    mutating func add(requestedAssetCount: Int) throws {
      let (nextBatches, batchOverflow) = batches.addingReportingOverflow(1)
      let (nextAssets, assetOverflow) = requestedAssets.addingReportingOverflow(requestedAssetCount)
      guard !batchOverflow, !assetOverflow else {
        throw ValidationError.counterOverflow
      }
      batches = nextBatches
      requestedAssets = nextAssets
    }

    static func + (left: Counter, right: Counter) throws -> Counter {
      let (batches, batchOverflow) = left.batches.addingReportingOverflow(right.batches)
      let (requestedAssets, assetOverflow) = left.requestedAssets.addingReportingOverflow(
        right.requestedAssets)
      guard !batchOverflow, !assetOverflow else {
        throw ValidationError.counterOverflow
      }
      return Counter(batches: batches, requestedAssets: requestedAssets)
    }
  }

  private struct State: Sendable {
    var nextDispatchID: UInt64 = 1
    var selectedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport?
    var firstObservedAtEpochSeconds: Double?
    var lastObservedAtEpochSeconds: Double?
    var started = Counter()
    var resolved = Counter()
    var rejected = Counter()
    var cancelled = Counter()
    var activeRequestedAssetCounts: [UInt64: Int] = [:]
  }

  private struct SharedStateKey: Hashable, Sendable {
    let runID: String
    let path: String
    let configuredTransport: String?
    let resolvedTransport: String
  }

  private final class SharedState: @unchecked Sendable {
    let ownerID = UUID()
    let lock = NSLock()
    var value = State()
  }

  private static let sharedStatesLock = NSLock()
  nonisolated(unsafe) private static var sharedStates: [SharedStateKey: SharedState] = [:]

  private let request: Request
  private let observedAtEpochSeconds: () -> Double
  private let sharedState: SharedState?

  init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    observedAtEpochSeconds: @escaping () -> Double = { Date().timeIntervalSince1970 }
  ) {
    let request = Self.makeRequest(environment: environment)
    self.request = request
    self.observedAtEpochSeconds = observedAtEpochSeconds
    sharedState = Self.resolveSharedState(for: request)
  }

  func beginDispatchIfRequested(
    selectedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport,
    requestedAssetCount: Int
  ) throws -> Dispatch? {
    let enabledRequest = try enabledRequestIfPresent()
    guard let enabledRequest else {
      return nil
    }
    guard requestedAssetCount >= 0 else {
      throw ValidationError.invalidRequestedAssetCount(requestedAssetCount)
    }
    guard let sharedState else {
      throw ValidationError.counterOverflow
    }

    sharedState.lock.lock()
    defer { sharedState.lock.unlock() }
    var candidate = sharedState.value
    if let firstSelectedTransport = candidate.selectedTransport {
      guard firstSelectedTransport == selectedTransport else {
        throw ValidationError.mixedSelectedTransports(
          first: firstSelectedTransport.rawValue,
          subsequent: selectedTransport.rawValue
        )
      }
    } else {
      candidate.selectedTransport = selectedTransport
    }

    let timestamp = try validatedTimestamp(after: candidate.lastObservedAtEpochSeconds)
    guard candidate.nextDispatchID < UInt64.max else {
      throw ValidationError.counterOverflow
    }
    let dispatchID = candidate.nextDispatchID
    candidate.nextDispatchID += 1
    try candidate.started.add(requestedAssetCount: requestedAssetCount)
    candidate.activeRequestedAssetCounts[dispatchID] = requestedAssetCount
    candidate.firstObservedAtEpochSeconds = candidate.firstObservedAtEpochSeconds ?? timestamp
    candidate.lastObservedAtEpochSeconds = timestamp

    try write(candidate, request: enabledRequest)
    sharedState.value = candidate
    return Dispatch(
      ownerID: sharedState.ownerID,
      id: dispatchID,
      requestedAssetCount: requestedAssetCount,
      selectedTransport: selectedTransport
    )
  }

  @discardableResult
  func completeDispatchIfRequested(
    _ dispatch: Dispatch?,
    completion: DispatchCompletion
  ) throws -> Bool {
    guard let dispatch else {
      return false
    }
    let enabledRequest = try enabledRequestIfPresent()
    guard let enabledRequest else {
      return false
    }
    guard let sharedState, dispatch.ownerID == sharedState.ownerID else {
      throw ValidationError.foreignDispatch
    }

    sharedState.lock.lock()
    defer { sharedState.lock.unlock() }
    var candidate = sharedState.value
    guard
      candidate.activeRequestedAssetCounts.removeValue(forKey: dispatch.id)
        == dispatch.requestedAssetCount
    else {
      throw ValidationError.dispatchAlreadyCompleted(dispatch.id)
    }
    guard candidate.selectedTransport == dispatch.selectedTransport else {
      throw ValidationError.mixedSelectedTransports(
        first: candidate.selectedTransport?.rawValue ?? "<none>",
        subsequent: dispatch.selectedTransport.rawValue
      )
    }

    let timestamp = try validatedTimestamp(after: candidate.lastObservedAtEpochSeconds)
    switch completion {
    case .resolved:
      try candidate.resolved.add(requestedAssetCount: dispatch.requestedAssetCount)
    case .rejected:
      try candidate.rejected.add(requestedAssetCount: dispatch.requestedAssetCount)
    case .cancelled:
      try candidate.cancelled.add(requestedAssetCount: dispatch.requestedAssetCount)
    }
    candidate.lastObservedAtEpochSeconds = timestamp

    try write(candidate, request: enabledRequest)
    sharedState.value = candidate
    return true
  }

  private func enabledRequestIfPresent() throws -> (
    runID: String,
    path: String,
    configuredTransport: String?,
    resolvedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport
  )? {
    switch request {
    case .disabled:
      return nil
    case .invalid(let error):
      throw error
    case .enabled(let runID, let path, let configuredTransport, let resolvedTransport):
      return (runID, path, configuredTransport, resolvedTransport)
    }
  }

  private func validatedTimestamp(after previous: Double?) throws -> Double {
    let timestamp = observedAtEpochSeconds()
    guard timestamp.isFinite else {
      throw ValidationError.invalidObservedTimestamp
    }
    if let previous, timestamp < previous {
      throw ValidationError.observedTimestampMovedBackward(
        previous: previous,
        subsequent: timestamp
      )
    }
    return timestamp
  }

  private func write(
    _ state: State,
    request: (
      runID: String,
      path: String,
      configuredTransport: String?,
      resolvedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport
    )
  ) throws {
    guard
      let selectedTransport = state.selectedTransport,
      let firstObservedAtEpochSeconds = state.firstObservedAtEpochSeconds,
      let lastObservedAtEpochSeconds = state.lastObservedAtEpochSeconds
    else {
      throw ValidationError.counterOverflow
    }
    let completed = try state.resolved + state.rejected + state.cancelled
    var inFlight = Counter()
    for requestedAssetCount in state.activeRequestedAssetCounts.values {
      try inFlight.add(requestedAssetCount: requestedAssetCount)
    }
    let payload = Payload(
      schemaVersion: Self.schemaVersion,
      runId: request.runID,
      configuredResultTransport: request.configuredTransport,
      resolvedResultTransport: request.resolvedTransport.rawValue,
      selectedResultTransport: selectedTransport.rawValue,
      observedAtEpochSeconds: firstObservedAtEpochSeconds,
      lastObservedAtEpochSeconds: lastObservedAtEpochSeconds,
      startedBatchCount: state.started.batches,
      startedRequestedAssetCount: state.started.requestedAssets,
      completedBatchCount: completed.batches,
      completedRequestedAssetCount: completed.requestedAssets,
      resolvedBatchCount: state.resolved.batches,
      resolvedRequestedAssetCount: state.resolved.requestedAssets,
      rejectedBatchCount: state.rejected.batches,
      rejectedRequestedAssetCount: state.rejected.requestedAssets,
      cancelledBatchCount: state.cancelled.batches,
      cancelledRequestedAssetCount: state.cancelled.requestedAssets,
      inFlightBatchCount: inFlight.batches,
      inFlightRequestedAssetCount: inFlight.requestedAssets
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(payload)
    try data.write(to: URL(fileURLWithPath: request.path), options: .atomic)
  }

  private static func resolveSharedState(for request: Request) -> SharedState? {
    guard
      case .enabled(
        let runID,
        let path,
        let configuredTransport,
        let resolvedTransport
      ) = request
    else {
      return nil
    }
    let key = SharedStateKey(
      runID: runID,
      path: path,
      configuredTransport: configuredTransport,
      resolvedTransport: resolvedTransport.rawValue
    )
    sharedStatesLock.lock()
    defer { sharedStatesLock.unlock() }
    if let existing = sharedStates[key] {
      return existing
    }
    let created = SharedState()
    sharedStates[key] = created
    return created
  }

  private static func makeRequest(environment: [String: String]) -> Request {
    guard
      let runID = environment[validationRunIDEnvironmentKey],
      let path = environment[validationAttestationPathEnvironmentKey]
    else {
      return .disabled
    }
    guard !runID.isEmpty else {
      return .invalid(.invalidRunID)
    }
    guard !path.isEmpty, NSString(string: path).isAbsolutePath else {
      return .invalid(.invalidAttestationPath)
    }
    return .enabled(
      runID: runID,
      path: path,
      configuredTransport:
        environment[PhotoAssetClassificationRuntimeConfiguration.resultTransportEnvironmentKey],
      resolvedTransport: PhotoAssetClassificationRuntimeConfiguration.resolve(
        environment: environment
      ).resultTransport
    )
  }
}
