import Foundation
import Photos
import Testing

@testable import BatchAssetInfoCore

@Suite("Photo classification pipeline session")
struct PhotoAssetClassificationPipelineSessionTests {
  @Test("Cancellation before coordinator start defers lifecycle completion")
  func cancellationBeforeStartDefersLifecycleCompletion() throws {
    let stateQueue = DispatchQueue(
      label: "com.jonluca.palate.tests.photo-classification-pipeline.state"
    )
    let cancellationDrained = DispatchSemaphore(value: 0)
    let lifecycleCompleted = DispatchSemaphore(value: 0)
    let session = PhotoAssetClassificationPipelineSession(
      ownerID: UUID(),
      assets: [],
      options: try PhotoAssetClassificationOptions(
        confidenceThreshold: 0.1,
        maximumLabelCount: 10
      ),
      imageManager: PHCachingImageManager(),
      classifier: PhotoAssetClassifier(),
      maximumInFlight: 1,
      visionQueue: OperationQueue(),
      stateQueue: stateQueue,
      completion: { _ in },
      lifecycleCompletion: { _ in
        lifecycleCompleted.signal()
      }
    )

    session.cancel(suppressCompletion: true)
    stateQueue.async {
      cancellationDrained.signal()
    }

    #expect(cancellationDrained.wait(timeout: .now() + 1) == .success)
    #expect(lifecycleCompleted.wait(timeout: .now()) == .timedOut)

    session.start()

    #expect(lifecycleCompleted.wait(timeout: .now() + 1) == .success)
  }
}
