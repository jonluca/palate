import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset thumbnail preheat store state")
struct PhotoAssetThumbnailPreheatStoreStateTests {
  @Test("Bridge requests validate targets and cap ordered opaque asset identifiers")
  func bridgeRequestValidation() throws {
    let uris = (0...PhotoAssetThumbnailPreheatRequest.maximumPayloadSize).map {
      "ph://asset-\($0)"
    }
    let request = try #require(
      PhotoAssetThumbnailPreheatRequest(
        scopeID: "scope",
        uris: ["file:///invalid", uris[0], uris[0]] + Array(uris.dropFirst()),
        pixelWidth: 320,
        pixelHeight: 240
      )
    )

    #expect(request.scopeID == "scope")
    #expect(request.keys.count == PhotoAssetThumbnailPreheatRequest.maximumPayloadSize - 2)
    #expect(request.keys.first?.assetIdentifier == "asset-0")
    #expect(request.keys.last?.assetIdentifier == "asset-61")
    #expect(request.keys.allSatisfy { $0.target.pixelWidth == 320 })
    #expect(request.keys.allSatisfy { $0.target.pixelHeight == 240 })
    #expect(request.keys.allSatisfy { $0.contentMode == .aspectFill })

    #expect(
      PhotoAssetThumbnailPreheatRequest(
        scopeID: "",
        uris: uris,
        pixelWidth: 320,
        pixelHeight: 240
      ) == nil
    )
    #expect(
      PhotoAssetThumbnailPreheatRequest(
        scopeID: "scope",
        uris: uris,
        pixelWidth: 0,
        pixelHeight: 240
      ) == nil
    )
  }

  @Test("Candidates keep the first key per asset before planner budgets are applied")
  func orderedAssetNormalizationAndBudget() throws {
    let medium = try Self.target(width: 10, height: 10)
    let large = try Self.target(width: 20, height: 20)
    let small = try Self.target(width: 5, height: 10)
    let firstAsset = try Self.key("first", target: medium)
    let ignoredAlternate = try Self.key("first", target: small, contentMode: .aspectFit)
    let overBudget = try Self.key("over-budget", target: large)
    let laterFit = try Self.key("later-fit", target: small)
    var state = State()

    let change = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [firstAsset, ignoredAlternate, overBudget, laterFit, firstAsset],
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: 150,
        maximumEstimatedByteCount: 600
      ),
      availableAssetsByIdentifier: Self.assets("first", "over-budget", "later-fit")
    )

    #expect(change.accepted)
    #expect(state.desiredKeys == [firstAsset, laterFit])
    #expect(state.activeKeys == [firstAsset, laterFit])
    #expect(state.pendingKeys.isEmpty)
    #expect(change.identifiersToFetch.isEmpty)
    #expect(
      Self.records(change) == [
        .start(firstAsset, FakeAsset(identifier: "first")),
        .start(laterFit, FakeAsset(identifier: "later-fit")),
      ])
  }

  @Test("A new lease is singular even when owner and scope are reused, and stale end is ignored")
  func singularLeaseAndStaleEnd() throws {
    let target = try Self.target()
    let firstKey = try Self.key("first", target: target)
    let secondKey = try Self.key("second", target: target)
    var state = State()

    let first = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [firstKey],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("first")
    )
    let firstLease = try #require(first.activeLease)
    let second = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [secondKey],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("second")
    )
    let secondLease = try #require(second.activeLease)

    #expect(firstLease.ownerID == secondLease.ownerID)
    #expect(firstLease.scopeID == secondLease.scopeID)
    #expect(firstLease.sequence != secondLease.sequence)
    #expect(
      Self.records(second) == [
        .stop(firstKey, FakeAsset(identifier: "first")),
        .start(secondKey, FakeAsset(identifier: "second")),
      ])

    let staleEnd = state.endLease(firstLease)
    #expect(!staleEnd.accepted)
    #expect(staleEnd.operations.isEmpty)
    #expect(state.activeLease == secondLease)
    #expect(state.activeKeys == [secondKey])

    let currentEnd = state.endLease(secondLease)
    #expect(currentEnd.accepted)
    #expect(
      Self.records(currentEnd) == [
        .stop(secondKey, FakeAsset(identifier: "second"))
      ])
    #expect(state.activeLease == nil)
    #expect(state.desiredKeys.isEmpty)
  }

  @Test("Desired, pending, and active state stay ordered across overlap updates")
  func trackedStateAndOperationOrder() throws {
    let target = try Self.target()
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    let third = try Self.key("third", target: target)
    let fourth = try Self.key("fourth", target: target)
    var state = State()

    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [first, second, third],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("first")
    )
    let lease = try #require(initial.activeLease)
    #expect(initial.identifiersToFetch == ["second", "third"])
    #expect(state.desiredKeys == [first, second, third])
    #expect(state.pendingKeys == [second, third])
    #expect(state.pendingAssetIdentifiers == ["second", "third"])
    #expect(state.activeKeys == [first])

    let shifted = state.updateLease(
      lease,
      candidates: [second, third, fourth],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("fourth")
    )

    #expect(shifted.identifiersToFetch.isEmpty)
    #expect(
      Self.records(shifted) == [
        .stop(first, FakeAsset(identifier: "first")),
        .start(fourth, FakeAsset(identifier: "fourth")),
      ])
    #expect(state.desiredKeys == [second, third, fourth])
    #expect(state.pendingKeys == [second, third])
    #expect(state.activeKeys == [fourth])
  }

  @Test("Fetch resolution starts only identifiers that are still pending and desired")
  func fetchResolutionFiltersDesiredMembership() throws {
    let target = try Self.target()
    let removed = try Self.key("removed", target: target)
    let retained = try Self.key("retained", target: target)
    let added = try Self.key("added", target: target)
    var state = State()

    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [removed, retained],
      budget: .unbounded
    )
    let lease = try #require(initial.activeLease)
    #expect(initial.identifiersToFetch == ["removed", "retained"])

    let shifted = state.updateLease(
      lease,
      candidates: [retained, added],
      budget: .unbounded
    )
    #expect(shifted.identifiersToFetch == ["added"])

    let resolution = state.resolveAssetFetch(
      identifiers: ["removed", "retained", "retained"],
      assetsByIdentifier: Self.assets("removed", "retained", "not-requested"),
      cacheGeneration: initial.cacheGeneration,
      lease: lease
    )

    #expect(resolution.accepted)
    #expect(
      Self.records(resolution) == [
        .start(retained, FakeAsset(identifier: "retained"))
      ])
    #expect(state.desiredKeys == [retained, added])
    #expect(state.pendingKeys == [added])
    #expect(state.activeKeys == [retained])
  }

  @Test("A pending asset follows its current rendering key without another fetch")
  func pendingAssetFollowsReplacementKey() throws {
    let square = try Self.target(width: 100, height: 100)
    let wide = try Self.target(width: 200, height: 100)
    let original = try Self.key("asset", target: square)
    let replacement = try Self.key("asset", target: wide, contentMode: .aspectFit)
    var state = State()

    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [original],
      budget: .unbounded
    )
    let lease = try #require(initial.activeLease)
    #expect(initial.identifiersToFetch == ["asset"])

    let updated = state.updateLease(
      lease,
      candidates: [replacement],
      budget: .unbounded
    )
    #expect(updated.identifiersToFetch.isEmpty)
    #expect(state.pendingKeys == [replacement])

    let resolved = state.resolveAssetFetch(
      identifiers: ["asset"],
      assetsByIdentifier: Self.assets("asset"),
      cacheGeneration: initial.cacheGeneration,
      lease: lease
    )
    #expect(
      Self.records(resolved) == [
        .start(replacement, FakeAsset(identifier: "asset"))
      ])
    #expect(state.activeKeys == [replacement])
  }

  @Test("An active asset is reused when its rendering key changes, after an ordered stop")
  func activeAssetFollowsReplacementKey() throws {
    let square = try Self.target(width: 100, height: 100)
    let wide = try Self.target(width: 200, height: 100)
    let original = try Self.key("asset", target: square)
    let replacement = try Self.key("asset", target: wide, contentMode: .aspectFit)
    let asset = FakeAsset(identifier: "asset")
    var state = State()

    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [original],
      budget: .unbounded,
      availableAssetsByIdentifier: ["asset": asset]
    )
    let lease = try #require(initial.activeLease)

    let updated = state.updateLease(
      lease,
      candidates: [replacement],
      budget: .unbounded
    )

    #expect(updated.identifiersToFetch.isEmpty)
    #expect(
      Self.records(updated) == [
        .stop(original, asset),
        .start(replacement, asset),
      ])
    #expect(state.activeKeys == [replacement])
    #expect(state.pendingKeys.isEmpty)
  }

  @Test("A completed fetch clears missing identifiers instead of leaving phantom pending state")
  func missingFetchResultsClearPendingState() throws {
    let target = try Self.target()
    let found = try Self.key("found", target: target)
    let missing = try Self.key("missing", target: target)
    var state = State()
    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [found, missing],
      budget: .unbounded
    )
    let lease = try #require(initial.activeLease)

    let resolved = state.resolveAssetFetch(
      identifiers: ["found", "missing"],
      assetsByIdentifier: Self.assets("found"),
      cacheGeneration: initial.cacheGeneration,
      lease: lease
    )

    #expect(
      Self.records(resolved) == [
        .start(found, FakeAsset(identifier: "found"))
      ])
    #expect(state.pendingKeys.isEmpty)
    #expect(state.activeKeys == [found])
    #expect(state.desiredKeys == [found, missing])
  }

  @Test("Late fetches from a replaced lease cannot mutate current state")
  func lateFetchFromReplacedLease() throws {
    let target = try Self.target()
    let stale = try Self.key("stale", target: target)
    let current = try Self.key("current", target: target)
    var state = State()

    let first = state.beginLease(
      ownerID: "first-owner",
      scopeID: "first-scope",
      candidates: [stale],
      budget: .unbounded
    )
    let staleLease = try #require(first.activeLease)
    let replacement = state.beginLease(
      ownerID: "current-owner",
      scopeID: "current-scope",
      candidates: [current],
      budget: .unbounded
    )
    let currentLease = try #require(replacement.activeLease)

    let late = state.resolveAssetFetch(
      identifiers: ["stale"],
      assetsByIdentifier: Self.assets("stale"),
      cacheGeneration: first.cacheGeneration,
      lease: staleLease
    )

    #expect(!late.accepted)
    #expect(late.operations.isEmpty)
    #expect(state.activeLease == currentLease)
    #expect(state.pendingKeys == [current])
    #expect(state.activeKeys.isEmpty)
  }

  @Test("A wrong cache generation is rejected even for the current lease")
  func lateFetchFromWrongGeneration() throws {
    let target = try Self.target()
    let key = try Self.key("asset", target: target)
    var state = State(cacheGeneration: 12)
    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [key],
      budget: .unbounded
    )
    let lease = try #require(initial.activeLease)

    let late = state.resolveAssetFetch(
      identifiers: ["asset"],
      assetsByIdentifier: Self.assets("asset"),
      cacheGeneration: 11,
      lease: lease
    )

    #expect(!late.accepted)
    #expect(late.operations.isEmpty)
    #expect(state.activeLease == lease)
    #expect(state.pendingKeys == [key])
    #expect(state.activeKeys.isEmpty)
  }

  @Test("Clear stops active bindings and rejects callbacks from the cleared lease")
  func clearBehavior() throws {
    let target = try Self.target()
    let active = try Self.key("active", target: target)
    let pending = try Self.key("pending", target: target)
    var state = State(cacheGeneration: 9)
    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [active, pending],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("active")
    )
    let lease = try #require(initial.activeLease)

    let cleared = state.clear()
    #expect(cleared.accepted)
    #expect(cleared.cacheGeneration == 9)
    #expect(
      Self.records(cleared) == [
        .stop(active, FakeAsset(identifier: "active"))
      ])
    #expect(state.activeLease == nil)
    #expect(state.desiredKeys.isEmpty)
    #expect(state.pendingKeys.isEmpty)
    #expect(state.activeKeys.isEmpty)

    let late = state.resolveAssetFetch(
      identifiers: ["pending"],
      assetsByIdentifier: Self.assets("pending"),
      cacheGeneration: 9,
      lease: lease
    )
    #expect(!late.accepted)
    #expect(late.operations.isEmpty)
  }

  @Test("Invalidation advances generation across wrap and rejects old fetch resolution")
  func invalidationBehavior() throws {
    let target = try Self.target()
    let key = try Self.key("asset", target: target)
    var state = State(cacheGeneration: .max)
    let initial = state.beginLease(
      ownerID: "owner",
      scopeID: "scope",
      candidates: [key],
      budget: .unbounded,
      availableAssetsByIdentifier: Self.assets("asset")
    )
    let lease = try #require(initial.activeLease)

    let invalidated = state.invalidateCache()
    #expect(invalidated.accepted)
    #expect(invalidated.cacheGeneration == 0)
    #expect(
      Self.records(invalidated) == [
        .stop(key, FakeAsset(identifier: "asset"))
      ])
    #expect(state.activeLease == nil)
    #expect(state.desiredKeys.isEmpty)

    let late = state.resolveAssetFetch(
      identifiers: ["asset"],
      assetsByIdentifier: Self.assets("asset"),
      cacheGeneration: .max,
      lease: lease
    )
    #expect(!late.accepted)
    #expect(state.cacheGeneration == 0)
    #expect(state.activeKeys.isEmpty)
  }

  private struct FakeAsset: Equatable {
    let identifier: String
  }

  private enum OperationRecord: Equatable {
    case stop(PhotoAssetThumbnailRequestKey, FakeAsset)
    case start(PhotoAssetThumbnailRequestKey, FakeAsset)
  }

  private typealias State = PhotoAssetThumbnailPreheatStoreState<String, String, FakeAsset>
  private typealias Change = PhotoAssetThumbnailPreheatStoreChange<String, String, FakeAsset>

  private static func records(_ change: Change) -> [OperationRecord] {
    change.operations.map { operation in
      switch operation {
      case .stop(let binding):
        .stop(binding.key, binding.asset)
      case .start(let binding):
        .start(binding.key, binding.asset)
      }
    }
  }

  private static func assets(_ identifiers: String...) -> [String: FakeAsset] {
    Dictionary(
      uniqueKeysWithValues: identifiers.map {
        ($0, FakeAsset(identifier: $0))
      })
  }

  private static func target(width: Int = 10, height: Int = 10) throws
    -> PhotoAssetThumbnailTarget
  {
    try PhotoAssetThumbnailTarget(pixelWidth: width, pixelHeight: height)
  }

  private static func key(
    _ identifier: String,
    target: PhotoAssetThumbnailTarget,
    contentMode: PhotoAssetThumbnailContentMode = .aspectFill
  ) throws -> PhotoAssetThumbnailRequestKey {
    try PhotoAssetThumbnailRequestKey(
      assetIdentifier: identifier,
      target: target,
      contentMode: contentMode
    )
  }
}
