import Foundation
@preconcurrency import Photos
import Testing

@testable import PhotosProfilerSupport

private final class PhotoLibraryAuthorizationStatusRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var statuses: [PHAuthorizationStatus] = []

  func record(_ status: PHAuthorizationStatus) {
    lock.lock()
    statuses.append(status)
    lock.unlock()
  }

  func snapshot() -> [PHAuthorizationStatus] {
    lock.lock()
    defer { lock.unlock() }
    return statuses
  }
}

@Suite("Photo library authorization resolution")
struct PhotoLibraryAuthorizationResolutionTests {
  @Test("Only the first callback or timeout resolution is delivered")
  func firstResolutionWins() {
    let callbackFirstRecorder = PhotoLibraryAuthorizationStatusRecorder()
    let callbackFirst = PhotoLibraryAuthorizationResolution(
      handler: callbackFirstRecorder.record
    )
    #expect(callbackFirst.resolve(.authorized))
    #expect(!callbackFirst.resolve(.notDetermined))
    #expect(callbackFirstRecorder.snapshot() == [.authorized])

    let timeoutFirstRecorder = PhotoLibraryAuthorizationStatusRecorder()
    let timeoutFirst = PhotoLibraryAuthorizationResolution(
      handler: timeoutFirstRecorder.record
    )
    #expect(timeoutFirst.resolve(.notDetermined))
    #expect(!timeoutFirst.resolve(.authorized))
    #expect(timeoutFirstRecorder.snapshot() == [.notDetermined])
  }

  @Test("Concurrent callback and timeout resolution remains one-shot")
  func concurrentResolutionRemainsOneShot() {
    for _ in 0..<100 {
      let recorder = PhotoLibraryAuthorizationStatusRecorder()
      let resolution = PhotoLibraryAuthorizationResolution(handler: recorder.record)
      let start = DispatchSemaphore(value: 0)
      let group = DispatchGroup()
      for status in [PHAuthorizationStatus.authorized, .notDetermined] {
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
          start.wait()
          resolution.resolve(status)
          group.leave()
        }
      }
      start.signal()
      start.signal()

      #expect(group.wait(timeout: .now() + 1) == .success)
      #expect(recorder.snapshot().count == 1)
    }
  }
}
