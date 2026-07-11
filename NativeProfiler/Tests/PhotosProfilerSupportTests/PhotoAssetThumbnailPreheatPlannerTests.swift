import Testing

@testable import BatchAssetInfoCore

@Suite("Photo asset thumbnail preheat planner")
struct PhotoAssetThumbnailPreheatPlannerTests {
  @Test("Ordered candidates retain their first exact occurrence")
  func orderedDeduplication() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    let third = try Self.key("third", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner(generation: 7)

    let delta = planner.transition(
      to: [first, second, first, third, second],
      budget: .unbounded,
      generation: 7
    )

    #expect(delta.transition == .updated)
    #expect(delta.starts == [first, second, third])
    #expect(delta.stops.isEmpty)
    #expect(delta.retained.isEmpty)
    #expect(delta.activeKeys == [first, second, third])
    #expect(delta.activePixelCount == 300)
    #expect(delta.activeEstimatedByteCount == 1_200)
  }

  @Test("Pixel and estimated-byte caps independently bound the ordered selection")
  func boundedSelection() throws {
    let small = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let large = try PhotoAssetThumbnailTarget(pixelWidth: 20, pixelHeight: 20)
    let tiny = try PhotoAssetThumbnailTarget(pixelWidth: 5, pixelHeight: 10)
    let first = try Self.key("first", target: small)
    let overBudget = try Self.key("over-budget", target: large)
    let laterFit = try Self.key("later-fit", target: tiny)
    let candidates = [first, overBudget, first, laterFit]

    var pixelBoundedPlanner = PhotoAssetThumbnailPreheatPlanner()
    let pixelBounded = pixelBoundedPlanner.transition(
      to: candidates,
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: 150,
        maximumEstimatedByteCount: 10_000
      ),
      generation: 0
    )
    #expect(pixelBounded.activeKeys == [first, laterFit])
    #expect(pixelBounded.activePixelCount == 150)
    #expect(pixelBounded.activeEstimatedByteCount == 600)

