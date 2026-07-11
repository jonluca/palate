public struct PhotoAssetThumbnailPreheatLease<
  OwnerID: Hashable & Sendable, ScopeID: Hashable & Sendable
>: Hashable, Sendable {
  public let ownerID: OwnerID
  public let scopeID: ScopeID
  public let sequence: UInt64
}
