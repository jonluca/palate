import Foundation
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification image request deadlines")
struct PhotoAssetClassificationImageRequestDeadlineTests {
  @Test("A missing PhotoKit callback times out once and frees the next pipeline slot")
  func missingCallback() throws {
    var scheduler = PhotoAssetClassificationPipelineScheduler(itemCount: 2, maximumInFlight: 1)
    #expect(scheduler.fillAvailableSlots() == [0])
    var timer: DispatchWorkItem?
    var timeouts = 0
    let deadline = PhotoAssetClassificationImageRequestDeadline(
      schedule: { delay, item in
        #expect(delay == .seconds(30))
        timer = item
      },
      onTimeout: {
        timeouts += 1
        let released = scheduler.complete(index: 0)
        #expect(released)
      }
    )

    let scheduled = try #require(timer)
    scheduled.perform()
    scheduled.perform()
    #expect(timeouts == 1)
    #expect(scheduler.fillAvailableSlots() == [1])
    #expect(!deadline.receive(terminalResult))
    let released = scheduler.complete(index: 1)
    #expect(released)
    #expect(scheduler.isComplete)
  }

  @Test("Degraded callbacks leave the original deadline armed")
  func degradedPreview() throws {
    var timer: DispatchWorkItem?
    var timeouts = 0
    let deadline = PhotoAssetClassificationImageRequestDeadline(
      schedule: { _, item in timer = item },
      onTimeout: { timeouts += 1 }
    )
    let preview = PhotoAssetClassificationImageResult(
      image: nil, isDegraded: true, isCancelled: false, errorDescription: nil
    )
    let scheduled = try #require(timer)
    #expect(!deadline.receive(preview))
    #expect(!deadline.receive(preview))
    #expect(!scheduled.isCancelled)
    scheduled.perform()
    #expect(timeouts == 1)
    #expect(!deadline.receive(terminalResult))
  }

  @Test("A final callback cancels the deadline and rejects duplicate callbacks")
  func finalCallback() throws {
    var timer: DispatchWorkItem?
    var timeouts = 0
    let deadline = PhotoAssetClassificationImageRequestDeadline(
      schedule: { _, item in timer = item },
      onTimeout: { timeouts += 1 }
    )
    #expect(deadline.receive(terminalResult))
    #expect(!deadline.receive(terminalResult))
    let scheduled = try #require(timer)
    #expect(scheduled.isCancelled)
    scheduled.perform()
    #expect(timeouts == 0)
  }

  @Test("Session cancellation disarms the deadline and ignores later PhotoKit results")
  func cancelledRequest() throws {
    var timer: DispatchWorkItem?
    var timeouts = 0
    let deadline = PhotoAssetClassificationImageRequestDeadline(
      schedule: { _, item in timer = item },
      onTimeout: { timeouts += 1 }
    )
    deadline.cancel()
    deadline.cancel()
    #expect(!deadline.receive(terminalResult))
    let scheduled = try #require(timer)
    #expect(scheduled.isCancelled)
    scheduled.perform()
    #expect(timeouts == 0)
  }

  @Test("Error and cancellation results finish even if PhotoKit marks them degraded")
  func degradedTerminalResults() throws {
    for result in [
      PhotoAssetClassificationImageResult(
        image: nil, isDegraded: true, isCancelled: true, errorDescription: nil
      ),
      PhotoAssetClassificationImageResult(
        image: nil, isDegraded: true, isCancelled: false, errorDescription: "iCloud unavailable"
      ),
    ] {
      var timer: DispatchWorkItem?
      var timeouts = 0
      let deadline = PhotoAssetClassificationImageRequestDeadline(
        schedule: { _, item in timer = item },
        onTimeout: { timeouts += 1 }
      )
      #expect(deadline.receive(result))
      let scheduled = try #require(timer)
      #expect(scheduled.isCancelled)
      scheduled.perform()
      #expect(timeouts == 0)
    }
  }

  @Test("Releasing a request cancels its timer without retaining its owner")
  func releaseRequest() throws {
    var timer: DispatchWorkItem?
    var timeouts = 0
    var deadline: PhotoAssetClassificationImageRequestDeadline? = .init(
      schedule: { _, item in timer = item },
      onTimeout: { timeouts += 1 }
    )
    weak let weakDeadline = deadline
    deadline = nil
    #expect(weakDeadline == nil)
    let scheduled = try #require(timer)
    #expect(scheduled.isCancelled)
    scheduled.perform()
    #expect(timeouts == 0)
  }

  private var terminalResult: PhotoAssetClassificationImageResult {
    .init(image: nil, isDegraded: false, isCancelled: false, errorDescription: nil)
  }
}
