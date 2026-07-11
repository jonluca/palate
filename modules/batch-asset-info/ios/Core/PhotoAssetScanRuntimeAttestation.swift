import Foundation

enum PhotoAssetScanRuntimeAttestation {
  static let schemaVersion = 2
  static let validationRunIDEnvironmentKey = "PALATE_PHOTO_SCAN_VALIDATION_RUN_ID"
  static let validationAttestationPathEnvironmentKey =
    "PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH"

  struct Metrics: Equatable, Sendable {
    let libraryTotalCount: Int
    let unknownVisibleCount: Int
    let excludedVisibleCount: Int
    let excludedPhotosWithLocation: Int
    let excludedSkippedAssets: Int
  }

  struct Payload: Encodable, Equatable, Sendable {
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

    private enum CodingKeys: String, CodingKey {
      case schemaVersion
      case runId
      case configuredPhotoScanStrategy
      case resolvedPhotoScanStrategy
      case selectedScanKind
      case selectedScanImplementation
      case libraryTotalCount
      case unknownVisibleCount
      case excludedVisibleCount
      case excludedPhotosWithLocation
      case excludedSkippedAssets
      case observedAtEpochSeconds
    }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(schemaVersion, forKey: .schemaVersion)
      try container.encode(runId, forKey: .runId)
      if let configuredPhotoScanStrategy {
        try container.encode(
          configuredPhotoScanStrategy,
          forKey: .configuredPhotoScanStrategy
        )
      } else {
        try container.encodeNil(forKey: .configuredPhotoScanStrategy)
      }
      try container.encode(resolvedPhotoScanStrategy, forKey: .resolvedPhotoScanStrategy)
      try container.encode(selectedScanKind, forKey: .selectedScanKind)
      try container.encode(selectedScanImplementation, forKey: .selectedScanImplementation)
      try container.encode(libraryTotalCount, forKey: .libraryTotalCount)
      try container.encode(unknownVisibleCount, forKey: .unknownVisibleCount)
      try container.encode(excludedVisibleCount, forKey: .excludedVisibleCount)
      try container.encode(
        excludedPhotosWithLocation,
        forKey: .excludedPhotosWithLocation
      )
      try container.encode(excludedSkippedAssets, forKey: .excludedSkippedAssets)
      try container.encode(observedAtEpochSeconds, forKey: .observedAtEpochSeconds)
    }
  }

  enum ValidationError: Error, Equatable {
    case invalidMetrics
  }

  static func makePayload(
    runID: String,
    selectedScanImplementation: PhotoAssetScanImplementation,
    metrics: Metrics,
    environment: [String: String],
    observedAtEpochSeconds: Double
  ) throws -> Payload {
    let (visibleCount, visibleCountOverflow) = metrics.unknownVisibleCount.addingReportingOverflow(
      metrics.excludedVisibleCount
    )
    let (excludedDetailCount, excludedDetailCountOverflow) =
      metrics.excludedPhotosWithLocation.addingReportingOverflow(metrics.excludedSkippedAssets)
    guard
      metrics.libraryTotalCount >= 0,
      metrics.unknownVisibleCount >= 0,
      metrics.excludedVisibleCount >= 0,
      metrics.excludedPhotosWithLocation >= 0,
      metrics.excludedSkippedAssets >= 0,
      !visibleCountOverflow,
      visibleCount == metrics.libraryTotalCount,
      !excludedDetailCountOverflow,
      excludedDetailCount <= metrics.excludedVisibleCount,
      selectedScanImplementation.scanKind != .legacy
        || (metrics.unknownVisibleCount == metrics.libraryTotalCount
          && metrics.excludedVisibleCount == 0
          && metrics.excludedPhotosWithLocation == 0
          && metrics.excludedSkippedAssets == 0)
    else {
      throw ValidationError.invalidMetrics
    }

    return Payload(
      schemaVersion: schemaVersion,
      runId: runID,
      configuredPhotoScanStrategy: environment[PhotoAssetScanStrategy.environmentKey],
      resolvedPhotoScanStrategy: PhotoAssetScanStrategy.resolve(environment: environment).rawValue,
      selectedScanKind: selectedScanImplementation.scanKind.rawValue,
      selectedScanImplementation: selectedScanImplementation.rawValue,
      libraryTotalCount: metrics.libraryTotalCount,
      unknownVisibleCount: metrics.unknownVisibleCount,
      excludedVisibleCount: metrics.excludedVisibleCount,
      excludedPhotosWithLocation: metrics.excludedPhotosWithLocation,
      excludedSkippedAssets: metrics.excludedSkippedAssets,
      observedAtEpochSeconds: observedAtEpochSeconds
    )
  }

  @discardableResult
  static func writeIfRequested(
    selectedScanImplementation: PhotoAssetScanImplementation,
    metrics: Metrics,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    observedAtEpochSeconds: () -> Double = { Date().timeIntervalSince1970 }
  ) throws -> Bool {
    guard
      let runID = environment[validationRunIDEnvironmentKey], !runID.isEmpty,
      let path = environment[validationAttestationPathEnvironmentKey], !path.isEmpty
    else {
      return false
    }

    let payload = try makePayload(
      runID: runID,
      selectedScanImplementation: selectedScanImplementation,
      metrics: metrics,
      environment: environment,
      observedAtEpochSeconds: observedAtEpochSeconds()
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(payload)
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    return true
  }
}
