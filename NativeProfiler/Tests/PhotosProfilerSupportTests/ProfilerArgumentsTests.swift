import BatchAssetInfoCore
import Testing

@testable import PhotosProfilerSupport

@Suite("Profiler arguments")
struct ProfilerArgumentsTests {
  @Test("Defaults are stable")
  func defaults() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [])

    #expect(arguments.mode == .photos)
    #expect(arguments.batchSizes == [2_000, 500, 250])
    #expect(arguments.iterations == 5)
    #expect(arguments.warmupIterations == 1)
    #expect(arguments.maximumAssetCount == nil)
    #expect(arguments.visionSampleCount == 0)
    #expect(arguments.visionConcurrency == PhotoAssetClassifier.recommendedConcurrency)
    #expect(arguments.initialImageCounts == [9, 24])
    #expect(arguments.initialImagePixelWidth == 384)
    #expect(arguments.initialImagePixelHeight == 480)
    #expect(arguments.initialImageIterations == 4)
    #expect(arguments.initialImageTimeoutMilliseconds == 30_000)
  }

  @Test("Initial-image mode values parse")
  func initialImageValues() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--mode", "initial-images",
      "--image-counts", "24,9,24",
      "--image-width", "360",
      "--image-height", "480",
      "--image-iterations", "6",
      "--image-timeout-ms", "12000",
    ])

    #expect(arguments.mode == .initialImages)
    #expect(arguments.initialImageCounts == [24, 9])
    #expect(arguments.initialImagePixelWidth == 360)
    #expect(arguments.initialImagePixelHeight == 480)
    #expect(arguments.initialImageIterations == 6)
    #expect(arguments.initialImageTimeoutMilliseconds == 12_000)
  }

  @Test("Custom values parse and duplicate batch sizes are removed")
  func customValues() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--batch-sizes", "100,500,100",
      "--iterations", "7",
      "--warmup", "2",
      "--max-assets", "12000",
      "--vision-sample", "8",
      "--vision-concurrency", "3",
    ])

    #expect(arguments.batchSizes == [100, 500])
    #expect(arguments.iterations == 7)
    #expect(arguments.warmupIterations == 2)
    #expect(arguments.maximumAssetCount == 12_000)
    #expect(arguments.visionSampleCount == 8)
    #expect(arguments.visionConcurrency == 3)
  }

  @Test("Invalid batch sizes fail before touching Photos")
  func invalidBatchSizes() {
    #expect(throws: ProfilerArgumentsError.batchSizeOutOfRange(maximum: 5_000)) {
      try ProfilerArguments(commandLineArguments: ["--batch-sizes", "5001"])
    }
  }

  @Test("Initial-image iterations must be counterbalanced")
  func invalidInitialImageIterations() {
    #expect(throws: ProfilerArgumentsError.imageIterationsMustBeEven) {
      try ProfilerArguments(commandLineArguments: ["--image-iterations", "3"])
    }
  }

  @Test("Initial-image dimensions are bounded")
  func invalidInitialImageDimensions() {
    #expect(
      throws: ProfilerArgumentsError.imageDimensionOutOfRange(
        maximum: PhotoAssetThumbnailTarget.maximumDimension
      )
    ) {
      try ProfilerArguments(commandLineArguments: ["--image-width", "0"])
    }
  }
}
