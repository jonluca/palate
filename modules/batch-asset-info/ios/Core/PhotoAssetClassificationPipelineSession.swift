import Foundation
@preconcurrency import Photos

final class PhotoAssetClassificationPipelineSession: @unchecked Sendable {
  let id = UUID()
  let ownerID: UUID

  private let assets: [PHAsset]
  private let options: PhotoAssetClassificationOptions
  private let imageManager: PHCachingImageManager
  private let classifier: PhotoAssetClassifier
  private var completion: (@Sendable ([PhotoAssetClassificationOutcome]) -> Void)?
  private let lifecycleCompletion: @Sendable (UUID) -> Void
  private let stateQueue: DispatchQueue
  private let visionQueue: OperationQueue
  private let cancellationLock = NSLock()
  private var cancellationRequested = false
  private var shouldDeliverCompletion = true

  private var outcomes: [PhotoAssetClassificationOutcome?]
  private var imageRequestIDs: [Int: PHImageRequestID] = [:]
  private var visionOperations: [Int: PhotoAssetClassificationPipelineVisionOperation] = [:]
  private var scheduler: PhotoAssetClassificationPipelineScheduler
  private var didStart = false
  private var didComplete = false

  init(
    ownerID: UUID,
    assets: [PHAsset],
    options: PhotoAssetClassificationOptions,
    imageManager: PHCachingImageManager,
    classifier: PhotoAssetClassifier,
    maximumInFlight: Int,
    visionQueue: OperationQueue,
    stateQueue: DispatchQueue = DispatchQueue(
      label: "com.jonluca.palate.photo-classification-pipeline.state",
      qos: .userInitiated
    ),
    completion: @escaping @Sendable ([PhotoAssetClassificationOutcome]) -> Void,
    lifecycleCompletion: @escaping @Sendable (UUID) -> Void
  ) {
    self.ownerID = ownerID
    self.assets = assets
    self.options = options
    self.imageManager = imageManager
    self.classifier = classifier
    self.completion = completion
    self.lifecycleCompletion = lifecycleCompletion
    outcomes = Array(repeating: nil, count: assets.count)
    scheduler = PhotoAssetClassificationPipelineScheduler(
      itemCount: assets.count,
      maximumInFlight: maximumInFlight
    )

    self.visionQueue = visionQueue
    self.stateQueue = stateQueue
  }

  func start() {
    stateQueue.async { [self] in
      guard !didStart, !didComplete else {
        return
      }
      didStart = true
      guard !isCancellationRequested else {
        cancelOnStateQueue()
        return
      }
      guard !assets.isEmpty else {
        finishIfNeeded()
        return
      }
      fillAvailableSlots()
    }
  }

  func cancel(suppressCompletion: Bool) {
    cancellationLock.lock()
    cancellationRequested = true
    if suppressCompletion {
      shouldDeliverCompletion = false
    }
    cancellationLock.unlock()

    stateQueue.async { [self] in
      cancelOnStateQueue()
    }
  }

  private func fillAvailableSlots() {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    guard !isCancellationRequested else {
      cancelOnStateQueue()
      return
    }
    for index in scheduler.fillAvailableSlots() {
      requestImage(at: index)
    }
  }

  private func requestImage(at index: Int) {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    let asset = assets[index]
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.isSynchronous = false
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast

    let requestID = imageManager.requestImage(
      for: asset,
      targetSize: PhotoAssetClassifier.defaultTargetSize,
      contentMode: .aspectFit,
      options: options
    ) { [weak self] image, info in
      guard let self else {
        return
      }
      let result = PhotoAssetClassificationImageResult(
        image: image,
        isDegraded: info?[PHImageResultIsDegradedKey] as? Bool ?? false,
        isCancelled: info?[PHImageCancelledKey] as? Bool ?? false,
        errorDescription: (info?[PHImageErrorKey] as? Error)?.localizedDescription
      )
      self.stateQueue.async { [self] in
        self.handleImageResult(result, asset: asset, index: index)
      }
    }
    imageRequestIDs[index] = requestID
    if isCancellationRequested {
      cancelOnStateQueue()
    }
  }

