import Testing

@testable import PhotosProfilerSupport

@Suite("Photo library Vision profiler")
struct PhotoLibraryVisionProfilerTests {
  @Test("Comparison order alternates from the requested first strategy")
  func counterbalancedOrder() {
    let pipelineFirst = (0..<6).map {
      PhotoLibraryVisionProfiler.pipelineRunsFirst(
        at: $0,
        startingWithPipeline: true
      )
    }
    let baselineFirst = (0..<6).map {
      PhotoLibraryVisionProfiler.pipelineRunsFirst(
        at: $0,
        startingWithPipeline: false
      )
    }

    #expect(pipelineFirst == [true, false, true, false, true, false])
    #expect(baselineFirst == [false, true, false, true, false, true])
  }

  @Test("Measured order continues after warmup comparisons")
  func measuredOrderContinuesAfterWarmup() {
    #expect(
      PhotoLibraryVisionProfiler.measurementOrder(
        iterations: 4,
        warmupIterations: 1,
        startingWithPipeline: false
      ) == [
        "pipeline-then-baseline",
        "baseline-then-pipeline",
        "pipeline-then-baseline",
        "baseline-then-pipeline",
      ]
    )
    #expect(
      PhotoLibraryVisionProfiler.measurementOrder(
        iterations: 4,
        warmupIterations: 2,
        startingWithPipeline: true
      ) == [
        "pipeline-then-baseline",
        "baseline-then-pipeline",
        "pipeline-then-baseline",
        "baseline-then-pipeline",
      ]
    )
  }

  @Test("Asset windows are disjoint and shrink evenly to available assets")
  func disjointAssetWindows() {
    let complete = PhotoLibraryVisionProfiler.assetWindowPlan(
      availableAssetCount: 2_400,
      requestedAssetsPerComparison: 200,
      comparisonCount: 12
    )
    #expect(complete.assetsPerComparison == 200)
    #expect(complete.requestedUniqueAssetCount == 2_400)
    #expect(complete.profiledUniqueAssetCount == 2_400)
    #expect(complete.range(forComparisonAt: 0) == (0..<200))
    #expect(complete.range(forComparisonAt: 11) == (2_200..<2_400))

    let reduced = PhotoLibraryVisionProfiler.assetWindowPlan(
      availableAssetCount: 1_000,
      requestedAssetsPerComparison: 200,
      comparisonCount: 12
    )
    #expect(reduced.assetsPerComparison == 83)
    #expect(reduced.requestedUniqueAssetCount == 2_400)
    #expect(reduced.profiledUniqueAssetCount == 996)
    #expect(reduced.range(forComparisonAt: 0) == (0..<83))
    #expect(reduced.range(forComparisonAt: 11) == (913..<996))

    let insufficient = PhotoLibraryVisionProfiler.assetWindowPlan(
      availableAssetCount: 5,
      requestedAssetsPerComparison: 200,
      comparisonCount: 12
    )
    #expect(insufficient.assetsPerComparison == 0)
    #expect(insufficient.profiledUniqueAssetCount == 0)
  }
}
