import ExpoModulesCore
import UIKit

final class PhotoAssetThumbnailView: ExpoView {
  let onLoad = EventDispatcher()
  let onError = EventDispatcher()

  private let imageView = UIImageView()
  private let store = PhotoAssetThumbnailStore.shared
  private var requestedURI: String?
  private var currentKey: PhotoAssetThumbnailRequestKey?
  private var requestToken: PhotoAssetThumbnailRequestToken?
  private var requestGeneration: UInt64 = 0

  var uri: String? {
    didSet {
      if uri != oldValue {
        cancelCurrentRequest(clearImage: true)
      }
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    imageView.clipsToBounds = true
    imageView.contentMode = .scaleAspectFill
    imageView.isUserInteractionEnabled = false
    addSubview(imageView)
  }

  deinit {
    requestToken?.cancel()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    applyChanges()
  }

  func applyChanges() {
    guard bounds.width > 0, bounds.height > 0 else {
      cancelCurrentRequest(clearImage: true)
      return
    }
    guard let uri else {
      cancelCurrentRequest(clearImage: true)
      return
    }
    guard let assetIdentifier = PhotoAssetURI.localIdentifier(from: uri) else {
      cancelCurrentRequest(clearImage: true)
      emitError(.invalidURI(uri), uri: uri)
      return
    }

    let scale = window?.screen.scale ?? UIScreen.main.scale
    let key: PhotoAssetThumbnailRequestKey
    do {
      let target = try PhotoAssetThumbnailTarget(
        pointWidth: Double(bounds.width),
        pointHeight: Double(bounds.height),
        scale: Double(scale)
      )
      key = try PhotoAssetThumbnailRequestKey(
        assetIdentifier: assetIdentifier,
        target: target,
        contentMode: .aspectFill
      )
    } catch let error as PhotoAssetThumbnailError {
      cancelCurrentRequest(clearImage: true)
      emitError(error, uri: uri)
      return
    } catch {
      cancelCurrentRequest(clearImage: true)
      emitError(.imageUnavailable(assetIdentifier), uri: uri)
      return
    }

    guard key != currentKey || uri != requestedURI else {
      return
    }

    requestToken?.cancel()
    requestGeneration &+= 1
    let generation = requestGeneration
    currentKey = key
    requestedURI = uri
    imageView.image = nil

    requestToken = store.requestThumbnailOnMainActor(for: key) { [weak self] event in
      self?.handle(event, key: key, uri: uri, generation: generation)
    }
  }

  private func handle(
    _ event: PhotoAssetThumbnailEvent,
    key: PhotoAssetThumbnailRequestKey,
    uri: String,
    generation: UInt64
  ) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard generation == requestGeneration,
          key == currentKey,
          uri == requestedURI,
          uri == self.uri
    else {
      return
    }

    switch event {
    case .image(let image, let isDegraded):
      imageView.image = image
      let pixelSize = photoAssetThumbnailPixelSize(image)
      onLoad([
        "uri": uri,
        "assetId": key.assetIdentifier,
        "width": pixelSize.width,
        "height": pixelSize.height,
        "isDegraded": isDegraded
      ])
    case .failure(let error):
      emitError(error, uri: uri)
    }
  }

  private func cancelCurrentRequest(clearImage: Bool) {
    requestToken?.cancel()
    requestToken = nil
    currentKey = nil
    requestedURI = nil
    requestGeneration &+= 1
    if clearImage {
      imageView.image = nil
    }
  }

  private func emitError(_ error: PhotoAssetThumbnailError, uri: String) {
    onError([
      "uri": uri,
      "code": error.code,
      "message": error.localizedDescription
    ])
  }
}
