import Foundation
@preconcurrency import Photos

public final class PhotoAssetThumbnailStore: NSObject, PHPhotoLibraryChangeObserver,
  @unchecked Sendable
{
  public static let cacheInvalidatedNotification = Notification.Name(
    "com.jonluca.palate.photo-thumbnails.cache-invalidated"
  )

  public static let shared: PhotoAssetThumbnailStore = {
    let store = PhotoAssetThumbnailStore()
    store.startObservingPhotoLibraryChanges()
    return store
  }()

  public static let defaultBatchDelay: TimeInterval = 0.002
  public static let defaultFinalImageCacheByteLimit = 32 * 1_024 * 1_024
  public static let defaultFinalImageCacheCountLimit = 64
  public static let defaultAssetCacheCountLimit = 256

  private let imageManager: PHCachingImageManager
  private let stateQueue: DispatchQueue
  private let assetFetchQueue: DispatchQueue
  private let callbackQueue: DispatchQueue
  private let callbacksRunOnMainQueue: Bool
  private let batchDelay: TimeInterval
  private let finalImageCache = NSCache<
    PhotoAssetThumbnailCacheKey, PhotoAssetThumbnailCachedImage
  >()
  private let assetCache = NSCache<NSString, PHAsset>()

  private var entries: [PhotoAssetThumbnailRequestKey: PhotoAssetThumbnailRequestEntry] = [:]
  private var pendingBatch = PhotoAssetThumbnailBatchAccumulator()
  private var flushScheduled = false
  private var waitingKeysByAssetIdentifier: [String: Set<PhotoAssetThumbnailRequestKey>] = [:]
  private var assetIdentifiersBeingFetched: Set<String> = []
  private var cacheGeneration: UInt64 = 0
  private var observesPhotoLibraryChanges = false

  public init(
    callbackQueue: DispatchQueue = .main,
    batchDelay: TimeInterval = PhotoAssetThumbnailStore.defaultBatchDelay,
    finalImageCacheByteLimit: Int = PhotoAssetThumbnailStore.defaultFinalImageCacheByteLimit,
    finalImageCacheCountLimit: Int = PhotoAssetThumbnailStore.defaultFinalImageCacheCountLimit,
    assetCacheCountLimit: Int = PhotoAssetThumbnailStore.defaultAssetCacheCountLimit
  ) {
    self.callbackQueue = callbackQueue
    callbacksRunOnMainQueue = callbackQueue === DispatchQueue.main
    self.batchDelay = max(0, batchDelay)
    imageManager = PHCachingImageManager()
    stateQueue = DispatchQueue(
      label: "com.jonluca.palate.photo-thumbnails.state", qos: .userInitiated)
    assetFetchQueue = DispatchQueue(
      label: "com.jonluca.palate.photo-thumbnails.assets", qos: .userInitiated)
    super.init()
    finalImageCache.totalCostLimit = max(1, finalImageCacheByteLimit)
    finalImageCache.countLimit = max(1, finalImageCacheCountLimit)
    assetCache.countLimit = max(1, assetCacheCountLimit)
  }

  deinit {
    if observesPhotoLibraryChanges {
      PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }
  }

  public func photoLibraryDidChange(_ changeInstance: PHChange) {
    _ = changeInstance
    clearCaches(notifyMountedViews: true, completion: nil)
  }

  @discardableResult
  public func requestThumbnail(
    for key: PhotoAssetThumbnailRequestKey,
    completion: @escaping @Sendable (PhotoAssetThumbnailEvent) -> Void
  ) -> PhotoAssetThumbnailRequestToken {
    let subscriberId = UUID()
    let token = PhotoAssetThumbnailRequestToken { [weak self] in
      self?.cancelSubscriber(id: subscriberId, for: key)
    }
    let subscriber = PhotoAssetThumbnailSubscriber(
      id: subscriberId,
      token: token,
      completion: completion
    )

    stateQueue.async { [weak self] in
      self?.enqueue(subscriber: subscriber, for: key)
    }
    return token
  }

  /// Delivers events on the main actor without adding another dispatch when the store's callback
  /// queue is already the main queue (as it is for `shared` and the default initializer).
  @discardableResult
  public func requestThumbnailOnMainActor(
    for key: PhotoAssetThumbnailRequestKey,
    completion: @escaping @MainActor @Sendable (PhotoAssetThumbnailEvent) -> Void
  ) -> PhotoAssetThumbnailRequestToken {
    let callbacksRunOnMainQueue = callbacksRunOnMainQueue
    return requestThumbnail(for: key) { event in
      if callbacksRunOnMainQueue {
        MainActor.assumeIsolated {
          completion(event)
        }
      } else {
        DispatchQueue.main.async {
          completion(event)
        }
      }
    }
  }

  public func clearCaches(completion: (@MainActor @Sendable () -> Void)? = nil) {
    clearCaches(notifyMountedViews: true, completion: completion)
  }

  func clearCaches(
    notifyMountedViews: Bool,
    completion: (@MainActor @Sendable () -> Void)? = nil
  ) {
    stateQueue.async { [weak self] in
      guard let self else {
        DispatchQueue.main.async {
          completion?()
        }
        return
      }

      cacheGeneration &+= 1
      finalImageCache.removeAllObjects()
      assetCache.removeAllObjects()
      pendingBatch = PhotoAssetThumbnailBatchAccumulator()
      flushScheduled = false
      waitingKeysByAssetIdentifier.removeAll(keepingCapacity: false)
      assetIdentifiersBeingFetched.removeAll(keepingCapacity: false)

      let activeEntries = Array(entries.values)
      entries.removeAll(keepingCapacity: false)
      for entry in activeEntries {
        if let requestId = entry.requestId {
          imageManager.cancelImageRequest(requestId)
        }
        deliver(.failure(.cacheCleared), to: Array(entry.subscribers.values))
      }
      imageManager.stopCachingImagesForAllAssets()

      DispatchQueue.main.async {
        if notifyMountedViews {
          NotificationCenter.default.post(
            name: Self.cacheInvalidatedNotification,
            object: self
          )
        }
        completion?()
      }
    }
  }

  private func startObservingPhotoLibraryChanges() {
    guard !observesPhotoLibraryChanges else {
      return
    }
    observesPhotoLibraryChanges = true
    PHPhotoLibrary.shared().register(self)
  }

  private func enqueue(
    subscriber: PhotoAssetThumbnailSubscriber,
    for key: PhotoAssetThumbnailRequestKey
  ) {
    guard !subscriber.token.isCancelled else {
      return
    }

    let cacheKey = PhotoAssetThumbnailCacheKey(key)
    if let cached = finalImageCache.object(forKey: cacheKey) {
      deliver(.image(cached.image, isDegraded: false), to: [subscriber])
      return
    }

    if var entry = entries[key] {
      entry.subscribers[subscriber.id] = subscriber
      let degradedImage = entry.latestDegradedImage
      entries[key] = entry
      if let degradedImage {
        deliver(.image(degradedImage, isDegraded: true), to: [subscriber])
      }
      return
    }

    entries[key] = PhotoAssetThumbnailRequestEntry(
      id: UUID(),
      subscribers: [subscriber.id: subscriber],
      phase: .pending,
      requestId: nil,
      latestDegradedImage: nil
    )
    pendingBatch.enqueue(key)
    scheduleFlushIfNeeded()
  }

  private func scheduleFlushIfNeeded() {
    guard !flushScheduled else {
      return
    }
    flushScheduled = true

    stateQueue.asyncAfter(deadline: .now() + batchDelay) { [weak self] in
      self?.flushPendingBatch()
    }
  }

  private func flushPendingBatch() {
    flushScheduled = false
    let queuedKeys = pendingBatch.drain()
    guard !queuedKeys.isEmpty else {
      return
    }

    var identifiersToFetch: [String] = []
    var newlyQueuedIdentifiers: Set<String> = []

    for key in queuedKeys {
      guard var entry = entries[key], !entry.subscribers.isEmpty, entry.phase == .pending else {
        continue
      }

      if let asset = assetCache.object(forKey: key.assetIdentifier as NSString) {
        startImageRequest(for: key, asset: asset)
        continue
      }

      entry.phase = .waitingForAsset
      entries[key] = entry
      waitingKeysByAssetIdentifier[key.assetIdentifier, default: []].insert(key)

      if !assetIdentifiersBeingFetched.contains(key.assetIdentifier),
        newlyQueuedIdentifiers.insert(key.assetIdentifier).inserted
      {
        assetIdentifiersBeingFetched.insert(key.assetIdentifier)
        identifiersToFetch.append(key.assetIdentifier)
      }
    }

    guard !identifiersToFetch.isEmpty else {
      return
    }

    let generation = cacheGeneration
    let identifiers = identifiersToFetch
    assetFetchQueue.async { [weak self] in
      let result = Self.fetchAssets(withIdentifiers: identifiers)
      self?.stateQueue.async { [weak self] in
        self?.finishAssetFetch(
          identifiers: identifiers,
          result: result,
          generation: generation
        )
      }
    }
  }

  private static func fetchAssets(withIdentifiers identifiers: [String])
    -> PhotoAssetThumbnailAssetFetchResult
  {
    let authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard authorizationStatus == .authorized || authorizationStatus == .limited else {
      return .failure(.photoLibraryAccessRequired(status: authorizationStatus.rawValue))
    }

    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
    var assetsByIdentifier: [String: PHAsset] = [:]
    assetsByIdentifier.reserveCapacity(fetchResult.count)
    fetchResult.enumerateObjects { asset, _, _ in
      assetsByIdentifier[asset.localIdentifier] = asset
    }
    return .success(assetsByIdentifier)
  }

  private func finishAssetFetch(
    identifiers: [String],
    result: PhotoAssetThumbnailAssetFetchResult,
    generation: UInt64
  ) {
    guard generation == cacheGeneration else {
      return
    }

    switch result {
    case .success(let assetsByIdentifier):
      for asset in assetsByIdentifier.values {
        assetCache.setObject(asset, forKey: asset.localIdentifier as NSString)
      }

      for identifier in identifiers {
        assetIdentifiersBeingFetched.remove(identifier)
        let waitingKeys = waitingKeysByAssetIdentifier.removeValue(forKey: identifier) ?? []
        guard let asset = assetsByIdentifier[identifier] else {
          for key in waitingKeys {
            failEntry(for: key, error: .assetNotFound(identifier))
          }
          continue
        }

        for key in waitingKeys {
          startImageRequest(for: key, asset: asset)
        }
      }

    case .failure(let error):
      for identifier in identifiers {
        assetIdentifiersBeingFetched.remove(identifier)
        let waitingKeys = waitingKeysByAssetIdentifier.removeValue(forKey: identifier) ?? []
        for key in waitingKeys {
          failEntry(for: key, error: error)
        }
      }
    }
  }

  private func startImageRequest(for key: PhotoAssetThumbnailRequestKey, asset: PHAsset) {
    guard var entry = entries[key], !entry.subscribers.isEmpty else {
      return
    }
    guard entry.phase == .pending || entry.phase == .waitingForAsset else {
      return
    }

    entry.phase = .requesting
    let entryId = entry.id
    entries[key] = entry

    let options = PHImageRequestOptions()
    options.isSynchronous = false
    options.version = .current
    options.deliveryMode = .opportunistic
    options.resizeMode = .exact
    options.normalizedCropRect = .zero
    options.isNetworkAccessAllowed = true

    let requestId = imageManager.requestImage(
      for: asset,
      targetSize: key.target.size,
      contentMode: key.contentMode.photoKitValue,
      options: options
    ) { [weak self] image, info in
      let result = PhotoAssetThumbnailRawResult(
        image: image,
        isDegraded: info?[PHImageResultIsDegradedKey] as? Bool ?? false,
        isCancelled: info?[PHImageCancelledKey] as? Bool ?? false,
        errorDescription: (info?[PHImageErrorKey] as? Error)?.localizedDescription
      )
      self?.stateQueue.async { [weak self] in
        self?.handleImageResult(result, for: key, entryId: entryId)
      }
    }

    guard var currentEntry = entries[key],
      currentEntry.id == entryId,
      currentEntry.phase == .requesting
    else {
      imageManager.cancelImageRequest(requestId)
      return
    }
    currentEntry.requestId = requestId
    entries[key] = currentEntry
  }

  private func handleImageResult(
    _ result: PhotoAssetThumbnailRawResult,
    for key: PhotoAssetThumbnailRequestKey,
    entryId: UUID
  ) {
    guard var entry = entries[key], entry.acceptsImageResult(from: entryId) else {
      return
    }

    if result.isCancelled {
      failEntry(for: key, error: .requestCancelled(key.assetIdentifier))
      return
    }

    if let image = result.image {
      if result.isDegraded {
        entry.latestDegradedImage = image
        entries[key] = entry
        deliver(.image(image, isDegraded: true), to: Array(entry.subscribers.values))
      } else {
        let cachedImage = PhotoAssetThumbnailCachedImage(image)
        finalImageCache.setObject(
          cachedImage,
          forKey: PhotoAssetThumbnailCacheKey(key),
          cost: cachedImage.cost
        )
        entries.removeValue(forKey: key)
        deliver(.image(image, isDegraded: false), to: Array(entry.subscribers.values))
      }
      return
    }

    guard !result.isDegraded else {
      return
    }

    if let errorDescription = result.errorDescription {
      failEntry(
        for: key,
        error: .photoKitFailure(assetIdentifier: key.assetIdentifier, message: errorDescription)
      )
    } else {
      failEntry(for: key, error: .imageUnavailable(key.assetIdentifier))
    }
  }

  private func failEntry(for key: PhotoAssetThumbnailRequestKey, error: PhotoAssetThumbnailError) {
    guard let entry = entries.removeValue(forKey: key) else {
      return
    }
    deliver(.failure(error), to: Array(entry.subscribers.values))
  }

  private func cancelSubscriber(id: UUID, for key: PhotoAssetThumbnailRequestKey) {
    stateQueue.async { [weak self] in
      guard let self, var entry = entries[key] else {
        return
      }

      entry.subscribers.removeValue(forKey: id)
      guard entry.subscribers.isEmpty else {
        entries[key] = entry
        return
      }

      entries.removeValue(forKey: key)
      waitingKeysByAssetIdentifier[key.assetIdentifier]?.remove(key)
      if waitingKeysByAssetIdentifier[key.assetIdentifier]?.isEmpty == true {
        waitingKeysByAssetIdentifier.removeValue(forKey: key.assetIdentifier)
      }
      if let requestId = entry.requestId {
        imageManager.cancelImageRequest(requestId)
      }
    }
  }

  private func deliver(
    _ event: PhotoAssetThumbnailEvent,
    to subscribers: [PhotoAssetThumbnailSubscriber]
  ) {
    callbackQueue.async {
      for subscriber in subscribers where !subscriber.token.isCancelled {
        subscriber.completion(event)
      }
    }
  }
}
