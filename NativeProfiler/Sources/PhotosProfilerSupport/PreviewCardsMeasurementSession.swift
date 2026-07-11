import Foundation

final class PreviewCardsMeasurementSession: @unchecked Sendable {
  typealias CancellationHandler = @Sendable () -> Void
  typealias RequestStarter =
    @Sendable (
      _ receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
    ) -> [CancellationHandler]

  private let callbackQueue: DispatchQueue
  private let timeoutMilliseconds: Int
  private let onAllStripRenderable: @Sendable () -> Void
  private let onAllFinal: @Sendable () -> Void
  private var accumulator: PreviewCardsMeasurementAccumulator
  private var continuation: CheckedContinuation<PreviewCardsBenchmarkReport.LoadMeasurement, Never>?
  private var cancellationHandlers: [CancellationHandler] = []
  private var timer: DispatchSourceTimer?
  private var startedAt: UInt64 = 0
  private var finishScheduled = false
  private var completed = false

  init(
    callbackQueue: DispatchQueue,
    requests: [PreviewCardsAssetRequest],
    cardCount: Int,
    displayDegradedImages: Bool,
    timeoutMilliseconds: Int,
    onAllStripRenderable: @escaping @Sendable () -> Void,
    onAllFinal: @escaping @Sendable () -> Void
  ) {
    self.callbackQueue = callbackQueue
    self.timeoutMilliseconds = timeoutMilliseconds
    self.onAllStripRenderable = onAllStripRenderable
    self.onAllFinal = onAllFinal
    accumulator = PreviewCardsMeasurementAccumulator(
      requests: requests,
      cardCount: cardCount,
      displayDegradedImages: displayDegradedImages
    )
  }

  func run(startRequests: @escaping RequestStarter) async
    -> PreviewCardsBenchmarkReport.LoadMeasurement
  {
    await withCheckedContinuation { continuation in
      callbackQueue.async { [self] in
        self.continuation = continuation
        startedAt = DispatchTime.now().uptimeNanoseconds
        startTimer()
        let handlers = startRequests { [weak self] event in
          self?.receive(event)
        }
        if completed {
          for handler in handlers {
            handler()
          }
        } else {
          cancellationHandlers = handlers
        }
      }
    }
  }

  private func startTimer() {
    let source = DispatchSource.makeTimerSource(queue: callbackQueue)
    source.schedule(deadline: .now() + .milliseconds(timeoutMilliseconds))
    source.setEventHandler { [weak self] in
      self?.timeOut()
    }
    timer = source
    source.resume()
  }

  private func receive(_ event: InitialImageLoadEvent) {
    guard !completed else {
      return
    }
    let hadAllRenderable = accumulator.allStripRenderableMilliseconds != nil
    let hadAllFinal = accumulator.allFinalMilliseconds != nil
    let elapsed = elapsedMilliseconds()
    accumulator.record(event, elapsedMilliseconds: elapsed)
    if !hadAllRenderable, accumulator.allStripRenderableMilliseconds != nil {
      onAllStripRenderable()
    }
    if !hadAllFinal, accumulator.allFinalMilliseconds != nil {
      onAllFinal()
    }
    if accumulator.isTerminal {
      scheduleFinish()
    }
  }

  private func scheduleFinish() {
    guard !finishScheduled else {
      return
    }
    finishScheduled = true
    // A queue turn records any already-enqueued post-terminal callback as a stale event.
    callbackQueue.async { [weak self] in
      self?.finish()
    }
  }

  private func timeOut() {
    guard !completed else {
      return
    }
    accumulator.recordTimeouts(elapsedMilliseconds: elapsedMilliseconds())
    finish()
  }

  private func finish() {
    guard !completed else {
      return
    }
    completed = true
    timer?.setEventHandler {}
    timer?.cancel()
    timer = nil
    let handlers = cancellationHandlers
    cancellationHandlers.removeAll(keepingCapacity: false)
    for handler in handlers {
      handler()
    }
    let measurement = accumulator.makeMeasurement(
      allTerminalMilliseconds: elapsedMilliseconds()
    )
    let continuation = continuation
    self.continuation = nil
    continuation?.resume(returning: measurement)
  }

  private func elapsedMilliseconds() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
  }
}
