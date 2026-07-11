import BatchAssetInfoCore
import Foundation

public struct ProfilerArguments: Equatable, Sendable {
  public static let maximumBatchSize = PhotoAssetScanSession.maximumPageSize
  public static let defaultBatchSizes = [2_000, 500, 250]
  public static let maximumInitialImageCount = 500
  public static let defaultInitialImageCounts = [9, 24]
  public static let defaultInitialImagePixelWidth = 384
  public static let defaultInitialImagePixelHeight = 480
  public static let defaultInitialImageIterations = 4
  public static let defaultInitialImageTimeoutMilliseconds = 30_000
  public static let defaultThumbnailScrollVisibleRowCount = 4
  public static let defaultThumbnailScrollAheadRowCount = 3
  public static let defaultThumbnailScrollBehindRowCount = 1
  public static let defaultThumbnailScrollFlingTransitionCount = 4
  public static let defaultThumbnailScrollPixelWidth = 480
  public static let defaultThumbnailScrollPixelHeight = 480
  public static let defaultThumbnailScrollIterations = 4
  public static let defaultThumbnailScrollTimeoutMilliseconds = 30_000
  public static let defaultThumbnailScrollRssSampleIntervalMilliseconds = 5
  public static let maximumThumbnailScrollRowCount = 16
  public static let maximumThumbnailScrollFlingTransitionCount = 8
  public static let maximumThumbnailScrollRssSampleIntervalMilliseconds = 1_000
  public static let defaultPreviewCardVisibleCount = 4
  public static let defaultPreviewCardPixelWidth = 1_200
  public static let defaultPreviewCardPixelHeight = 320
  public static let defaultPreviewCardIterations = 12
  public static let defaultPreviewCardTimeoutMilliseconds = 30_000
  public static let defaultPreviewCardRssSampleIntervalMilliseconds = 5
  public static let maximumPreviewCardVisibleCount = 32
  public static let maximumPreviewCardRssSampleIntervalMilliseconds = 1_000
  public static let defaultAuthorizationTimeoutMilliseconds = 30_000
  public static let maximumAuthorizationTimeoutMilliseconds = 300_000

  public let mode: ProfilerMode
  public let batchSizes: [Int]
  public let iterations: Int
  public let warmupIterations: Int
  public let maximumAssetCount: Int?
  public let visionSampleCount: Int
  public let visionConcurrency: Int
  public let visionPipelineMaximumInFlight: Int
  public let visionPipelineFirst: Bool
  public let authorizationTimeoutMilliseconds: Int
  public let initialImageCounts: [Int]
  public let initialImagePixelWidth: Int
  public let initialImagePixelHeight: Int
  public let initialImageIterations: Int
  public let initialImageTimeoutMilliseconds: Int
  public let thumbnailScrollVisibleRowCount: Int
  public let thumbnailScrollAheadRowCount: Int
  public let thumbnailScrollBehindRowCount: Int
  public let thumbnailScrollFlingTransitionCount: Int
  public let thumbnailScrollPixelWidth: Int
  public let thumbnailScrollPixelHeight: Int
  public let thumbnailScrollIterations: Int
  public let thumbnailScrollTimeoutMilliseconds: Int
  public let thumbnailScrollRssSampleIntervalMilliseconds: Int
  public let previewCardVisibleCount: Int
  public let previewCardPixelWidth: Int
  public let previewCardPixelHeight: Int
  public let previewCardIterations: Int
  public let previewCardTimeoutMilliseconds: Int
  public let previewCardRssSampleIntervalMilliseconds: Int
  public let showHelp: Bool

