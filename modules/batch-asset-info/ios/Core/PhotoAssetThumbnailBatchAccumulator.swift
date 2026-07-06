struct PhotoAssetThumbnailBatchAccumulator {
  private var orderedKeys: [PhotoAssetThumbnailRequestKey] = []
  private var keys: Set<PhotoAssetThumbnailRequestKey> = []

  var isEmpty: Bool {
    orderedKeys.isEmpty
  }

  mutating func enqueue(_ key: PhotoAssetThumbnailRequestKey) {
    if keys.insert(key).inserted {
      orderedKeys.append(key)
    }
  }

  mutating func drain() -> [PhotoAssetThumbnailRequestKey] {
    let drained = orderedKeys
    orderedKeys.removeAll(keepingCapacity: true)
    keys.removeAll(keepingCapacity: true)
    return drained
  }
}
