import Foundation
@preconcurrency import Photos

public enum PhotoLibraryAuthorization {
  public static func requestIfNeeded() async -> PHAuthorizationStatus {
    let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard current == .notDetermined else {
      return current
    }

    return await withCheckedContinuation { continuation in
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
        continuation.resume(returning: status)
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