  public init(
    mode: ProfilerMode = .photos,
    batchSizes: [Int] = Self.defaultBatchSizes,
    iterations: Int = 5,
    warmupIterations: Int = 1,
    maximumAssetCount: Int? = nil,
    visionSampleCount: Int = 0,
    visionConcurrency: Int = PhotoAssetClassifier.recommendedConcurrency,
    visionPipelineMaximumInFlight: Int = PhotoAssetClassificationPipeline.defaultMaximumInFlight,
    visionPipelineFirst: Bool = false,
    authorizationTimeoutMilliseconds: Int = Self.defaultAuthorizationTimeoutMilliseconds,
    initialImageCounts: [Int] = Self.defaultInitialImageCounts,
    initialImagePixelWidth: Int = Self.defaultInitialImagePixelWidth,
    initialImagePixelHeight: Int = Self.defaultInitialImagePixelHeight,
    initialImageIterations: Int = Self.defaultInitialImageIterations,
    initialImageTimeoutMilliseconds: Int = Self.defaultInitialImageTimeoutMilliseconds,
    thumbnailScrollVisibleRowCount: Int = Self.defaultThumbnailScrollVisibleRowCount,
    thumbnailScrollAheadRowCount: Int = Self.defaultThumbnailScrollAheadRowCount,
    thumbnailScrollBehindRowCount: Int = Self.defaultThumbnailScrollBehindRowCount,
    thumbnailScrollFlingTransitionCount: Int = Self.defaultThumbnailScrollFlingTransitionCount,
    thumbnailScrollPixelWidth: Int = Self.defaultThumbnailScrollPixelWidth,
    thumbnailScrollPixelHeight: Int = Self.defaultThumbnailScrollPixelHeight,
    thumbnailScrollIterations: Int = Self.defaultThumbnailScrollIterations,
    thumbnailScrollTimeoutMilliseconds: Int = Self.defaultThumbnailScrollTimeoutMilliseconds,
    thumbnailScrollRssSampleIntervalMilliseconds: Int = Self
      .defaultThumbnailScrollRssSampleIntervalMilliseconds,
    previewCardVisibleCount: Int = Self.defaultPreviewCardVisibleCount,
    previewCardPixelWidth: Int = Self.defaultPreviewCardPixelWidth,
    previewCardPixelHeight: Int = Self.defaultPreviewCardPixelHeight,
    previewCardIterations: Int = Self.defaultPreviewCardIterations,
    previewCardTimeoutMilliseconds: Int = Self.defaultPreviewCardTimeoutMilliseconds,
    previewCardRssSampleIntervalMilliseconds: Int = Self
      .defaultPreviewCardRssSampleIntervalMilliseconds,
    showHelp: Bool = false
  ) throws {
    guard !batchSizes.isEmpty else {
      throw ProfilerArgumentsError.emptyBatchSizes
    }
    guard batchSizes.allSatisfy({ (1...Self.maximumBatchSize).contains($0) }) else {
      throw ProfilerArgumentsError.batchSizeOutOfRange(maximum: Self.maximumBatchSize)
    }
    guard iterations > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--iterations")
    }
    guard warmupIterations >= 0 else {
      throw ProfilerArgumentsError.negativeValue(option: "--warmup")
    }
    if let maximumAssetCount, maximumAssetCount <= 0 {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--max-assets")
    }
    guard visionSampleCount >= 0 else {
      throw ProfilerArgumentsError.negativeValue(option: "--vision-sample")
    }
    guard visionSampleCount == 0 || iterations.isMultiple(of: 2) else {
      throw ProfilerArgumentsError.visionIterationsMustBeEven
    }
    guard visionConcurrency > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--vision-concurrency")
    }
    guard visionPipelineMaximumInFlight > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--vision-pipeline-depth")
    }
    guard authorizationTimeoutMilliseconds > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--authorization-timeout-ms")
    }
    guard authorizationTimeoutMilliseconds <= Self.maximumAuthorizationTimeoutMilliseconds else {
      throw ProfilerArgumentsError.authorizationTimeoutOutOfRange(
        maximumMilliseconds: Self.maximumAuthorizationTimeoutMilliseconds
      )
    }
    guard !initialImageCounts.isEmpty else {
      throw ProfilerArgumentsError.emptyImageCounts
    }
    guard initialImageCounts.allSatisfy({ (1...Self.maximumInitialImageCount).contains($0) }) else {
      throw ProfilerArgumentsError.imageCountOutOfRange(maximum: Self.maximumInitialImageCount)
    }
    guard (1...PhotoAssetThumbnailTarget.maximumDimension).contains(initialImagePixelWidth),
      (1...PhotoAssetThumbnailTarget.maximumDimension).contains(initialImagePixelHeight)
    else {
      throw ProfilerArgumentsError.imageDimensionOutOfRange(
        maximum: PhotoAssetThumbnailTarget.maximumDimension)
    }
    guard initialImageIterations > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--image-iterations")
    }
    guard initialImageIterations.isMultiple(of: 2) else {
      throw ProfilerArgumentsError.imageIterationsMustBeEven
    }
    guard mode != .initialImagePreheat || initialImageIterations.isMultiple(of: 4) else {
      throw ProfilerArgumentsError.imagePreheatIterationsMustBeMultipleOfFour
    }
    guard initialImageTimeoutMilliseconds > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--image-timeout-ms")
    }
    for (option, value) in [
      ("--scroll-visible-rows", thumbnailScrollVisibleRowCount),
      ("--scroll-ahead-rows", thumbnailScrollAheadRowCount),
      ("--scroll-behind-rows", thumbnailScrollBehindRowCount),
    ] {
      guard (1...Self.maximumThumbnailScrollRowCount).contains(value) else {
        throw ProfilerArgumentsError.valueOutOfRange(
          option: option,
          maximum: Self.maximumThumbnailScrollRowCount
        )
      }
    }
    guard
      (1...Self.maximumThumbnailScrollFlingTransitionCount).contains(
        thumbnailScrollFlingTransitionCount)
    else {
      throw ProfilerArgumentsError.valueOutOfRange(
        option: "--scroll-fling-windows",
        maximum: Self.maximumThumbnailScrollFlingTransitionCount
      )
    }
    guard (1...PhotoAssetThumbnailTarget.maximumDimension).contains(thumbnailScrollPixelWidth),
      (1...PhotoAssetThumbnailTarget.maximumDimension).contains(thumbnailScrollPixelHeight)
    else {
      throw ProfilerArgumentsError.imageDimensionOutOfRange(
        maximum: PhotoAssetThumbnailTarget.maximumDimension
      )
    }
    guard thumbnailScrollIterations > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--scroll-iterations")
    }
    guard thumbnailScrollIterations.isMultiple(of: 4) else {
      throw ProfilerArgumentsError.thumbnailScrollIterationsMustBeMultipleOfFour
    }
    guard thumbnailScrollTimeoutMilliseconds > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--scroll-timeout-ms")
    }
    guard
      (1...Self.maximumThumbnailScrollRssSampleIntervalMilliseconds).contains(
        thumbnailScrollRssSampleIntervalMilliseconds)
    else {
      throw ProfilerArgumentsError.valueOutOfRange(
        option: "--scroll-rss-sample-ms",
        maximum: Self.maximumThumbnailScrollRssSampleIntervalMilliseconds
      )
    }
    guard (1...Self.maximumPreviewCardVisibleCount).contains(previewCardVisibleCount) else {
      throw ProfilerArgumentsError.valueOutOfRange(
        option: "--preview-visible-cards",
        maximum: Self.maximumPreviewCardVisibleCount
      )
    }
    guard (1...PhotoAssetThumbnailTarget.maximumDimension).contains(previewCardPixelWidth),
      (1...PhotoAssetThumbnailTarget.maximumDimension).contains(previewCardPixelHeight)
    else {
      throw ProfilerArgumentsError.imageDimensionOutOfRange(
        maximum: PhotoAssetThumbnailTarget.maximumDimension
      )
    }
    guard
      previewCardPixelWidth <= PhotoAssetThumbnailTarget.maximumPixelCount
        / previewCardPixelHeight
    else {
      throw ProfilerArgumentsError.imageDimensionOutOfRange(
        maximum: PhotoAssetThumbnailTarget.maximumDimension
      )
    }
    guard previewCardIterations > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--preview-iterations")
    }
    guard previewCardIterations.isMultiple(of: 12) else {
      throw ProfilerArgumentsError.previewCardIterationsMustBeMultipleOfTwelve
    }
    guard previewCardTimeoutMilliseconds > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--preview-timeout-ms")
    }
    guard
      (1...Self.maximumPreviewCardRssSampleIntervalMilliseconds).contains(
        previewCardRssSampleIntervalMilliseconds)
    else {
      throw ProfilerArgumentsError.valueOutOfRange(
        option: "--preview-rss-sample-ms",
        maximum: Self.maximumPreviewCardRssSampleIntervalMilliseconds
      )
    }

    self.mode = mode
    self.batchSizes = Self.uniqued(batchSizes)
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.maximumAssetCount = maximumAssetCount
    self.visionSampleCount = visionSampleCount
    self.visionConcurrency = visionConcurrency
    self.visionPipelineMaximumInFlight = visionPipelineMaximumInFlight
    self.visionPipelineFirst = visionPipelineFirst
    self.authorizationTimeoutMilliseconds = authorizationTimeoutMilliseconds
    self.initialImageCounts = Self.uniqued(initialImageCounts)
    self.initialImagePixelWidth = initialImagePixelWidth
    self.initialImagePixelHeight = initialImagePixelHeight
    self.initialImageIterations = initialImageIterations
    self.initialImageTimeoutMilliseconds = initialImageTimeoutMilliseconds
    self.thumbnailScrollVisibleRowCount = thumbnailScrollVisibleRowCount
    self.thumbnailScrollAheadRowCount = thumbnailScrollAheadRowCount
    self.thumbnailScrollBehindRowCount = thumbnailScrollBehindRowCount
    self.thumbnailScrollFlingTransitionCount = thumbnailScrollFlingTransitionCount
    self.thumbnailScrollPixelWidth = thumbnailScrollPixelWidth
    self.thumbnailScrollPixelHeight = thumbnailScrollPixelHeight
    self.thumbnailScrollIterations = thumbnailScrollIterations
    self.thumbnailScrollTimeoutMilliseconds = thumbnailScrollTimeoutMilliseconds
    self.thumbnailScrollRssSampleIntervalMilliseconds =
      thumbnailScrollRssSampleIntervalMilliseconds
    self.previewCardVisibleCount = previewCardVisibleCount
    self.previewCardPixelWidth = previewCardPixelWidth
    self.previewCardPixelHeight = previewCardPixelHeight
    self.previewCardIterations = previewCardIterations
    self.previewCardTimeoutMilliseconds = previewCardTimeoutMilliseconds
    self.previewCardRssSampleIntervalMilliseconds = previewCardRssSampleIntervalMilliseconds
    self.showHelp = showHelp
  }

  public init(commandLineArguments: [String]) throws {
    var mode = ProfilerMode.photos
    var batchSizes = Self.defaultBatchSizes
    var iterations = 5
    var warmupIterations = 1
    var maximumAssetCount: Int?
    var visionSampleCount = 0
    var visionConcurrency = PhotoAssetClassifier.recommendedConcurrency
    var visionPipelineMaximumInFlight = PhotoAssetClassificationPipeline.defaultMaximumInFlight
    var visionPipelineFirst = false
    var authorizationTimeoutMilliseconds = Self.defaultAuthorizationTimeoutMilliseconds
    var initialImageCounts = Self.defaultInitialImageCounts
    var initialImagePixelWidth = Self.defaultInitialImagePixelWidth
    var initialImagePixelHeight = Self.defaultInitialImagePixelHeight
    var initialImageIterations = Self.defaultInitialImageIterations
    var initialImageTimeoutMilliseconds = Self.defaultInitialImageTimeoutMilliseconds
    var thumbnailScrollVisibleRowCount = Self.defaultThumbnailScrollVisibleRowCount
    var thumbnailScrollAheadRowCount = Self.defaultThumbnailScrollAheadRowCount
    var thumbnailScrollBehindRowCount = Self.defaultThumbnailScrollBehindRowCount
    var thumbnailScrollFlingTransitionCount = Self.defaultThumbnailScrollFlingTransitionCount
    var thumbnailScrollPixelWidth = Self.defaultThumbnailScrollPixelWidth
    var thumbnailScrollPixelHeight = Self.defaultThumbnailScrollPixelHeight
    var thumbnailScrollIterations = Self.defaultThumbnailScrollIterations
    var thumbnailScrollTimeoutMilliseconds = Self.defaultThumbnailScrollTimeoutMilliseconds
    var thumbnailScrollRssSampleIntervalMilliseconds =
      Self.defaultThumbnailScrollRssSampleIntervalMilliseconds
    var previewCardVisibleCount = Self.defaultPreviewCardVisibleCount
    var previewCardPixelWidth = Self.defaultPreviewCardPixelWidth
    var previewCardPixelHeight = Self.defaultPreviewCardPixelHeight
    var previewCardIterations = Self.defaultPreviewCardIterations
    var previewCardTimeoutMilliseconds = Self.defaultPreviewCardTimeoutMilliseconds
    var previewCardRssSampleIntervalMilliseconds =
      Self.defaultPreviewCardRssSampleIntervalMilliseconds
    var showHelp = false

    var index = 0
    while index < commandLineArguments.count {
      let option = commandLineArguments[index]
      switch option {
      case "--mode":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        guard let parsedMode = ProfilerMode(rawValue: value) else {
          throw ProfilerArgumentsError.invalidMode(value)
        }
        mode = parsedMode
      case "--batch-sizes":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        batchSizes = try Self.parseBatchSizes(value)
      case "--iterations":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        iterations = try Self.parseInteger(value, option: option)
      case "--warmup":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        warmupIterations = try Self.parseInteger(value, option: option)
      case "--max-assets":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        maximumAssetCount = try Self.parseInteger(value, option: option)
      case "--vision-sample":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        visionSampleCount = try Self.parseInteger(value, option: option)
      case "--vision-concurrency":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        visionConcurrency = try Self.parseInteger(value, option: option)
      case "--vision-pipeline-depth":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        visionPipelineMaximumInFlight = try Self.parseInteger(value, option: option)
      case "--vision-pipeline-first":
        visionPipelineFirst = true
      case "--authorization-timeout-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        authorizationTimeoutMilliseconds = try Self.parseInteger(value, option: option)
      case "--image-counts":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        initialImageCounts = try Self.parseImageCounts(value)
      case "--image-width":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        initialImagePixelWidth = try Self.parseInteger(value, option: option)
      case "--image-height":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        initialImagePixelHeight = try Self.parseInteger(value, option: option)
      case "--image-iterations":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        initialImageIterations = try Self.parseInteger(value, option: option)
      case "--image-timeout-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        initialImageTimeoutMilliseconds = try Self.parseInteger(value, option: option)
      case "--scroll-visible-rows":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollVisibleRowCount = try Self.parseInteger(value, option: option)
      case "--scroll-ahead-rows":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollAheadRowCount = try Self.parseInteger(value, option: option)
      case "--scroll-behind-rows":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollBehindRowCount = try Self.parseInteger(value, option: option)
      case "--scroll-fling-windows":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollFlingTransitionCount = try Self.parseInteger(value, option: option)
      case "--scroll-width":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollPixelWidth = try Self.parseInteger(value, option: option)
      case "--scroll-height":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollPixelHeight = try Self.parseInteger(value, option: option)
      case "--scroll-iterations":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollIterations = try Self.parseInteger(value, option: option)
      case "--scroll-timeout-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollTimeoutMilliseconds = try Self.parseInteger(value, option: option)
      case "--scroll-rss-sample-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        thumbnailScrollRssSampleIntervalMilliseconds = try Self.parseInteger(
          value,
          option: option
        )
      case "--preview-visible-cards":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardVisibleCount = try Self.parseInteger(value, option: option)
      case "--preview-width":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardPixelWidth = try Self.parseInteger(value, option: option)
      case "--preview-height":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardPixelHeight = try Self.parseInteger(value, option: option)
      case "--preview-iterations":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardIterations = try Self.parseInteger(value, option: option)
      case "--preview-timeout-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardTimeoutMilliseconds = try Self.parseInteger(value, option: option)
      case "--preview-rss-sample-ms":
        let value = try Self.value(after: option, at: &index, in: commandLineArguments)
        previewCardRssSampleIntervalMilliseconds = try Self.parseInteger(value, option: option)
      case "--help", "-h":
        showHelp = true
      default:
        throw ProfilerArgumentsError.unknownOption(option)
      }
      index += 1
    }

    try self.init(
      mode: mode,
      batchSizes: batchSizes,
      iterations: iterations,
      warmupIterations: warmupIterations,
      maximumAssetCount: maximumAssetCount,
      visionSampleCount: visionSampleCount,
      visionConcurrency: visionConcurrency,
      visionPipelineMaximumInFlight: visionPipelineMaximumInFlight,
      visionPipelineFirst: visionPipelineFirst,
      authorizationTimeoutMilliseconds: authorizationTimeoutMilliseconds,
      initialImageCounts: initialImageCounts,
      initialImagePixelWidth: initialImagePixelWidth,
      initialImagePixelHeight: initialImagePixelHeight,
      initialImageIterations: initialImageIterations,
      initialImageTimeoutMilliseconds: initialImageTimeoutMilliseconds,
      thumbnailScrollVisibleRowCount: thumbnailScrollVisibleRowCount,
      thumbnailScrollAheadRowCount: thumbnailScrollAheadRowCount,
      thumbnailScrollBehindRowCount: thumbnailScrollBehindRowCount,
      thumbnailScrollFlingTransitionCount: thumbnailScrollFlingTransitionCount,
      thumbnailScrollPixelWidth: thumbnailScrollPixelWidth,
      thumbnailScrollPixelHeight: thumbnailScrollPixelHeight,
      thumbnailScrollIterations: thumbnailScrollIterations,
      thumbnailScrollTimeoutMilliseconds: thumbnailScrollTimeoutMilliseconds,
      thumbnailScrollRssSampleIntervalMilliseconds: thumbnailScrollRssSampleIntervalMilliseconds,
      previewCardVisibleCount: previewCardVisibleCount,
      previewCardPixelWidth: previewCardPixelWidth,
      previewCardPixelHeight: previewCardPixelHeight,
      previewCardIterations: previewCardIterations,
      previewCardTimeoutMilliseconds: previewCardTimeoutMilliseconds,
      previewCardRssSampleIntervalMilliseconds: previewCardRssSampleIntervalMilliseconds,
      showHelp: showHelp
    )
  }

  public static let usage = """
    Usage: PalatePhotosProfiler [options]

      --mode MODE             photos, vision, initial-images, initial-image-preheat, thumbnail-scroll, or preview-cards (default: photos)
      --batch-sizes N,N,...  Batch/page sizes from 1 through 5000 (default: 2000,500,250)
      --iterations N         Measured iterations per strategy and batch size; Vision requires an even value (default: 5)
      --warmup N             Unmeasured warmup iterations (default: 1)
      --max-assets N         Profile at most the first N assets in the retained snapshot
      --vision-sample N      Classify N assets with the shared Vision core (default: 0)
      --vision-concurrency N Maximum parallel Vision classifications (default: \(PhotoAssetClassifier.recommendedConcurrency))
      --vision-pipeline-depth N Maximum acquired/processing pipeline assets (default: \(PhotoAssetClassificationPipeline.defaultMaximumInFlight))
      --vision-pipeline-first Run the pipelined strategy before the synchronous baseline
      --authorization-timeout-ms N Wait 1...\(maximumAuthorizationTimeoutMilliseconds) ms for the Photos permission decision (default: \(defaultAuthorizationTimeoutMilliseconds))
      --image-counts N,N,... Visible image counts (default: 9,24; maximum: \(maximumInitialImageCount))
      --image-width N        Thumbnail target width in pixels (default: \(defaultInitialImagePixelWidth))
      --image-height N       Thumbnail target height in pixels (default: \(defaultInitialImagePixelHeight))
      --image-iterations N   Even A/B iterations; preheat mode requires a multiple of four (default: \(defaultInitialImageIterations))
      --image-timeout-ms N   Timeout per strategy measurement (default: \(defaultInitialImageTimeoutMilliseconds))
      --scroll-visible-rows N Fully or partially visible 3-column rows (default: \(defaultThumbnailScrollVisibleRowCount))
      --scroll-ahead-rows N  Rows ahead in candidate windows (default: \(defaultThumbnailScrollAheadRowCount))
      --scroll-behind-rows N Rows behind in candidate windows (default: \(defaultThumbnailScrollBehindRowCount))
      --scroll-fling-windows N Forward window transitions per burst (default: \(defaultThumbnailScrollFlingTransitionCount))
      --scroll-width N       Grid thumbnail target width in pixels (default: \(defaultThumbnailScrollPixelWidth))
      --scroll-height N      Grid thumbnail target height in pixels (default: \(defaultThumbnailScrollPixelHeight))
      --scroll-iterations N  Multiple-of-four four-arm iterations (default: \(defaultThumbnailScrollIterations))
      --scroll-timeout-ms N  Timeout per visible window (default: \(defaultThumbnailScrollTimeoutMilliseconds))
      --scroll-rss-sample-ms N Sampled resident-memory interval (default: \(defaultThumbnailScrollRssSampleIntervalMilliseconds))
      --preview-visible-cards N Visible card strips (default: \(defaultPreviewCardVisibleCount))
      --preview-width N      Total card width in pixels (default: \(defaultPreviewCardPixelWidth))
      --preview-height N     Card height in pixels (default: \(defaultPreviewCardPixelHeight))
      --preview-iterations N Multiple-of-twelve A/B iterations (default: \(defaultPreviewCardIterations))
      --preview-timeout-ms N Timeout per card strip (default: \(defaultPreviewCardTimeoutMilliseconds))
      --preview-rss-sample-ms N Sampled resident-memory interval (default: \(defaultPreviewCardRssSampleIntervalMilliseconds))
      --help, -h             Print this help
    """

  private static func value(after option: String, at index: inout Int, in arguments: [String])
    throws -> String
  {
    let valueIndex = index + 1
    guard valueIndex < arguments.count else {
      throw ProfilerArgumentsError.missingValue(option: option)
    }
    index = valueIndex
    return arguments[valueIndex]
  }

  private static func parseInteger(_ value: String, option: String) throws -> Int {
    guard let parsed = Int(value) else {
      throw ProfilerArgumentsError.invalidInteger(option: option, value: value)
    }
    return parsed
  }

  private static func parseBatchSizes(_ value: String) throws -> [Int] {
    let components = value.split(separator: ",", omittingEmptySubsequences: false)
    guard !components.isEmpty else {
      throw ProfilerArgumentsError.emptyBatchSizes
    }

    return try components.map { component in
      let string = String(component)
      guard !string.isEmpty, let size = Int(string) else {
        throw ProfilerArgumentsError.invalidBatchSizes(value)
      }
      return size
    }
  }

  private static func parseImageCounts(_ value: String) throws -> [Int] {
    let components = value.split(separator: ",", omittingEmptySubsequences: false)
    guard !components.isEmpty else {
      throw ProfilerArgumentsError.emptyImageCounts
    }

    return try components.map { component in
      let string = String(component)
      guard !string.isEmpty, let count = Int(string) else {
        throw ProfilerArgumentsError.invalidImageCounts(value)
      }
      return count
    }
  }

  private static func uniqued(_ values: [Int]) -> [Int] {
    var seen = Set<Int>()
    return values.filter { seen.insert($0).inserted }
  }
}
