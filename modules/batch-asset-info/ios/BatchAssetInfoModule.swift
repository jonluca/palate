import ExpoModulesCore
import Photos

public class BatchAssetInfoModule: Module {
  private static let visionClassificationStrategyEnvironmentKey =
    "PALATE_VISION_CLASSIFICATION_STRATEGY"
  private let thumbnailPreheatOwnerID = UUID()
  private let processingQueue = DispatchQueue(
    label: "com.batchassetinfo.processing", qos: .userInitiated, attributes: .concurrent)
  private let assetInfoQueue = DispatchQueue(
    label: "com.batchassetinfo.metadata", qos: .userInitiated)
  private let imageClassifier = PhotoAssetClassifier()
  private let classificationLifecycle = PhotoAssetClassificationLifecycleGate()
  private let visionResultTransportRuntimeAttestation =
    PhotoAssetVisionResultTransportRuntimeAttestation()
  private let visionAttestationDispatchLock = NSLock()
  private var activeVisionAttestationDispatches:
    Set<PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch> = []
  private var assetScanSessions: [String: PhotoAssetScanSession] = [:]

  private let classificationResources:
    (
      configuration: PhotoAssetClassificationRuntimeConfiguration,
      queue: OperationQueue,
      pipeline: PhotoAssetClassificationPipeline
    ) = {
      let configuration = PhotoAssetClassificationRuntimeConfiguration.resolve()
      let queue = OperationQueue()
      queue.name = "com.batchassetinfo.classification"
      queue.qualityOfService = .userInitiated
      queue.maxConcurrentOperationCount = configuration.visionConcurrency
      return (
        configuration,
        queue,
        PhotoAssetClassificationPipeline(
          maximumInFlight: configuration.pipelineMaximumInFlight,
          visionQueue: queue
        )
      )
    }()

