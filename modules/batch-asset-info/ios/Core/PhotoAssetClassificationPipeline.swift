import Foundation
import Photos

final class PhotoAssetClassificationLifecycleGate: @unchecked Sendable {
  private let condition = NSCondition()
  private var isDestroyed = false
  private var activeAdmissionCount = 0

  func admit() -> Bool {
    condition.lock()
    defer { condition.unlock() }
    return !isDestroyed
  }

  @discardableResult
  func performIfActive<Result>(_ operation: () throws -> Result) rethrows -> Result? {
    condition.lock()
    guard !isDestroyed else {
      condition.unlock()
      return nil
    }
    activeAdmissionCount += 1
    condition.unlock()

    defer {
      condition.lock()
      activeAdmissionCount -= 1
      if activeAdmissionCount == 0 {
        condition.broadcast()
      }
      condition.unlock()
    }
    return try operation()
  }

  func destroy() {
    condition.lock()
    isDestroyed = true
    while activeAdmissionCount > 0 {
      condition.wait()
    }
    condition.unlock()
  }
}

struct PhotoAssetClassificationRuntimeConfiguration: Equatable, Sendable {
  static let visionConcurrencyEnvironmentKey = "PALATE_VISION_CONCURRENCY"
  static let pipelineDepthEnvironmentKey = "PALATE_VISION_PIPELINE_DEPTH"
  static let resultPageSizeEnvironmentKey = "PALATE_VISION_RESULT_PAGE_SIZE"
  static let defaultResultPageSize = 1_000
  static let maximumVisionConcurrency = 16
  static let maximumPipelineDepth = 64
  static let maximumResultPageSize = 2_000

  let visionConcurrency: Int
  let pipelineMaximumInFlight: Int
  let resultPageSize: Int

  static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> PhotoAssetClassificationRuntimeConfiguration {
    PhotoAssetClassificationRuntimeConfiguration(
      visionConcurrency: positiveBoundedInteger(
        environment[visionConcurrencyEnvironmentKey],
        maximum: maximumVisionConcurrency,
        fallback: PhotoAssetClassifier.recommendedConcurrency
      ),
      pipelineMaximumInFlight: positiveBoundedInteger(
        environment[pipelineDepthEnvironmentKey],
        maximum: maximumPipelineDepth,
        fallback: PhotoAssetClassificationPipeline.defaultMaximumInFlight
      ),
      resultPageSize: positiveBoundedInteger(
        environment[resultPageSizeEnvironmentKey],
        maximum: maximumResultPageSize,
        fallback: defaultResultPageSize
      )
    )
  }

  private static func positiveBoundedInteger(
    _ value: String?,
    maximum: Int,
    fallback: Int
  ) -> Int {
    guard let value, let parsed = Int(value), (1...maximum).contains(parsed) else {
      return fallback
    }
    return parsed
  }
}

public final class PhotoAssetClassificationPipeline: @unchecked Sendable {
  public static let defaultMaximumInFlight = 4

  private let ownerID = UUID()
  private let imageManager: PHCachingImageManager
  private let classifier: PhotoAssetClassifier
  private let maximumInFlight: Int
  private let visionQueue: OperationQueue
  private let coordinator = PhotoAssetClassificationPipelineCoordinator.shared
  private let lifecycleLock = NSLock()
  private var sessions: [UUID: PhotoAssetClassificationPipelineSession] = [:]
  private var isShutdown = false

  public convenience init(
    imageManager: PHCachingImageManager = PHCachingImageManager(),
    maximumInFlight: Int = PhotoAssetClassificationPipeline.defaultMaximumInFlight,
    visionConcurrency: Int = PhotoAssetClassifier.recommendedConcurrency
  ) {
    precondition(visionConcurrency > 0, "Photo classification visionConcurrency must be positive")
    let queue = OperationQueue()
    queue.name = "com.jonluca.palate.photo-classification-pipeline.vision"
    queue.qualityOfService = .userInitiated
    queue.maxConcurrentOperationCount = visionConcurrency
    self.init(
      imageManager: imageManager,
      maximumInFlight: maximumInFlight,
      visionQueue: queue
    )
  }

  public init(
    imageManager: PHCachingImageManager = PHCachingImageManager(),
    maximumInFlight: Int = PhotoAssetClassificationPipeline.defaultMaximumInFlight,
    visionQueue: OperationQueue
  ) {
    precondition(maximumInFlight > 0, "Photo classification maximumInFlight must be positive")
    self.imageManager = imageManager
    classifier = PhotoAssetClassifier()
    self.maximumInFlight = maximumInFlight
    self.visionQueue = visionQueue
  }

  deinit {
    shutdown()
  }

  public func classify(
    assets: [PHAsset],
    options: PhotoAssetClassificationOptions,
    completion: @escaping @Sendable ([PhotoAssetClassificationOutcome]) -> Void
  ) {
    let session = PhotoAssetClassificationPipelineSession(
      ownerID: ownerID,
      assets: assets,
      options: options,
      imageManager: imageManager,
      classifier: classifier,
      maximumInFlight: maximumInFlight,
      visionQueue: visionQueue,
      completion: completion,
      lifecycleCompletion: { [weak self, coordinator] sessionID in
        self?.removeSession(id: sessionID)
        coordinator.sessionDidFinish(id: sessionID)
      }
    )

    guard register(session) else {
      completion(Self.cancelledOutcomes(for: assets))
      return
    }
    coordinator.enqueue(session)
  }

  public func shutdown() {
    lifecycleLock.lock()
    guard !isShutdown else {
      lifecycleLock.unlock()
      return
    }
    isShutdown = true
    let sessionsToCancel = Array(sessions.values)
    sessions.removeAll(keepingCapacity: false)
    lifecycleLock.unlock()

    for session in sessionsToCancel {
      session.cancel(suppressCompletion: true)
    }
    coordinator.cancelSessions(ownerID: ownerID)
  }

  private func register(_ session: PhotoAssetClassificationPipelineSession) -> Bool {
    lifecycleLock.lock()
    defer { lifecycleLock.unlock() }
    guard !isShutdown else {
      return false
    }
    sessions[session.id] = session
    return true
  }

  private func removeSession(id: UUID) {
    lifecycleLock.lock()
    sessions.removeValue(forKey: id)
    lifecycleLock.unlock()
  }

  private static func cancelledOutcomes(for assets: [PHAsset])
    -> [PhotoAssetClassificationOutcome]
  {
    assets.map { asset in
      .failure(
        assetId: asset.localIdentifier,
        message: PhotoAssetClassificationError.imageRequestCancelled(
          assetId: asset.localIdentifier
        ).localizedDescription
      )
    }
  }
}
