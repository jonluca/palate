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
    #expect(
      arguments.visionPipelineMaximumInFlight
        == PhotoAssetClassificationPipeline.defaultMaximumInFlight
    )
    #expect(!arguments.visionPipelineFirst)
    #expect(arguments.authorizationTimeoutMilliseconds == 30_000)
    #expect(arguments.initialImageCounts == [9, 24])
    #expect(arguments.initialImagePixelWidth == 384)
    #expect(arguments.initialImagePixelHeight == 480)
    #expect(arguments.initialImageIterations == 4)
    #expect(arguments.initialImageTimeoutMilliseconds == 30_000)
    #expect(arguments.thumbnailScrollVisibleRowCount == 4)
    #expect(arguments.thumbnailScrollAheadRowCount == 3)
    #expect(arguments.thumbnailScrollBehindRowCount == 1)
    #expect(arguments.thumbnailScrollFlingTransitionCount == 4)
    #expect(arguments.thumbnailScrollPixelWidth == 480)
    #expect(arguments.thumbnailScrollPixelHeight == 480)
    #expect(arguments.thumbnailScrollIterations == 4)
    #expect(arguments.thumbnailScrollTimeoutMilliseconds == 30_000)
    #expect(arguments.thumbnailScrollRssSampleIntervalMilliseconds == 5)
    #expect(arguments.previewCardVisibleCount == 4)
    #expect(arguments.previewCardPixelWidth == 1_200)
    #expect(arguments.previewCardPixelHeight == 320)
    #expect(arguments.previewCardIterations == 12)
    #expect(arguments.previewCardTimeoutMilliseconds == 30_000)
    #expect(arguments.previewCardRssSampleIntervalMilliseconds == 5)
  }

  @Test("Preview-card mode and production-shaped card values parse")
  func previewCardValues() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--mode", "preview-cards",
      "--preview-visible-cards", "5",
      "--preview-width", "1500",
      "--preview-height", "360",
      "--preview-iterations", "12",
      "--preview-timeout-ms", "12000",
      "--preview-rss-sample-ms", "10",
    ])

    #expect(arguments.mode == .previewCards)
    #expect(arguments.previewCardVisibleCount == 5)
    #expect(arguments.previewCardPixelWidth == 1_500)
    #expect(arguments.previewCardPixelHeight == 360)
    #expect(arguments.previewCardIterations == 12)
    #expect(arguments.previewCardTimeoutMilliseconds == 12_000)
    #expect(arguments.previewCardRssSampleIntervalMilliseconds == 10)
    #expect(ProfilerArguments.usage.contains("preview-cards"))
  }

  @Test("Thumbnail-scroll mode and production-shaped grid values parse")
  func thumbnailScrollValues() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--mode", "thumbnail-scroll",
      "--scroll-visible-rows", "5",
      "--scroll-ahead-rows", "4",
      "--scroll-behind-rows", "2",
      "--scroll-fling-windows", "6",
      "--scroll-width", "512",
      "--scroll-height", "480",
      "--scroll-iterations", "8",
      "--scroll-timeout-ms", "12000",
      "--scroll-rss-sample-ms", "10",
    ])

    #expect(arguments.mode == .thumbnailScroll)
    #expect(arguments.thumbnailScrollVisibleRowCount == 5)
    #expect(arguments.thumbnailScrollAheadRowCount == 4)
    #expect(arguments.thumbnailScrollBehindRowCount == 2)
    #expect(arguments.thumbnailScrollFlingTransitionCount == 6)
    #expect(arguments.thumbnailScrollPixelWidth == 512)
    #expect(arguments.thumbnailScrollPixelHeight == 480)
    #expect(arguments.thumbnailScrollIterations == 8)
    #expect(arguments.thumbnailScrollTimeoutMilliseconds == 12_000)
    #expect(arguments.thumbnailScrollRssSampleIntervalMilliseconds == 10)
    #expect(ProfilerArguments.usage.contains("thumbnail-scroll"))
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

  @Test("Initial-image preheat mode parses and is documented")
  func initialImagePreheatMode() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--mode", "initial-image-preheat",
    ])

    #expect(arguments.mode == .initialImagePreheat)
    #expect(ProfilerArguments.usage.contains("initial-image-preheat"))
  }

  @Test("Invalid mode error documents every accepted value")
  func invalidModeError() {
    let error = ProfilerArgumentsError.invalidMode("invalid")

    #expect(
      error.errorDescription
        == "Invalid profiler mode: invalid. Expected photos, vision, initial-images, initial-image-preheat, thumbnail-scroll, or preview-cards."
    )
  }

  @Test("Vision-only mode parses")
  func visionMode() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--mode", "vision",
      "--iterations", "8",
      "--vision-sample", "100",
    ])

    #expect(arguments.mode == .vision)
    #expect(arguments.visionSampleCount == 100)
  }

  @Test("Custom values parse and duplicate batch sizes are removed")
  func customValues() throws {
    let arguments = try ProfilerArguments(commandLineArguments: [
      "--batch-sizes", "100,500,100",
      "--iterations", "8",
      "--warmup", "2",
      "--max-assets", "12000",
      "--vision-sample", "8",
      "--vision-concurrency", "3",
      "--vision-pipeline-depth", "8",
      "--vision-pipeline-first",
      "--authorization-timeout-ms", "300000",
    ])

    #expect(arguments.batchSizes == [100, 500])
    #expect(arguments.iterations == 8)
    #expect(arguments.warmupIterations == 2)
    #expect(arguments.maximumAssetCount == 12_000)
    #expect(arguments.visionSampleCount == 8)
    #expect(arguments.visionConcurrency == 3)
    #expect(arguments.visionPipelineMaximumInFlight == 8)
    #expect(arguments.visionPipelineFirst)
    #expect(arguments.authorizationTimeoutMilliseconds == 300_000)
  }

  @Test("Vision measurements require an even iteration count")
  func visionIterationsMustBeEven() throws {
    #expect(throws: ProfilerArgumentsError.visionIterationsMustBeEven) {
      try ProfilerArguments(commandLineArguments: [
        "--iterations", "3",
        "--vision-sample", "8",
      ])
    }

    let metadataOnly = try ProfilerArguments(commandLineArguments: ["--iterations", "3"])
    #expect(metadataOnly.iterations == 3)
    #expect(metadataOnly.visionSampleCount == 0)
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
    #expect(throws: ProfilerArgumentsError.imagePreheatIterationsMustBeMultipleOfFour) {
      try ProfilerArguments(commandLineArguments: [
        "--mode", "initial-image-preheat",
        "--image-iterations", "6",
      ])
    }

    let initialImages = try? ProfilerArguments(commandLineArguments: [
      "--mode", "initial-images",
      "--image-iterations", "6",
    ])
    #expect(initialImages?.initialImageIterations == 6)
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

  @Test("Thumbnail-scroll iterations use complete four-arm blocks")
  func invalidThumbnailScrollIterations() {
    #expect(throws: ProfilerArgumentsError.thumbnailScrollIterationsMustBeMultipleOfFour) {
      try ProfilerArguments(commandLineArguments: ["--scroll-iterations", "6"])
    }
    #expect(
      throws: ProfilerArgumentsError.valueOutOfRange(
        option: "--scroll-visible-rows",
        maximum: 16
      )
    ) {
      try ProfilerArguments(commandLineArguments: ["--scroll-visible-rows", "17"])
    }
  }

  @Test("Preview-card iterations cover full geometry and A/B blocks")
  func invalidPreviewCardIterations() {
    #expect(throws: ProfilerArgumentsError.previewCardIterationsMustBeMultipleOfTwelve) {
      try ProfilerArguments(commandLineArguments: ["--preview-iterations", "4"])
    }
    #expect(
      throws: ProfilerArgumentsError.valueOutOfRange(
        option: "--preview-visible-cards",
        maximum: 32
      )
    ) {
      try ProfilerArguments(commandLineArguments: ["--preview-visible-cards", "33"])
    }
  }

  @Test("Photos authorization timeout is positive and bounded")
  func invalidAuthorizationTimeout() {
    #expect(throws: ProfilerArgumentsError.nonPositiveValue(option: "--authorization-timeout-ms")) {
      try ProfilerArguments(commandLineArguments: ["--authorization-timeout-ms", "0"])
    }
    #expect(
      throws: ProfilerArgumentsError.authorizationTimeoutOutOfRange(
        maximumMilliseconds: 300_000
      )
    ) {
      try ProfilerArguments(commandLineArguments: ["--authorization-timeout-ms", "300001"])
    }
  }
}
