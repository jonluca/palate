import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification global session scheduler")
struct PhotoAssetClassificationPipelineGlobalSchedulerTests {
  @Test("Sessions start one at a time in FIFO order")
  func serializedFIFO() {
    let first = UUID()
    let second = UUID()
    let third = UUID()
    var scheduler = PhotoAssetClassificationPipelineGlobalScheduler()

    let firstStart = scheduler.enqueue(sessionID: first)
    let secondStart = scheduler.enqueue(sessionID: second)
    let thirdStart = scheduler.enqueue(sessionID: third)
    #expect(firstStart == first)
    #expect(secondStart == nil)
    #expect(thirdStart == nil)
    #expect(scheduler.activeSessionID == first)
    #expect(scheduler.pendingSessionIDs == [second, third])

    let startAfterFirst = scheduler.finish(sessionID: first)
    let startAfterSecond = scheduler.finish(sessionID: second)
    let startAfterThird = scheduler.finish(sessionID: third)
    #expect(startAfterFirst == second)
    #expect(startAfterSecond == third)
    #expect(startAfterThird == nil)
    #expect(scheduler.activeSessionID == nil)
    #expect(scheduler.pendingSessionIDs.isEmpty)
  }

  @Test("Cancelling an owner does not start the next owner before active work finishes")
  func cancellationWaitsForActiveFinish() {
    let active = UUID()
    let sameOwnerPending = UUID()
    let nextOwner = UUID()
    var scheduler = PhotoAssetClassificationPipelineGlobalScheduler()

    _ = scheduler.enqueue(sessionID: active)
    _ = scheduler.enqueue(sessionID: sameOwnerPending)
    _ = scheduler.enqueue(sessionID: nextOwner)

    let cancellations = scheduler.cancel(sessionIDs: [active, sameOwnerPending])
    #expect(cancellations.activeSessionID == active)
    #expect(cancellations.pendingSessionIDs == [sameOwnerPending])
    #expect(scheduler.activeSessionID == active)
    #expect(scheduler.pendingSessionIDs == [nextOwner])
    let startAfterOutOfOrderFinish = scheduler.finish(sessionID: sameOwnerPending)
    let startAfterActiveFinish = scheduler.finish(sessionID: active)
    #expect(startAfterOutOfOrderFinish == nil)
    #expect(startAfterActiveFinish == nextOwner)
  }

  @Test("Cancelling queued sessions preserves the relative order of survivors")
  func queuedCancellationPreservesOrder() {
    let active = UUID()
    let cancelledFirst = UUID()
    let survivorFirst = UUID()
    let cancelledSecond = UUID()
    let survivorSecond = UUID()
    var scheduler = PhotoAssetClassificationPipelineGlobalScheduler()

    for sessionID in [active, cancelledFirst, survivorFirst, cancelledSecond, survivorSecond] {
      _ = scheduler.enqueue(sessionID: sessionID)
    }

    let cancellations = scheduler.cancel(sessionIDs: [cancelledFirst, cancelledSecond])
    #expect(cancellations.activeSessionID == nil)
    #expect(cancellations.pendingSessionIDs == [cancelledFirst, cancelledSecond])
    #expect(scheduler.pendingSessionIDs == [survivorFirst, survivorSecond])
    let startAfterActive = scheduler.finish(sessionID: active)
    let startAfterFirstSurvivor = scheduler.finish(sessionID: survivorFirst)
    #expect(startAfterActive == survivorFirst)
    #expect(startAfterFirstSurvivor == survivorSecond)
  }
}
