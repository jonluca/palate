import ExpoModulesCore
import Photos

public class BatchAssetInfoModule: Module {
  private static let visionClassificationStrategyEnvironmentKey =
    "PALATE_VISION_CLASSIFICATION_STRATEGY"
  private let processingQueue = DispatchQueue(
    label: "com.batchassetinfo.processing", qos: .userInitiated, attributes: .concurrent)
  private let assetInfoQueue = DispatchQueue(
    label: "com.batchassetinfo.metadata", qos: .userInitiated)
  private let imageClassifier = PhotoAssetClassifier()
  private let classificationLifecycle = PhotoAssetClassificationLifecycleGate()
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

    Constant("visionResultPageSize") {
      PhotoAssetClassificationRuntimeConfiguration.resolve().resultPageSize
    }

    OnDestroy {
      self.classificationLifecycle.destroy()
      self.classificationResources.pipeline.shutdown()
      self.classificationResources.queue.cancelAllOperations()
      self.assetInfoQueue.async {
        self.assetScanSessions.removeAll()
      }
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
        let session = try PhotoAssetScanSession()
        let sessionId = UUID().uuidString
        self.assetScanSessions[sessionId] = session
        return [
          "sessionId": sessionId,
          "totalCount": session.totalCount,
          "maxPageSize": PhotoAssetScanSession.maximumPageSize,
        ]
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
        maxLabels: options.maxLabels, promise: promise)
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
    assetIds: [String], confidenceThreshold: Float, maxLabels: Int, promise: Promise
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
        self.classificationLifecycle.performIfActive {
          promise.resolve([])
        }
        return
      }

      if ProcessInfo.processInfo.environment[Self.visionClassificationStrategyEnvironmentKey]
        == "baseline"
      {
        self.classifyImageBatchWithSynchronousBaseline(
          indexedAssets: indexedAssets,
          assetCount: assetIds.count,
          options: classificationOptions,
          promise: promise
        )
      } else {
        self.classifyImageBatchWithPipeline(
          indexedAssets: indexedAssets,
          requestedIndexById: requestedIndexById,
          assetCount: assetIds.count,
          options: classificationOptions,
          promise: promise
        )
      }
    }
  }

  private func classifyImageBatchWithPipeline(
    indexedAssets: [(asset: PHAsset, index: Int)],
    requestedIndexById: [String: Int],
    assetCount: Int,
    options: PhotoAssetClassificationOptions,
    promise: Promise
  ) {
    classificationLifecycle.performIfActive {
      classificationResources.pipeline.classify(
        assets: indexedAssets.map(\.asset),
        options: options
      ) { outcomes in
        self.classificationLifecycle.performIfActive {
          var orderedResults = [[String: Any]?](repeating: nil, count: assetCount)
          for outcome in outcomes {
            guard let index = requestedIndexById[outcome.assetId] else {
              continue
            }
            switch outcome {
            case .success(let classification):
              orderedResults[index] = self.classificationDictionary(classification)
            case .failure(let assetId, let message):
              orderedResults[index] = [
                "assetId": assetId,
                "labels": [],
                "error": message,
              ]
            }
          }
          promise.resolve(orderedResults.compactMap { $0 })
        }
      }
    }
  }

  private func classifyImageBatchWithSynchronousBaseline(
    indexedAssets: [(asset: PHAsset, index: Int)],
    assetCount: Int,
    options: PhotoAssetClassificationOptions,
    promise: Promise
  ) {
    classificationLifecycle.performIfActive {
      var orderedResults = [[String: Any]?](repeating: nil, count: assetCount)
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
        self.classificationLifecycle.performIfActive {
          promise.resolve(orderedResults.compactMap { $0 })
        }
      }
    }
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
