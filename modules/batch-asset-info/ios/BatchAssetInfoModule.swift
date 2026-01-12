import ExpoModulesCore
import Photos
import Vision

public class BatchAssetInfoModule: Module {
  // Concurrent queue for parallel image processing
  private let processingQueue = DispatchQueue(label: "com.batchassetinfo.processing", qos: .userInitiated, attributes: .concurrent)

  // Limit concurrent operations to avoid memory pressure
  private let semaphore = DispatchSemaphore(value: 8)

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
    DispatchQueue.global(qos: .userInitiated).async {
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

      // Return results on main thread
      DispatchQueue.main.async {
        promise.resolve(results)
      }
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
    DispatchQueue.global(qos: .userInitiated).async {
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)

      guard let asset = fetchResult.firstObject else {
        DispatchQueue.main.async {
          promise.reject("ASSET_NOT_FOUND", "Asset with id \(assetId) not found")
        }
        return
      }

      self.loadAndClassifyImage(asset: asset, confidenceThreshold: confidenceThreshold, maxLabels: maxLabels) { result in
        DispatchQueue.main.async {
          switch result {
          case .success(let classificationResult):
            promise.resolve(classificationResult)
          case .failure(let error):
            promise.reject("CLASSIFICATION_FAILED", error.localizedDescription)
          }
        }
      }
    }
  }

  private func classifyImageBatch(assetIds: [String], confidenceThreshold: Float, maxLabels: Int, promise: Promise) {
    processingQueue.async {
      let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: assetIds, options: nil)

      // Pre-allocate results array with thread-safe access
      var results: [[String: Any]] = []
      let resultsLock = NSLock()
      let group = DispatchGroup()

      // Collect all assets first
      var assets: [PHAsset] = []
      assets.reserveCapacity(fetchResult.count)
      fetchResult.enumerateObjects { asset, _, _ in
        assets.append(asset)
      }

      // Process assets concurrently
      for asset in assets {
        group.enter()
        self.processingQueue.async {
          // Limit concurrent operations
          self.semaphore.wait()
          defer { self.semaphore.signal() }

          self.loadAndClassifyImageSync(asset: asset, confidenceThreshold: confidenceThreshold, maxLabels: maxLabels) { result in
            resultsLock.lock()
            switch result {
            case .success(let classificationResult):
              results.append(classificationResult)
            case .failure:
              results.append([
                "assetId": asset.localIdentifier,
                "labels": [],
                "error": "Classification failed"
              ])
            }
            resultsLock.unlock()
            group.leave()
          }
        }
      }

      group.notify(queue: .main) {
        promise.resolve(results)
      }
    }
  }

  // Synchronous image loading for parallel batch processing
  private func loadAndClassifyImageSync(asset: PHAsset, confidenceThreshold: Float, maxLabels: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    let options = PHImageRequestOptions()
    options.deliveryMode = .fastFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = true
    options.resizeMode = .fast

    // Vision models work well at 299x299
    let targetSize = CGSize(width: 299, height: 299)

    PHImageManager.default().requestImage(
      for: asset,
      targetSize: targetSize,
      contentMode: .aspectFit,
      options: options
    ) { image, info in
      guard let image = image, let cgImage = image.cgImage else {
        completion(.failure(NSError(domain: "BatchAssetInfo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to load image"])))
        return
      }

      self.performClassification(cgImage: cgImage, assetId: asset.localIdentifier, confidenceThreshold: confidenceThreshold, maxLabels: maxLabels, completion: completion)
    }
  }

  private func loadAndClassifyImage(asset: PHAsset, confidenceThreshold: Float, maxLabels: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    let options = PHImageRequestOptions()
    options.deliveryMode = .fastFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = false
    options.resizeMode = .fast

    let targetSize = CGSize(width: 299, height: 299)

    PHImageManager.default().requestImage(
      for: asset,
      targetSize: targetSize,
      contentMode: .aspectFit,
      options: options
    ) { image, info in
      guard let image = image, let cgImage = image.cgImage else {
        completion(.failure(NSError(domain: "BatchAssetInfo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to load image"])))
        return
      }

      self.performClassification(cgImage: cgImage, assetId: asset.localIdentifier, confidenceThreshold: confidenceThreshold, maxLabels: maxLabels, completion: completion)
    }
  }

  private func performClassification(cgImage: CGImage, assetId: String, confidenceThreshold: Float, maxLabels: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

    do {
      try handler.perform([request])

      guard let observations = request.results as? [VNClassificationObservation] else {
        completion(.failure(NSError(domain: "BatchAssetInfo", code: 2, userInfo: [NSLocalizedDescriptionKey: "No classification results"])))
        return
      }

      // Filter observations above threshold and limit count
      let filteredObservations = observations
        .filter { $0.confidence >= confidenceThreshold }
        .prefix(maxLabels)

      // Map to simple label/confidence pairs
      let labels: [[String: Any]] = filteredObservations.map { observation in
        [
          "label": observation.identifier,
          "confidence": observation.confidence
        ]
      }

      let result: [String: Any] = [
        "assetId": assetId,
        "labels": labels
      ]

      completion(.success(result))
    } catch {
      completion(.failure(error))
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

