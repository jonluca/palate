import ExpoModulesCore
import UIKit

final class PhotoAssetThumbnailView: ExpoView {
  private static let automaticRetryDelay: TimeInterval = 0.15

  let onLoad = EventDispatcher()
  let onError = EventDispatcher()

  private let imageView = UIImageView()
  private let store = PhotoAssetThumbnailStore.shared
  private var requestedURI: String?
  private var currentKey: PhotoAssetThumbnailRequestKey?
  private var requestToken: PhotoAssetThumbnailRequestToken?
  private var requestGeneration: UInt64 = 0
  private var retryKey: PhotoAssetThumbnailRequestKey?
  private var retryPolicy = PhotoAssetThumbnailRetryPolicy()
  private var retryWorkItem: DispatchWorkItem?

  var uri: String? {
    didSet {
      if uri != oldValue {
        cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
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
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(thumbnailCacheDidInvalidate(_:)),
      name: PhotoAssetThumbnailStore.cacheInvalidatedNotification,
      object: store
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    retryWorkItem?.cancel()
    requestToken?.cancel()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    applyChanges()
  }

  func applyChanges() {
    guard bounds.width > 0, bounds.height > 0 else {
      cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
      return
    }
    guard let uri else {
      cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
      return
    }
    guard let assetIdentifier = PhotoAssetURI.localIdentifier(from: uri) else {
      cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
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
      cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
      emitError(error, uri: uri)
      return
    } catch {
      cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
      emitError(.imageUnavailable(assetIdentifier), uri: uri)
      return
    }

    if retryKey != key {
      resetAutomaticRetryState(for: key)
    }
    guard key != currentKey || uri != requestedURI else {
      return
    }

    retryWorkItem?.cancel()
    retryWorkItem = nil
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
      if !isDegraded {
        retryPolicy.reset()
      }
      let pixelSize = photoAssetThumbnailPixelSize(image)
      onLoad([
        "uri": uri,
        "assetId": key.assetIdentifier,
        "width": pixelSize.width,
        "height": pixelSize.height,
        "isDegraded": isDegraded,
      ])
    case .failure(let error):
      cancelCurrentRequest(clearImage: true)
      if error == .cacheCleared {
        return
      }
      if scheduleAutomaticRetry(for: key, uri: uri, after: error) {
        return
      }
      emitError(error, uri: uri)
    }
  }

  @objc private func thumbnailCacheDidInvalidate(_ notification: Notification) {
    _ = notification
    cancelCurrentRequest(clearImage: true, resetAutomaticRetry: true)
    applyChanges()
  }

  private func scheduleAutomaticRetry(
    for key: PhotoAssetThumbnailRequestKey,
    uri: String,
    after error: PhotoAssetThumbnailError
  ) -> Bool {
    guard retryKey == key, retryPolicy.consumeRetry(for: error) else {
      return false
    }

    let workItem = DispatchWorkItem { [weak self] in
      guard let self else {
        return
      }
      retryWorkItem = nil
      guard self.uri == uri, retryKey == key else {
        return
      }
      applyChanges()
    }
    retryWorkItem = workItem
    DispatchQueue.main.asyncAfter(
      deadline: .now() + Self.automaticRetryDelay,
      execute: workItem
    )
    return true
  }

  private func resetAutomaticRetryState(for key: PhotoAssetThumbnailRequestKey? = nil) {
    retryWorkItem?.cancel()
    retryWorkItem = nil
    retryKey = key
    retryPolicy.reset()
  }

  private func cancelCurrentRequest(clearImage: Bool, resetAutomaticRetry: Bool = false) {
    retryWorkItem?.cancel()
    retryWorkItem = nil
    requestToken?.cancel()
    requestToken = nil
    currentKey = nil
    requestedURI = nil
    requestGeneration &+= 1
    if clearImage {
      imageView.image = nil
    }
    if resetAutomaticRetry {
      retryKey = nil
      retryPolicy.reset()
    }
  }

  private func emitError(_ error: PhotoAssetThumbnailError, uri: String) {
    onError([
      "uri": uri,
      "code": error.code,
      "message": error.localizedDescription,
    ])
  }
}
