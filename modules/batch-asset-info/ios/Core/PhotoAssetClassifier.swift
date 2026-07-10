import Foundation
import Photos
import Vision

public final class PhotoAssetClassifier: @unchecked Sendable {
  public static let defaultTargetSize = CGSize(width: 299, height: 299)
  /// Vision and PhotoKit contend above two workers on Apple silicon in the real-library profiler.
  public static var recommendedConcurrency: Int {
    min(max(ProcessInfo.processInfo.activeProcessorCount - 1, 1), 2)
  }

  private let imageManager: PHCachingImageManager
  private let targetSize: CGSize

  public init(
    imageManager: PHCachingImageManager = PHCachingImageManager(),
    targetSize: CGSize = PhotoAssetClassifier.defaultTargetSize
  ) {
    self.imageManager = imageManager
    self.targetSize = targetSize
  }

  public func classify(
    asset: PHAsset,
    options: PhotoAssetClassificationOptions
  ) -> Result<PhotoAssetClassification, Error> {
    let requestOptions = makeImageRequestOptions()
    var result: Result<PhotoAssetClassification, Error> = .failure(
      PhotoAssetClassificationError.imageUnavailable(assetId: asset.localIdentifier)
    )

    imageManager.requestImage(
      for: asset,
      targetSize: targetSize,
      contentMode: .aspectFit,
      options: requestOptions
    ) { image, info in
      if let error = info?[PHImageErrorKey] as? Error {
        result = .failure(error)
        return
      }
      if (info?[PHImageCancelledKey] as? Bool) == true {
        result = .failure(
          PhotoAssetClassificationError.imageRequestCancelled(assetId: asset.localIdentifier)
        )
        return
      }
      guard let image else {
        result = .failure(
          PhotoAssetClassificationError.imageUnavailable(assetId: asset.localIdentifier)
        )
        return
      }

      result = self.classify(
        image: image,
        assetId: asset.localIdentifier,
        options: options
      )
    }

    return result
  }

  public func classify(
    image: PhotoAssetThumbnailImage,
    assetId: String,
    options: PhotoAssetClassificationOptions
  ) -> Result<PhotoAssetClassification, Error> {
    guard let input = image.visionImageInput() else {
      return .failure(PhotoAssetClassificationError.imageUnavailable(assetId: assetId))
    }
    return classify(input: input, assetId: assetId, options: options)
  }

  private func makeImageRequestOptions() -> PHImageRequestOptions {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.isSynchronous = true
    options.resizeMode = .fast
    return options
  }

  private func classify(
    input: VisionImageInput,
    assetId: String,
    options: PhotoAssetClassificationOptions
  ) -> Result<PhotoAssetClassification, Error> {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(
      cgImage: input.image,
      orientation: input.orientation,
      options: [:]
    )

    do {
      try handler.perform([request])
      guard let observations = request.results else {
        return .failure(PhotoAssetClassificationError.noClassificationResults(assetId: assetId))
      }

      var labels: [PhotoAssetClassificationLabel] = []
      labels.reserveCapacity(min(options.maximumLabelCount, observations.count))
      if options.maximumLabelCount > 0 {
        for observation in observations where observation.confidence >= options.confidenceThreshold {
          labels.append(
            PhotoAssetClassificationLabel(
              identifier: observation.identifier,
              confidence: observation.confidence
            )
          )
          if labels.count == options.maximumLabelCount {
            break
          }
        }
      }

      return .success(PhotoAssetClassification(assetId: assetId, labels: labels))
    } catch {
      return .failure(error)
    }
  }
}
