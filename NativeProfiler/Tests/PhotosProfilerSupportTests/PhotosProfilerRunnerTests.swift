import Testing

@testable import PhotosProfilerSupport

@Suite("Photos profiler runner")
struct PhotosProfilerRunnerTests {
  @Test("Vision-only execution skips metadata and initial images")
  func visionOnlyExecutionPlan() {
    let plan = PhotosProfilerExecutionPlan.make(for: .vision)

    #expect(!plan.runsMetadata)
    #expect(plan.runsVision)
    #expect(!plan.runsInitialImages)
  }

  @Test("Combined Photos execution retains metadata before Vision")
  func photosExecutionPlan() {
    let plan = PhotosProfilerExecutionPlan.make(for: .photos)

    #expect(plan.runsMetadata)
    #expect(plan.runsVision)
    #expect(!plan.runsInitialImages)
  }

  @Test("Root status fails exact parity mismatches")
  func parityFailureStatus() {
    let vision = makeVision(status: "ok", exactParity: false)

    #expect(PhotosProfilerRunner.reportStatus(for: vision) == "error")
  }

  @Test("Root status preserves partial Vision results")
  func partialStatus() {
    let vision = makeVision(status: "partial", exactParity: true)

    #expect(PhotosProfilerRunner.reportStatus(for: vision) == "partial")
  }

  @Test("Disabled and exact Vision results leave the root successful")
  func successfulStatus() {
    #expect(PhotosProfilerRunner.reportStatus(for: nil) == "ok")
    #expect(
      PhotosProfilerRunner.reportStatus(
        for: makeVision(status: "disabled", exactParity: true)
      ) == "ok"
    )
    #expect(
      PhotosProfilerRunner.reportStatus(
        for: makeVision(status: "ok", exactParity: true)
      ) == "ok"
    )
  }

  @Test("Unavailable Vision providers fail the root report")
  func unavailableProviderStatus() {
    #expect(
      PhotosProfilerRunner.reportStatus(
        for: makeVision(status: "providerNotInstalled", exactParity: true)
      ) == "error"
    )
  }

  private func makeVision(status: String, exactParity: Bool) -> ProfilerReport.Vision {
    ProfilerReport.Vision(
      status: status,
      requestedSampleCount: 1,
      processedSampleCount: 1,
      failureCount: 0,
      totalLabelCount: 1,
      concurrency: 2,
      elapsedMilliseconds: 1,
      assetsPerSecond: 1_000,
      details: nil,
      validation: ProfilerReport.Vision.Validation(
        exactOutcomeParity: exactParity,
        mismatchCount: exactParity ? 0 : 1,
        comparedAssetCount: 1,
        comparisonRuns: 1
      )
    )
  }
}