  public func definition() -> ModuleDefinition {
    Name("BatchAssetInfo")

    Constant("supportsPhotoAssetThumbnailView") {
      true
    }

    Constant("supportsPhotoAssetThumbnailPreheat") {
      true
    }

    Constant("resolvedPhotoAssetThumbnailPreheatStrategy") {
      PhotoAssetThumbnailPreheatStrategy.resolve().rawValue
    }

    Constant("resolvedPhotoScanStrategy") {
      PhotoAssetScanStrategy.resolve().rawValue
    }

    Constant("resolvedVisitFoodDetectionStrategy") {
      PhotoAssetVisitFoodDetectionStrategy.resolve().rawValue
    }

    Function("isVisionVisitFoodValidationModeEnabled") {
      PhotoAssetVisionVisitFoodValidationMode.isEnabled()
    }

    Constant("visionResultPageSize") {
      PhotoAssetClassificationRuntimeConfiguration.resolve().resultPageSize
    }

    Constant("resolvedVisionPageOrchestrationStrategy") {
      PhotoAssetClassificationRuntimeConfiguration.resolve().pageOrchestrationStrategy.rawValue
    }

    Constant("resolvedVisionResultTransport") {
      self.classificationResources.configuration.resultTransport.rawValue
    }

    OnDestroy {
      self.classificationLifecycle.destroy()
      self.classificationResources.pipeline.shutdown()
      self.classificationResources.queue.cancelAllOperations()
      self.cancelAllVisionAttestationDispatches()
      self.assetInfoQueue.async {
        self.assetScanSessions.removeAll()
      }
      PhotoAssetThumbnailStore.shared.endPreheat(ownerID: self.thumbnailPreheatOwnerID)
      // The bounded thumbnail store is process-wide and can still serve views owned by a newer
      // AppContext during a bridge reload. Clearing it here can cancel those views without a
      // matching lifecycle update, leaving every thumbnail blank.
    }

    View(PhotoAssetThumbnailView.self) {
      Events("onLoad", "onError")

      Prop("uri") { (view: PhotoAssetThumbnailView, uri: String?) in
        view.uri = uri
      }

      OnViewDidUpdateProps { view in
        view.applyChanges()
      }
    }

    AsyncFunction("clearPhotoAssetThumbnailCache") { (promise: Promise) in
      PhotoAssetThumbnailStore.shared.clearCaches {
        promise.resolve(nil)
      }
    }

    Function("updatePhotoAssetThumbnailPreheat") {
      (scopeID: String, uris: [String], pixelWidth: Int, pixelHeight: Int) -> Bool in
      guard PhotoAssetThumbnailPreheatStrategy.resolve() == .windowedV1,
        let request = PhotoAssetThumbnailPreheatRequest(
          scopeID: scopeID,
          uris: uris,
          pixelWidth: pixelWidth,
          pixelHeight: pixelHeight
        )
      else {
        return false
      }

      PhotoAssetThumbnailStore.shared.updatePreheat(
        ownerID: self.thumbnailPreheatOwnerID,
        scopeID: request.scopeID,
        candidates: request.keys
      )
      return true
    }

    Function("endPhotoAssetThumbnailPreheat") { (scopeID: String) -> Bool in
      guard PhotoAssetThumbnailPreheatStrategy.resolve() == .windowedV1,
        !scopeID.isEmpty
      else {
        return false
      }
      PhotoAssetThumbnailStore.shared.endPreheat(
        ownerID: self.thumbnailPreheatOwnerID,
        scopeID: scopeID
      )
      return true
    }

    AsyncFunction("getAssetInfoBatch") { (assetIds: [String], promise: Promise) in
      self.fetchAssetInfoBatch(assetIds: assetIds, promise: promise)
    }

    AsyncFunction("getAssetInfoBatchWithOptions") {
      (assetIds: [String], options: GetAssetInfoOptions, promise: Promise) in
      self.fetchAssetInfoBatch(
        assetIds: assetIds, includeLocation: options.includeLocation, promise: promise)
    }

    AsyncFunction("beginAssetScan") { () throws -> [String: Any] in
      do {
        return try self.beginAssetScanSession()
      } catch {
        throw self.assetScanException(error)
      }
    }.runOnQueue(assetInfoQueue)

    AsyncFunction("beginIncrementalAssetScan") {
      (existingAssetIds: [String]) throws -> [String: Any] in
      do {
        return try self.beginAssetScanSession(existingAssetIdentifiers: existingAssetIds)
      } catch {
        throw self.assetScanException(error)
      }
    }.runOnQueue(assetInfoQueue)

    AsyncFunction("beginDatabaseBackedIncrementalAssetScan") {
      (databasePath: String) throws -> [String: Any] in
      do {
        let session = try PhotoAssetScanSession(databasePath: databasePath)
        return try self.retainAssetScanSession(
          session,
          selectedScanImplementation: .databaseBacked
        )
      } catch {
        throw self.assetScanException(error)
      }
    }.runOnQueue(assetInfoQueue)

    AsyncFunction("getAssetScanPage") {
      (sessionId: String, offset: Int, limit: Int) throws -> [String: Any?] in
      guard let session = self.assetScanSessions[sessionId] else {
        throw self.assetScanSessionNotFoundException(sessionId: sessionId)
      }

      do {
        return self.assetScanPageDictionary(try session.page(offset: offset, limit: limit))
      } catch {
        throw self.assetScanException(error)
      }
    }.runOnQueue(assetInfoQueue)

    AsyncFunction("endAssetScan") { (sessionId: String) throws -> Void in
      guard self.assetScanSessions.removeValue(forKey: sessionId) != nil else {
        throw self.assetScanSessionNotFoundException(sessionId: sessionId)
      }
    }.runOnQueue(assetInfoQueue)

    AsyncFunction("classifyImage") {
      (assetId: String, options: ClassificationOptions, promise: Promise) in
      self.classifySingleImage(
        assetId: assetId, confidenceThreshold: options.confidenceThreshold,
        maxLabels: options.maxLabels, promise: promise)
    }

    AsyncFunction("classifyImageBatch") {
      (assetIds: [String], options: ClassificationOptions, promise: Promise) in
      self.classifyImageBatch(
        assetIds: assetIds, confidenceThreshold: options.confidenceThreshold,
        maxLabels: options.maxLabels, resultTransport: .legacy, promise: promise)
    }

    AsyncFunction("classifyImageBatchPackedV1") {
      (assetIds: [String], options: ClassificationOptions, promise: Promise) in
      self.classifyImageBatch(
        assetIds: assetIds, confidenceThreshold: options.confidenceThreshold,
        maxLabels: options.maxLabels, resultTransport: .packedV1, promise: promise)
    }
  }

