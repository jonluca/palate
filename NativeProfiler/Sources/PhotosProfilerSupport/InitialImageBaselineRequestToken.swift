import Foundation
@preconcurrency import Photos

final class InitialImageBaselineRequestToken: @unchecked Sendable {
  private let lock = NSLock()
  private let imageManager: PHImageManager
  private var requestId: PHImageRequestID?
  private var cancelled = false

  init(imageManager: PHImageManager) {
    self.imageManager = imageManager
  }

  func assign(requestId: PHImageRequestID) {
    let shouldCancel: Bool
    lock.lock()
    if cancelled {
      shouldCancel = true
    } else {
      self.requestId = requestId
      shouldCancel = false
    }
    lock.unlock()

    if shouldCancel {
      imageManager.cancelImageRequest(requestId)
    }
  }

  func cancel() {
    let requestId: PHImageRequestID?
    lock.lock()
    if cancelled {
      requestId = nil
    } else {
      cancelled = true
      requestId = self.requestId
      self.requestId = nil
    }
    lock.unlock()

    if let requestId {
      imageManager.cancelImageRequest(requestId)
    }
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }
}
