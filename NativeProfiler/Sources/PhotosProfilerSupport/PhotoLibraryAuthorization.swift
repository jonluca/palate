import Foundation
@preconcurrency import Photos

final class PhotoLibraryAuthorizationResolution: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (PHAuthorizationStatus) -> Void)?

  init(handler: @escaping @Sendable (PHAuthorizationStatus) -> Void) {
    self.handler = handler
  }

  @discardableResult
  func resolve(_ status: PHAuthorizationStatus) -> Bool {
    lock.lock()
    let pendingHandler = handler
    handler = nil
    lock.unlock()
    guard let pendingHandler else {
      return false
    }
    pendingHandler(status)
    return true
  }
}

public enum PhotoLibraryAuthorization {
  private static let requestTimeout: TimeInterval = 30

  public static func requestIfNeeded() async -> PHAuthorizationStatus {
    let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard current == .notDetermined else {
      return current
    }

    return await withCheckedContinuation { continuation in
      let resolution = PhotoLibraryAuthorizationResolution { status in
        continuation.resume(returning: status)
      }
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
        resolution.resolve(status)
      }
      DispatchQueue.global(qos: .userInitiated).asyncAfter(
        deadline: .now() + requestTimeout
      ) {
        resolution.resolve(.notDetermined)
      }
    }
  }

  public static func name(for status: PHAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
      return "notDetermined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    case .limited:
      return "limited"
    @unknown default:
      return "unknown"
    }
  }

  public static func permitsReading(_ status: PHAuthorizationStatus) -> Bool {
    status == .authorized || status == .limited
  }
}
