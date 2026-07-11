import Foundation
@preconcurrency import Photos

final class PhotoAssetThumbnailPreheatRuntime {
  typealias Lease = PhotoAssetThumbnailPreheatLease<UUID, String>
  typealias State = PhotoAssetThumbnailPreheatStoreState<UUID, String, PHAsset>
  typealias Change = PhotoAssetThumbnailPreheatStoreChange<UUID, String, PHAsset>

  private let imageManager: PHCachingImageManager
  private var state = State()
  private var fetchLeaseByAssetIdentifier: [String: Lease] = [:]
  private var updateCount = 0
  private var startedKeyCount = 0
  private var stoppedKeyCount = 0
  private var retainedKeyCount = 0
  private var fetchIdentifierCount = 0
  private var cacheStartCallCount = 0
  private var cacheStopCallCount = 0
  private var cacheStopAllCount = 0

  init(imageManager: PHCachingImageManager) {
    self.imageManager = imageManager
  }

  var cacheGeneration: UInt64 {
    state.cacheGeneration
  }

  var pendingAssetIdentifiers: [String] {
    state.pendingAssetIdentifiers
  }

  var metrics: PhotoAssetThumbnailPreheatRuntimeMetrics {
    PhotoAssetThumbnailPreheatRuntimeMetrics(
      updateCount: updateCount,
      startedKeyCount: startedKeyCount,
      stoppedKeyCount: stoppedKeyCount,
      retainedKeyCount: retainedKeyCount,
      fetchIdentifierCount: fetchIdentifierCount,
      cacheStartCallCount: cacheStartCallCount,
      cacheStopCallCount: cacheStopCallCount,
      cacheStopAllCount: cacheStopAllCount,
      activeKeyCount: state.activeKeys.count,
      pendingKeyCount: state.pendingKeys.count
    )
  }

  func update(
    ownerID: UUID,
    scopeID: String,
    candidates: [PhotoAssetThumbnailRequestKey],
    budget: PhotoAssetThumbnailPreheatBudget,
    availableAssetsByIdentifier: [String: PHAsset]
  ) -> [String] {
    let activeKeysBeforeUpdate = Set(state.activeKeys)
    let change: Change
    let updatesExistingLease: Bool
    if let lease = state.activeLease,
      lease.ownerID == ownerID,
      lease.scopeID == scopeID
    {
      updatesExistingLease = true
      change = state.updateLease(
        lease,
        candidates: candidates,
        budget: budget,
        availableAssetsByIdentifier: availableAssetsByIdentifier
      )
    } else {
      updatesExistingLease = false
      fetchLeaseByAssetIdentifier.removeAll(keepingCapacity: false)
      change = state.beginLease(
        ownerID: ownerID,
        scopeID: scopeID,
        candidates: candidates,
        budget: budget,
        availableAssetsByIdentifier: availableAssetsByIdentifier
      )
    }

    updateCount += 1
    fetchIdentifierCount += change.identifiersToFetch.count
    if updatesExistingLease {
      retainedKeyCount += activeKeysBeforeUpdate.intersection(state.activeKeys).count
    }
    apply(change.operations)
    guard let lease = change.activeLease else {
      fetchLeaseByAssetIdentifier.removeAll(keepingCapacity: false)
      return []
    }
    for identifier in change.identifiersToFetch {
      fetchLeaseByAssetIdentifier[identifier] = lease
    }
    let pendingIdentifierSet = Set(state.pendingAssetIdentifiers)
    fetchLeaseByAssetIdentifier = fetchLeaseByAssetIdentifier.filter {
      pendingIdentifierSet.contains($0.key)
    }
    return state.pendingAssetIdentifiers
  }

  func end(ownerID: UUID, scopeID: String? = nil) {
    guard let lease = state.activeLease, lease.ownerID == ownerID else {
      return
    }
    if let scopeID, lease.scopeID != scopeID {
      return
    }

    let change = state.endLease(lease)
    fetchLeaseByAssetIdentifier = fetchLeaseByAssetIdentifier.filter { $0.value != lease }
    apply(change.operations)
  }

  func resolveAssetFetch(
    identifiers: [String],
    assetsByIdentifier: [String: PHAsset],
    cacheGeneration: UInt64
  ) {
    var operations: [PhotoAssetThumbnailPreheatStoreOperation<PHAsset>] = []
    operations.reserveCapacity(identifiers.count)
    for identifier in identifiers {
      guard let lease = fetchLeaseByAssetIdentifier.removeValue(forKey: identifier) else {
        continue
      }
      let asset: [String: PHAsset]
      if let resolved = assetsByIdentifier[identifier] {
        asset = [identifier: resolved]
      } else {
        asset = [:]
      }
      let change = state.resolveAssetFetch(
        identifiers: [identifier],
        assetsByIdentifier: asset,
        cacheGeneration: cacheGeneration,
        lease: lease
      )
      operations.append(contentsOf: change.operations)
    }
    apply(operations)
  }

  func invalidateCache() {
    _ = state.invalidateCache()
    fetchLeaseByAssetIdentifier.removeAll(keepingCapacity: false)
    cacheStopAllCount += 1
  }

  private func apply(_ operations: [PhotoAssetThumbnailPreheatStoreOperation<PHAsset>]) {
    var stops: [PhotoAssetThumbnailPreheatAssetBinding<PHAsset>] = []
    var starts: [PhotoAssetThumbnailPreheatAssetBinding<PHAsset>] = []
    stops.reserveCapacity(operations.count)
    starts.reserveCapacity(operations.count)
    for operation in operations {
      switch operation {
      case .stop(let binding):
        stops.append(binding)
      case .start(let binding):
        starts.append(binding)
      }
    }

    stoppedKeyCount += stops.count
    startedKeyCount += starts.count

    apply(stops, start: false)
    apply(starts, start: true)
  }

  private func apply(
    _ bindings: [PhotoAssetThumbnailPreheatAssetBinding<PHAsset>],
    start: Bool
  ) {
    var descriptorOrder: [PhotoAssetThumbnailRenderDescriptor] = []
    var assetsByDescriptor: [PhotoAssetThumbnailRenderDescriptor: [PHAsset]] = [:]
    for binding in bindings {
      let descriptor = binding.key.renderDescriptor
      if assetsByDescriptor[descriptor] == nil {
        descriptorOrder.append(descriptor)
        assetsByDescriptor[descriptor] = []
      }
      assetsByDescriptor[descriptor]?.append(binding.asset)
    }

    for descriptor in descriptorOrder {
      guard let assets = assetsByDescriptor[descriptor], !assets.isEmpty else {
        continue
      }
      if start {
        cacheStartCallCount += 1
        imageManager.startCachingImages(
          for: assets,
          targetSize: descriptor.target.size,
          contentMode: descriptor.contentMode.photoKitValue,
          options: descriptor.makePhotoKitOptions()
        )
      } else {
        cacheStopCallCount += 1
        imageManager.stopCachingImages(
          for: assets,
          targetSize: descriptor.target.size,
          contentMode: descriptor.contentMode.photoKitValue,
          options: descriptor.makePhotoKitOptions()
        )
      }
    }
  }
}