  private func fetchAssetInfoBatch(
    assetIds: [String], includeLocation: Bool = true, promise: Promise
  ) {
    assetInfoQueue.async {
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: assetIds, options: nil)

      var results: [[String: Any?]] = []
      results.reserveCapacity(assetIds.count)

      fetchResult.enumerateObjects { asset, _, _ in
        let metadata = PhotoAssetMetadata(asset: asset)
        results.append(self.legacyAssetInfoDictionary(metadata, includeLocation: includeLocation))
      }

      promise.resolve(results)
    }
  }

  private func beginAssetScanSession(
    existingAssetIdentifiers: [String]? = nil
  ) throws -> [String: Any] {
    let session: PhotoAssetScanSession
    let selectedScanImplementation: PhotoAssetScanImplementation
    if let existingAssetIdentifiers {
      session = try PhotoAssetScanSession(existingAssetIdentifiers: existingAssetIdentifiers)
      selectedScanImplementation = .identifierList
    } else {
      session = try PhotoAssetScanSession()
      selectedScanImplementation = .legacy
    }

    return try retainAssetScanSession(
      session,
      selectedScanImplementation: selectedScanImplementation
    )
  }

  private func retainAssetScanSession(
    _ session: PhotoAssetScanSession,
    selectedScanImplementation: PhotoAssetScanImplementation
  ) throws -> [String: Any] {
    try PhotoAssetScanRuntimeAttestation.writeIfRequested(
      selectedScanImplementation: selectedScanImplementation,
      metrics: PhotoAssetScanRuntimeAttestation.Metrics(
        libraryTotalCount: session.libraryTotalCount,
        unknownVisibleCount: session.totalCount,
        excludedVisibleCount: session.excludedVisibleCount,
        excludedPhotosWithLocation: session.excludedPhotosWithLocation,
        excludedSkippedAssets: session.excludedSkippedAssets
      )
    )

    let sessionId = UUID().uuidString
    assetScanSessions[sessionId] = session
    return [
      "sessionId": sessionId,
      "totalCount": session.totalCount,
      "libraryTotalCount": session.libraryTotalCount,
      "excludedVisibleCount": session.excludedVisibleCount,
      "excludedPhotosWithLocation": session.excludedPhotosWithLocation,
      "excludedSkippedAssets": session.excludedSkippedAssets,
      "maxPageSize": PhotoAssetScanSession.maximumPageSize,
    ]
  }

  private func legacyAssetInfoDictionary(
    _ metadata: PhotoAssetMetadata,
    includeLocation: Bool
  ) -> [String: Any?] {
    var info: [String: Any?] = [
      "id": metadata.id,
      "uri": metadata.uri,
      "creationTime": metadata.creationTime ?? 0,
      "modificationTime": metadata.modificationTime ?? 0,
      "width": metadata.width,
      "height": metadata.height,
      "mediaType": metadata.mediaType.rawValue,
      "duration": metadata.duration,
    ]

    if includeLocation, let location = metadata.location {
      info["location"] = [
        "latitude": location.latitude,
        "longitude": location.longitude,
        "altitude": location.altitude,
        "speed": location.speed,
        "heading": location.heading,
      ]
    } else {
      info["location"] = nil
    }

    return info
  }

  private func assetScanPageDictionary(_ page: PhotoAssetScanPage) -> [String: Any?] {
    let assets: [[String: Any?]] = page.assets.map { asset in
      [
        "id": asset.id,
        "uri": asset.uri,
        "creationTime": asset.creationTime,
        "latitude": asset.latitude,
        "longitude": asset.longitude,
        "mediaType": asset.mediaType.rawValue,
        "duration": asset.duration,
      ]
    }

    return [
      "assets": assets,
      "offset": page.offset,
      "nextOffset": page.nextOffset,
      "totalCount": page.totalCount,
      "hasNextPage": page.hasNextPage,
    ]
  }

  private func assetScanException(_ error: Error) -> Exception {
    guard let scanError = error as? PhotoAssetScanError else {
      return Exception(
        name: "AssetScanError",
        description: error.localizedDescription,
        code: "ERR_ASSET_SCAN_FAILED"
      )
    }

    return Exception(
      name: "AssetScanError",
      description: scanError.localizedDescription,
      code: scanError.code
    )
  }

  private func assetScanSessionNotFoundException(sessionId: String) -> Exception {
    Exception(
      name: "AssetScanSessionNotFoundError",
      description:
        "Asset scan session \(sessionId.isEmpty ? "<empty>" : sessionId) does not exist or has ended.",
      code: "ERR_ASSET_SCAN_SESSION_NOT_FOUND"
    )
  }

  // MARK: - Image Classification

  private func classifySingleImage(
    assetId: String, confidenceThreshold: Float, maxLabels: Int, promise: Promise
  ) {
    processingQueue.async {
      guard self.classificationLifecycle.admit() else {
        return
      }
      let classificationOptions: PhotoAssetClassificationOptions
      do {
        classificationOptions = try PhotoAssetClassificationOptions(
          confidenceThreshold: confidenceThreshold,
          maximumLabelCount: maxLabels
        )
      } catch {
        self.classificationLifecycle.performIfActive {
          promise.reject("INVALID_CLASSIFICATION_OPTIONS", error.localizedDescription)
        }
        return
      }

      guard self.classificationLifecycle.admit() else {
        return
      }
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)

      guard let asset = fetchResult.firstObject else {
        self.classificationLifecycle.performIfActive {
          promise.reject("ASSET_NOT_FOUND", "Asset with id \(assetId) not found")
        }
        return
      }

      let operation = BlockOperation {
        guard self.classificationLifecycle.admit() else {
          return
        }
        let result = autoreleasepool {
          self.imageClassifier.classify(asset: asset, options: classificationOptions)
        }

        self.classificationLifecycle.performIfActive {
          switch result {
          case .success(let classificationResult):
            promise.resolve(self.classificationDictionary(classificationResult))
          case .failure(let error):
            promise.reject("CLASSIFICATION_FAILED", error.localizedDescription)
          }
        }
      }
      self.classificationLifecycle.performIfActive {
        self.classificationResources.queue.addOperation(operation)
      }
    }
  }

  private func classifyImageBatch(
    assetIds: [String], confidenceThreshold: Float, maxLabels: Int,
    resultTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport,
    promise: Promise
  ) {
    let attestationDispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?
    do {
      attestationDispatch = try beginVisionAttestationDispatch(
        selectedTransport: resultTransport,
        requestedAssetCount: assetIds.count
      )
    } catch {
      promise.reject(
        "VISION_RESULT_TRANSPORT_ATTESTATION_FAILED",
        error.localizedDescription
      )
      return
    }

    processingQueue.async {
      guard self.classificationLifecycle.admit() else {
        self.cancelVisionAttestationDispatch(attestationDispatch)
        return
      }
      let classificationOptions: PhotoAssetClassificationOptions
      do {
        classificationOptions = try PhotoAssetClassificationOptions(
          confidenceThreshold: confidenceThreshold,
          maximumLabelCount: maxLabels
        )
      } catch {
        let rejected: Bool? = self.classificationLifecycle.performIfActive {
          guard
            self.completeVisionAttestationDispatch(
              attestationDispatch,
              completion: .rejected,
              promise: promise
            )
          else {
            return true
          }
          promise.reject("INVALID_CLASSIFICATION_OPTIONS", error.localizedDescription)
          return true
        }
        if rejected == nil {
          self.cancelVisionAttestationDispatch(attestationDispatch)
        }
        return
      }

      guard self.classificationLifecycle.admit() else {
        self.cancelVisionAttestationDispatch(attestationDispatch)
        return
      }
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: assetIds, options: nil)

      var requestedIndexById: [String: Int] = [:]
      requestedIndexById.reserveCapacity(assetIds.count)
      for (index, assetId) in assetIds.enumerated() where requestedIndexById[assetId] == nil {
        requestedIndexById[assetId] = index
      }

      var indexedAssets: [(asset: PHAsset, index: Int)] = []
      indexedAssets.reserveCapacity(fetchResult.count)
      fetchResult.enumerateObjects { asset, _, _ in
        guard let index = requestedIndexById[asset.localIdentifier] else {
          return
        }
        indexedAssets.append((asset: asset, index: index))
      }

      if indexedAssets.isEmpty {
        let delivered: Bool? = self.classificationLifecycle.performIfActive {
          switch resultTransport {
          case .legacy:
            guard
              self.completeVisionAttestationDispatch(
                attestationDispatch,
                completion: .resolved,
                promise: promise
              )
            else {
              return true
            }
            promise.resolve([])
          case .packedV1:
            self.resolvePackedClassificationBatch(
              requestedAssetIds: assetIds,
              outcomes: [],
              attestationDispatch: attestationDispatch,
              promise: promise
            )
          }
          return true
        }
        if delivered == nil {
          self.cancelVisionAttestationDispatch(attestationDispatch)
        }
        return
      }

      if ProcessInfo.processInfo.environment[Self.visionClassificationStrategyEnvironmentKey]
        == "baseline"
      {
        switch resultTransport {
        case .legacy:
          self.classifyImageBatchWithSynchronousBaseline(
            indexedAssets: indexedAssets,
            assetCount: assetIds.count,
            options: classificationOptions,
            attestationDispatch: attestationDispatch,
            promise: promise
          )
        case .packedV1:
          self.classifyImageBatchPackedV1WithSynchronousBaseline(
            indexedAssets: indexedAssets,
            requestedAssetIds: assetIds,
            options: classificationOptions,
            attestationDispatch: attestationDispatch,
            promise: promise
          )
        }
      } else {
        self.classifyImageBatchWithPipeline(
          indexedAssets: indexedAssets,
          requestedAssetIds: assetIds,
          requestedIndexById: requestedIndexById,
          options: classificationOptions,
          resultTransport: resultTransport,
          attestationDispatch: attestationDispatch,
          promise: promise
        )
      }
    }
  }

  private func classifyImageBatchWithPipeline(
    indexedAssets: [(asset: PHAsset, index: Int)],
    requestedAssetIds: [String],
    requestedIndexById: [String: Int],
    options: PhotoAssetClassificationOptions,
    resultTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport,
    attestationDispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?,
    promise: Promise
  ) {
    let scheduled: Bool? = classificationLifecycle.performIfActive {
      classificationResources.pipeline.classify(
        assets: indexedAssets.map(\.asset),
        options: options
      ) { outcomes in
        let delivered: Bool? = self.classificationLifecycle.performIfActive {
          switch resultTransport {
          case .legacy:
            let results = self.legacyClassificationResults(
              outcomes: outcomes,
              requestedIndexById: requestedIndexById,
              assetCount: requestedAssetIds.count
            )
            guard
              self.completeVisionAttestationDispatch(
                attestationDispatch,
                completion: .resolved,
                promise: promise
              )
            else {
              return true
            }
            promise.resolve(
              results
            )
          case .packedV1:
            self.resolvePackedClassificationBatch(
              requestedAssetIds: requestedAssetIds,
              outcomes: outcomes,
              attestationDispatch: attestationDispatch,
              promise: promise
            )
          }
          return true
        }
        if delivered == nil {
          self.cancelVisionAttestationDispatch(attestationDispatch)
        }
      }
      return true
    }
    if scheduled == nil {
      cancelVisionAttestationDispatch(attestationDispatch)
    }
  }

  private func classifyImageBatchWithSynchronousBaseline(
    indexedAssets: [(asset: PHAsset, index: Int)],
    assetCount: Int,
    options: PhotoAssetClassificationOptions,
    attestationDispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?,
    promise: Promise
  ) {
    let scheduled: Bool? = classificationLifecycle.performIfActive {
      var orderedResults = [[String: Any]?](
        repeating: nil,
        count: assetCount
      )
      let resultsLock = NSLock()
      let group = DispatchGroup()
      for indexedAsset in indexedAssets {
        group.enter()
        let operation = BlockOperation {
          guard self.classificationLifecycle.admit() else {
            return
          }
          let result = autoreleasepool {
            self.imageClassifier.classify(asset: indexedAsset.asset, options: options)
          }
          let classificationResult: [String: Any]
          switch result {
          case .success(let classification):
            classificationResult = self.classificationDictionary(classification)
          case .failure(let error):
            classificationResult = [
              "assetId": indexedAsset.asset.localIdentifier,
              "labels": [],
              "error": error.localizedDescription,
            ]
          }
          resultsLock.lock()
          orderedResults[indexedAsset.index] = classificationResult
          resultsLock.unlock()
        }
        operation.completionBlock = {
          group.leave()
        }
        classificationResources.queue.addOperation(operation)
      }
      group.notify(queue: processingQueue) {
        let delivered: Bool? = self.classificationLifecycle.performIfActive {
          guard
            self.completeVisionAttestationDispatch(
              attestationDispatch,
              completion: .resolved,
              promise: promise
            )
          else {
            return true
          }
          promise.resolve(orderedResults.compactMap { $0 })
          return true
        }
        if delivered == nil {
          self.cancelVisionAttestationDispatch(attestationDispatch)
        }
      }
      return true
    }
    if scheduled == nil {
      cancelVisionAttestationDispatch(attestationDispatch)
    }
  }

  private func classifyImageBatchPackedV1WithSynchronousBaseline(
    indexedAssets: [(asset: PHAsset, index: Int)],
    requestedAssetIds: [String],
    options: PhotoAssetClassificationOptions,
    attestationDispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?,
    promise: Promise
  ) {
    let scheduled: Bool? = classificationLifecycle.performIfActive {
      var orderedOutcomes = [PhotoAssetClassificationOutcome?](
        repeating: nil,
        count: requestedAssetIds.count
      )
      let resultsLock = NSLock()
      let group = DispatchGroup()
      for indexedAsset in indexedAssets {
        group.enter()
        let operation = BlockOperation {
          guard self.classificationLifecycle.admit() else {
            return
          }
          let result = autoreleasepool {
            self.imageClassifier.classify(asset: indexedAsset.asset, options: options)
          }
          let outcome: PhotoAssetClassificationOutcome
          switch result {
          case .success(let classification):
            outcome = .success(classification)
          case .failure(let error):
            outcome = .failure(
              assetId: indexedAsset.asset.localIdentifier,
              message: error.localizedDescription
            )
          }
          resultsLock.lock()
          orderedOutcomes[indexedAsset.index] = outcome
          resultsLock.unlock()
        }
        operation.completionBlock = {
          group.leave()
        }
        classificationResources.queue.addOperation(operation)
      }
      group.notify(queue: processingQueue) {
        let delivered: Bool? = self.classificationLifecycle.performIfActive {
          self.resolvePackedClassificationBatch(
            requestedAssetIds: requestedAssetIds,
            outcomes: orderedOutcomes.compactMap { $0 },
            attestationDispatch: attestationDispatch,
            promise: promise
          )
          return true
        }
        if delivered == nil {
          self.cancelVisionAttestationDispatch(attestationDispatch)
        }
      }
      return true
    }
    if scheduled == nil {
      cancelVisionAttestationDispatch(attestationDispatch)
    }
  }

  private func resolvePackedClassificationBatch(
    requestedAssetIds: [String],
    outcomes: [PhotoAssetClassificationOutcome],
    attestationDispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?,
    promise: Promise
  ) {
    let slots = PhotoAssetClassificationBatchSlot.make(
      requestedAssetIds: requestedAssetIds,
      outcomes: outcomes
    )
    do {
      let data = try PhotoAssetClassificationPackedResultV1Encoder.encode(slots)
      guard
        completeVisionAttestationDispatch(
          attestationDispatch,
          completion: .resolved,
          promise: promise
        )
      else {
        return
      }
      promise.resolve(NativeArrayBuffer.wrap(dataWithoutCopy: data))
    } catch {
      guard
        completeVisionAttestationDispatch(
          attestationDispatch,
          completion: .rejected,
          promise: promise
        )
      else {
        return
      }
      promise.reject("PACKED_CLASSIFICATION_ENCODING_FAILED", error.localizedDescription)
    }
  }

  @discardableResult
  private func beginVisionAttestationDispatch(
    selectedTransport: PhotoAssetClassificationRuntimeConfiguration.ResultTransport,
    requestedAssetCount: Int
  ) throws -> PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch? {
    visionAttestationDispatchLock.lock()
    defer { visionAttestationDispatchLock.unlock() }
    let dispatch = try visionResultTransportRuntimeAttestation.beginDispatchIfRequested(
      selectedTransport: selectedTransport,
      requestedAssetCount: requestedAssetCount
    )
    if let dispatch {
      activeVisionAttestationDispatches.insert(dispatch)
    }
    return dispatch
  }

  @discardableResult
  private func completeVisionAttestationDispatch(
    _ dispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?,
    completion: PhotoAssetVisionResultTransportRuntimeAttestation.DispatchCompletion,
    promise: Promise
  ) -> Bool {
    visionAttestationDispatchLock.lock()
    do {
      try visionResultTransportRuntimeAttestation.completeDispatchIfRequested(
        dispatch,
        completion: completion
      )
      if let dispatch {
        activeVisionAttestationDispatches.remove(dispatch)
      }
      visionAttestationDispatchLock.unlock()
      return true
    } catch {
      visionAttestationDispatchLock.unlock()
      promise.reject(
        "VISION_RESULT_TRANSPORT_ATTESTATION_FAILED",
        error.localizedDescription
      )
      return false
    }
  }

  private func cancelVisionAttestationDispatch(
    _ dispatch: PhotoAssetVisionResultTransportRuntimeAttestation.Dispatch?
  ) {
    visionAttestationDispatchLock.lock()
    defer { visionAttestationDispatchLock.unlock() }
    _ = try? visionResultTransportRuntimeAttestation.completeDispatchIfRequested(
      dispatch,
      completion: .cancelled
    )
    if let dispatch {
      activeVisionAttestationDispatches.remove(dispatch)
    }
  }

  private func cancelAllVisionAttestationDispatches() {
    visionAttestationDispatchLock.lock()
    defer { visionAttestationDispatchLock.unlock() }
    for dispatch in activeVisionAttestationDispatches {
      _ = try? visionResultTransportRuntimeAttestation.completeDispatchIfRequested(
        dispatch,
        completion: .cancelled
      )
    }
    activeVisionAttestationDispatches.removeAll()
  }

  private func legacyClassificationResults(
    outcomes: [PhotoAssetClassificationOutcome],
    requestedIndexById: [String: Int],
    assetCount: Int
  ) -> [[String: Any]] {
    var orderedResults = [[String: Any]?](repeating: nil, count: assetCount)
    for outcome in outcomes {
      guard let index = requestedIndexById[outcome.assetId] else {
        continue
      }
      switch outcome {
      case .success(let classification):
        orderedResults[index] = classificationDictionary(classification)
      case .failure(let assetId, let message):
        orderedResults[index] = [
          "assetId": assetId,
          "labels": [],
          "error": message,
        ]
      }
    }
    return orderedResults.compactMap { $0 }
  }

  private func classificationDictionary(_ classification: PhotoAssetClassification) -> [String: Any]
  {
    [
      "assetId": classification.assetId,
      "labels": classification.labels.map { label in
        [
          "label": label.identifier,
          "confidence": label.confidence,
        ]
      },
    ]
  }

}
