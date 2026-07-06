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

  public let mode: ProfilerMode
  public let batchSizes: [Int]
  public let iterations: Int
  public let warmupIterations: Int
  public let maximumAssetCount: Int?
  public let visionSampleCount: Int
  public let visionConcurrency: Int
  public let initialImageCounts: [Int]
  public let initialImagePixelWidth: Int
  public let initialImagePixelHeight: Int
  public let initialImageIterations: Int
  public let initialImageTimeoutMilliseconds: Int
  public let showHelp: Bool

  public init(
    mode: ProfilerMode = .photos,
    batchSizes: [Int] = Self.defaultBatchSizes,
    iterations: Int = 5,
    warmupIterations: Int = 1,
    maximumAssetCount: Int? = nil,
    visionSampleCount: Int = 0,
    visionConcurrency: Int = PhotoAssetClassifier.recommendedConcurrency,
    initialImageCounts: [Int] = Self.defaultInitialImageCounts,
    initialImagePixelWidth: Int = Self.defaultInitialImagePixelWidth,
    initialImagePixelHeight: Int = Self.defaultInitialImagePixelHeight,
    initialImageIterations: Int = Self.defaultInitialImageIterations,
    initialImageTimeoutMilliseconds: Int = Self.defaultInitialImageTimeoutMilliseconds,
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
    guard visionConcurrency > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--vision-concurrency")
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
    guard initialImageTimeoutMilliseconds > 0 else {
      throw ProfilerArgumentsError.nonPositiveValue(option: "--image-timeout-ms")
    }

    self.mode = mode
    self.batchSizes = Self.uniqued(batchSizes)
    self.iterations = iterations
    self.warmupIterations = warmupIterations
    self.maximumAssetCount = maximumAssetCount
    self.visionSampleCount = visionSampleCount
    self.visionConcurrency = visionConcurrency
    self.initialImageCounts = Self.uniqued(initialImageCounts)
    self.initialImagePixelWidth = initialImagePixelWidth
    self.initialImagePixelHeight = initialImagePixelHeight
    self.initialImageIterations = initialImageIterations
    self.initialImageTimeoutMilliseconds = initialImageTimeoutMilliseconds
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
    var initialImageCounts = Self.defaultInitialImageCounts
    var initialImagePixelWidth = Self.defaultInitialImagePixelWidth
    var initialImagePixelHeight = Self.defaultInitialImagePixelHeight
    var initialImageIterations = Self.defaultInitialImageIterations
    var initialImageTimeoutMilliseconds = Self.defaultInitialImageTimeoutMilliseconds
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
      initialImageCounts: initialImageCounts,
      initialImagePixelWidth: initialImagePixelWidth,
      initialImagePixelHeight: initialImagePixelHeight,
      initialImageIterations: initialImageIterations,
      initialImageTimeoutMilliseconds: initialImageTimeoutMilliseconds,
      showHelp: showHelp
    )
  }

  public static let usage = """
    Usage: PalatePhotosProfiler [options]

      --mode MODE             photos or initial-images (default: photos)
      --batch-sizes N,N,...  Batch/page sizes from 1 through 5000 (default: 2000,500,250)
      --iterations N         Measured iterations per strategy and batch size (default: 5)
      --warmup N             Unmeasured warmup iterations (default: 1)
      --max-assets N         Profile at most the first N assets in the retained snapshot
      --vision-sample N      Classify N assets with the shared Vision core (default: 0)
      --vision-concurrency N Maximum parallel Vision classifications (default: \(PhotoAssetClassifier.recommendedConcurrency))
      --image-counts N,N,... Visible image counts (default: 9,24; maximum: \(maximumInitialImageCount))
      --image-width N        Thumbnail target width in pixels (default: \(defaultInitialImagePixelWidth))
      --image-height N       Thumbnail target height in pixels (default: \(defaultInitialImagePixelHeight))
      --image-iterations N   Even A/B iterations per image count (default: \(defaultInitialImageIterations))
      --image-timeout-ms N   Timeout per strategy measurement (default: \(defaultInitialImageTimeoutMilliseconds))
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
