import ExpoModulesCore
import Photos
import Vision

public class BatchAssetInfoModule: Module {
  private let processingQueue = DispatchQueue(label: "com.batchassetinfo.processing", qos: .userInitiated, attributes: .concurrent)
  private let assetInfoQueue = DispatchQueue(label: "com.batchassetinfo.metadata", qos: .userInitiated)
  private let imageManager = PHCachingImageManager()
  private let classificationTargetSize = CGSize(width: 299, height: 299)

  private let classificationSemaphore: DispatchSemaphore = {
    let processorCount = ProcessInfo.processInfo.activeProcessorCount
    let concurrency = min(max(processorCount - 1, 2), 6)
    return DispatchSemaphore(value: concurrency)
  }()

  public func definition() -> ModuleDefinition {
    Name("BatchAssetInfo")

    AsyncFunction("getAssetInfoBatch") { (assetIds: [String], promise: Promise) in
      self.fetchAssetInfoBatch(assetIds: assetIds, promise: promise)
    }

    AsyncFunction("getAssetInfoBatchWithOptions") { (assetIds: [String], options: GetAssetInfoOptions, promise: Promise) in
      self.fetchAssetInfoBatch(assetIds: assetIds, includeLocation: options.includeLocation, promise: promise)
    }

    AsyncFunction("classifyImage") { (assetId: String, options: ClassificationOptions, promise: Promise) in
      self.classifySingleImage(assetId: assetId, confidenceThreshold: options.confidenceThreshold, maxLabels: options.maxLabels, promise: promise)
    }

    AsyncFunction("classifyImageBatch") { (assetIds: [String], options: ClassificationOptions, promise: Promise) in
      self.classifyImageBatch(assetIds: assetIds, confidenceThreshold: options.confidenceThreshold, maxLabels: options.maxLabels, promise: promise)
    }
  }

  private func fetchAssetInfoBatch(assetIds: [String], includeLocation: Bool = true, promise: Promise) {
    assetInfoQueue.async {
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: assetIds, options: nil)

      var results: [[String: Any?]] = []
      results.reserveCapacity(assetIds.count)

      fetchResult.enumerateObjects { asset, _, _ in
        var info: [String: Any?] = [
          "id": asset.localIdentifier,
          "creationTime": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
          "modificationTime": (asset.modificationDate?.timeIntervalSince1970 ?? 0) * 1000,
          "width": asset.pixelWidth,
          "height": asset.pixelHeight,
          "mediaType": self.mediaTypeToString(asset.mediaType),
          "duration": asset.duration,
        ]

        // Include location if available and requested
        if includeLocation, let location = asset.location {
          info["location"] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "altitude": location.altitude,
            "speed": location.speed,
            "heading": location.course,
          ]
        } else {
          info["location"] = nil
        }

        // Get the local URI for the asset
        info["uri"] = "ph://\(asset.localIdentifier)"

        results.append(info)
      }

