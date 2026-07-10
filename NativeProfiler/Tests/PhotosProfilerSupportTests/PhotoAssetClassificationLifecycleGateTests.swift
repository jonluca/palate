import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification lifecycle gate")
struct PhotoAssetClassificationLifecycleGateTests {
  @Test("Queued work cannot enter after destruction")
  func queuedWorkCannotEnterAfterDestruction() {
    let gate = PhotoAssetClassificationLifecycleGate()
    let queue = DispatchQueue(
      label: "com.jonluca.palate.tests.photo-classification-lifecycle.suspended"
    )
    let workStarted = DispatchSemaphore(value: 0)
    let workFinished = DispatchSemaphore(value: 0)
    queue.suspend()
    queue.async {
      gate.performIfActive {
        workStarted.signal()
      }
      workFinished.signal()
    }

    #expect(gate.admit())
    gate.destroy()
    #expect(!gate.admit())
    queue.resume()

    #expect(workFinished.wait(timeout: .now() + 1) == .success)
    #expect(workStarted.wait(timeout: .now()) == .timedOut)
  }

  @Test("Active admissions remain concurrent")
  func activeAdmissionsRemainConcurrent() {
    let gate = PhotoAssetClassificationLifecycleGate()
    let queue = DispatchQueue(
      label: "com.jonluca.palate.tests.photo-classification-lifecycle.concurrent",
      attributes: .concurrent
    )
    let firstStarted = DispatchSemaphore(value: 0)
    let releaseFirst = DispatchSemaphore(value: 0)
    let firstFinished = DispatchSemaphore(value: 0)
    let secondFinished = DispatchSemaphore(value: 0)
    queue.async {
      gate.performIfActive {
        firstStarted.signal()
        releaseFirst.wait()
      }
      firstFinished.signal()
    }

    #expect(firstStarted.wait(timeout: .now() + 1) == .success)
    queue.async {
      gate.performIfActive {}
      secondFinished.signal()
    }
    #expect(secondFinished.wait(timeout: .now() + 1) == .success)
    releaseFirst.signal()
    #expect(firstFinished.wait(timeout: .now() + 1) == .success)
  }

  @Test("Destruction drains active delivery and rejects new admissions")
  func destructionDrainsActiveDelivery() {
    let gate = PhotoAssetClassificationLifecycleGate()
    let deliveryStarted = DispatchSemaphore(value: 0)
    let releaseDelivery = DispatchSemaphore(value: 0)
    let destructionReturned = DispatchSemaphore(value: 0)

    DispatchQueue.global(qos: .userInitiated).async {
      gate.performIfActive {
        deliveryStarted.signal()
        releaseDelivery.wait()
      }
    }
    #expect(deliveryStarted.wait(timeout: .now() + 1) == .success)

    DispatchQueue.global(qos: .userInitiated).async {
      gate.destroy()
      destructionReturned.signal()
    }

    let destructionDeadline = Date().addingTimeInterval(1)
    while gate.admit(), Date() < destructionDeadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    #expect(!gate.admit())
    #expect(gate.performIfActive { true } == nil)
    #expect(destructionReturned.wait(timeout: .now()) == .timedOut)

    releaseDelivery.signal()
    #expect(destructionReturned.wait(timeout: .now() + 1) == .success)
  }
}
