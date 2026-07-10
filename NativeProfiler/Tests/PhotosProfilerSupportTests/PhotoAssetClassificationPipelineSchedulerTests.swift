import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification pipeline scheduler")
struct PhotoAssetClassificationPipelineSchedulerTests {
  @Test("Empty input completes without starting work")
  func emptyInput() {
    var scheduler = PhotoAssetClassificationPipelineScheduler(
      itemCount: 0,
      maximumInFlight: 4
    )

    #expect(scheduler.isComplete)
    #expect(scheduler.fillAvailableSlots().isEmpty)
  }

  @Test("The in-flight bound holds across out-of-order completion")
  func boundedOutOfOrderCompletion() {
    var scheduler = PhotoAssetClassificationPipelineScheduler(
      itemCount: 10,
      maximumInFlight: 3
    )
    var started = scheduler.fillAvailableSlots()

    #expect(started == [0, 1, 2])
    #expect(scheduler.activeIndices == Set([0, 1, 2]))
    let completedFirst = scheduler.complete(index: 1)
    let completedDuplicate = scheduler.complete(index: 1)
    #expect(completedFirst)
    #expect(!completedDuplicate)
    started += scheduler.fillAvailableSlots()
    #expect(scheduler.activeIndices == Set([0, 2, 3]))

    while !scheduler.isComplete {
      let index = scheduler.activeIndices.max()!
      let completed = scheduler.complete(index: index)
      #expect(completed)
      started += scheduler.fillAvailableSlots()
      #expect(scheduler.activeIndices.count <= 3)
    }

    #expect(started == Array(0..<10))
    #expect(scheduler.completedCount == 10)
    #expect(scheduler.activeIndices.isEmpty)
  }

  @Test("Cancellation accounts for work that never entered the pipeline")
  func cancelUnstarted() {
    var scheduler = PhotoAssetClassificationPipelineScheduler(
      itemCount: 7,
      maximumInFlight: 2
    )

    let started = scheduler.fillAvailableSlots()
    let cancelled = scheduler.cancelUnstarted()
    let cancelledAgain = scheduler.cancelUnstarted()
    #expect(started == [0, 1])
    #expect(cancelled == [2, 3, 4, 5, 6])
    #expect(cancelledAgain.isEmpty)
    #expect(!scheduler.isComplete)
    let completedSecond = scheduler.complete(index: 1)
    let completedFirst = scheduler.complete(index: 0)
    #expect(completedSecond)
    #expect(completedFirst)
    #expect(scheduler.isComplete)
    #expect(scheduler.completedCount == 7)
  }
}
