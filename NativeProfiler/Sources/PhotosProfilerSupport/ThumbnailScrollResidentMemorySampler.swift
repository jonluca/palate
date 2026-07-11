import Darwin
import Foundation

final class ThumbnailScrollResidentMemorySampler: @unchecked Sendable {
  enum Checkpoint: Hashable, Sendable {
    case currentVisibleTerminal
    case nextVisibleTerminal
    case afterPreheatEnd
    case afterCacheCleanup
  }

  struct Snapshot: Equatable, Sendable {
    let baselineBytes: UInt64
    let currentVisibleTerminalBytes: UInt64?
    let nextVisibleTerminalBytes: UInt64?
    let currentVisibleTerminalSampledPeakBytes: UInt64?
    let nextVisibleTerminalSampledPeakBytes: UInt64?
    let afterPreheatEndBytes: UInt64?
    let afterCacheCleanupBytes: UInt64?
    let sampledPeakBytes: UInt64
    let sampleCount: Int
  }

  typealias Reader = @Sendable () -> UInt64?

  private let queue = DispatchQueue(
    label: "com.jonluca.palate.photos-profiler.thumbnail-scroll.rss",
    qos: .utility
  )
  private let sampleIntervalMilliseconds: Int
  private let reader: Reader
  private var timer: DispatchSourceTimer?
  private var baselineBytes: UInt64?
  private var sampledPeakBytes: UInt64 = 0
  private var sampleCount = 0
  private var checkpointBytes: [Checkpoint: UInt64] = [:]
  private var checkpointPeakBytes: [Checkpoint: UInt64] = [:]

  init(
    sampleIntervalMilliseconds: Int,
    reader: @escaping Reader = ThumbnailScrollResidentMemorySampler.readCurrentResidentBytes
  ) {
    self.sampleIntervalMilliseconds = max(1, sampleIntervalMilliseconds)
    self.reader = reader
  }

  func start() async throws {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { [self] in
        guard timer == nil else {
          continuation.resume()
          return
        }
        guard let baseline = recordSample() else {
          continuation.resume(throwing: ThumbnailScrollBenchmarkError.residentMemoryUnavailable)
          return
        }
        baselineBytes = baseline

        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(
          deadline: .now() + .milliseconds(sampleIntervalMilliseconds),
          repeating: .milliseconds(sampleIntervalMilliseconds),
          leeway: .milliseconds(max(1, sampleIntervalMilliseconds / 2))
        )
        source.setEventHandler { [weak self] in
          _ = self?.recordSample()
        }
        timer = source
        source.resume()
        continuation.resume()
      }
    }
  }

  func capture(_ checkpoint: Checkpoint) {
    let bytes = reader()
    queue.async { [self] in
      if let bytes {
        recordSample(bytes)
        checkpointBytes[checkpoint] = bytes
        checkpointPeakBytes[checkpoint] = sampledPeakBytes
      }
    }
  }

  func stop() async throws -> Snapshot {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { [self] in
        _ = recordSample()
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        guard let baselineBytes else {
          continuation.resume(throwing: ThumbnailScrollBenchmarkError.residentMemoryUnavailable)
          return
        }
        continuation.resume(
          returning: Snapshot(
            baselineBytes: baselineBytes,
            currentVisibleTerminalBytes: checkpointBytes[.currentVisibleTerminal],
            nextVisibleTerminalBytes: checkpointBytes[.nextVisibleTerminal],
            currentVisibleTerminalSampledPeakBytes: checkpointPeakBytes[
              .currentVisibleTerminal
            ],
            nextVisibleTerminalSampledPeakBytes: checkpointPeakBytes[.nextVisibleTerminal],
            afterPreheatEndBytes: checkpointBytes[.afterPreheatEnd],
            afterCacheCleanupBytes: checkpointBytes[.afterCacheCleanup],
            sampledPeakBytes: sampledPeakBytes,
            sampleCount: sampleCount
          )
        )
      }
    }
  }

  private func recordSample() -> UInt64? {
    guard let bytes = reader() else {
      return nil
    }
    recordSample(bytes)
    return bytes
  }

  private func recordSample(_ bytes: UInt64) {
    sampledPeakBytes = max(sampledPeakBytes, bytes)
    sampleCount += 1
  }

  private static func readCurrentResidentBytes() -> UInt64? {
    var information = mach_task_basic_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<natural_t>.size
    )
    let result = withUnsafeMutablePointer(to: &information) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { reboundPointer in
        task_info(
          mach_task_self_,
          task_flavor_t(MACH_TASK_BASIC_INFO),
          reboundPointer,
          &count
        )
      }
    }
    guard result == KERN_SUCCESS else {
      return nil
    }
    return UInt64(information.resident_size)
  }
}
