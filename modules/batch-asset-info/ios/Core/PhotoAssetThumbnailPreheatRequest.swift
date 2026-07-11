public struct PhotoAssetThumbnailPreheatRequest: Equatable, Sendable {
  public static let maximumPayloadSize = 64

  public let scopeID: String
  public let keys: [PhotoAssetThumbnailRequestKey]

  public init?(
    scopeID: String,
    uris: [String],
    pixelWidth: Int,
    pixelHeight: Int
  ) {
    guard !scopeID.isEmpty,
      let target = try? PhotoAssetThumbnailTarget(
        pixelWidth: pixelWidth,
        pixelHeight: pixelHeight
      )
    else {
      return nil
    }

    var seenAssetIdentifiers: Set<String> = []
    var keys: [PhotoAssetThumbnailRequestKey] = []
    keys.reserveCapacity(min(uris.count, Self.maximumPayloadSize))
    for uri in uris.prefix(Self.maximumPayloadSize) {
      guard let identifier = PhotoAssetURI.localIdentifier(from: uri),
        seenAssetIdentifiers.insert(identifier).inserted,
        let key = try? PhotoAssetThumbnailRequestKey(
          assetIdentifier: identifier,
          target: target,
          contentMode: .aspectFill
        )
      else {
        continue
      }
      keys.append(key)
    }

    self.scopeID = scopeID
    self.keys = keys
  }
}
