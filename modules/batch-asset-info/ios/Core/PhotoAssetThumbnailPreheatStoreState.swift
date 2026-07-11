public struct PhotoAssetThumbnailPreheatStoreState<
  OwnerID: Hashable & Sendable, ScopeID: Hashable & Sendable, Asset
> {
  public private(set) var cacheGeneration: UInt64
  public private(set) var activeLease: PhotoAssetThumbnailPreheatLease<OwnerID, ScopeID>?
  public private(set) var desiredKeys: [PhotoAssetThumbnailRequestKey] = []
  public private(set) var pendingKeys: [PhotoAssetThumbnailRequestKey] = []
  public private(set) var activeKeys: [PhotoAssetThumbnailRequestKey] = []

  public var pendingAssetIdentifiers: [String] {
    pendingKeys.map(\.assetIdentifier)
  }

  private var planner: PhotoAssetThumbnailPreheatPlanner
  private var nextLeaseSequence: UInt64 = 0
  private var pendingAssetIdentifierSet: Set<String> = []
  private var activeBindingsByKey:
    [PhotoAssetThumbnailRequestKey: PhotoAssetThumbnailPreheatAssetBinding<Asset>] = [:]

  public init(cacheGeneration: UInt64 = 0) {
    self.cacheGeneration = cacheGeneration
    planner = PhotoAssetThumbnailPreheatPlanner(generation: cacheGeneration)
  }

  /// Replaces the one active lease. A fresh sequence makes callbacks and `endLease` calls from
  /// every previous lease harmless, including when the owner and scope values are reused.
  public mutating func beginLease(
    ownerID: OwnerID,
    scopeID: ScopeID,
    candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget,
    availableAssetsByIdentifier: [String: Asset] = [:]
  ) -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    let stoppedBindings = removeAllState()
    nextLeaseSequence &+= 1
    activeLease = PhotoAssetThumbnailPreheatLease(
      ownerID: ownerID,
      scopeID: scopeID,
      sequence: nextLeaseSequence
    )

    var reusableAssets = availableAssetsByIdentifier
    for binding in stoppedBindings where reusableAssets[binding.key.assetIdentifier] == nil {
      reusableAssets[binding.key.assetIdentifier] = binding.asset
    }
    let applied = apply(
      candidates: candidates,
      budget: budget,
      availableAssetsByIdentifier: reusableAssets
    )

    return makeChange(
      accepted: true,
      stoppedBindings: stoppedBindings,
      startedBindings: applied.startedBindings,
      identifiersToFetch: applied.identifiersToFetch
    )
  }

  /// Updates only the matching active lease. Stale lease tokens cannot replace current state.
  public mutating func updateLease(
    _ lease: PhotoAssetThumbnailPreheatLease<OwnerID, ScopeID>,
    candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget,
    availableAssetsByIdentifier: [String: Asset] = [:]
  ) -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    guard lease == activeLease else {
      return makeChange(accepted: false)
    }

    let applied = apply(
      candidates: candidates,
      budget: budget,
      availableAssetsByIdentifier: availableAssetsByIdentifier
    )
    return makeChange(
      accepted: true,
      stoppedBindings: applied.stoppedBindings,
      startedBindings: applied.startedBindings,
      identifiersToFetch: applied.identifiersToFetch
    )
  }

  /// Ends only the matching active lease. An end arriving after replacement is a no-op.
  public mutating func endLease(
    _ lease: PhotoAssetThumbnailPreheatLease<OwnerID, ScopeID>
  ) -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    guard lease == activeLease else {
      return makeChange(accepted: false)
    }

    let stoppedBindings = removeAllState()
    activeLease = nil
    return makeChange(accepted: true, stoppedBindings: stoppedBindings)
  }

  /// Resolves one completed asset fetch. Results are accepted only for the exact generation and
  /// lease that initiated the fetch, and only while each identifier remains pending and desired.
  public mutating func resolveAssetFetch(
    identifiers: [String],
    assetsByIdentifier: [String: Asset],
    cacheGeneration requestedGeneration: UInt64,
    lease: PhotoAssetThumbnailPreheatLease<OwnerID, ScopeID>
  ) -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    guard requestedGeneration == cacheGeneration, lease == activeLease else {
      return makeChange(accepted: false)
    }

    let resolvedIdentifiers = Self.orderedUniqueIdentifiers(identifiers)
    let resolvedIdentifierSet = Set(resolvedIdentifiers)
    let pendingAtResolution = pendingAssetIdentifierSet
    pendingAssetIdentifierSet.subtract(resolvedIdentifierSet)

    var startedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>] = []
    startedBindings.reserveCapacity(resolvedIdentifiers.count)
    for key in desiredKeys {
      let identifier = key.assetIdentifier
      guard resolvedIdentifierSet.contains(identifier), pendingAtResolution.contains(identifier),
        activeBindingsByKey[key] == nil, let asset = assetsByIdentifier[identifier]
      else {
        continue
      }

      let binding = PhotoAssetThumbnailPreheatAssetBinding(key: key, asset: asset)
      activeBindingsByKey[key] = binding
      startedBindings.append(binding)
    }
    rebuildTrackedKeys()

    return makeChange(accepted: true, startedBindings: startedBindings)
  }

  /// Clears lease state without changing the cache generation. The next lease still receives a
  /// new sequence, so callbacks from the cleared lease cannot attach to it.
  public mutating func clear() -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    let stoppedBindings = removeAllState()
    activeLease = nil
    return makeChange(accepted: true, stoppedBindings: stoppedBindings)
  }

  /// Clears lease state and advances the cache generation, invalidating all in-flight fetches.
  public mutating func invalidateCache()
    -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset>
  {
    let stoppedBindings = removeAllState()
    activeLease = nil
    cacheGeneration &+= 1
    planner = PhotoAssetThumbnailPreheatPlanner(generation: cacheGeneration)
    return makeChange(accepted: true, stoppedBindings: stoppedBindings)
  }

  private mutating func apply(
    candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget,
    availableAssetsByIdentifier: [String: Asset]
  ) -> (
    stoppedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>],
    startedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>],
    identifiersToFetch: [String]
  ) {
    let normalizedCandidates = Self.normalizedCandidates(candidates)
    let delta = planner.transition(
      to: normalizedCandidates,
      budget: budget,
      generation: cacheGeneration
    )
    let nextDesiredKeys = delta.activeKeys
    let nextDesiredKeySet = Set(nextDesiredKeys)
    let nextDesiredIdentifierSet = Set(nextDesiredKeys.map(\.assetIdentifier))

    var reusableAssets = availableAssetsByIdentifier
    var stoppedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>] = []
    for key in activeKeys where !nextDesiredKeySet.contains(key) {
      guard let binding = activeBindingsByKey.removeValue(forKey: key) else {
        continue
      }
      stoppedBindings.append(binding)
      if reusableAssets[key.assetIdentifier] == nil {
        reusableAssets[key.assetIdentifier] = binding.asset
      }
    }

    desiredKeys = nextDesiredKeys
    pendingAssetIdentifierSet.formIntersection(nextDesiredIdentifierSet)

    var startedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>] = []
    var identifiersToFetch: [String] = []
    for key in desiredKeys where activeBindingsByKey[key] == nil {
      let identifier = key.assetIdentifier
      if let asset = reusableAssets[identifier] {
        let binding = PhotoAssetThumbnailPreheatAssetBinding(key: key, asset: asset)
        activeBindingsByKey[key] = binding
        pendingAssetIdentifierSet.remove(identifier)
        startedBindings.append(binding)
      } else if pendingAssetIdentifierSet.insert(identifier).inserted {
        identifiersToFetch.append(identifier)
      }
    }
    rebuildTrackedKeys()

    return (stoppedBindings, startedBindings, identifiersToFetch)
  }

  private mutating func removeAllState() -> [PhotoAssetThumbnailPreheatAssetBinding<Asset>] {
    let stoppedBindings = activeKeys.compactMap { activeBindingsByKey[$0] }
    desiredKeys.removeAll(keepingCapacity: false)
    pendingKeys.removeAll(keepingCapacity: false)
    activeKeys.removeAll(keepingCapacity: false)
    pendingAssetIdentifierSet.removeAll(keepingCapacity: false)
    activeBindingsByKey.removeAll(keepingCapacity: false)
    planner = PhotoAssetThumbnailPreheatPlanner(generation: cacheGeneration)
    return stoppedBindings
  }

  private mutating func rebuildTrackedKeys() {
    pendingKeys = desiredKeys.filter {
      pendingAssetIdentifierSet.contains($0.assetIdentifier)
    }
    activeKeys = desiredKeys.filter { activeBindingsByKey[$0] != nil }
  }

  private func makeChange(
    accepted: Bool,
    stoppedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>] = [],
    startedBindings: [PhotoAssetThumbnailPreheatAssetBinding<Asset>] = [],
    identifiersToFetch: [String] = []
  ) -> PhotoAssetThumbnailPreheatStoreChange<OwnerID, ScopeID, Asset> {
    let operations =
      stoppedBindings.map(PhotoAssetThumbnailPreheatStoreOperation.stop)
      + startedBindings.map(PhotoAssetThumbnailPreheatStoreOperation.start)
    return PhotoAssetThumbnailPreheatStoreChange(
      accepted: accepted,
      cacheGeneration: cacheGeneration,
      activeLease: activeLease,
      operations: operations,
      identifiersToFetch: identifiersToFetch
    )
  }

  private static func normalizedCandidates(
    _ candidates: [PhotoAssetThumbnailRequestKey]
  ) -> [PhotoAssetThumbnailRequestKey] {
    var seenAssetIdentifiers: Set<String> = []
    return candidates.filter {
      seenAssetIdentifiers.insert($0.assetIdentifier).inserted
    }
  }

  private static func orderedUniqueIdentifiers(_ identifiers: [String]) -> [String] {
    var seen: Set<String> = []
    return identifiers.filter { seen.insert($0).inserted }
  }
}
