public struct PhotoAssetThumbnailPreheatStoreChange<
  OwnerID: Hashable & Sendable, ScopeID: Hashable & Sendable, Asset
> {
  public let accepted: Bool
  public let cacheGeneration: UInt64
  public let activeLease: PhotoAssetThumbnailPreheatLease<OwnerID, ScopeID>?
  /// Cache operations in execution order. Every stop precedes every start in the same change.
  public let operations: [PhotoAssetThumbnailPreheatStoreOperation<Asset>]
  public let identifiersToFetch: [String]
}
