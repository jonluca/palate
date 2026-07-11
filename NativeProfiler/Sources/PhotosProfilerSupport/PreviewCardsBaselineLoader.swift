import BatchAssetInfoCore
import Foundation
@preconcurrency import Photos

final class PreviewCardsBaselineLoader: @unchecked Sendable {
  private let imageManager = PHImageManager.default()
  private let fetchQueue = DispatchQueue(
    label: "com.jonluca.palate.photos-profiler.preview-cards.baseline",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private let callbackQueue: DispatchQueue

  init(callbackQueue: DispatchQueue) {
    self.callbackQueue = callbackQueue
  }

  func request(
    requests: [PreviewCardsAssetRequest],
    receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
  ) -> [InitialImageBaselineRequestToken] {
    requests.map { request in
      let token = InitialImageBaselineRequestToken(imageManager: imageManager)
      fetchQueue.async { [self, token] in
        guard !token.isCancelled else {
          return
        }
        let result = PHAsset.fetchAssets(
          withLocalIdentifiers: [request.identifier],
          options: nil
        )
        guard let asset = result.firstObject else {
          deliver(
            .failure(identifier: request.identifier, code: "ASSET_NOT_FOUND"),
            receive: receive
          )
          return
        }
        guard !token.isCancelled else {
          return
        }

        let options = PHImageRequestOptions()
        options.isSynchronous = false
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.normalizedCropRect = .zero
        options.isNetworkAccessAllowed = true
        let requestID = imageManager.requestImage(
          for: asset,
          targetSize: Self.coverTarget(for: asset, container: request.target),
          contentMode: .aspectFit,
          options: options
        ) { [weak self, token] image, info in
          guard let self, !token.isCancelled else {
            return
          }
          if (info?[PHImageCancelledKey] as? Bool) == true {
            deliver(
              .failure(identifier: request.identifier, code: "CANCELLED"),
              receive: receive
            )
            return
          }
          if info?[PHImageErrorKey] as? Error != nil {
            deliver(
              .failure(identifier: request.identifier, code: "PHOTOKIT_ERROR"),
              receive: receive
            )
            return
          }

          let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
          guard let image else {
            if !isDegraded {
              let isInCloud = info?[PHImageResultIsInCloudKey] as? Bool ?? false
              deliver(
                .failure(
                  identifier: request.identifier,
                  code: isInCloud ? "ICLOUD_UNAVAILABLE" : "IMAGE_UNAVAILABLE"
                ),
                receive: receive
              )
            }
            return
          }
          let size = InitialImagePixelSize.read(image)
          deliver(
            .image(
              identifier: request.identifier,
              pixelWidth: size.width,
              pixelHeight: size.height,
              isDegraded: isDegraded
            ),
            receive: receive
          )
        }
        token.assign(requestId: requestID)
      }
      return token
    }
  }

  static func coverTarget(
    for asset: PHAsset,
    container: PhotoAssetThumbnailTarget
  ) -> CGSize {
    let sourceWidth = max(1, asset.pixelWidth)
    let sourceHeight = max(1, asset.pixelHeight)
    let ratio = max(
      Double(container.pixelWidth) / Double(sourceWidth),
      Double(container.pixelHeight) / Double(sourceHeight)
    )
    return CGSize(
      width: (Double(sourceWidth) * ratio).rounded(.up),
      height: (Double(sourceHeight) * ratio).rounded(.up)
    )
  }

  private func deliver(
    _ event: InitialImageLoadEvent,
    receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
  ) {
    callbackQueue.async {
      receive(event)
    }
  }
}
