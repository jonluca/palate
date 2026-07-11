import Foundation

final class ThumbnailScrollWindowMeasurementSession: @unchecked Sendable {
  typealias TimedMeasurement = InitialImageMeasurementSession.TimedMeasurement
  typealias CancellationHandler = @Sendable () -> Void
  typealias RequestStarter =
    @Sendable (
      _ receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
    ) -> [CancellationHandler]

  private let callbackQueue: DispatchQueue
  private let imageCount: Int
  private let iteration: Int
  private let samplePosition: InitialImageSamplePosition
  private let timeoutMilliseconds: Int
  private let onTerminal: @Sendable () -> Void
  private var accumulator: InitialImageMeasurementAccumulator
  private var resultContinuation: CheckedContinuation<TimedMeasurement, Never>?
  private var completedResult: TimedMeasurement?
  private var cancellationHandlers: [CancellationHandler] = []
  private var timer: DispatchSourceTimer?
  private var startedAt: UInt64 = 0
  private var started = false

  init(
    callbackQueue: DispatchQueue,
    imageCount: Int,
    iteration: Int,
    samplePosition: InitialImageSamplePosition,
    timeoutMilliseconds: Int,
    requestedIdentifiers: [String],
    onTerminal: @escaping @Sendable () -> Void
  ) {
    self.callbackQueue = callbackQueue
    self.imageCount = imageCount
    self.iteration = iteration
    self.samplePosition = samplePosition
    self.timeoutMilliseconds = timeoutMilliseconds
    self.onTerminal = onTerminal
    accumulator = InitialImageMeasurementAccumulator(
      requestedIdentifiers: requestedIdentifiers,
      displayDegradedImages: true
    )
  }

  /// Starts every request before returning, allowing the caller to submit preheat work afterward
  /// with the same render-before-viewability ordering used by the FlashList producer.
  func start(startRequests: @escaping RequestStarter) async {
    await withCheckedContinuation { continuation in
      callbackQueue.async { [self] in
        precondition(!started, "A thumbnail-scroll window can only start once")
        started = true
        startedAt = DispatchTime.now().uptimeNanoseconds
        startTimer()
        let handlers = startRequests { [weak self] event in
          self?.receive(event)
        }
        if completedResult != nil {
          for handler in handlers {
            handler()
          }
        } else {
          cancellationHandlers = handlers
        }
        continuation.resume()
      }
    }
  }

  func result() async -> TimedMeasurement {
    await withCheckedContinuation { continuation in
      callbackQueue.async { [self] in
        precondition(started, "A thumbnail-scroll window must start before awaiting its result")
        precondition(
          resultContinuation == nil, "Only one thumbnail-scroll result waiter is allowed")
        if let completedResult {
          continuation.resume(returning: completedResult)
        } else {
          resultContinuation = continuation
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
    guard completedResult == nil else {
      return
    }
    let elapsed = elapsedMilliseconds()
    accumulator.record(event, elapsedMilliseconds: elapsed)
    if accumulator.isTerminal {
      finish(elapsedMilliseconds: elapsed)
    }
  }

  private func timeOut() {
    guard completedResult == nil else {
      return
    }
    let elapsed = elapsedMilliseconds()
    accumulator.recordTimeouts(elapsedMilliseconds: elapsed)
    let handlers = cancellationHandlers
    cancellationHandlers.removeAll(keepingCapacity: false)
    for handler in handlers {
      handler()
    }
    finish(elapsedMilliseconds: elapsed)
  }

  private func finish(elapsedMilliseconds: Double) {
    guard completedResult == nil else {
      return
    }
    timer?.setEventHandler {}
    timer?.cancel()
    timer = nil
    cancellationHandlers.removeAll(keepingCapacity: false)

    let result = TimedMeasurement(
      measurement: accumulator.makeMeasurement(
        strategy: .batchedThumbnailStore,
        imageCount: imageCount,
        iteration: iteration,
        samplePosition: samplePosition,
        allTerminalMilliseconds: elapsedMilliseconds
      ),
      terminalUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
    )
    completedResult = result
    onTerminal()
    let continuation = resultContinuation
    resultContinuation = nil
    continuation?.resume(returning: result)
  }

  private func elapsedMilliseconds() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
  }
}