    var byteBoundedPlanner = PhotoAssetThumbnailPreheatPlanner()
    let byteBounded = byteBoundedPlanner.transition(
      to: candidates,
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: 10_000,
        maximumEstimatedByteCount: 600
      ),
      generation: 0
    )
    #expect(byteBounded.activeKeys == [first, laterFit])
    #expect(byteBounded.activePixelCount == 150)
    #expect(byteBounded.activeEstimatedByteCount == 600)
  }

  @Test("Overlapping windows emit only ordered start and stop deltas")
  func overlappingDeltas() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 12, pixelHeight: 8)
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    let third = try Self.key("third", target: target)
    let fourth = try Self.key("fourth", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner()

    _ = planner.transition(
      to: [first, second, third],
      budget: .unbounded,
      generation: 0
    )
    let shifted = planner.transition(
      to: [second, third, fourth],
      budget: .unbounded,
      generation: 0
    )

    #expect(shifted.starts == [fourth])
    #expect(shifted.stops == [first])
    #expect(shifted.retained == [second, third])
    #expect(shifted.activeKeys == [second, third, fourth])

    let reordered = planner.transition(
      to: [fourth, second, third],
      budget: .unbounded,
      generation: 0
    )
    #expect(reordered.starts.isEmpty)
    #expect(reordered.stops.isEmpty)
    #expect(reordered.retained == [fourth, second, third])
    #expect(reordered.activeKeys == [fourth, second, third])
  }

  @Test("Target-size and content-mode changes replace an asset's cache key")
  func renderingIdentityChanges() throws {
    let square = try PhotoAssetThumbnailTarget(pixelWidth: 100, pixelHeight: 100)
    let wide = try PhotoAssetThumbnailTarget(pixelWidth: 200, pixelHeight: 100)
    let original = try Self.key("asset", target: square, contentMode: .aspectFill)
    let resized = try Self.key("asset", target: wide, contentMode: .aspectFill)
    let fitted = try Self.key("asset", target: wide, contentMode: .aspectFit)
    var planner = PhotoAssetThumbnailPreheatPlanner()

    _ = planner.transition(to: [original], budget: .unbounded, generation: 0)
    let resizeDelta = planner.transition(to: [resized], budget: .unbounded, generation: 0)
    #expect(resizeDelta.starts == [resized])
    #expect(resizeDelta.stops == [original])
    #expect(resizeDelta.retained.isEmpty)

    let modeDelta = planner.transition(to: [fitted], budget: .unbounded, generation: 0)
    #expect(modeDelta.starts == [fitted])
    #expect(modeDelta.stops == [resized])
    #expect(modeDelta.retained.isEmpty)
  }

  @Test("A newer generation resets state and stale generations cannot mutate it")
  func generationReset() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    let third = try Self.key("third", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner(generation: 4)

    _ = planner.transition(to: [first, second], budget: .unbounded, generation: 4)
    let reset = planner.transition(to: [second, third], budget: .unbounded, generation: 5)
    #expect(reset.transition == .resetGeneration)
    #expect(reset.requestedGeneration == 5)
    #expect(reset.activeGeneration == 5)
    #expect(reset.starts == [second, third])
    #expect(reset.stops.isEmpty)
    #expect(reset.retained.isEmpty)

    let stale = planner.transition(to: [first], budget: .unbounded, generation: 4)
    #expect(stale.transition == .ignoredStaleGeneration)
    #expect(stale.requestedGeneration == 4)
    #expect(stale.activeGeneration == 5)
    #expect(stale.starts.isEmpty)
    #expect(stale.stops.isEmpty)
    #expect(stale.retained == [second, third])
    #expect(stale.activeKeys == [second, third])
    #expect(planner.activeKeys == [second, third])

    let current = planner.transition(to: [third], budget: .unbounded, generation: 5)
    #expect(current.transition == .updated)
    #expect(current.starts.isEmpty)
    #expect(current.stops == [second])
    #expect(current.retained == [third])
  }

  @Test("Generation ordering remains safe across UInt64 wraparound")
  func generationWraparound() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let beforeWrap = try Self.key("before-wrap", target: target)
    let afterWrap = try Self.key("after-wrap", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner(generation: .max)
    _ = planner.transition(to: [beforeWrap], budget: .unbounded, generation: .max)

    let wrapped = planner.transition(to: [afterWrap], budget: .unbounded, generation: 0)
    #expect(wrapped.transition == .resetGeneration)
    #expect(wrapped.activeGeneration == 0)
    #expect(wrapped.starts == [afterWrap])

    let stale = planner.transition(to: [beforeWrap], budget: .unbounded, generation: .max)
    #expect(stale.transition == .ignoredStaleGeneration)
    #expect(stale.activeKeys == [afterWrap])
    #expect(planner.generation == 0)
  }

  @Test("Generation ordering has an explicit half-range cutoff")
  func generationHalfRangeCutoff() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let acceptedKey = try Self.key("accepted", target: target)
    let rejectedKey = try Self.key("rejected", target: target)
    let largestForwardDistance = UInt64.max / 2
    let ambiguousHalfRange = largestForwardDistance + 1

    var acceptedPlanner = PhotoAssetThumbnailPreheatPlanner(generation: 0)
    let accepted = acceptedPlanner.transition(
      to: [acceptedKey],
      budget: .unbounded,
      generation: largestForwardDistance
    )
    #expect(accepted.transition == .resetGeneration)
    #expect(accepted.activeGeneration == largestForwardDistance)

    var rejectedPlanner = PhotoAssetThumbnailPreheatPlanner(generation: 0)
    let rejected = rejectedPlanner.transition(
      to: [rejectedKey],
      budget: .unbounded,
      generation: ambiguousHalfRange
    )
    #expect(rejected.transition == .ignoredStaleGeneration)
    #expect(rejected.activeGeneration == 0)
    #expect(rejected.activeKeys.isEmpty)
  }

  @Test("A zero budget stops every active key without underflow")
  func zeroBudget() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 10, pixelHeight: 10)
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner()
    _ = planner.transition(to: [first, second], budget: .unbounded, generation: 0)

    let delta = planner.transition(
      to: [first, second],
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: 0,
        maximumEstimatedByteCount: 0
      ),
      generation: 0
    )

    #expect(delta.starts.isEmpty)
    #expect(delta.stops == [first, second])
    #expect(delta.retained.isEmpty)
    #expect(delta.activeKeys.isEmpty)
    #expect(delta.activePixelCount == 0)
    #expect(delta.activeEstimatedByteCount == 0)
  }

  @Test("The key-count cap applies after exact deduplication")
  func keyCountBudget() throws {
    let target = try PhotoAssetThumbnailTarget(pixelWidth: 1, pixelHeight: 1)
    let first = try Self.key("first", target: target)
    let second = try Self.key("second", target: target)
    let third = try Self.key("third", target: target)
    var planner = PhotoAssetThumbnailPreheatPlanner()

    let bounded = planner.transition(
      to: [first, first, second, third],
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: .max,
        maximumEstimatedByteCount: .max,
        maximumKeyCount: 2
      ),
      generation: 0
    )

    #expect(bounded.activeKeys == [first, second])
    #expect(bounded.activePixelCount == 2)
    #expect(bounded.activeEstimatedByteCount == 8)

    let empty = planner.transition(
      to: [first, second],
      budget: PhotoAssetThumbnailPreheatBudget(
        maximumPixelCount: .max,
        maximumEstimatedByteCount: .max,
        maximumKeyCount: 0
      ),
      generation: 0
    )
    #expect(empty.stops == [first, second])
    #expect(empty.activeKeys.isEmpty)
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
