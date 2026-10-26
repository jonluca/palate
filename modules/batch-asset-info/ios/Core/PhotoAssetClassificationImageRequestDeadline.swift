import Foundation

/// Accessed only on the classification session's state queue, including the deadline callback.
final class PhotoAssetClassificationImageRequestDeadline: @unchecked Sendable {
  static let timeout: DispatchTimeInterval = .seconds(30)

  private var isPending = true
  private var workItem: DispatchWorkItem?
  private let onTimeout: () -> Void

  init(
    schedule: (DispatchTimeInterval, DispatchWorkItem) -> Void,
    onTimeout: @escaping () -> Void
  ) {
    self.onTimeout = onTimeout
    let item = DispatchWorkItem { [weak self] in
      guard let self, finish() else {
        return
      }
      self.onTimeout()
    }
    workItem = item
    schedule(Self.timeout, item)
  }

  deinit {
    workItem?.cancel()
  }

  /// A degraded preview is not a completed high-quality image request.
  func receive(_ result: PhotoAssetClassificationImageResult) -> Bool {
    guard !result.isDegraded || result.isCancelled || result.errorDescription != nil else {
      return false
    }
    return finish()
  }

  func cancel() {
    _ = finish()
  }

  private func finish() -> Bool {
    guard isPending else {
      return false
    }
    isPending = false
    workItem?.cancel()
    workItem = nil
    return true
  }
}
