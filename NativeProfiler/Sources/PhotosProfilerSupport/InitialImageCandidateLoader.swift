import BatchAssetInfoCore
import Foundation

final class InitialImageCandidateLoader: @unchecked Sendable {
  private let store: PhotoAssetThumbnailStore
  private let preheatOwnerID = UUID()
  private let preheatScopeID = "real-photos-benchmark"

  init(callbackQueue: DispatchQueue) {
    store = PhotoAssetThumbnailStore(callbackQueue: callbackQueue)
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
        receive(profilerEvent)
      }
      return { [store, token] in
        token.cancel()
        withExtendedLifetime(store) {}
      }
    }
  }

  func preheat(keys: [PhotoAssetThumbnailRequestKey]) {
    store.updatePreheat(
      ownerID: preheatOwnerID,
      scopeID: preheatScopeID,
      candidates: keys
    )
  }

  func readMetrics() async -> PhotoAssetThumbnailStoreMetrics {
    await withCheckedContinuation { continuation in
      store.readMetrics { metrics in
        continuation.resume(returning: metrics)
      }
    }
  }

  func endPreheatAndReadMetrics() async -> PhotoAssetThumbnailStoreMetrics {
    store.endPreheat(ownerID: preheatOwnerID, scopeID: preheatScopeID)
    return await readMetrics()
  }

  func clear() async {
    store.endPreheat(ownerID: preheatOwnerID, scopeID: preheatScopeID)
    await withCheckedContinuation { continuation in
      store.clearCaches {
        continuation.resume()
      }
    }
  }
}