      promise.resolve(results)
    }
  }

  private func mediaTypeToString(_ mediaType: PHAssetMediaType) -> String {
    switch mediaType {
    case .image:
      return "photo"
    case .video:
      return "video"
    case .audio:
      return "audio"
    default:
      return "unknown"
    }
  }

  // MARK: - Image Classification

  private func classifySingleImage(assetId: String, confidenceThreshold: Float, maxLabels: Int, promise: Promise) {
    processingQueue.async {
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)

      guard let asset = fetchResult.firstObject else {
        promise.reject("ASSET_NOT_FOUND", "Asset with id \(assetId) not found")
        return
      }

      self.classificationSemaphore.wait()
      defer {
        self.classificationSemaphore.signal()
      }

      let result = autoreleasepool {
        self.loadAndClassifyImageSync(asset: asset, confidenceThreshold: confidenceThreshold, maxLabels: maxLabels)
      }

      switch result {
      case .success(let classificationResult):
        promise.resolve(classificationResult)
      case .failure(let error):
        promise.reject("CLASSIFICATION_FAILED", error.localizedDescription)
      }
    }
  }

  private func classifyImageBatch(assetIds: [String], confidenceThreshold: Float, maxLabels: Int, promise: Promise) {
    processingQueue.async {
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
        promise.resolve([])
        return
      }

      var orderedResults = Array<[String: Any]?>(repeating: nil, count: assetIds.count)
      let resultsLock = NSLock()
      let group = DispatchGroup()
      let assets = indexedAssets.map { $0.asset }
      let cacheOptions = self.makeImageRequestOptions(isSynchronous: false)

      self.imageManager.startCachingImages(
        for: assets,
        targetSize: self.classificationTargetSize,
        contentMode: .aspectFit,
        options: cacheOptions
      )

      for indexedAsset in indexedAssets {
        group.enter()
        self.processingQueue.async {
          self.classificationSemaphore.wait()
          defer {
            self.classificationSemaphore.signal()
            group.leave()
          }

          let result = autoreleasepool {
            self.loadAndClassifyImageSync(
              asset: indexedAsset.asset,
              confidenceThreshold: confidenceThreshold,
              maxLabels: maxLabels
            )
          }

          let classificationResult: [String: Any]
          switch result {
          case .success(let labels):
            classificationResult = labels
          case .failure:
            classificationResult = [
              "assetId": indexedAsset.asset.localIdentifier,
              "labels": [],
              "error": "Classification failed"
            ]
          }

          resultsLock.lock()
          orderedResults[indexedAsset.index] = classificationResult
          resultsLock.unlock()
        }
      }

      group.notify(queue: self.processingQueue) {
        self.imageManager.stopCachingImages(
          for: assets,
          targetSize: self.classificationTargetSize,
          contentMode: .aspectFit,
          options: cacheOptions
        )
        let results = orderedResults.compactMap { $0 }
        promise.resolve(results)
      }
    }
  }

  private func makeImageRequestOptions(isSynchronous: Bool) -> PHImageRequestOptions {
    let options = PHImageRequestOptions()
    options.deliveryMode = .fastFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = isSynchronous
    options.resizeMode = .fast
    return options
  }

  private func loadAndClassifyImageSync(asset: PHAsset, confidenceThreshold: Float, maxLabels: Int) -> Result<[String: Any], Error> {
    let options = makeImageRequestOptions(isSynchronous: true)
    var result: Result<[String: Any], Error> = .failure(
      NSError(domain: "BatchAssetInfo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to load image"])
    )

    imageManager.requestImage(
      for: asset,
      targetSize: classificationTargetSize,
      contentMode: .aspectFit,
      options: options
    ) { image, info in
      if let error = info?[PHImageErrorKey] as? Error {
        result = .failure(error)
        return
      }

      guard let image = image, let cgImage = image.cgImage else {
        result = .failure(NSError(domain: "BatchAssetInfo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to load image"]))
        return
      }

      result = self.performClassification(
        cgImage: cgImage,
        assetId: asset.localIdentifier,
        confidenceThreshold: confidenceThreshold,
        maxLabels: maxLabels
      )
    }

    return result
  }

  private func performClassification(cgImage: CGImage, assetId: String, confidenceThreshold: Float, maxLabels: Int) -> Result<[String: Any], Error> {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

    do {
      try handler.perform([request])

      guard let observations = request.results as? [VNClassificationObservation] else {
        return .failure(NSError(domain: "BatchAssetInfo", code: 2, userInfo: [NSLocalizedDescriptionKey: "No classification results"]))
      }

      let labelLimit = max(0, maxLabels)
      var labels: [[String: Any]] = []
      labels.reserveCapacity(min(labelLimit, observations.count))

      if labelLimit > 0 {
        for observation in observations where observation.confidence >= confidenceThreshold {
          labels.append([
            "label": observation.identifier,
            "confidence": observation.confidence
          ])

          if labels.count == labelLimit {
            break
          }
        }
      }

      let result: [String: Any] = [
        "assetId": assetId,
        "labels": labels
      ]

      return .success(result)
    } catch {
      return .failure(error)
    }
  }
}

struct GetAssetInfoOptions: Record {
  @Field
  var includeLocation: Bool = true
}

struct ClassificationOptions: Record {
  @Field
  var confidenceThreshold: Float = 0.1

  @Field
  var maxLabels: Int = 50
}
