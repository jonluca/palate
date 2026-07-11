import Foundation
@preconcurrency import Photos

struct PhotosProfilerExecutionPlan: Equatable, Sendable {
  let runsMetadata: Bool
  let runsVision: Bool
  let runsInitialImages: Bool
  let runsInitialImagePreheat: Bool
  let runsThumbnailScroll: Bool
  let runsPreviewCards: Bool

  static func make(for mode: ProfilerMode) -> PhotosProfilerExecutionPlan {
    switch mode {
    case .photos:
      PhotosProfilerExecutionPlan(
        runsMetadata: true,
        runsVision: true,
        runsInitialImages: false,
        runsInitialImagePreheat: false,
        runsThumbnailScroll: false,
        runsPreviewCards: false
      )
    case .vision:
      PhotosProfilerExecutionPlan(
        runsMetadata: false,
        runsVision: true,
        runsInitialImages: false,
        runsInitialImagePreheat: false,
        runsThumbnailScroll: false,
        runsPreviewCards: false
      )
    case .initialImages:
      PhotosProfilerExecutionPlan(
        runsMetadata: false,
        runsVision: false,
        runsInitialImages: true,
        runsInitialImagePreheat: false,
        runsThumbnailScroll: false,
        runsPreviewCards: false
      )
    case .initialImagePreheat:
      PhotosProfilerExecutionPlan(
        runsMetadata: false,
        runsVision: false,
        runsInitialImages: false,
        runsInitialImagePreheat: true,
        runsThumbnailScroll: false,
        runsPreviewCards: false
      )
    case .thumbnailScroll:
      PhotosProfilerExecutionPlan(
        runsMetadata: false,
        runsVision: false,
        runsInitialImages: false,
        runsInitialImagePreheat: false,
        runsThumbnailScroll: true,
        runsPreviewCards: false
      )
    case .previewCards:
      PhotosProfilerExecutionPlan(
        runsMetadata: false,
        runsVision: false,
        runsInitialImages: false,
        runsInitialImagePreheat: false,
        runsThumbnailScroll: false,
        runsPreviewCards: true
      )
    }
  }
}

private enum PhotoLibraryVisionAssetSource {
  static func identifiers(maximumCount: Int?) -> [String] {
    let options = PHFetchOptions()
    options.sortDescriptors = [
      NSSortDescriptor(key: #keyPath(PHAsset.creationDate), ascending: false)
    ]
    let assets = PHAsset.fetchAssets(with: .image, options: options)
    let count = min(maximumCount ?? assets.count, assets.count)
    var identifiers: [String] = []
    identifiers.reserveCapacity(count)
    assets.enumerateObjects { asset, index, stop in
      guard index < count else {
        stop.pointee = true
        return
      }
      identifiers.append(asset.localIdentifier)
    }
    return identifiers
  }
}

public struct PhotosProfilerRunner: Sendable {
  private let visionProfiler: any VisionProfiling

  public init(visionProfiler: any VisionProfiling = PhotoLibraryVisionProfiler()) {
    self.visionProfiler = visionProfiler
  }

  public func run(arguments: ProfilerArguments, bundleIdentifier: String) async throws
    -> ProfilerReport
  {
    let authorizationStatus = await PhotoLibraryAuthorization.requestIfNeeded(
      timeoutMilliseconds: arguments.authorizationTimeoutMilliseconds
    )
    let authorizationName = PhotoLibraryAuthorization.name(for: authorizationStatus)
    guard PhotoLibraryAuthorization.permitsReading(authorizationStatus) else {
      throw PhotosProfilerError.photoLibraryAccessUnavailable(status: authorizationName)
    }

    let plan = PhotosProfilerExecutionPlan.make(for: arguments.mode)
    var metadata: MetadataBenchmarkReport?
    var assetIdentifiers: [String]?
    if plan.runsMetadata {
      let metadataRunner = try MetadataBenchmarkRunner()
      let metadataResult = try metadataRunner.run(arguments: arguments)
      metadata = metadataResult.report
      assetIdentifiers = metadataResult.assetIdentifiers
    }

    let vision: ProfilerReport.Vision?
    if plan.runsVision {
      let identifiers =
        assetIdentifiers
        ?? PhotoLibraryVisionAssetSource.identifiers(maximumCount: arguments.maximumAssetCount)
      vision = try await visionProfiler.profile(
        assetIdentifiers: identifiers,
        sampleCount: arguments.visionSampleCount,
        concurrency: arguments.visionConcurrency,
        pipelineMaximumInFlight: arguments.visionPipelineMaximumInFlight,
        pipelineFirst: arguments.visionPipelineFirst,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations
      )
    } else {
      vision = nil
    }

    let initialImages: InitialImageBenchmarkReport?
    if plan.runsInitialImages {
      initialImages = try await InitialImageBenchmarkRunner().run(arguments: arguments)
    } else {
      initialImages = nil
    }

    let initialImagePreheat: InitialImagePreheatBenchmarkReport?
    if plan.runsInitialImagePreheat {
      initialImagePreheat = try await InitialImagePreheatBenchmarkRunner().run(arguments: arguments)
    } else {
      initialImagePreheat = nil
    }

    let thumbnailScroll: ThumbnailScrollBenchmarkReport?
    if plan.runsThumbnailScroll {
      thumbnailScroll = try await ThumbnailScrollBenchmarkRunner().run(arguments: arguments)
    } else {
      thumbnailScroll = nil
    }

    let previewCards: PreviewCardsBenchmarkReport?
    if plan.runsPreviewCards {
      previewCards = try await PreviewCardsBenchmarkRunner().run(arguments: arguments)
    } else {
      previewCards = nil
    }

    return ProfilerReport(
      schemaVersion: 1,
      status: Self.reportStatus(for: vision),
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      authorizationStatus: authorizationName,
      environment: ProfilerReport.Environment(
        bundleIdentifier: bundleIdentifier,
        operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
        architecture: Self.architecture,
        activeProcessorCount: ProcessInfo.processInfo.activeProcessorCount,
        physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory
      ),
      configuration: ProfilerReport.Configuration(
        mode: arguments.mode,
        batchSizes: arguments.batchSizes,
        iterations: arguments.iterations,
        warmupIterations: arguments.warmupIterations,
        maximumAssetCount: arguments.maximumAssetCount,
        visionSampleCount: arguments.visionSampleCount,
        visionConcurrency: arguments.visionConcurrency,
        visionPipelineMaximumInFlight: arguments.visionPipelineMaximumInFlight,
        visionPipelineFirst: arguments.visionPipelineFirst,
        authorizationTimeoutMilliseconds: arguments.authorizationTimeoutMilliseconds
      ),
      metadata: metadata,
      vision: vision,
      initialImages: initialImages,
      initialImagePreheat: initialImagePreheat,
      thumbnailScroll: thumbnailScroll,
      previewCards: previewCards
    )
  }

  static func reportStatus(for vision: ProfilerReport.Vision?) -> String {
    guard let vision else {
      return "ok"
    }
    if vision.validation?.exactOutcomeParity == false {
      return "error"
    }
    switch vision.status {
    case "ok", "disabled":
      return "ok"
    case "partial":
      return "partial"
    default:
      return "error"
    }
  }

  private static var architecture: String {
    #if arch(arm64)
      "arm64"
    #elseif arch(x86_64)
      "x86_64"
    #else
      "unknown"
    #endif
  }
}
