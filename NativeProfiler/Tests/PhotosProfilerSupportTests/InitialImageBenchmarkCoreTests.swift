import Testing

@testable import PhotosProfilerSupport

@Suite("Initial-image benchmark core")
struct InitialImageBenchmarkCoreTests {
  @Test("Accumulator records degraded, final, failure, dimensions, and latency")
  func accumulatorMetrics() {
    var accumulator = InitialImageMeasurementAccumulator(
      requestedIdentifiers: ["a", "b", "c"],
      displayDegradedImages: true
    )

    accumulator.record(
      .image(identifier: "a", pixelWidth: 100, pixelHeight: 80, isDegraded: true),
      elapsedMilliseconds: 1
    )
    accumulator.record(
      .image(identifier: "a", pixelWidth: 300, pixelHeight: 240, isDegraded: false),
      elapsedMilliseconds: 5
    )
    accumulator.record(
      .image(identifier: "b", pixelWidth: 400, pixelHeight: 320, isDegraded: false),
      elapsedMilliseconds: 9
    )
    accumulator.record(
      .failure(identifier: "c", code: "IMAGE_UNAVAILABLE"),
      elapsedMilliseconds: 10
    )

    #expect(accumulator.isTerminal)
    let measurement = accumulator.makeMeasurement(
      strategy: .batchedThumbnailStore,
      imageCount: 3,
      iteration: 1,
      samplePosition: .earlier,
      allTerminalMilliseconds: 10
    )
    #expect(measurement.renderableCount == 2)
    #expect(measurement.degradedAssetCount == 1)
    #expect(measurement.degradedEventCount == 1)
    #expect(measurement.finalCount == 2)
    #expect(measurement.failureCount == 1)
    #expect(measurement.firstRenderableMilliseconds == 1)
    #expect(measurement.firstDegradedMilliseconds == 1)
    #expect(measurement.firstFinalMilliseconds == 5)
    #expect(measurement.allVisibleFinalMilliseconds == nil)
    #expect(measurement.finalLatency?.p50Milliseconds == 7)
    #expect(measurement.finalLatency?.p95Milliseconds == 9)
    #expect(measurement.finalLatency?.maximumMilliseconds == 9)
    #expect(measurement.finalDimensions?.minimumPixelWidth == 300)
    #expect(measurement.finalDimensions?.maximumPixelHeight == 320)
    #expect(measurement.finalDimensions?.totalDecodedPixels == 200_000)
    #expect(measurement.failureCodeCounts == ["IMAGE_UNAVAILABLE": 1])
    #expect(measurement.unexpectedEventCount == 0)
    #expect(measurement.duplicateTerminalEventCount == 0)
    #expect(measurement.invalidDimensionCount == 0)
  }

  @Test("Baseline degraded callbacks are not counted as renderable")
  func baselineIgnoresDegradedForDisplay() {
    var accumulator = InitialImageMeasurementAccumulator(
      requestedIdentifiers: ["a"],
      displayDegradedImages: false
    )
    accumulator.record(
      .image(identifier: "a", pixelWidth: 20, pixelHeight: 20, isDegraded: true),
      elapsedMilliseconds: 1
    )
    #expect(accumulator.renderableCount == 0)
    accumulator.record(
      .image(identifier: "a", pixelWidth: 100, pixelHeight: 100, isDegraded: false),
      elapsedMilliseconds: 4
    )

    let measurement = accumulator.makeMeasurement(
      strategy: .currentPerItemRefetch,
      imageCount: 1,
      iteration: 1,
      samplePosition: .earlier,
      allTerminalMilliseconds: 4
    )
    #expect(measurement.firstDegradedMilliseconds == 1)
    #expect(measurement.firstRenderableMilliseconds == 4)
    #expect(measurement.allVisibleFinalMilliseconds == 4)
  }

  @Test("Timeout marks only outstanding identifiers")
  func timeoutAccounting() {
    var accumulator = InitialImageMeasurementAccumulator(
      requestedIdentifiers: ["a", "b"],
      displayDegradedImages: true
    )
    accumulator.record(
      .image(identifier: "a", pixelWidth: 100, pixelHeight: 100, isDegraded: false),
      elapsedMilliseconds: 2
    )
    accumulator.recordTimeouts(elapsedMilliseconds: 30)

    let measurement = accumulator.makeMeasurement(
      strategy: .batchedThumbnailStore,
      imageCount: 2,
      iteration: 1,
      samplePosition: .later,
      allTerminalMilliseconds: 30
    )
    #expect(measurement.finalCount == 1)
    #expect(measurement.failureCount == 1)
    #expect(measurement.timedOutCount == 1)
    #expect(measurement.failureCodeCounts == ["TIMEOUT": 1])
  }

  @Test("Sample plan is globally disjoint and counterbalanced")
  func samplePlan() throws {
    let identifiers = (0..<16).map { "asset-\($0)" }
    let plan = try InitialImageSamplePlan(
      identifiers: identifiers,
      imageCounts: [2],
      iterations: 4
    )

    #expect(plan.sampledIdentifierCount == 16)
    #expect(plan.pairs.count == 4)
    #expect(plan.pairs.map(\.baseline.position) == [.earlier, .later, .earlier, .later])
    #expect(plan.pairs.map(\.candidate.position) == [.later, .earlier, .later, .earlier])
    #expect(plan.pairs.map(\.executeCandidateFirst) == [false, true, false, true])
    let used = plan.pairs.flatMap { $0.baseline.identifiers + $0.candidate.identifiers }
    #expect(Set(used).count == used.count)
  }
}
