import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public final class MetadataBenchmarkRunner {
  private let session: PhotoAssetScanSession
  private let sessionSetupMilliseconds: Double

  public init() throws {
    let start = DispatchTime.now().uptimeNanoseconds
    session = try PhotoAssetScanSession()
    sessionSetupMilliseconds = Self.elapsedMilliseconds(since: start)
  }

  public func run(arguments: ProfilerArguments) throws -> (report: MetadataBenchmarkReport, assetIdentifiers: [String]) {
    let profiledAssetCount = min(arguments.maximumAssetCount ?? session.totalCount, session.totalCount)
    let coldBatchSize = arguments.batchSizes[0]
    let coldResult = try measureColdRetained(batchSize: coldBatchSize, assetLimit: profiledAssetCount)
    let canonicalIdentifiers = coldResult.identifiers
    let canonicalDigest = Self.digest(canonicalIdentifiers)
    try validate(
      [coldResult.measurement],
      against: canonicalDigest,
      batchSize: coldBatchSize,
      strategy: "coldRetainedFetchResult"
    )
    let coldRetainedPass = Self.strategy(
      name: "coldRetainedFetchResult",
      batchSize: coldBatchSize,
      measurements: [coldResult.measurement]
    )

    var strategies: [MetadataBenchmarkReport.Strategy] = []
    var validations: [MetadataBenchmarkReport.Validation] = []

    for batchSize in arguments.batchSizes {
      for _ in 0..<arguments.warmupIterations {
        _ = try measureRetained(batchSize: batchSize, assetLimit: profiledAssetCount, iteration: 0)
        _ = measureRefetch(identifiers: canonicalIdentifiers, batchSize: batchSize, iteration: 0)
      }

      let retained = try (1...arguments.iterations).map {
        try measureRetained(batchSize: batchSize, assetLimit: profiledAssetCount, iteration: $0)
      }
      let refetched = (1...arguments.iterations).map {
        measureRefetch(identifiers: canonicalIdentifiers, batchSize: batchSize, iteration: $0)
      }

      try validate(retained, against: canonicalDigest, batchSize: batchSize, strategy: "retainedFetchResult")
      try validate(refetched, against: canonicalDigest, batchSize: batchSize, strategy: "repeatedIdentifierRefetch")

      let retainedStrategy = Self.strategy(
        name: "retainedFetchResult",
        batchSize: batchSize,
        measurements: retained
      )
      let refetchedStrategy = Self.strategy(
        name: "repeatedIdentifierRefetch",
        batchSize: batchSize,
        measurements: refetched
      )
      strategies.append(retainedStrategy)
      strategies.append(refetchedStrategy)

      let retainedDigest = retained[0].identifierDigest
      let refetchedDigest = refetched[0].identifierDigest
      let retainedCount = retained[0].assetCount
      let refetchedCount = refetched[0].assetCount
      validations.append(
        MetadataBenchmarkReport.Validation(
          batchSize: batchSize,
          retainedAssetCount: retainedCount,
          refetchedAssetCount: refetchedCount,
          retainedIdentifierDigest: retainedDigest,
          refetchedIdentifierDigest: refetchedDigest,
          countsMatch: retainedCount == refetchedCount,
          identifierDigestsMatch: retainedDigest == refetchedDigest,
          retainedMedianMilliseconds: retainedStrategy.summary.medianMilliseconds,
          refetchedMedianMilliseconds: refetchedStrategy.summary.medianMilliseconds,
          retainedSpeedupVersusRefetch: Self.speedup(
            baselineMilliseconds: refetchedStrategy.summary.medianMilliseconds,
            candidateMilliseconds: retainedStrategy.summary.medianMilliseconds
          )
        )
      )
    }

    let report = MetadataBenchmarkReport(
      sessionSetupMilliseconds: sessionSetupMilliseconds,
      snapshotAssetCount: session.totalCount,
      profiledAssetCount: profiledAssetCount,
      canonicalIdentifierDigest: canonicalDigest.signature,
      coldRetainedPass: coldRetainedPass,
      strategies: strategies,
      validations: validations
    )
    return (report, canonicalIdentifiers)
  }

  private func measureColdRetained(
    batchSize: Int,
    assetLimit: Int
  ) throws -> (measurement: MetadataBenchmarkReport.Measurement, identifiers: [String]) {
    let start = DispatchTime.now().uptimeNanoseconds
    var identifiers: [String] = []
    identifiers.reserveCapacity(assetLimit)
    var digest = StableIdentifierDigest()
    var offset = 0

    while offset < assetLimit {
      let pageLimit = min(batchSize, assetLimit - offset)
      let page = try session.page(offset: offset, limit: pageLimit)
      guard !page.assets.isEmpty else {
        throw MetadataBenchmarkError.emptyPageBeforeEnd(offset: offset, totalCount: assetLimit)
      }

      for asset in page.assets.prefix(assetLimit - identifiers.count) {
        identifiers.append(asset.id)
        digest.add(asset.id)
      }
      if identifiers.count >= assetLimit {
        break
      }
      offset = try nextOffset(from: page.nextOffset, currentOffset: offset, totalCount: assetLimit)
    }

    return (
      MetadataBenchmarkReport.Measurement(
        iteration: 0,
        elapsedMilliseconds: Self.elapsedMilliseconds(since: start),
        assetCount: digest.count,
        identifierDigest: digest.signature
      ),
      identifiers
    )
  }

  private func measureRetained(
    batchSize: Int,
    assetLimit: Int,
    iteration: Int
  ) throws -> MetadataBenchmarkReport.Measurement {
    let start = DispatchTime.now().uptimeNanoseconds
    var digest = StableIdentifierDigest()
    var offset = 0

    while offset < assetLimit {
      let pageLimit = min(batchSize, assetLimit - offset)
      let page = try session.page(offset: offset, limit: pageLimit)
      guard !page.assets.isEmpty else {
        throw MetadataBenchmarkError.emptyPageBeforeEnd(offset: offset, totalCount: assetLimit)
      }

      for asset in page.assets.prefix(assetLimit - digest.count) {
        digest.add(asset.id)
      }
      if digest.count >= assetLimit {
        break
      }
      offset = try nextOffset(from: page.nextOffset, currentOffset: offset, totalCount: assetLimit)
    }

    return MetadataBenchmarkReport.Measurement(
      iteration: iteration,
      elapsedMilliseconds: Self.elapsedMilliseconds(since: start),
      assetCount: digest.count,
      identifierDigest: digest.signature
    )
  }

  private func measureRefetch(
    identifiers: [String],
    batchSize: Int,
    iteration: Int
  ) -> MetadataBenchmarkReport.Measurement {
    let start = DispatchTime.now().uptimeNanoseconds
    var digest = StableIdentifierDigest()

    for batchStart in stride(from: 0, to: identifiers.count, by: batchSize) {
      let batchEnd = min(batchStart + batchSize, identifiers.count)
      let batch = Array(identifiers[batchStart..<batchEnd])

      autoreleasepool {
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: batch, options: nil)
        fetched.enumerateObjects { asset, _, _ in
          let metadata = PhotoAssetMetadata(asset: asset)
          digest.add(metadata.id)
        }
      }
    }

    return MetadataBenchmarkReport.Measurement(
      iteration: iteration,
      elapsedMilliseconds: Self.elapsedMilliseconds(since: start),
      assetCount: digest.count,
      identifierDigest: digest.signature
    )
  }

  private func nextOffset(from nextOffset: Int?, currentOffset: Int, totalCount: Int) throws -> Int {
    guard let nextOffset else {
      throw MetadataBenchmarkError.missingNextOffset(offset: currentOffset, totalCount: totalCount)
    }
    guard nextOffset > currentOffset else {
      throw MetadataBenchmarkError.nonAdvancingPage(offset: currentOffset, nextOffset: nextOffset)
    }
    return nextOffset
  }

  private func validate(
    _ measurements: [MetadataBenchmarkReport.Measurement],
    against canonicalDigest: StableIdentifierDigest,
    batchSize: Int,
    strategy: String
  ) throws {
    for measurement in measurements {
      guard measurement.assetCount == canonicalDigest.count,
            measurement.identifierDigest == canonicalDigest.signature
      else {
        let actual = "\(measurement.assetCount)/\(measurement.identifierDigest)"
        let expected = "\(canonicalDigest.count)/\(canonicalDigest.signature)"
        throw MetadataBenchmarkError.validationFailed(
          batchSize: batchSize,
          strategy: strategy,
          expected: expected,
          actual: actual
        )
      }
    }
  }

  private static func strategy(
    name: String,
    batchSize: Int,
    measurements: [MetadataBenchmarkReport.Measurement]
  ) -> MetadataBenchmarkReport.Strategy {
    MetadataBenchmarkReport.Strategy(
      name: name,
      batchSize: batchSize,
      measurements: measurements,
      summary: BenchmarkSummary.calculate(
        milliseconds: measurements.map(\.elapsedMilliseconds),
        assetCount: measurements.first?.assetCount ?? 0
      )
    )
  }

  private static func digest(_ identifiers: [String]) -> StableIdentifierDigest {
    var digest = StableIdentifierDigest()
    for identifier in identifiers {
      digest.add(identifier)
    }
    return digest
  }

  private static func elapsedMilliseconds(since start: UInt64) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
  }

  private static func speedup(baselineMilliseconds: Double, candidateMilliseconds: Double) -> Double {
    candidateMilliseconds > 0 ? baselineMilliseconds / candidateMilliseconds : 0
  }
}