  private func handleImageResult(
    _ result: PhotoAssetClassificationImageResult,
    asset: PHAsset,
    index: Int
  ) {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    guard outcomes[index] == nil, visionOperations[index] == nil else {
      return
    }
    guard !isCancellationRequested else {
      cancelOnStateQueue()
      return
    }
    if let errorDescription = result.errorDescription {
      imageRequestIDs.removeValue(forKey: index)
      complete(
        .failure(assetId: asset.localIdentifier, message: errorDescription),
        at: index
      )
      return
    }
    if result.isCancelled {
      imageRequestIDs.removeValue(forKey: index)
      complete(
        .failure(
          assetId: asset.localIdentifier,
          message: PhotoAssetClassificationError.imageRequestCancelled(
            assetId: asset.localIdentifier
          ).localizedDescription
        ),
        at: index
      )
      return
    }
    if result.isDegraded {
      return
    }
    imageRequestIDs.removeValue(forKey: index)
    guard let image = result.image else {
      complete(
        .failure(
          assetId: asset.localIdentifier,
          message: PhotoAssetClassificationError.imageUnavailable(
            assetId: asset.localIdentifier
          ).localizedDescription
        ),
        at: index
      )
      return
    }

    let operation = PhotoAssetClassificationPipelineVisionOperation(
      image: image,
      assetID: asset.localIdentifier,
      options: options,
      classifier: classifier
    )
    operation.completionBlock = { [weak self, weak operation] in
      guard let self, let operation else {
        return
      }
      stateQueue.async { [self] in
        self.handleVisionOperationCompletion(operation, asset: asset, index: index)
      }
    }
    visionOperations[index] = operation
    visionQueue.addOperation(operation)
  }

  private func handleVisionOperationCompletion(
    _ operation: PhotoAssetClassificationPipelineVisionOperation,
    asset: PHAsset,
    index: Int
  ) {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    guard visionOperations[index] === operation else {
      return
    }
    visionOperations.removeValue(forKey: index)

    if isCancellationRequested || operation.isCancelled {
      complete(cancellationOutcome(for: asset), at: index)
    } else if let outcome = operation.outcome {
      complete(outcome, at: index)
    } else {
      complete(cancellationOutcome(for: asset), at: index)
    }
  }

  private func complete(_ outcome: PhotoAssetClassificationOutcome, at index: Int) {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    guard outcomes[index] == nil else {
      return
    }
    guard scheduler.complete(index: index) else {
      return
    }
    outcomes[index] = outcome
    if isCancellationRequested {
      cancelOnStateQueue()
    } else {
      fillAvailableSlots()
    }
    finishIfNeeded()
  }

  private func cancelOnStateQueue() {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    // A session can be cancelled after its pipeline registers it but before the global
    // coordinator admits it. Defer lifecycle completion until `start()` so the coordinator
    // cannot observe the finish before it has installed the session in its scheduler.
    guard didStart, !didComplete else {
      return
    }

    let requests = imageRequestIDs
    imageRequestIDs.removeAll(keepingCapacity: false)
    for requestID in requests.values {
      imageManager.cancelImageRequest(requestID)
    }

    for index in scheduler.cancelUnstarted() {
      outcomes[index] = cancellationOutcome(for: assets[index])
    }

    for index in scheduler.activeIndices where visionOperations[index] == nil {
      guard scheduler.complete(index: index) else {
        continue
      }
      outcomes[index] = cancellationOutcome(for: assets[index])
    }
    for operation in visionOperations.values {
      operation.cancel()
    }
    finishIfNeeded()
  }

  private func finishIfNeeded() {
    dispatchPrecondition(condition: .onQueue(stateQueue))
    guard !didComplete, scheduler.isComplete else {
      return
    }
    didComplete = true
    let cancelled = isCancellationRequested
    let orderedOutcomes = outcomes.enumerated().map { index, outcome in
      outcome
        ?? (cancelled
          ? cancellationOutcome(for: assets[index])
          : .failure(
            assetId: assets[index].localIdentifier,
            message: PhotoAssetClassificationError.imageUnavailable(
              assetId: assets[index].localIdentifier
            ).localizedDescription
          ))
    }
    let resultCompletion = shouldDeliverResultCompletion ? completion : nil
    completion = nil
    lifecycleCompletion(id)
    resultCompletion?(orderedOutcomes)
  }

  private var isCancellationRequested: Bool {
    cancellationLock.lock()
    defer { cancellationLock.unlock() }
    return cancellationRequested
  }

  private var shouldDeliverResultCompletion: Bool {
    cancellationLock.lock()
    defer { cancellationLock.unlock() }
    return shouldDeliverCompletion
  }

  private func cancellationOutcome(for asset: PHAsset) -> PhotoAssetClassificationOutcome {
    .failure(
      assetId: asset.localIdentifier,
      message: PhotoAssetClassificationError.imageRequestCancelled(
        assetId: asset.localIdentifier
      ).localizedDescription
    )
  }
}
