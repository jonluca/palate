import Foundation

public final class PhotoAssetThumbnailRequestToken: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var cancellationHandler: (@Sendable () -> Void)?

  init(cancellationHandler: @escaping @Sendable () -> Void) {
    self.cancellationHandler = cancellationHandler
  }

  public var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  public func cancel() {
    let handler: (@Sendable () -> Void)?
    lock.lock()
    if cancelled {
      handler = nil
    } else {
      cancelled = true
      handler = cancellationHandler
      cancellationHandler = nil
    }
    lock.unlock()

    handler?()
  }
}
