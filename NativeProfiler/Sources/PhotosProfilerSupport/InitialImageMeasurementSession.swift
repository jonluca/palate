import Foundation

final class InitialImageMeasurementSession: @unchecked Sendable {
  typealias CancellationHandler = @Sendable () -> Void
  typealias RequestStarter =
    @Sendable (
      _ receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
    ) -> [CancellationHandler]

  private let callbackQueue: DispatchQueue
  private let strategy: InitialImageStrategy
  private let imageCount: Int
  private let iteration: Int
  private let samplePosition: InitialImageSamplePosition
  private let timeoutMilliseconds: Int
  private var accumulator: InitialImageMeasurementAccumulator
  private var continuation: CheckedContinuation<InitialImageBenchmarkReport.Measurement, Never>?
  private var cancellationHandlers: [CancellationHandler] = []
  private var timer: DispatchSourceTimer?
  private var startedAt: UInt64 = 0
  private var completed = false

  init(
    callbackQueue: DispatchQueue,
    strategy: InitialImageStrategy,
    imageCount: Int,
    iteration: Int,
    samplePosition: InitialImageSamplePosition,
    timeoutMilliseconds: Int,
    requestedIdentifiers: [String],
    displayDegradedImages: Bool
  ) {
    self.callbackQueue = callbackQueue
    self.strategy = strategy
    self.imageCount = imageCount
    self.iteration = iteration
    self.samplePosition = samplePosition
    self.timeoutMilliseconds = timeoutMilliseconds
    accumulator = InitialImageMeasurementAccumulator(
      requestedIdentifiers: requestedIdentifiers,
      displayDegradedImages: displayDegradedImages
    )
  }

  func run(startRequests: @escaping RequestStarter) async -> InitialImageBenchmarkReport.Measurement
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
    let elapsed = elapsedMilliseconds()
    accumulator.record(event, elapsedMilliseconds: elapsed)
    if accumulator.isTerminal {
      finish(elapsedMilliseconds: elapsed)
    }
  }

  private func timeOut() {
    guard !completed else {
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
    guard !completed else {
      return
    }
    completed = true
    timer?.setEventHandler {}
    timer?.cancel()
    timer = nil
    cancellationHandlers.removeAll(keepingCapacity: false)

    let measurement = accumulator.makeMeasurement(
      strategy: strategy,
      imageCount: imageCount,
      iteration: iteration,
      samplePosition: samplePosition,
      allTerminalMilliseconds: elapsedMilliseconds
    )
    let continuation = continuation
    self.continuation = nil
    continuation?.resume(returning: measurement)
  }

  private func elapsedMilliseconds() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
  }
}
