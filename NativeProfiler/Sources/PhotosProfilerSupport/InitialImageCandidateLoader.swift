import BatchAssetInfoCore
import Foundation

final class InitialImageCandidateLoader: @unchecked Sendable {
  private let store: PhotoAssetThumbnailStore
  private let callbackQueue: DispatchQueue

  init(callbackQueue: DispatchQueue) {
    store = PhotoAssetThumbnailStore()
    self.callbackQueue = callbackQueue
  }

  func request(
    keys: [PhotoAssetThumbnailRequestKey],
    receive: @escaping @Sendable (InitialImageLoadEvent) -> Void
  ) -> [@Sendable () -> Void] {
    keys.map { key in
      let token = store.requestThumbnail(for: key) { event in
        let profilerEvent: InitialImageLoadEvent
        switch event {
        case .image(let image, let isDegraded):
          let size = InitialImagePixelSize.read(image)
          profilerEvent = .image(
            identifier: key.assetIdentifier,
            pixelWidth: size.width,
            pixelHeight: size.height,
            isDegraded: isDegraded
          )
        case .failure(let error):
          profilerEvent = .failure(identifier: key.assetIdentifier, code: error.code)
        }
        self.callbackQueue.async {
          receive(profilerEvent)
        }
      }
      return { [store, token] in
        token.cancel()
        withExtendedLifetime(store) {}
      }
    }
  }
}
