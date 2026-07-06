import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

public struct PhotoLibraryVisionProfiler: VisionProfiling {
  public init() {}

  public func profile(
    assetIdentifiers: [String],
    sampleCount: Int,
    concurrency: Int
  ) async throws -> ProfilerReport.Vision {
    guard sampleCount > 0 else {
      return ProfilerReport.Vision(
        status: "disabled",
        requestedSampleCount: 0,
        processedSampleCount: 0,
        failureCount: 0,
        totalLabelCount: 0,
        concurrency: concurrency,
        elapsedMilliseconds: nil,
        assetsPerSecond: nil,
        details: "Pass --vision-sample N to profile the shared PhotoKit/Vision classifier"
      )
    }

    let identifiers = Array(assetIdentifiers.prefix(sampleCount))
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
    var assets: [PHAsset] = []
    assets.reserveCapacity(fetchResult.count)
    fetchResult.enumerateObjects { asset, _, _ in
      assets.append(asset)
    }

    let options = try PhotoAssetClassificationOptions(
      confidenceThreshold: 0.1,
      maximumLabelCount: 50
    )
    let classifier = PhotoAssetClassifier()
    let accumulator = VisionProfileAccumulator()
    let queue = OperationQueue()
    queue.name = "com.jonluca.palate.photos-profiler.vision"
    queue.qualityOfService = .userInitiated
    queue.maxConcurrentOperationCount = concurrency

    let start = DispatchTime.now().uptimeNanoseconds
    for asset in assets {
      queue.addOperation {
        let result = autoreleasepool {
          classifier.classify(asset: asset, options: options)
        }
        accumulator.record(result)
      }
    }
    await withCheckedContinuation { continuation in
      queue.addBarrierBlock {
        continuation.resume()
      }
    }
    let elapsedMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000

    let snapshot = accumulator.snapshot()
    let missingAssets = max(0, identifiers.count - assets.count)
    let failureCount = snapshot.failedClassifications + missingAssets
    let processedCount = snapshot.successfulClassifications + snapshot.failedClassifications
    let assetsPerSecond = elapsedMilliseconds > 0
      ? Double(processedCount) / (elapsedMilliseconds / 1_000)
      : 0
    let details = snapshot.sampledErrorDescriptions.isEmpty
      ? nil
      : snapshot.sampledErrorDescriptions.joined(separator: " | ")

    return ProfilerReport.Vision(
      status: failureCount == 0 ? "ok" : "partial",
      requestedSampleCount: identifiers.count,
      processedSampleCount: processedCount,
      failureCount: failureCount,
      totalLabelCount: snapshot.totalLabels,
      concurrency: concurrency,
      elapsedMilliseconds: elapsedMilliseconds,
      assetsPerSecond: assetsPerSecond,
      details: details
    )
  }
}
