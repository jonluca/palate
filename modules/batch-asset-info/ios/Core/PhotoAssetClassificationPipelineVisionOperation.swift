import Foundation

final class PhotoAssetClassificationPipelineVisionOperation: Operation, @unchecked Sendable {
  private let image: PhotoAssetThumbnailImage
  private let assetID: String
  private let options: PhotoAssetClassificationOptions
  private let classifier: PhotoAssetClassifier

  private(set) var outcome: PhotoAssetClassificationOutcome?

  init(
    image: PhotoAssetThumbnailImage,
    assetID: String,
    options: PhotoAssetClassificationOptions,
    classifier: PhotoAssetClassifier
  ) {
    self.image = image
    self.assetID = assetID
    self.options = options
    self.classifier = classifier
  }

  override func main() {
    guard !isCancelled else {
      return
    }
    outcome = autoreleasepool {
      switch classifier.classify(image: image, assetId: assetID, options: options) {
      case .success(let classification):
        .success(classification)
      case .failure(let error):
        .failure(assetId: assetID, message: error.localizedDescription)
      }
    }
  }
}
