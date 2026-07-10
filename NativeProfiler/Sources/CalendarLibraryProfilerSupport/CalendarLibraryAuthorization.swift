@preconcurrency import EventKit
import Foundation

@MainActor
public enum CalendarLibraryAuthorization {
  public static func currentStatus() -> EKAuthorizationStatus {
    EKEventStore.authorizationStatus(for: .event)
  }

  public static func requestIfNeeded(
    eventStore: EKEventStore,
    currentStatus: EKAuthorizationStatus
  ) async throws -> EKAuthorizationStatus {
    guard currentStatus == .notDetermined else {
      return currentStatus
    }

    if #available(macOS 14.0, iOS 17.0, *) {
      _ = try await eventStore.requestFullAccessToEvents()
    } else {
      let _: Bool = try await withCheckedThrowingContinuation { continuation in
        eventStore.requestAccess(to: .event) { granted, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: granted)
          }
        }
      }
    }
    return EKEventStore.authorizationStatus(for: .event)
  }

  public static func name(for status: EKAuthorizationStatus) -> String {
    if #available(macOS 14.0, iOS 17.0, *) {
      switch status {
      case .notDetermined:
        return "notDetermined"
      case .restricted:
        return "restricted"
      case .denied:
        return "denied"
      case .fullAccess:
        return "fullAccess"
      case .writeOnly:
        return "writeOnly"
      case .authorized:
        return "authorized"
      @unknown default:
        return "unknown"
      }
    }

    switch status {
    case .notDetermined:
      return "notDetermined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    default:
      return "unknown"
    }
  }

  public static func permitsReading(_ status: EKAuthorizationStatus) -> Bool {
    if #available(macOS 14.0, iOS 17.0, *) {
      return status == .fullAccess || status == .authorized
    }
    return status == .authorized
  }
}
